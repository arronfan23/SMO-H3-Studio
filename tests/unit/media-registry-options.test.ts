// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MediaRegistry } from '../../src/main/media';

describe('MediaRegistry managed image authorization', () => {
  let directory: string;
  let outputDirectory: string;
  let registry: MediaRegistry;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-managed-images-'));
    outputDirectory = join(directory, 'output');
    await mkdir(join(outputDirectory, 'SMO-Image'), { recursive: true });
    registry = new MediaRegistry({
      avatarsDirectory: join(directory, 'avatars'),
      outputDirectory,
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('managed 输出图像与 isSelectedFile 一样无需显式选择', async () => {
    const source = join(outputDirectory, 'SMO-Image', 'generated.png');
    await writeFile(source, 'generated-image');

    await expect(registry.isSelectedFile(source)).resolves.toBe(true);
    await expect(registry.isSelectedImage(source)).resolves.toBe(true);
  });

  test('managed roots 不授权根外图片，显式选择后才可用', async () => {
    const source = join(directory, 'outside.png');
    await writeFile(source, 'outside-image');

    await expect(registry.isSelectedImage(source)).resolves.toBe(false);
    await registry.authorizeSelectedImage(source);
    await expect(registry.isSelectedImage(source)).resolves.toBe(true);
  });
});
