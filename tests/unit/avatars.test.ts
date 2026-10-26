// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AvatarService } from '../../src/main/avatars';
import { Store } from '../../src/main/store';

describe('AvatarService', () => {
  let directory: string;
  let avatarsDirectory: string;
  let store: Store;
  let service: AvatarService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-avatars-'));
    avatarsDirectory = join(directory, 'managed-avatars');
    store = new Store(':memory:');
    service = new AvatarService({ avatarsDirectory, store });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('copies a photo to a UUID file and returns the avatar saved in Store', async () => {
    const source = join(directory, 'portrait.PNG');
    await writeFile(source, 'portrait-image-data');

    const avatar = await service.createAvatar({
      name: '  薄荷主播  ',
      photoPath: source,
    });

    expect(avatar.name).toBe('薄荷主播');
    expect(dirname(avatar.photoPath)).toBe(avatarsDirectory);
    expect(basename(avatar.photoPath)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
    );
    expect(await readFile(avatar.photoPath, 'utf8')).toBe('portrait-image-data');
    expect(store.listAvatars()).toEqual([avatar]);
  });

  test.each(['.gif', '.txt', ''])('rejects unsupported image extension %s', async (extension) => {
    const source = join(directory, `portrait${extension}`);
    await writeFile(source, 'not-an-avatar');

    await expect(
      service.createAvatar({ name: 'Presenter', photoPath: source }),
    ).rejects.toThrow(/image extension/i);
    expect(store.listAvatars()).toEqual([]);
  });

  test('rejects a blank name before copying the image', async () => {
    const source = join(directory, 'portrait.jpg');
    await writeFile(source, 'portrait');

    await expect(
      service.createAvatar({ name: '   ', photoPath: source }),
    ).rejects.toThrow(/name/i);
    expect(store.listAvatars()).toEqual([]);
    await expect(readdir(avatarsDirectory)).rejects.toThrow();
  });

  test.each([
    { scenario: 'relative', path: 'portrait.png' },
    { scenario: 'missing', path: 'missing.png' },
  ])('rejects a $scenario image path', async ({ scenario, path }) => {
    const photoPath = scenario === 'missing' ? join(directory, path) : path;

    await expect(
      service.createAvatar({ name: 'Presenter', photoPath }),
    ).rejects.toThrow(/image (?:path|file)/i);
    expect(store.listAvatars()).toEqual([]);
  });
});
