// @vitest-environment node

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FileService } from '../../src/main/files';
import {
  MediaRegistry,
  registerMediaProtocol,
  registerPrivilegedMediaScheme,
} from '../../src/main/media';

describe('controlled media access', () => {
  let directory: string;
  let avatarsDirectory: string;
  let inputDirectory: string;
  let outputDirectory: string;
  let outsideDirectory: string;
  let registry: MediaRegistry;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-media-'));
    avatarsDirectory = join(directory, 'avatars');
    inputDirectory = join(directory, 'input');
    outputDirectory = join(directory, 'output');
    outsideDirectory = join(directory, 'outside');
    await Promise.all(
      [avatarsDirectory, inputDirectory, outputDirectory, outsideDirectory].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    registry = new MediaRegistry({
      avatarsDirectory,
      inputDirectory,
      outputDirectory,
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test.each([
    { root: 'avatars', filename: 'person.png' },
    { root: 'output', filename: 'result.mp4' },
  ])('issues an opaque URL only for an allowed $root file', async ({ root, filename }) => {
    const rootDirectories = {
      avatars: avatarsDirectory,
      input: inputDirectory,
      output: outputDirectory,
    } as const;
    const rootDirectory = rootDirectories[root as keyof typeof rootDirectories];
    const filePath = join(rootDirectory, filename);
    await writeFile(filePath, 'media');

    const url = await registry.createMediaUrl(filePath);

    expect(url).toMatch(/^smo-media:\/\/media\/[0-9a-f-]+$/);
    expect(url).not.toContain(filePath);
    expect(registry.resolveMediaUrl(url)).toBe(await realpath(filePath));
  });

  test.each([
    { kind: 'audio', filename: 'input-voice.mp3' },
    { kind: 'image', filename: 'input-photo.png' },
  ])('requires explicit $kind selection for a file in ComfyUI input', async ({
    kind,
    filename,
  }) => {
    const filePath = join(inputDirectory, filename);
    await writeFile(filePath, kind);
    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: false, filePaths: [filePath] });
    const service = new FileService(registry, { showOpenDialog });

    await expect(registry.createMediaUrl(filePath)).rejects.toThrow(/not allowed/i);

    if (kind === 'audio') {
      await expect(service.selectAudio()).resolves.toBe(filePath);
    } else {
      await expect(service.selectImage()).resolves.toBe(filePath);
    }
    await expect(registry.createMediaUrl(filePath)).resolves.toMatch(/^smo-media:/);
  });

  test('rejects files outside the managed roots until the user selects them', async () => {
    const audioPath = join(outsideDirectory, 'voice.mp3');
    await writeFile(audioPath, 'audio');

    await expect(registry.createMediaUrl(audioPath)).rejects.toThrow(/not allowed/i);

    await registry.authorizeSelectedFile(audioPath);
    const url = await registry.createMediaUrl(audioPath);
    expect(registry.resolveMediaUrl(url)).toBe(await realpath(audioPath));
  });

  test('rejects traversal and unsupported files even inside an allowed root', async () => {
    const privateVideo = join(outsideDirectory, 'private.mp4');
    const notes = join(outputDirectory, 'notes.txt');
    await Promise.all([writeFile(privateVideo, 'private'), writeFile(notes, 'notes')]);

    await expect(
      registry.createMediaUrl(join(outputDirectory, '..', 'outside', 'private.mp4')),
    ).rejects.toThrow(/not allowed/i);
    await expect(registry.createMediaUrl(notes)).rejects.toThrow(/extension/i);
  });

  test('serves only registered protocol tokens', async () => {
    const videoPath = join(outputDirectory, 'result.mp4');
    await writeFile(videoPath, 'video');
    const url = await registry.createMediaUrl(videoPath);
    let handler:
      | ((request: { url: string }, callback: (response: unknown) => void) => void)
      | undefined;
    const registerFileProtocol = vi.fn((scheme, callback) => {
      expect(scheme).toBe('smo-media');
      handler = callback;
      return true;
    });

    expect(registerMediaProtocol(registry, { registerFileProtocol })).toBe(true);
    const responses: unknown[] = [];
    handler?.({ url }, (response) => responses.push(response));
    handler?.({ url: 'smo-media://media/not-registered' }, (response) =>
      responses.push(response),
    );

    expect(responses).toEqual([{ path: await realpath(videoPath) }, { error: -6 }]);
  });

  test('registers a secure streaming scheme before application startup', () => {
    const registerSchemesAsPrivileged = vi.fn();

    registerPrivilegedMediaScheme({ registerSchemesAsPrivileged });

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: 'smo-media',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
        },
      },
    ]);
  });
});

describe('FileService', () => {
  test('uses native image and audio filters and authorizes the selected file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-files-'));
    const avatarsDirectory = join(directory, 'avatars');
    const inputDirectory = join(directory, 'input');
    const outputDirectory = join(directory, 'output');
    const imagePath = join(directory, 'selected.png');
    const audioPath = join(directory, 'selected.mp3');
    await Promise.all([writeFile(imagePath, 'image'), writeFile(audioPath, 'audio')]);
    const registry = new MediaRegistry({
      avatarsDirectory,
      inputDirectory,
      outputDirectory,
    });
    const showOpenDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [imagePath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [audioPath] });
    const service = new FileService(registry, { showOpenDialog });

    try {
      await expect(service.selectImage()).resolves.toBeNull();
      await expect(service.selectImage()).resolves.toBe(imagePath);
      await expect(service.selectAudio()).resolves.toBe(audioPath);
      await expect(registry.createMediaUrl(imagePath)).resolves.toMatch(/^smo-media:/);
      await expect(registry.createMediaUrl(audioPath)).resolves.toMatch(/^smo-media:/);

      expect(showOpenDialog.mock.calls[0][0].filters[0].extensions).toEqual([
        'png',
        'jpg',
        'jpeg',
        'webp',
      ]);
      expect(showOpenDialog.mock.calls[2][0].filters[0].extensions).toEqual([
        'wav',
        'mp3',
        'flac',
        'ogg',
        'm4a',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
