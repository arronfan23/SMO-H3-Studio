// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Store } from '../../src/main/store';
import { WorkService, type WorkServiceOptions } from '../../src/main/works';

interface Harness {
  directory: string;
  outputDirectory: string;
  store: Store;
  service: WorkService;
  avatarId: string;
}

const harnesses: Harness[] = [];

async function createHarness(
  removeFile?: WorkServiceOptions['removeFile'],
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-works-'));
  const outputDirectory = join(directory, 'output');
  await mkdir(outputDirectory, { recursive: true });
  const store = new Store(join(directory, 'studio.sqlite'));
  const avatar = store.createAvatar({
    name: 'Presenter',
    photoPath: join(directory, 'photo.png'),
  });
  const service = new WorkService({
    outputDirectory,
    store,
    ...(removeFile === undefined ? {} : { removeFile }),
  });
  const harness: Harness = { directory, outputDirectory, store, service, avatarId: avatar.id };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  const pending = harnesses.splice(0);
  for (const harness of pending) {
    harness.store.close();
    await rm(harness.directory, { recursive: true, force: true });
  }
});

describe('WorkService.deleteWork', () => {
  test('deletes a done work record and all associated assets, keeping unrelated files', async () => {
    const { directory, outputDirectory, store, service, avatarId } = await createHarness();
    const workId = 'done-work';
    const videoPath = join(outputDirectory, `${workId}.mp4`);
    const siblingVideo = join(outputDirectory, 'sibling.mp4');
    const sourcePhoto = join(directory, 'photo.png');
    const uploadedAsset = join(outputDirectory, 'upload.png');
    const otherWorkImage = join(outputDirectory, 'other-work.png');
    const otherWorkAudio = join(outputDirectory, 'other-work_asset.mp3');
    const similarlyNamedFile = join(outputDirectory, `${workId}-notes.png`);
    const nonAssetFile = join(outputDirectory, `${workId}_notes.txt`);
    const nestedDirectory = join(outputDirectory, `${workId}_nested`);
    const nestedAsset = join(nestedDirectory, `${workId}.png`);
    const associatedAssets = [
      join(outputDirectory, `${workId}.png`),
      ...['jpg', 'jpeg', 'webp', 'mp4', 'webm', 'gif', 'wav', 'mp3', 'flac', 'ogg', 'm4a'].map(
        (extension) => join(outputDirectory, `${workId}_asset.${extension}`),
      ),
    ];
    await writeFile(videoPath, 'video');
    await mkdir(nestedDirectory);
    await Promise.all(
      [
        siblingVideo,
        sourcePhoto,
        uploadedAsset,
        otherWorkImage,
        otherWorkAudio,
        similarlyNamedFile,
        nonAssetFile,
        nestedAsset,
        ...associatedAssets,
      ].map(async (filePath) => writeFile(filePath, 'asset')),
    );
    const done = store.addWork({
      id: workId,
      avatarId,
      mode: 'text',
      outputPath: videoPath,
      status: 'done',
    });

    await service.deleteWork(done.id);

    expect(existsSync(videoPath)).toBe(false);
    for (const assetPath of associatedAssets) {
      expect(existsSync(assetPath)).toBe(false);
    }
    expect(existsSync(sourcePhoto)).toBe(true);
    expect(existsSync(siblingVideo)).toBe(true);
    expect(existsSync(uploadedAsset)).toBe(true);
    expect(existsSync(otherWorkImage)).toBe(true);
    expect(existsSync(otherWorkAudio)).toBe(true);
    expect(existsSync(similarlyNamedFile)).toBe(true);
    expect(existsSync(nonAssetFile)).toBe(true);
    expect(existsSync(nestedAsset)).toBe(true);
    expect(store.getWork(done.id)).toBeNull();
  });

  test('deletes a failed work with a null output path', async () => {
    const { store, service, avatarId } = await createHarness();
    const failed = store.addWork({
      id: 'failed-work',
      avatarId,
      mode: 'audio',
      outputPath: null,
      status: 'failed',
    });

    await service.deleteWork(failed.id);

    expect(store.getWork(failed.id)).toBeNull();
  });

  test('deletes the record when the output file no longer exists', async () => {
    const { outputDirectory, store, service, avatarId } = await createHarness();
    const workId = 'missing-output';
    const associatedImage = join(outputDirectory, `${workId}.png`);
    await writeFile(associatedImage, 'image');
    const done = store.addWork({
      id: workId,
      avatarId,
      mode: 'text',
      outputPath: join(outputDirectory, `${workId}.mp4`),
      status: 'done',
    });

    await service.deleteWork(done.id);

    expect(existsSync(associatedImage)).toBe(false);
    expect(store.getWork(done.id)).toBeNull();
  });

  test('deletes the record when the output directory no longer exists', async () => {
    const { outputDirectory, store, service, avatarId } = await createHarness();
    const done = store.addWork({
      id: 'missing-directory',
      avatarId,
      mode: 'text',
      outputPath: join(outputDirectory, 'missing-directory.mp4'),
      status: 'done',
    });
    await rm(outputDirectory, { recursive: true, force: true });

    await service.deleteWork(done.id);

    expect(store.getWork(done.id)).toBeNull();
  });

  test('validates all associated assets before deleting any files', async () => {
    const { outputDirectory, store, service, avatarId } = await createHarness();
    const workId = 'invalid-asset';
    const videoPath = join(outputDirectory, `${workId}.mp4`);
    const associatedImage = join(outputDirectory, `${workId}.png`);
    const invalidAsset = join(outputDirectory, `${workId}_asset.png`);
    await writeFile(videoPath, 'video');
    await writeFile(associatedImage, 'image');
    await mkdir(invalidAsset);
    const done = store.addWork({
      id: workId,
      avatarId,
      mode: 'text',
      outputPath: videoPath,
      status: 'done',
    });

    await expect(service.deleteWork(done.id)).rejects.toThrow(/regular file/i);
    expect(existsSync(videoPath)).toBe(true);
    expect(existsSync(associatedImage)).toBe(true);
    expect(existsSync(invalidAsset)).toBe(true);
    expect(store.getWork(done.id)).not.toBeNull();
  });

  test('refuses an associated symbolic link without deleting the work or other assets', async () => {
    const { directory, outputDirectory, store, service, avatarId } = await createHarness();
    const workId = 'linked-asset';
    const videoPath = join(outputDirectory, `${workId}.mp4`);
    const associatedImage = join(outputDirectory, `${workId}.png`);
    const outsideDirectory = join(directory, 'outside');
    const outsideAsset = join(outsideDirectory, 'source.png');
    const linkedAsset = join(outputDirectory, `${workId}_asset.png`);
    await writeFile(videoPath, 'video');
    await writeFile(associatedImage, 'image');
    await mkdir(outsideDirectory);
    await writeFile(outsideAsset, 'source');
    await symlink(outsideDirectory, linkedAsset, process.platform === 'win32' ? 'junction' : 'dir');
    const done = store.addWork({
      id: workId,
      avatarId,
      mode: 'text',
      outputPath: videoPath,
      status: 'done',
    });

    await expect(service.deleteWork(done.id)).rejects.toThrow(/symbolic link|regular file/i);
    expect(existsSync(videoPath)).toBe(true);
    expect(existsSync(associatedImage)).toBe(true);
    expect(existsSync(linkedAsset)).toBe(true);
    expect(existsSync(outsideAsset)).toBe(true);
    expect(store.getWork(done.id)).not.toBeNull();
  });

  test.each(['pending', 'running'] as const)(
    'refuses to delete a %s work and keeps the record and video',
    async (status) => {
      const { outputDirectory, store, service, avatarId } = await createHarness();
      const videoPath = join(outputDirectory, `${status}.mp4`);
      await writeFile(videoPath, 'video');
      const work = store.addWork({
        id: `${status}-work`,
        avatarId,
        mode: 'text',
        outputPath: videoPath,
        status,
      });

      await expect(service.deleteWork(work.id)).rejects.toThrow(/completed or failed/i);
      expect(existsSync(videoPath)).toBe(true);
      expect(store.getWork(work.id)).not.toBeNull();
    },
  );

  test('refuses to delete an output outside the output directory', async () => {
    const { directory, store, service, avatarId } = await createHarness();
    const outsideVideo = join(directory, 'outside.mp4');
    await writeFile(outsideVideo, 'video');
    const outsideWork = store.addWork({
      id: 'outside-work',
      avatarId,
      mode: 'text',
      outputPath: outsideVideo,
      status: 'done',
    });

    await expect(service.deleteWork(outsideWork.id)).rejects.toThrow(/output directory/i);
    expect(existsSync(outsideVideo)).toBe(true);
    expect(store.getWork(outsideWork.id)).not.toBeNull();
  });

  test('refuses to delete an output that escapes through a parent traversal', async () => {
    const { directory, outputDirectory, store, service, avatarId } = await createHarness();
    const outsideVideo = join(directory, 'escaped.mp4');
    await writeFile(outsideVideo, 'video');
    const escaping = store.addWork({
      id: 'escaping-work',
      avatarId,
      mode: 'text',
      outputPath: join(outputDirectory, '..', 'escaped.mp4'),
      status: 'done',
    });

    await expect(service.deleteWork(escaping.id)).rejects.toThrow(/output directory/i);
    expect(existsSync(outsideVideo)).toBe(true);
    expect(store.getWork(escaping.id)).not.toBeNull();
  });

  test('refuses to delete an output path that points to a directory', async () => {
    const { outputDirectory, store, service, avatarId } = await createHarness();
    const folder = join(outputDirectory, 'clip.mp4');
    await mkdir(folder);
    const folderWork = store.addWork({
      id: 'folder-work',
      avatarId,
      mode: 'text',
      outputPath: folder,
      status: 'done',
    });

    await expect(service.deleteWork(folderWork.id)).rejects.toThrow(/regular video file/i);
    expect(existsSync(folder)).toBe(true);
    expect(store.getWork(folderWork.id)).not.toBeNull();
  });

  test('refuses to delete an output that is not an mp4 or webm video', async () => {
    const { outputDirectory, store, service, avatarId } = await createHarness();
    const textFile = join(outputDirectory, 'notes.txt');
    await writeFile(textFile, 'notes');
    const textWork = store.addWork({
      id: 'text-work',
      avatarId,
      mode: 'text',
      outputPath: textFile,
      status: 'done',
    });

    await expect(service.deleteWork(textWork.id)).rejects.toThrow(/mp4 or webm/i);
    expect(existsSync(textFile)).toBe(true);
    expect(store.getWork(textWork.id)).not.toBeNull();
  });

  test('keeps the record and video when the file removal fails', async () => {
    const failure = new Error('disk refused to delete');
    const { outputDirectory, store, service, avatarId } = await createHarness(async () => {
      throw failure;
    });
    const videoPath = join(outputDirectory, 'done.mp4');
    await writeFile(videoPath, 'video');
    const done = store.addWork({
      id: 'done-work',
      avatarId,
      mode: 'text',
      outputPath: videoPath,
      status: 'done',
    });

    await expect(service.deleteWork(done.id)).rejects.toBe(failure);
    expect(existsSync(videoPath)).toBe(true);
    expect(store.getWork(done.id)).not.toBeNull();
  });

  test('rejects deleting an unknown work', async () => {
    const { service } = await createHarness();

    await expect(service.deleteWork('missing')).rejects.toThrow(/not found/i);
  });
});
