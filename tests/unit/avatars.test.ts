// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
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
    const files = new FileService({ mediaRegistry: registry, dialog: { showOpenDialog }, outputDirectory: join(directory, 'output'), dataDirectory: directory });

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

  test('导入 managed 输出图像会复制独立资产，重复导入生成不同 UUID', async () => {
    const outputDirectory = join(directory, 'output', 'SMO-Image');
    const source = join(outputDirectory, 'generated.png');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(source, 'generated-image-data');

    const first = await service.createAvatar({ name: 'Generated', photoPath: source });
    const second = await service.createAvatar({ name: 'Generated', photoPath: source });

    expect(first.id).not.toBe(second.id);
    expect(first.photoPath).not.toBe(second.photoPath);
    expect(dirname(first.photoPath)).toBe(avatarsDirectory);
    expect(dirname(second.photoPath)).toBe(avatarsDirectory);
    expect(basename(first.photoPath)).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(basename(second.photoPath)).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(await readFile(first.photoPath, 'utf8')).toBe('generated-image-data');
    expect(await readFile(second.photoPath, 'utf8')).toBe('generated-image-data');
    expect(await readFile(source, 'utf8')).toBe('generated-image-data');
    expect(store.listAvatars()).toHaveLength(2);

    await writeFile(first.photoPath, 'changed-copy');
    expect(await readFile(source, 'utf8')).toBe('generated-image-data');
    expect(await readFile(second.photoPath, 'utf8')).toBe('generated-image-data');
  });

  test('根外图片导入仍需显式选择，否则不复制资产', async () => {
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

  test('renames an avatar through the real service and Store', async () => {
    const source = join(directory, 'portrait.png');
    await writeFile(source, 'portrait');
    await registry.authorizeSelectedImage(source);
    const avatar = await service.createAvatar({ name: 'Before', photoPath: source });

    const updated = await service.updateAvatar(avatar.id, { name: '  After  ' });

    expect(updated).toEqual({ ...avatar, name: 'After' });
    expect(store.listAvatars()).toEqual([updated]);
  });

  test('deletes only the managed photo and preserves its directory and sibling files', async () => {
    const source = join(directory, 'portrait.png');
    await writeFile(source, 'portrait');
    await registry.authorizeSelectedImage(source);
    const avatar = await service.createAvatar({ name: 'Disposable', photoPath: source });
    const sibling = join(avatarsDirectory, 'unrelated.png');
    await writeFile(sibling, 'keep-me');

    await service.deleteAvatar(avatar.id);

    expect(store.listAvatars()).toEqual([]);
    await expect(readFile(avatar.photoPath, 'utf8')).rejects.toThrow();
    expect(await readFile(sibling, 'utf8')).toBe('keep-me');
    expect(await readdir(avatarsDirectory)).toEqual(['unrelated.png']);
  });

  test('refuses deletion when works reference the avatar and keeps the photo', async () => {
    const source = join(directory, 'portrait.png');
    await writeFile(source, 'portrait');
    await registry.authorizeSelectedImage(source);
    const avatar = await service.createAvatar({ name: 'Referenced', photoPath: source });
    const work = store.addWork({
      id: 'work-1',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'failed',
    });

    await expect(service.deleteAvatar(avatar.id)).rejects.toThrow(
      /cannot be deleted while works exist/i,
    );

    expect(store.listAvatars()).toEqual([avatar]);
    expect(store.getWork(work.id)).toEqual(work);
    expect(await readFile(avatar.photoPath, 'utf8')).toBe('portrait');
  });

  test('never removes a directory even if a stored photo path points to one', async () => {
    await mkdir(avatarsDirectory, { recursive: true });
    const avatar = store.createAvatar({
      name: 'Invalid path',
      photoPath: avatarsDirectory,
    });

    await expect(service.deleteAvatar(avatar.id)).rejects.toThrow(
      /photo is not a file/i,
    );

    expect(store.listAvatars()).toEqual([avatar]);
    expect(await readdir(avatarsDirectory)).toEqual([]);
  });
});
