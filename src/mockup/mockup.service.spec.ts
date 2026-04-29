import { Test } from '@nestjs/testing';
import * as sharp from 'sharp';
import { MockupService } from './mockup.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SamService } from './sam.service';

describe('MockupService.composeColorVariant', () => {
  let svc: MockupService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        MockupService,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) => ({
              'aws.s3Bucket': 'b',
              'aws.r2PublicUrl': 'https://r2.example',
              'aws.r2AccountId': 'acc',
              'aws.accessKeyId': 'k',
              'aws.secretAccessKey': 's',
            }[k]),
          },
        },
        { provide: PrismaService, useValue: {} },
        { provide: SamService, useValue: { getOrCreateMask: jest.fn() } },
      ],
    }).compile();
    svc = mod.get(MockupService);
  });

  // 200x200 mid-grey blank simulating real shirt-photo shadow (so screen-blend
  // path has actual shadow tones to lift), opaque mask in middle 100x100,
  // transparent overlay.
  const makeBlank = () =>
    sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 100, g: 100, b: 100, alpha: 1 } },
    }).png().toBuffer();

  const makeMask = () =>
    sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{
        input: Buffer.from(`<svg width="200" height="200"><rect x="50" y="50" width="100" height="100" fill="white"/></svg>`),
        blend: 'over',
      }])
      .png()
      .toBuffer();

  const makeOverlay = () =>
    sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();

  it('produces a JPEG buffer for a light target color', async () => {
    (svc as any).fetchAsBuffer = jest.fn()
      .mockImplementationOnce(makeBlank)
      .mockImplementationOnce(makeMask)
      .mockImplementationOnce(makeOverlay);
    const result = await (svc as any).composeColorVariant({
      canonicalBlankUrl: 'a',
      shirtMaskUrl: 'b',
      designOverlayUrl: 'c',
      colorHex: '#FFD1DC', // light pink
    });
    expect(Buffer.isBuffer(result)).toBe(true);
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(200);
  });

  it('produces a JPEG buffer for a dark target color (triggers screen blend path)', async () => {
    (svc as any).fetchAsBuffer = jest.fn()
      .mockImplementationOnce(makeBlank)
      .mockImplementationOnce(makeMask)
      .mockImplementationOnce(makeOverlay);
    const result = await (svc as any).composeColorVariant({
      canonicalBlankUrl: 'a',
      shirtMaskUrl: 'b',
      designOverlayUrl: 'c',
      colorHex: '#0a1f33', // dark navy → luminance ~22
    });
    expect(Buffer.isBuffer(result)).toBe(true);
    // Sample center pixel (within mask area) — should be near target navy.
    const { data } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    const w = 200;
    const ix = (100 * w + 100) * 3;
    const r = data[ix], g = data[ix + 1], b = data[ix + 2];
    // Allow generous tolerance — screen blend lifts shadow tone.
    expect(r).toBeLessThan(80);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(120);
  });

  it('skips mask path when shirtMaskUrl is null (whole image, used by SAM-failed)', async () => {
    // Note: per spec round-2, SAM-failed should NOT enter this code path —
    // generateColorVariants should short-circuit. This test guards the
    // method against null mask anyway, asserting it does not crash.
    (svc as any).fetchAsBuffer = jest.fn()
      .mockImplementationOnce(makeBlank)
      .mockImplementationOnce(makeOverlay);
    const result = await (svc as any).composeColorVariant({
      canonicalBlankUrl: 'a',
      shirtMaskUrl: null,
      designOverlayUrl: 'c',
      colorHex: '#FFD1DC',
    });
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});
