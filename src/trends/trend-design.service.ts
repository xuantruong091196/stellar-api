import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { GeminiService } from '../ai-content/gemini.service';
import { S3Service } from '../common/services/s3.service';
import { ReplicateClient } from './upscale/replicate.client';
import { CompositeService } from './composite/composite.service';
import { TrendDesignQueue } from './trend-design.queue';
import { TrendDesignStatus, CopyrightRisk } from '../../generated/prisma';
import { fetchWithTimeout } from '../common/safe-fetch';

@Injectable()
export class TrendDesignService implements OnModuleInit {
  private readonly logger = new Logger(TrendDesignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
    private readonly s3: S3Service,
    private readonly replicate: ReplicateClient,
    private readonly composite: CompositeService,
    private readonly queue: TrendDesignQueue,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor((job) => this.processJob(job.data.trendDesignId));
  }

  async createGenerationJob(params: {
    trendItemId: string;
    storeId: string;
    providerProductId: string;
  }) {
    const trendItem = await this.prisma.trendItem.findUnique({ where: { id: params.trendItemId } });
    if (!trendItem) throw new NotFoundException('Trend not found');
    if (trendItem.copyrightRisk === CopyrightRisk.BLOCKED) {
      throw new BadRequestException('Trend is blocked due to copyright');
    }

    const prompt = this.buildPrompt(trendItem, params.providerProductId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 3_600_000);
    const trendDesign = await this.prisma.trendDesign.create({
      data: {
        trendItemId: trendItem.id,
        storeId: params.storeId,
        promptUsed: prompt,
        styleUsed: trendItem.styleRefs as any,
        status: TrendDesignStatus.PENDING,
        expiresAt,
      },
    });

    await this.queue.enqueue({ trendDesignId: trendDesign.id });
    return { trendDesignId: trendDesign.id, status: trendDesign.status };
  }

  async getStatus(trendDesignId: string, storeId: string) {
    const td = await this.prisma.trendDesign.findUnique({
      where: { id: trendDesignId },
      include: { design: true },
    });
    if (!td) throw new NotFoundException('Trend design not found');
    if (td.storeId !== storeId) throw new NotFoundException('Trend design not found');
    return td;
  }

  private buildPrompt(trendItem: { keyword: string; niche: string; styleRefs: any }, productType: string): string {
    const refs = (trendItem.styleRefs as Array<{ palette: string[]; styleTags: string[] }>) || [];
    const palette = refs.flatMap((r) => r.palette).slice(0, 3).join(', ');
    const tags = [...new Set(refs.flatMap((r) => r.styleTags))].slice(0, 4).join(', ');
    const sanitizedKeyword = trendItem.keyword.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
    return `Create a typographic print-on-demand design for a ${productType}.
Niche: ${trendItem.niche}.
Quote/Keyword: "${sanitizedKeyword}".
Style: ${tags || 'modern typography'}.
Palette: ${palette || '#000000, #ffffff'}.
Requirements: transparent PNG background, centered composition, typography is the hero, no logos or copyrighted characters, PORTRAIT aspect 5:6 (output dimensions approximately 832x1216), high contrast.`;
  }

  private async processJob(trendDesignId: string) {
    const start = Date.now();
    const td = await this.prisma.trendDesign.findUnique({
      where: { id: trendDesignId },
      include: { trendItem: true },
    });
    if (!td) return;

    try {
      await this.prisma.trendDesign.update({
        where: { id: trendDesignId },
        data: { status: TrendDesignStatus.GENERATING, attempts: { increment: 1 } },
      });

      const baseImageUrl = await this.gemini.generateImage(td.promptUsed);
      if (!baseImageUrl) throw new Error('Gemini returned no image');

      await this.prisma.trendDesign.update({
        where: { id: trendDesignId },
        data: { status: TrendDesignStatus.UPSCALING },
      });

      let upscaledUrl = await this.replicate.upscale4x(baseImageUrl);
      let printQuality: 'hi' | 'lo' = 'hi';
      if (!upscaledUrl) {
        this.logger.warn(`Upscale failed for ${trendDesignId}; proceeding with base image as lo-quality`);
        upscaledUrl = baseImageUrl;
        printQuality = 'lo';
      }

      await this.prisma.trendDesign.update({
        where: { id: trendDesignId },
        data: { status: TrendDesignStatus.COMPOSITING },
      });

      const res = await fetchWithTimeout(upscaledUrl, { timeoutMs: 30_000 });
      const buffer = Buffer.from(await res.arrayBuffer());
      const key = `trend-designs/${trendDesignId}/print.png`;
      const finalUrl = await this.s3.uploadFile(key, buffer, 'image/png');

      const design = await this.prisma.design.create({
        data: {
          storeId: td.storeId,
          name: printQuality === 'lo'
            ? `[lo-quality] Trend: ${td.trendItem.keyword.slice(0, 60)}`
            : `Trend: ${td.trendItem.keyword.slice(0, 60)}`,
          fileUrl: finalUrl,
          fileSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
          fileSizeBytes: buffer.length,
          mimeType: 'image/png',
          // Hi-quality after Real-ESRGAN x4 from 832x1216 ≈ 3328x4864.
          // Lo-quality fallback uses base 832x1216.
          width: printQuality === 'hi' ? 3328 : 832,
          height: printQuality === 'hi' ? 4864 : 1216,
        },
      });

      await this.prisma.trendDesign.update({
        where: { id: trendDesignId },
        data: {
          status: TrendDesignStatus.COMPLETED,
          designId: design.id,
          completedAt: new Date(),
          generationDurationMs: Date.now() - start,
        },
      });
      this.logger.log(`TrendDesign ${trendDesignId} completed in ${Date.now() - start}ms`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`TrendDesign ${trendDesignId} failed: ${message}`);
      await this.prisma.trendDesign.update({
        where: { id: trendDesignId },
        data: { status: TrendDesignStatus.FAILED, errorMessage: message },
      });
      throw err;
    }
  }
}
