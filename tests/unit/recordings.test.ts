// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_RECORDING_BYTES,
  RecordingService,
  type RecordingServiceOptions,
} from '../../src/main/recordings';
import type { AudioConverter } from '../../src/main/audio-converter';
import { MediaRegistry } from '../../src/main/media';
import { registerIpc, type IpcServices } from '../../src/main/ipc';
import { createAppServices } from '../../src/main/app-services';
import { createIpcSchema, type SmoApi } from '../../src/shared/ipc';

const { exposeInMainWorld, ipcRendererInvoke } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  ipcRendererInvoke: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(), isPackaged: false },
  contextBridge: { exposeInMainWorld },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  ipcRenderer: { invoke: ipcRendererInvoke },
  protocol: { registerFileProtocol: vi.fn(() => true) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
  shell: { openExternal: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createHarness(
  overrides: Partial<RecordingServiceOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'smo-recordings-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const recordingsDirectory = join(directory, 'recordings');
  const temporaryDirectory = join(directory, 'recording-tmp');
  const mediaRegistry = new MediaRegistry({
    avatarsDirectory: join(directory, 'avatars'),
    outputDirectory: join(directory, 'output'),
    recordingsDirectory,
  });
  const converter = vi.fn<AudioConverter>(async (input) => {
    await writeFile(input.destinationPath, 'converted wav');
  });
  const service = new RecordingService({
    recordingsDirectory,
    temporaryDirectory,
    mediaRegistry,
    ffmpegPath: () => 'G:\\runtime\\tools\\ffmpeg\\ffmpeg.exe',
    converter,
    ...overrides,
  });
  cleanups.push(() => service.close());
  return {
    converter,
    directory,
    mediaRegistry,
    recordingsDirectory,
    service,
    temporaryDirectory,
  };
}

describe('RecordingService 录音', () => {
  test('writes unique temporary WebM files and returns authorized UUID WAV outputs', async () => {
    const sourceContents: Uint8Array[] = [];
    const harness = await createHarness({
      converter: async (input) => {
        sourceContents.push(await readFile(input.sourcePath));
        await writeFile(input.destinationPath, 'converted wav');
      },
    });
    const authorize = vi.spyOn(harness.mediaRegistry, 'authorizeSelectedFile');

    const first = await harness.service.save({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm;codecs=opus',
    });
    const second = await harness.service.save({
      bytes: new Uint8Array([4, 5]),
      mimeType: 'audio/webm',
    });

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.wav$/i;
    expect(basename(first)).toMatch(uuidPattern);
    expect(basename(second)).toMatch(uuidPattern);
    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(resolve(harness.recordingsDirectory));
    expect(dirname(second)).toBe(resolve(harness.recordingsDirectory));
    expect(sourceContents.map((bytes) => Array.from(bytes))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);

    expect(harness.converter).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenNthCalledWith(1, first);
    expect(authorize).toHaveBeenNthCalledWith(2, second);
    await expect(harness.mediaRegistry.createMediaUrl(first)).resolves.toMatch(
      /^smo-media:/,
    );
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    expect((await readdir(harness.recordingsDirectory)).sort()).toEqual(
      [basename(first), basename(second)].sort(),
    );
  });

  test('passes recording WAV conversion paths, format, and runtime FFmpeg', async () => {
    const harness = await createHarness();

    const output = await harness.service.save({
      bytes: new Uint8Array([9]),
      mimeType: 'audio/webm',
    });

    expect(harness.converter).toHaveBeenCalledTimes(1);
    const input = harness.converter.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      ffmpegPath: 'G:\\runtime\\tools\\ffmpeg\\ffmpeg.exe',
      destinationPath: output,
      format: 'wav',
    });
    expect(input?.sourcePath).toMatch(/\.webm$/i);
    expect(dirname(input?.sourcePath ?? '')).toBe(
      resolve(harness.temporaryDirectory),
    );
    expect(input?.signal).toBeInstanceOf(AbortSignal);
    await expect(readFile(input?.sourcePath ?? '')).rejects.toThrow();
  });

  test('rejects empty, oversized, and non-Uint8Array recording bytes before conversion', async () => {
    const harness = await createHarness();

    await expect(
      harness.service.save({ bytes: new Uint8Array(), mimeType: 'audio/webm' }),
    ).rejects.toThrow(/empty/i);
    await expect(
      harness.service.save({
        bytes: [1] as unknown as Uint8Array,
        mimeType: 'audio/webm',
      }),
    ).rejects.toThrow(/Uint8Array/);
    await expect(
      harness.service.save({
        bytes: new Uint8Array(MAX_RECORDING_BYTES + 1),
        mimeType: 'audio/webm',
      }),
    ).rejects.toThrow(/200 MiB/i);
    expect(harness.converter).not.toHaveBeenCalled();
  });

  test('cleans temporary and partial output files when conversion fails without authorizing', async () => {
    const failure = new Error('conversion failed');
    const harness = await createHarness({
      converter: async (input) => {
        await writeFile(input.destinationPath, 'partial output');
        throw failure;
      },
    });
    const authorize = vi.spyOn(harness.mediaRegistry, 'authorizeSelectedFile');

    await expect(
      harness.service.save({
        bytes: new Uint8Array([1, 2]),
        mimeType: 'audio/webm',
      }),
    ).rejects.toBe(failure);

    expect(authorize).not.toHaveBeenCalled();
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    expect(await readdir(harness.recordingsDirectory)).toEqual([]);
  });

  test('close aborts and awaits an active conversion and cleans its files', async () => {
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await createHarness({
      converter: (input) => {
        signal = input.signal;
        markStarted();
        return new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
    });

    const pending = harness.service.save({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/webm',
    });
    await started;
    await harness.service.close();

    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    expect(await readdir(harness.recordingsDirectory)).toEqual([]);
  });

  test('close before conversion completes removes temporary WebM and partial WAV without authorizing', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const harness = await createHarness({
      converter: async (input) => {
        await writeFile(input.destinationPath, 'partial wav');
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
    });
    const authorize = vi.spyOn(harness.mediaRegistry, 'authorizeSelectedFile');
    const pending = harness.service.save({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/webm',
    });
    await started;
    const rejection = expect(pending).rejects.toThrow(/closed/i);

    await harness.service.close();
    await rejection;

    expect(authorize).not.toHaveBeenCalled();
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    expect(await readdir(harness.recordingsDirectory)).toEqual([]);
  });

  test('close after conversion while authorization is pending rejects save and awaits cleanup', async () => {
    const harness = await createHarness();
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorize = vi
      .spyOn(harness.mediaRegistry, 'authorizeSelectedFile')
      .mockImplementation(async () => {
        markAuthorizationStarted();
        await authorizationReleased;
      });
    const pending = harness.service.save({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/webm',
    });
    await authorizationStarted;
    const destinationPath =
      harness.converter.mock.calls[0]?.[0].destinationPath ?? '';
    expect(await readFile(destinationPath, 'utf8')).toBe('converted wav');
    const rejection = expect(pending).rejects.toThrow(/closed/i);
    let closeSettled = false;
    const closing = harness.service.close().then(() => {
      closeSettled = true;
    });

    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseAuthorization();
    await closing;
    await rejection;

    expect(authorize).toHaveBeenCalledWith(destinationPath);
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    expect(await readdir(harness.recordingsDirectory)).toEqual([]);
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  test('treats the recordings directory as a managed media root', async () => {
    const harness = await createHarness();
    const output = join(harness.recordingsDirectory, 'managed.wav');
    await mkdir(harness.recordingsDirectory, { recursive: true });
    await writeFile(output, 'wav');

    await expect(harness.mediaRegistry.createMediaUrl(output)).resolves.toMatch(
      /^smo-media:/,
    );
  });

  test('discard removes a recording and revokes its authorization token', async () => {
    const harness = await createHarness();
    const output = await harness.service.save({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/webm',
    });
    const url = await harness.mediaRegistry.createMediaUrl(output);
    expect(harness.mediaRegistry.resolveMediaUrl(url)).toBe(
      await realpath(output),
    );

    await harness.service.discard(output);

    await expect(readFile(output)).rejects.toThrow();
    expect(harness.mediaRegistry.resolveMediaUrl(url)).toBeNull();
  });

  test('discard refuses outside files and symlinks that escape the recordings root', async () => {
    const harness = await createHarness();
    await mkdir(harness.recordingsDirectory, { recursive: true });
    const outside = join(harness.directory, 'outside.wav');
    const link = join(harness.recordingsDirectory, 'linked.wav');
    await writeFile(outside, 'keep outside audio');
    await symlink(outside, link, 'file');
    await harness.mediaRegistry.authorizeSelectedFile(outside);
    const outsideUrl = await harness.mediaRegistry.createMediaUrl(outside);

    for (const candidate of [outside, link]) {
      await expect(harness.service.discard(candidate)).rejects.toThrow(
        /recordings directory|not allowed/i,
      );
    }

    expect(await readFile(outside, 'utf8')).toBe('keep outside audio');
    expect(harness.mediaRegistry.resolveMediaUrl(outsideUrl)).toBe(
      await realpath(outside),
    );
  });

  test('discard refuses a non-WAV file even inside the recordings root', async () => {
    const harness = await createHarness();
    await mkdir(harness.recordingsDirectory, { recursive: true });
    const notes = join(harness.recordingsDirectory, 'notes.txt');
    await writeFile(notes, 'do not delete');

    await expect(harness.service.discard(notes)).rejects.toThrow(/WAV/i);
    expect(await readFile(notes, 'utf8')).toBe('do not delete');
  });

  test('discard rejects alias.wav when its canonical target is notes.txt', async () => {
    const harness = await createHarness();
    await mkdir(harness.recordingsDirectory, { recursive: true });
    const notes = join(harness.recordingsDirectory, 'notes.txt');
    const alias = join(harness.recordingsDirectory, 'alias.wav');
    await writeFile(notes, 'canonical target must survive');
    await symlink(notes, alias, 'file');

    await expect(harness.service.discard(alias)).rejects.toThrow(/WAV/i);
    expect(await readFile(notes, 'utf8')).toBe('canonical target must survive');
  });
});

describe('recordings:save IPC 录音', () => {
  test('accepts only a strict Uint8Array and mimeType payload', () => {
    const schema = createIpcSchema();
    const request = {
      channel: 'recordings:save',
      payload: { bytes: new Uint8Array([1, 2]), mimeType: 'audio/webm' },
    } as const;

    expect(schema.parse(request)).toEqual(request);
    for (const payload of [
      {},
      { bytes: [], mimeType: 'audio/webm' },
      { bytes: new Uint8Array([1]), mimeType: '' },
      {
        bytes: new Uint8Array([1]),
        mimeType: 'audio/webm',
        destinationPath: 'G:\\outside\\chosen.wav',
      },
    ]) {
      expect(() =>
        schema.parse({ channel: 'recordings:save', payload }),
      ).toThrow();
    }
  });

  test('dispatches bytes to RecordingService without a renderer destination path', async () => {
    const save = vi.fn(async () => 'G:\\data\\recordings\\one.wav');
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    registerIpc(
      { recordings: { save } } as unknown as IpcServices,
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
    );
    const payload = { bytes: new Uint8Array([3, 4]), mimeType: 'audio/webm' };

    await expect(handlers.get('recordings:save')?.(payload)).resolves.toBe(
      'G:\\data\\recordings\\one.wav',
    );
    expect(save).toHaveBeenCalledWith(payload);
  });
});

describe('recordings:discard IPC 录音', () => {
  test('accepts only a strict recording path payload', () => {
    const schema = createIpcSchema();
    const request = {
      channel: 'recordings:discard',
      payload: { path: 'G:\\data\\recordings\\one.wav' },
    } as const;

    expect(schema.parse(request)).toEqual(request);
    for (const payload of [
      {},
      { path: '' },
      { path: 'G:\\data\\recordings\\one.wav', recursive: true },
    ]) {
      expect(() =>
        schema.parse({ channel: 'recordings:discard', payload }),
      ).toThrow();
    }
  });

  test('dispatches only the parsed path to RecordingService.discard', async () => {
    const discard = vi.fn(async () => undefined);
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    registerIpc(
      { recordings: { save: vi.fn(), discard } } as unknown as IpcServices,
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
    );

    await expect(
      handlers.get('recordings:discard')?.({
        path: 'G:\\data\\recordings\\one.wav',
      }),
    ).resolves.toBeUndefined();
    expect(discard).toHaveBeenCalledWith('G:\\data\\recordings\\one.wav');
  });
});

describe('AppServices recording 录音', () => {
  test('resolves FFmpeg from the active runtime at save time', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-app-recording-'));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const runtimeRoot = join(dataDirectory, 'active-runtime');
    await writeFile(
      join(dataDirectory, 'environment.json'),
      JSON.stringify({
        schemaVersion: 1,
        runtimeId: 'sm120',
        runtimeRoot,
        modelDirectory: join(dataDirectory, 'models'),
        outputDirectory: join(dataDirectory, 'output'),
        profile: 'balanced-16gb',
        hardwareFingerprint: {
          gpu: 'Test GPU',
          vramGiB: 16,
          ramGiB: 64,
          cudaComputeCapability: '12.0',
        },
        manifestVersion: '1',
        status: 'ready',
        createdAt: '2026-01-01T00:00:00+08:00',
        updatedAt: '2026-01-01T00:00:00+08:00',
      }),
    );
    const converter = vi.fn<AudioConverter>(async (input) => {
      await writeFile(input.destinationPath, 'converted wav');
    });
    const services = await createAppServices({
      dataDirectory,
      recordingConverter: converter,
    });
    cleanups.push(() => services.close());

    await services.recordings.save({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/webm',
    });

    expect(converter).toHaveBeenCalledWith(
      expect.objectContaining({
        ffmpegPath: join(runtimeRoot, 'tools', 'ffmpeg', 'ffmpeg.exe'),
      }),
    );
  });

  test('close aborts and awaits recording conversion before releasing services', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-app-recording-'));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let signal: AbortSignal | undefined;
    const services = await createAppServices({
      dataDirectory,
      recordingConverter: (input) => {
        signal = input.signal;
        markStarted();
        return new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(input.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
    });
    cleanups.push(() => services.close());

    const pending = services.recordings.save({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/webm',
    });
    await started;
    const rejection = expect(pending).rejects.toThrow(/closed/i);
    await services.close();
    await rejection;

    expect(signal?.aborted).toBe(true);
  });
});

describe('recordings preload 录音', () => {
  let api: SmoApi;

  beforeAll(async () => {
    await import('../../src/preload/index');
    api = exposeInMainWorld.mock.calls[0]?.[1] as SmoApi;
  });

  beforeEach(() => {
    ipcRendererInvoke.mockReset();
  });

  test('converts Blob.arrayBuffer to Uint8Array and never sends an output path', async () => {
    ipcRendererInvoke.mockResolvedValueOnce('G:\\data\\recordings\\one.wav');
    const blob = new Blob([new Uint8Array([5, 6, 7])], {
      type: 'audio/webm;codecs=opus',
    });

    await expect(api.recordings.save(blob)).resolves.toBe(
      'G:\\data\\recordings\\one.wav',
    );
    expect(ipcRendererInvoke).toHaveBeenCalledWith('recordings:save', {
      bytes: expect.any(Uint8Array),
      mimeType: 'audio/webm;codecs=opus',
    });
    const payload = ipcRendererInvoke.mock.calls[0]?.[1] as {
      bytes: Uint8Array;
    };
    expect(Array.from(payload.bytes)).toEqual([5, 6, 7]);
    expect(payload).not.toHaveProperty('destinationPath');
    expect(payload).not.toHaveProperty('path');
  });

  test('discard exposes only the dedicated fixed channel', async () => {
    ipcRendererInvoke.mockResolvedValueOnce(undefined);

    await expect(
      api.recordings.discard('G:\\data\\recordings\\one.wav'),
    ).resolves.toBeUndefined();
    expect(ipcRendererInvoke).toHaveBeenCalledWith('recordings:discard', {
      path: 'G:\\data\\recordings\\one.wav',
    });
  });
});
