// @vitest-environment node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../../src/main/store';
import { WorkService, type WorkServiceOptions } from '../../src/main/works';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const execFileMock = vi.mocked(execFile);

interface ExecFileOptions {
  env?: NodeJS.ProcessEnv;
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockExecFile(
  handler: (file: string, args: string[], options: ExecFileOptions) => void | Promise<void>,
): void {
  execFileMock.mockImplementation(
    ((file: string, args: string[], options: ExecFileOptions, callback: ExecFileCallback) => {
      Promise.resolve()
        .then(() => handler(file, args, options))
        .then(
          () => callback(null, '', ''),
          (error: unknown) => callback(error as Error, '', ''),
        );
      return undefined;
    }) as unknown as typeof execFile,
  );
}

function parseDeletePaths(options: ExecFileOptions): string[] {
  return JSON.parse(options.env?.SMO_WORK_DELETE_PATHS ?? '[]') as string[];
}

beforeEach(() => {
  execFileMock.mockReset();
  // Keep the suite off real PowerShell processes; the handle-deletion sample
  // test opts back into the real implementation explicitly.
  mockExecFile(async (_file, _args, options) => {
    await Promise.all(parseDeletePaths(options).map((filePath) => rm(filePath, { force: true })));
  });
});

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
  test.each([
    { mode: 'speech' as const, extension: 'wav' },
    { mode: 'speech' as const, extension: 'mp3' },
    { mode: 'speech' as const, extension: 'flac' },
    { mode: 'speech' as const, extension: 'm4a' },
    { mode: 'image' as const, extension: 'png' },
    { mode: 'image' as const, extension: 'jpg' },
    { mode: 'image' as const, extension: 'jpeg' },
    { mode: 'image' as const, extension: 'webp' },
  ])('deletes a $mode 作品 with .$extension media without touching source files', async ({
    mode,
    extension,
  }) => {
    const { directory, outputDirectory, store, service } = await createHarness();
    const workId = `${mode}-${extension}`;
    const outputPath = join(outputDirectory, `${workId}.${extension}`);
    const associatedAsset = join(outputDirectory, `${workId}_cover.png`);
    const referenceMedia = join(directory, `reference.${extension}`);
    const avatarPhoto = join(directory, 'photo.png');
    await Promise.all(
      [outputPath, associatedAsset, referenceMedia, avatarPhoto].map(async (filePath) =>
        writeFile(filePath, 'media'),
      ),
    );
    store.addWork({
      id: workId,
      avatarId: null,
      mode,
      outputPath,
      status: 'done',
    });

    await service.deleteWork(workId);

    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(associatedAsset)).toBe(false);
    expect(existsSync(referenceMedia)).toBe(true);
    expect(existsSync(avatarPhoto)).toBe(true);
    expect(store.getWork(workId)).toBeNull();
  });

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

  test('deletes a failed work record with a null output path when no output matches', async () => {
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

  test.each([
    {
      mode: 'text' as const,
      subdirectory: 'SMO-H3',
      extension: 'mp4',
      associatedExtension: 'png',
      disallowedExtension: 'mp3',
    },
    {
      mode: 'audio' as const,
      subdirectory: 'SMO-H3',
      extension: 'webm',
      associatedExtension: 'jpg',
      disallowedExtension: 'wav',
    },
    {
      mode: 'image' as const,
      subdirectory: 'SMO-Image',
      extension: 'png',
      associatedExtension: 'webp',
      disallowedExtension: 'mp4',
    },
    {
      mode: 'speech' as const,
      subdirectory: 'SMO-Speech',
      extension: 'wav',
      associatedExtension: 'm4a',
      disallowedExtension: 'png',
    },
  ])(
    'deletes real $mode output for a failed work with a null output path only in $subdirectory',
    async ({ mode, subdirectory, extension, associatedExtension, disallowedExtension }) => {
      const { directory, outputDirectory, store, service, avatarId } = await createHarness();
      const workId = `failed-${mode}`;
      const modeDirectory = join(outputDirectory, subdirectory);
      const otherModeDirectory = join(
        outputDirectory,
        subdirectory === 'SMO-H3' ? 'SMO-Image' : 'SMO-H3',
      );
      const nestedDirectory = join(modeDirectory, `${workId}_nested`);
      const outputPath = join(modeDirectory, `${workId}.${extension}`);
      const associatedAsset = join(
        modeDirectory,
        `${workId}_asset.${associatedExtension}`,
      );
      const disallowedAsset = join(
        modeDirectory,
        `${workId}_asset.${disallowedExtension}`,
      );
      const otherWorkOutput = join(modeDirectory, `other-${mode}.${extension}`);
      const similarlyNamedFile = join(modeDirectory, `${workId}-other.${extension}`);
      const rootCandidate = join(outputDirectory, `${workId}.${extension}`);
      const otherModeCandidate = join(otherModeDirectory, `${workId}.${extension}`);
      const nestedCandidate = join(nestedDirectory, `${workId}.${extension}`);
      const referenceMedia = join(directory, `${workId}.${extension}`);
      await Promise.all([
        mkdir(modeDirectory, { recursive: true }),
        mkdir(otherModeDirectory, { recursive: true }),
        mkdir(nestedDirectory, { recursive: true }),
      ]);
      await Promise.all(
        [
          outputPath,
          associatedAsset,
          disallowedAsset,
          otherWorkOutput,
          similarlyNamedFile,
          rootCandidate,
          otherModeCandidate,
          nestedCandidate,
          referenceMedia,
        ].map(async (filePath) => writeFile(filePath, 'media')),
      );
      store.addWork({
        id: workId,
        avatarId,
        mode,
        outputPath: null,
        status: 'failed',
      });

      await service.deleteWork(workId);

      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(associatedAsset)).toBe(false);
      expect(existsSync(disallowedAsset)).toBe(true);
      expect(existsSync(otherWorkOutput)).toBe(true);
      expect(existsSync(similarlyNamedFile)).toBe(true);
      expect(existsSync(rootCandidate)).toBe(true);
      expect(existsSync(otherModeCandidate)).toBe(true);
      expect(existsSync(nestedCandidate)).toBe(true);
      expect(existsSync(referenceMedia)).toBe(true);
      expect(store.getWork(workId)).toBeNull();
    },
  );

  test('refuses failed null-output image candidates outside the real output root', async () => {
    const { directory, outputDirectory, store, service } = await createHarness();
    const workId = 'failed-outside-image';
    const outsideDirectory = join(directory, 'outside-image');
    const outsideImage = join(outsideDirectory, `${workId}_00001.png`);
    await mkdir(outsideDirectory);
    await writeFile(outsideImage, 'image');
    await symlink(
      outsideDirectory,
      join(outputDirectory, 'SMO-Image'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    store.addWork({
      id: workId,
      avatarId: null,
      mode: 'image',
      outputPath: null,
      status: 'failed',
    });

    await expect(service.deleteWork(workId)).rejects.toThrow(/output directory/i);

    expect(existsSync(outsideImage)).toBe(true);
    expect(store.getWork(workId)).not.toBeNull();
  });

  test('refuses a symbolic failed null-output speech candidate without deleting other assets', async () => {
    const { directory, outputDirectory, store, service } = await createHarness();
    const workId = 'failed-linked-speech';
    const speechDirectory = join(outputDirectory, 'SMO-Speech');
    const outputPath = join(speechDirectory, `${workId}.wav`);
    const linkedAsset = join(speechDirectory, `${workId}_linked.mp3`);
    const outsideDirectory = join(directory, 'outside-speech');
    const outsideAsset = join(outsideDirectory, 'source.mp3');
    await mkdir(speechDirectory);
    await mkdir(outsideDirectory);
    await writeFile(outputPath, 'audio');
    await writeFile(outsideAsset, 'source');
    await symlink(
      outsideDirectory,
      linkedAsset,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    store.addWork({
      id: workId,
      avatarId: null,
      mode: 'speech',
      outputPath: null,
      status: 'failed',
    });

    await expect(service.deleteWork(workId)).rejects.toThrow(/symbolic link|regular file/i);

    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(linkedAsset)).toBe(true);
    expect(existsSync(outsideAsset)).toBe(true);
    expect(store.getWork(workId)).not.toBeNull();
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

  test.each([
    { mode: 'speech' as const, extension: 'wav' },
    { mode: 'image' as const, extension: 'png' },
  ])('refuses a symbolic $mode 作品 output without deleting its target', async ({
    mode,
    extension,
  }) => {
    const { directory, outputDirectory, store, service } = await createHarness();
    const workId = `linked-${mode}`;
    const outsideDirectory = join(directory, `${mode}-outside`);
    const outsideTarget = join(outsideDirectory, `source.${extension}`);
    const outputPath = join(outputDirectory, `${workId}.${extension}`);
    await mkdir(outsideDirectory);
    await writeFile(outsideTarget, 'source');
    await symlink(
      outsideDirectory,
      outputPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    store.addWork({ id: workId, avatarId: null, mode, outputPath, status: 'done' });

    await expect(service.deleteWork(workId)).rejects.toThrow(
      /symbolic link|regular (?:audio|image) file/i,
    );

    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(outsideTarget)).toBe(true);
    expect(store.getWork(workId)).not.toBeNull();
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

  test.each([
    { mode: 'speech' as const, extension: 'mp3' },
    { mode: 'image' as const, extension: 'webp' },
  ])('refuses a $mode 作品 output outside the output directory', async ({
    mode,
    extension,
  }) => {
    const { directory, store, service } = await createHarness();
    const workId = `outside-${mode}`;
    const outputPath = join(directory, `${workId}.${extension}`);
    await writeFile(outputPath, 'media');
    store.addWork({ id: workId, avatarId: null, mode, outputPath, status: 'done' });

    await expect(service.deleteWork(workId)).rejects.toThrow(/output directory/i);

    expect(existsSync(outputPath)).toBe(true);
    expect(store.getWork(workId)).not.toBeNull();
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

  test.each([
    { mode: 'speech' as const, filename: 'speech.mp4', message: /audio/i },
    { mode: 'image' as const, filename: 'image.mp3', message: /image/i },
  ])('refuses media with the wrong extension for a $mode 作品', async ({
    mode,
    filename,
    message,
  }) => {
    const { outputDirectory, store, service } = await createHarness();
    const outputPath = join(outputDirectory, filename);
    await writeFile(outputPath, 'wrong media type');
    store.addWork({ id: mode, avatarId: null, mode, outputPath, status: 'done' });

    await expect(service.deleteWork(mode)).rejects.toThrow(message);

    expect(existsSync(outputPath)).toBe(true);
    expect(store.getWork(mode)).not.toBeNull();
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

  test('keeps the record and remaining assets when a subsidiary removal fails, then retry finishes cleanup', async () => {
    const failure = new Error('asset still locked');
    let removalCalls = 0;
    let failOnCall: number | null = 2;
    const removeFile: NonNullable<WorkServiceOptions['removeFile']> = async (
      filePath,
      options,
    ) => {
      removalCalls += 1;
      if (failOnCall !== null && removalCalls === failOnCall) {
        throw failure;
      }
      await rm(filePath, options);
    };
    const { outputDirectory, store, service, avatarId } = await createHarness(removeFile);
    const workId = 'partial-cleanup';
    const videoPath = join(outputDirectory, `${workId}.mp4`);
    const imageAsset = join(outputDirectory, `${workId}.png`);
    const audioAsset = join(outputDirectory, `${workId}_voice.mp3`);
    await writeFile(videoPath, 'video');
    await writeFile(imageAsset, 'image');
    await writeFile(audioAsset, 'audio');
    const done = store.addWork({
      id: workId,
      avatarId,
      mode: 'text',
      outputPath: videoPath,
      status: 'done',
    });

    await expect(service.deleteWork(done.id)).rejects.toBe(failure);
    // The main video was already removed; the failed subsidiary and everything
    // after it must stay untouched, and the record must survive.
    expect(existsSync(videoPath)).toBe(false);
    expect(existsSync(imageAsset) || existsSync(audioAsset)).toBe(true);
    expect(store.getWork(done.id)).not.toBeNull();

    failOnCall = null;
    await service.deleteWork(done.id);

    expect(existsSync(imageAsset)).toBe(false);
    expect(existsSync(audioAsset)).toBe(false);
    expect(store.getWork(done.id)).toBeNull();
  });

  test('refuses an output whose parent directory is a junction escaping the output directory', async () => {
    const { directory, outputDirectory, store, service, avatarId } = await createHarness();
    const outsideDirectory = join(directory, 'outside-target');
    await mkdir(outsideDirectory);
    const outsideVideo = join(outsideDirectory, 'junction-work.mp4');
    await writeFile(outsideVideo, 'video');
    const junctionDirectory = join(outputDirectory, 'via-junction');
    await symlink(
      outsideDirectory,
      junctionDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const work = store.addWork({
      id: 'junction-work',
      avatarId,
      mode: 'text',
      outputPath: join(junctionDirectory, 'junction-work.mp4'),
      status: 'done',
    });

    await expect(service.deleteWork(work.id)).rejects.toThrow(/output directory/i);
    expect(existsSync(outsideVideo)).toBe(true);
    expect(store.getWork(work.id)).not.toBeNull();
  });

  test.skipIf(process.platform !== 'win32')(
    'passes every validated asset to a single PowerShell handle-delete process via the environment',
    async () => {
      const { outputDirectory, store, service, avatarId } = await createHarness();
      const workId = 'handle-wire';
      const videoPath = join(outputDirectory, `${workId}.mp4`);
      const assetPath = join(outputDirectory, `${workId}_cover.png`);
      await writeFile(videoPath, 'video');
      await writeFile(assetPath, 'image');
      const done = store.addWork({
        id: workId,
        avatarId,
        mode: 'text',
        outputPath: videoPath,
        status: 'done',
      });
      const invocations: Array<{ file: string; args: string[]; options: ExecFileOptions }> = [];
      mockExecFile((file, args, options) => {
        invocations.push({ file, args, options });
      });

      await service.deleteWork(done.id);

      expect(invocations).toHaveLength(1);
      const [{ file, args, options }] = invocations;
      expect(file).toBe('powershell.exe');
      expect(args).toContain('-NoProfile');
      const script = args[args.indexOf('-Command') + 1];
      expect(script).toMatch(/SetFileInformationByHandle/);
      expect(script).toMatch(/GetFinalPathNameByHandle/);
      // Paths must travel through the environment, never inside the command.
      expect(script).not.toContain(videoPath);
      expect(script).not.toContain(options.env?.SMO_WORK_DELETE_ROOT ?? '');
      expect(parseDeletePaths(options).sort()).toEqual([videoPath, assetPath].sort());
      expect(typeof options.env?.SMO_WORK_DELETE_ROOT).toBe('string');
      expect(store.getWork(done.id)).toBeNull();
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'refuses to delete when the parent directory is swapped for an outside junction after validation',
    async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      const realExecFile = actual.execFile as unknown as (
        file: string,
        args: string[],
        options: ExecFileOptions,
        callback: ExecFileCallback,
      ) => unknown;
      const { directory, outputDirectory, store, service, avatarId } = await createHarness();
      const workId = 'swap-work';
      const subDirectory = join(outputDirectory, 'sub');
      await mkdir(subDirectory);
      const videoPath = join(subDirectory, `${workId}.mp4`);
      await writeFile(videoPath, 'video');
      const outsideDirectory = join(directory, 'outside-swap');
      await mkdir(outsideDirectory);
      const outsideVideo = join(outsideDirectory, `${workId}.mp4`);
      await writeFile(outsideVideo, 'must survive');
      const done = store.addWork({
        id: workId,
        avatarId,
        mode: 'text',
        outputPath: videoPath,
        status: 'done',
      });
      execFileMock.mockImplementation(
        ((file: string, args: string[], options: ExecFileOptions, callback: ExecFileCallback) => {
          void (async () => {
            // Validation has already passed at this point; swap the parent for
            // a junction moments before the real process opens the file.
            await rename(subDirectory, `${subDirectory}-real`);
            await symlink(outsideDirectory, subDirectory, 'junction');
            realExecFile(file, args, options, callback);
          })().catch((error: unknown) => callback(error as Error, '', ''));
          return undefined;
        }) as unknown as typeof execFile,
      );

      await expect(service.deleteWork(done.id)).rejects.toThrow(/escapes|outside|root/i);
      expect(existsSync(outsideVideo)).toBe(true);
      expect(store.getWork(done.id)).not.toBeNull();
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'keeps the work record and files when handle deletion fails',
    async () => {
      const { outputDirectory, store, service, avatarId } = await createHarness();
      const videoPath = join(outputDirectory, 'handle-failure.mp4');
      await writeFile(videoPath, 'video');
      const done = store.addWork({
        id: 'handle-failure',
        avatarId,
        mode: 'text',
        outputPath: videoPath,
        status: 'done',
      });
      mockExecFile(() => {
        throw new Error('SetFileInformationByHandle denied');
      });

      await expect(service.deleteWork(done.id)).rejects.toThrow(/denied/i);
      expect(existsSync(videoPath)).toBe(true);
      expect(store.getWork(done.id)).not.toBeNull();
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'deletes files through open handles, including paths with spaces and CJK characters',
    async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
      execFileMock.mockImplementation(actual.execFile);
      const { outputDirectory, store, service, avatarId } = await createHarness();
      const workId = 'handle-sample';
      const nested = join(outputDirectory, '子 目录 素材');
      await mkdir(nested);
      const videoPath = join(nested, `${workId}.mp4`);
      const assetPath = join(nested, `${workId}_封面 图.png`);
      await writeFile(videoPath, 'video');
      await writeFile(assetPath, 'image');
      const done = store.addWork({
        id: workId,
        avatarId,
        mode: 'text',
        outputPath: videoPath,
        status: 'done',
      });

      await service.deleteWork(done.id);

      expect(existsSync(videoPath)).toBe(false);
      expect(existsSync(assetPath)).toBe(false);
      expect(store.getWork(done.id)).toBeNull();
    },
  );

  test('rejects deleting an unknown work', async () => {
    const { service } = await createHarness();

    await expect(service.deleteWork('missing')).rejects.toThrow(/not found/i);
  });
});
