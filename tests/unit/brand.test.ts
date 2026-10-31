// @vitest-environment node

import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const iconPath = fileURLToPath(new URL('../../public/brand/icon.png', import.meta.url));

interface RawIcon {
  data: Buffer;
  info: {
    width: number;
    height: number;
    channels: number;
  };
}

async function readRawIcon(): Promise<RawIcon> {
  const { data, info } = await sharp(iconPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

function alphaAt(icon: RawIcon, x: number, y: number): number {
  const { width, channels } = icon.info;
  return icon.data[(y * width + x) * channels + channels - 1];
}

describe('brand icon transparency', () => {
  test('is a 512x512 RGBA image', async () => {
    const icon = await readRawIcon();
    expect(icon.info.width).toBe(512);
    expect(icon.info.height).toBe(512);
    expect(icon.info.channels).toBe(4);
  });

  test('has fully transparent corners from the circular mask', async () => {
    const icon = await readRawIcon();
    const { width, height } = icon.info;
    const corners: Array<[number, number]> = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ];
    for (const [x, y] of corners) {
      expect(alphaAt(icon, x, y)).toBe(0);
    }
  });

  test('keeps the logo visible at the center', async () => {
    const icon = await readRawIcon();
    const { width, height } = icon.info;
    const centerAlpha = alphaAt(icon, Math.floor(width / 2), Math.floor(height / 2));
    expect(centerAlpha).toBeGreaterThan(0);
  });

  test('has a reasonable share of opaque pixels', async () => {
    const icon = await readRawIcon();
    const { width, height, channels } = icon.info;
    let opaque = 0;
    for (let i = channels - 1; i < icon.data.length; i += channels) {
      if (icon.data[i] > 0) {
        opaque += 1;
      }
    }
    const share = opaque / (width * height);
    // A full square would be 1; a circle inscribed in the square is ~0.785.
    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.95);
  });
});
