// @vitest-environment node

import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { AvatarService } from '../../src/main/avatars';
import { FileService, type FileDialog } from '../../src/main/files';
import { MediaRegistry } from '../../src/main/media';
import { Store } from '../../src/main/store';

describe('AvatarService', () => {
  let directory: string;
  let avatarsDirectory: string;
  let store: Store;
  let service: AvatarService;
  let registry: MediaRegistry;
  let showOpenDialog: Mock<FileDialog['showOpenDialog']>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-avatars-'));
    avatarsDirectory = join(directory, 'managed-avatars');
    store = new Store(':memory:');
    registry = new MediaRegistry({
      avatarsDirectory,
      outputDirectory: join(directory, 'output'),
    });
    showOpenDialog = vi.fn<FileDialog['showOpenDialog']>();
    service = new AvatarService({ avatarsDirectory, store, mediaRegistry: registry });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('copies a photo to a UUID file and returns the avatar saved in Store', async () => {
    const source = join(directory, 'portrait.PNG');
    await writeFile(source, 'portrait-image-data');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    const files = new FileService(registry, { showOpenDialog });

    await expect(files.selectImage()).resolves.toBe(source);

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
    const mediaUrl = await registry.createMediaUrl(avatar.photoPath);
    expect(registry.resolveMediaUrl(mediaUrl)).toBe(await realpath(avatar.photoPath));
  });

  test('rejects an existing image that was not explicitly selected without copying it', async () => {
    const source = join(directory, 'private.png');
    await writeFile(source, 'private-image-data');

    await expect(
      service.createAvatar({ name: 'Presenter', photoPath: source }),
    ).rejects.toThrow(/selectImage/i);

    expect(store.listAvatars()).toEqual([]);
    await expect(readdir(avatarsDirectory)).rejects.toThrow();
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
