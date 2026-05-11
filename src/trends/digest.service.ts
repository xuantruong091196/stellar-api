import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../notifications/email.service';
import { TrendInsightService } from './trend-insight.service';

/**
 * Weekly trend insights digest. Every Monday 09:00 UTC, emails the current
 * window's top-5 ranked insights to every store with a valid email address.
 *
 * Why sendRaw (not the typed notification system): a digest is a simple
 * HTML email that doesn't fit the per-event NotificationType taxonomy. Using
 * sendRaw keeps blast radius small — no new NotificationType, no changes to
 * EVENT_CATEGORY_MAP / EVENT_PRIORITY_MAP. If digests later need
 * per-category routing / priority, promote to a typed notification then.
 *
 * v1 scope:
 *   * Same global top-5 to every merchant (no per-niche personalization —
 *     Open Question #8 "how to derive a merchant's niches" is still open).
 *     The dashboard widget can do per-niche filtering; the digest is the
 *     "here's what's hot across POD right now" broadcast.
 *   * No opt-out yet. v2: add a StoreSettings.weeklyDigest flag + unsubscribe
 *     link. For now, dev/test stores are excluded to avoid spamming fixtures.
 *   * Cold start: if there are 0 insights this window, NO email is sent.
 *   * Per-store email failure is logged, never aborts the cron.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly insights: TrendInsightService,
  ) {}

  /** Monday 09:00 UTC. */
  @Cron('0 9 * * 1')
  async sendWeeklyDigest(): Promise<void> {
    try {
      const result = await this.runDigest();
      this.logger.log(
        `Weekly trend digest: ${result.insights} insights → ${result.sent}/${result.recipients} emails sent (${result.failed} failed, ${result.skipped} skipped no-insights)`,
      );
    } catch (err) {
      this.logger.error(
        `Weekly trend digest failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Public so admin endpoints / tests can trigger a one-off run. Returns
   * counts for verification.
   */
  async runDigest(): Promise<{
    insights: number;
    recipients: number;
    sent: number;
    failed: number;
    skipped: number;
  }> {
    const topInsights = await this.insights.getInsights({ limit: 5 });
    if (topInsights.length === 0) {
      this.logger.log('No insights this window — skipping digest entirely');
      return { insights: 0, recipients: 0, sent: 0, failed: 0, skipped: 1 };
    }

    const stores = await this.prisma.store.findMany({
      where: {
        email: { not: '' },
        plan: { notIn: ['dev'] }, // exclude docker-compose dev fixtures
      },
      select: { id: true, name: true, email: true },
    });

    const html = this.renderDigestHtml(topInsights);
    const subject = `Trending in POD this week — ${topInsights.length} insights`;

    let sent = 0;
    let failed = 0;
    for (const store of stores) {
      try {
        const res = await this.email.sendRaw({
          to: store.email,
          subject,
          html,
        });
        if (res.sent) sent++;
        else {
          failed++;
          this.logger.warn(
            `Digest not sent to ${store.email}: ${res.reason ?? 'unknown'}`,
          );
        }
      } catch (err) {
        failed++;
        this.logger.warn(
          `Digest email error for ${store.email}: ${(err as Error).message}`,
        );
      }
    }

    return {
      insights: topInsights.length,
      recipients: stores.length,
      sent,
      failed,
      skipped: 0,
    };
  }

  /**
   * Minimal inline-styled HTML. No external CSS, no images — keeps it out
   * of spam folders and renders in every client. Each insight is one row
   * with niche, style tag, price band, score, and a sample listing title.
   */
  private renderDigestHtml(
    insights: Awaited<ReturnType<TrendInsightService['getInsights']>>,
  ): string {
    const rows = insights
      .map((i, idx) => {
        const priceBand = `$${i.priceBandLow.toFixed(0)}–$${i.priceBandHigh.toFixed(0)}`;
        const sample = i.topEvidenceKeyword
          ? `<span style="color:#666;font-style:italic;">e.g. "${escapeHtml(i.topEvidenceKeyword)}"</span>`
          : '';
        return `
          <tr style="border-bottom:1px solid #eee;">
            <td style="padding:8px 12px;font-weight:bold;color:#999;">${idx + 1}</td>
            <td style="padding:8px 12px;">
              <strong>${escapeHtml(i.niche)}</strong> &middot; ${escapeHtml(i.styleTag)}
              <br/><span style="color:#888;font-size:13px;">${priceBand} &middot; score ${i.score.toFixed(0)}/100</span>
              ${sample ? `<br/>${sample}` : ''}
            </td>
          </tr>`;
      })
      .join('');

    return `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;">
        <h2 style="color:#222;">Trending in print-on-demand this week</h2>
        <p style="color:#555;">Here are the top ${insights.length} trend signals our system picked up across social platforms and marketplaces. Pick one, hit "Generate design with this trend" in your dashboard, and ride the wave.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          ${rows}
        </table>
        <p style="color:#999;font-size:12px;margin-top:24px;">
          Sent by Stelo. Trend insights refresh hourly; this digest is weekly.
        </p>
      </div>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
