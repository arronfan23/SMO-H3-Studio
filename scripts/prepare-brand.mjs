import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const brandDirectory = join(projectRoot, 'resources/brand');
const publicBrandDirectory = join(projectRoot, 'public/brand');

await mkdir(brandDirectory, { recursive: true });
await mkdir(publicBrandDirectory, { recursive: true });

const ICON_SIZE = 512;

// Circular mask: white inscribed circle on a transparent background.
// Composited with `dest-in` so only the circle keeps the source pixels.
const mask = await sharp({
  create: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    {
      input: Buffer.from(
        `<svg width="${ICON_SIZE}" height="${ICON_SIZE}">` +
          `<circle cx="${ICON_SIZE / 2}" cy="${ICON_SIZE / 2}" r="${ICON_SIZE / 2}" ` +
          `fill="#ffffff"/></svg>`,
      ),
    },
  ])
  .png()
  .toBuffer();

const png = await sharp(join(brandDirectory, 'logo-original.jpg'))
  .resize({ width: ICON_SIZE, height: ICON_SIZE, fit: 'cover' })
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer();
const ico = await pngToIco(png);

await Promise.all([
  writeFile(join(brandDirectory, 'icon.png'), png),
  writeFile(join(brandDirectory, 'icon.ico'), ico),
  writeFile(join(publicBrandDirectory, 'icon.png'), png),
]);
