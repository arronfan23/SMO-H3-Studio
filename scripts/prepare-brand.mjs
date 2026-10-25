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

const png = await sharp(join(brandDirectory, 'logo-original.jpg'))
  .resize({ width: 512, height: 512, fit: 'inside' })
  .png()
  .toBuffer();
const ico = await pngToIco(png);

await Promise.all([
  writeFile(join(brandDirectory, 'icon.png'), png),
  writeFile(join(brandDirectory, 'icon.ico'), ico),
  writeFile(join(publicBrandDirectory, 'icon.png'), png),
]);
