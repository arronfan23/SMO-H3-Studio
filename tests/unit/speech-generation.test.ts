// @vitest-environment node

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AudioConverter } from '../../src/main/audio-converter';
import { createAppServices } from '../../src/main/app-services';
import type { ComfyClient } from '../../src/main/comfy';
import { ComfyProcessManager } from '../../src/main/comfy-process';
import {
  createGenerationHandler,
  createRetryHandler,
  type GenerationHandler,
} from '../../src/main/generation';
import { JobCoordinator } from '../../src/main/jobs';
import { MediaRegistry } from '../../src/main/media';
import { MediaComponentService } from '../../src/main/media-components';
import type { MediaComponentState } from '../../src/shared/media-components';
import {
  createSpeechGenerationHandler,
  type SpeechGenerationHandlerOptions,
} from '../../src/main/speech-generation';
import {
  SpeechProcessManager,
  type SpeechGenerateRequest,
} from '../../src/main/speech-process';
import { SpeechRuntime } from '../../src/main/speech-runtime';
import { Store } from '../../src/main/store';
import { WorkService } from '../../src/main/works';
import type {
  SpeechGenerationRequest,
  VideoGenerationRequest,
  Work,
  WorkStatus,
} from '../../src/shared/types';

const { protocolRegisterFileProtocol } = vi.hoisted(() => ({
  protocolRegisterFileProtocol: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => join(tmpdir(), 'smo-speech-test-user-data'),
  },
  dialog: { showOpenDialog: vi.fn() },
  protocol: { registerFileProtocol: protocolRegisterFileProtocol },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const WAV = Uint8Array.from([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
const cleanups: Array<() => void | Promise<void>> = [];

class FakeSpeechChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;

  readonly kill = vi.fn(() => {
    if (this.exitCode !== null) return false;
    queueMicrotask(() => this.emitExit(null));
    return true;
  });

  emitExit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

async function waitForWork(
  store: Store,
  id: string,
  status: WorkStatus,
): Promise<Work> {
  await vi.waitFor(
    () => expect(store.getWork(id)?.status).toBe(status),
    { timeout: 1_000, interval: 5 },
  );
  return store.getWork(id)!;
}

async function createHarness(
  overrides: Partial<SpeechGenerationHandlerOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'smo-speech-generation-'));
  const store = new Store(':memory:');
  const outputDirectory = join(directory, 'output');
  const temporaryDirectory = join(directory, 'speech-tmp');
  const referenceAudioPath = join(directory, 'reference.wav');
  await writeFile(referenceAudioPath, 'authorized reference audio');
  const mediaRegistry = new MediaRegistry({
    avatarsDirectory: join(directory, 'avatars'),
    outputDirectory,
  });
  await mediaRegistry.authorizeSelectedFile(referenceAudioPath);
  let componentStatus: MediaComponentState['status'] = 'ready';
  const mediaComponents = {
    getState: vi.fn((id: 'speech' | 'image'): MediaComponentState => ({
      id,
      status: componentStatus,
      downloadedBytes: 100,
      totalBytes: 100,
      currentFile: null,
      error: null,
      active: componentStatus === 'installing',
    })),
  };
  const speech = {
    generate: vi.fn(async (_request: SpeechGenerateRequest) => WAV),
    close: vi.fn(async () => undefined),
  };
  const converter = vi.fn<AudioConverter>(async (input) => {
    await writeFile(input.destinationPath, `converted:${input.format}`);
  });
  const durationReader = vi.fn(async (_path: string) => 1.25);
  const jobCoordinator = new JobCoordinator({
    onEvent: (event) => {
      store.updateWork(event.id, {
        status: event.status,
        ...(event.status === 'failed'
          ? {
              error:
                event.error instanceof Error
                  ? event.error.message
                  : String(event.error),
            }
          : {}),
      });
    },
  });
  const startSpeech = createSpeechGenerationHandler({
    store,
    speech,
    mediaComponents,
    mediaRegistry,
    jobCoordinator,
    outputDirectory,
    temporaryDirectory,
    ffmpegPath: 'G:\\speech-tools\\ffmpeg.exe',
    converter,
    durationReader,
    ...overrides,
  });
  const customRequest: SpeechGenerationRequest = {
    mode: 'speech',
    speechMode: 'custom',
    prompt: '本地语音任务测试',
    language: 'Chinese',
    outputFormat: 'wav',
    speaker: 'Vivian',
    instruct: '平静地说',
    referenceAudioPath,
  };

  cleanups.push(async () => {
    await jobCoordinator.close();
    await speech.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    converter,
    customRequest,
    directory,
    durationReader,
    jobCoordinator,
    mediaComponents,
    mediaRegistry,
    outputDirectory,
    referenceAudioPath,
    setComponentStatus: (status: MediaComponentState['status']) => {
      componentStatus = status;
    },
    speech,
    startSpeech,
    store,
    temporaryDirectory,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.restoreAllMocks();
});

describe('speech generation validation', () => {
  test('speech custom and clone modes require an authorized reference', async () => {
    const harness = await createHarness();

    await expect(
      harness.startSpeech({ ...harness.customRequest, referenceAudioPath: undefined }),
    ).rejects.toThrow(/referenceAudioPath/i);
    await expect(
      harness.startSpeech({
        ...harness.customRequest,
        speechMode: 'clone',
        speaker: undefined,
        referenceAudioPath: undefined,
      }),
    ).rejects.toThrow(/referenceAudioPath/i);
    await expect(
      harness.startSpeech({
        ...harness.customRequest,
        speechMode: 'clone',
        speaker: undefined,
        referenceAudioPath: join(harness.directory, 'unauthorized.wav'),
      }),
    ).rejects.toThrow(/authorized|selected|reference/i);
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.speech.generate).not.toHaveBeenCalled();
  });

  test('speech rejects generation until the speech component is ready', async () => {
    const harness = await createHarness();
    harness.setComponentStatus('missing');

    await expect(harness.startSpeech(harness.customRequest)).rejects.toThrow(
      /component.*ready|install/i,
    );
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.speech.generate).not.toHaveBeenCalled();
  });

  test('speech maps custom voice fields with reference audio', async () => {
    const harness = await createHarness();

    const result = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, result.id, 'done');

    expect(harness.speech.generate).toHaveBeenCalledWith({
      voiceMode: 'custom',
      text: harness.customRequest.prompt,
      language: 'Chinese',
      speaker: 'Vivian',
      instruct: '平静地说',
      referenceAudioPath: harness.referenceAudioPath,
    });
  });

  test.each([
    { referenceText: '  ', expectedXVectorOnly: true },
    { referenceText: '参考原文', expectedXVectorOnly: false },
  ])(
    'speech clone preserves reference text metadata=$expectedXVectorOnly',
    async ({ referenceText }) => {
      const harness = await createHarness();
      const request: SpeechGenerationRequest = {
        mode: 'speech',
        speechMode: 'clone',
        prompt: '克隆语音',
        language: 'Auto',
        outputFormat: 'wav',
        referenceAudioPath: harness.referenceAudioPath,
        referenceText,
      };

      const result = await harness.startSpeech(request);
      await waitForWork(harness.store, result.id, 'done');

      // Legacy reference text remains available in work metadata for retries.
      expect(harness.speech.generate).toHaveBeenCalledWith({
        voiceMode: 'clone',
        text: '克隆语音',
        language: 'Auto',
        referenceAudioPath: harness.referenceAudioPath,
        referenceText,
      });
    },
  );
});

describe('speech output formats', () => {
  test.each(['wav', 'mp3', 'flac', 'm4a'] as const)(
    'speech writes a completed %s work in SMO-Speech',
    async (outputFormat) => {
      const harness = await createHarness();

      const result = await harness.startSpeech({
        ...harness.customRequest,
        outputFormat,
      });
      const work = await waitForWork(harness.store, result.id, 'done');
      const expectedOutput = join(
        harness.outputDirectory,
        'SMO-Speech',
        `${result.id}.${outputFormat}`,
      );

      expect(work).toMatchObject({
        id: result.id,
        avatarId: null,
        mode: 'speech',
        outputPath: expectedOutput,
        error: null,
      });
      expect(work.completedAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(work.completedAt!))).toBe(false);
      expect(work.metadata?.request).toEqual({
        ...harness.customRequest,
        outputFormat,
      });
      expect(harness.durationReader).toHaveBeenCalledWith(expectedOutput);
      if (outputFormat === 'wav') {
        expect(harness.converter).not.toHaveBeenCalled();
        expect(new Uint8Array(await readFile(expectedOutput))).toEqual(WAV);
      } else {
        expect(harness.converter).toHaveBeenCalledTimes(1);
        expect(harness.converter).toHaveBeenCalledWith(
          expect.objectContaining({
            ffmpegPath: 'G:\\speech-tools\\ffmpeg.exe',
            destinationPath: expectedOutput,
            format: outputFormat,
          }),
        );
        expect(await readFile(expectedOutput, 'utf8')).toBe(
          `converted:${outputFormat}`,
        );
      }
      expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    },
  );

  test('speech M4A publishes done only after temporary WAV cleanup', async () => {
    const cleanupGate = deferred<void>();
    const removeFile: typeof rm = async (...args) => {
      if (String(args[0]).includes('speech-tmp')) {
        await cleanupGate.promise;
      }
      return rm(...args);
    };
    const harness = await createHarness({ removeFile });

    const result = await harness.startSpeech({
      ...harness.customRequest,
      outputFormat: 'm4a',
    });
    await vi.waitFor(() => {
      expect(harness.store.getWork(result.id)?.outputPath).not.toBeNull();
    });
    expect(harness.store.getWork(result.id)?.status).toBe('running');

    cleanupGate.resolve();
    await waitForWork(harness.store, result.id, 'done');
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
  });

  test('speech M4A publishes failed only after temporary WAV cleanup', async () => {
    const cleanupGate = deferred<void>();
    const removeFile: typeof rm = async (...args) => {
      if (String(args[0]).includes('speech-tmp')) {
        await cleanupGate.promise;
      }
      return rm(...args);
    };
    const harness = await createHarness({ removeFile });
    harness.converter.mockImplementationOnce(async (input) => {
      await writeFile(input.destinationPath, 'partial m4a');
      throw new Error('injected m4a conversion failure');
    });

    const result = await harness.startSpeech({
      ...harness.customRequest,
      outputFormat: 'm4a',
    });
    await vi.waitFor(() => {
      expect(harness.store.getWork(result.id)?.error).not.toBeNull();
    });
    expect(harness.store.getWork(result.id)?.status).toBe('running');

    cleanupGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');
    expect(work.error).toBe('injected m4a conversion failure');
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
  });

  test('speech M4A fails explicitly when temporary WAV cleanup fails', async () => {
    const removeFile: typeof rm = async (...args) => {
      if (String(args[0]).includes('speech-tmp')) {
        throw new Error('injected temporary cleanup failure');
      }
      return rm(...args);
    };
    const harness = await createHarness({ removeFile });

    const result = await harness.startSpeech({
      ...harness.customRequest,
      outputFormat: 'm4a',
    });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/temporary WAV cleanup|injected temporary cleanup/i);
    expect(work.outputPath).toBeNull();
    expect(work.completedAt).toBeNull();
  });

  test('speech removes temporary and partial output files after conversion fails', async () => {
    const harness = await createHarness();
    harness.converter.mockImplementationOnce(async (input) => {
      await writeFile(input.destinationPath, 'partial mp3');
      throw new Error('injected conversion failure');
    });

    const result = await harness.startSpeech({
      ...harness.customRequest,
      outputFormat: 'mp3',
    });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('injected conversion failure');
    expect(work.outputPath).toBeNull();
    expect(work.completedAt).toBeNull();
    expect(await readdir(harness.temporaryDirectory)).toEqual([]);
    expect(
      await readdir(join(harness.outputDirectory, 'SMO-Speech')),
    ).toEqual([]);
  });

  test('speech preserves a failed output for diagnostic deletion retry', async () => {
    let failOutputRemoval = true;
    const removeFile: typeof rm = async (...args) => {
      if (failOutputRemoval && String(args[0]).includes('SMO-Speech')) {
        throw new Error('disk refused speech output deletion');
      }
      return rm(...args);
    };
    const harness = await createHarness({ removeFile });
    harness.converter.mockImplementationOnce(async (input) => {
      await writeFile(input.destinationPath, 'unrecorded partial m4a');
      throw new Error('injected m4a conversion failure');
    });

    const result = await harness.startSpeech({
      ...harness.customRequest,
      outputFormat: 'm4a',
    });
    const work = await waitForWork(harness.store, result.id, 'failed');
    const expectedOutput = join(
      harness.outputDirectory,
      'SMO-Speech',
      `${result.id}.m4a`,
    );

    expect(work.outputPath).toBe(expectedOutput);
    expect(work.error).toMatch(/m4a conversion failure/i);
    expect(work.error).toMatch(/disk refused speech output deletion/i);
    expect(await readFile(expectedOutput, 'utf8')).toBe('unrecorded partial m4a');

    failOutputRemoval = false;
    const workService = new WorkService({
      outputDirectory: harness.outputDirectory,
      store: harness.store,
      removeFile,
    });
    await workService.deleteWork(work.id);
    expect(harness.store.getWork(work.id)).toBeNull();
    await expect(readFile(expectedOutput)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('speech rejects an output path that escapes SMO-Speech before creating a work', async () => {
    const harness = await createHarness({ idGenerator: () => '../escape' });

    await expect(harness.startSpeech(harness.customRequest)).rejects.toThrow(
      /output.*escape|output.*directory/i,
    );
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.speech.generate).not.toHaveBeenCalled();
  });

  test('speech failure preserves a pre-existing output it never created', async () => {
    const harness = await createHarness({ idGenerator: () => 'existing-work' });
    const outputDirectory = join(harness.outputDirectory, 'SMO-Speech');
    const existingOutput = join(outputDirectory, 'existing-work.wav');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(existingOutput, 'existing work bytes');
    harness.speech.generate.mockRejectedValueOnce(new Error('inference failed'));

    const result = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, result.id, 'failed');

    expect(await readFile(existingOutput, 'utf8')).toBe('existing work bytes');
  });
});

describe('speech single-job coordination', () => {
  test('speech marks a new work failed when the coordinator is already closed', async () => {
    const harness = await createHarness();
    await harness.jobCoordinator.close();

    await expect(harness.startSpeech(harness.customRequest)).rejects.toThrow(
      /closed/i,
    );

    const works = harness.store.listWorks();
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/closed/i),
      outputPath: null,
    });
  });

  test('speech rejects a second task without adding a work and releases the lock after completion', async () => {
    const harness = await createHarness();
    const gate = deferred<Uint8Array<ArrayBuffer>>();
    harness.speech.generate.mockReturnValueOnce(gate.promise);

    const first = await harness.startSpeech(harness.customRequest);
    await vi.waitFor(() => expect(harness.speech.generate).toHaveBeenCalledTimes(1));
    await expect(harness.startSpeech(harness.customRequest)).rejects.toThrow(
      /another generation/i,
    );
    expect(harness.store.listWorks()).toHaveLength(1);

    gate.resolve(WAV);
    await waitForWork(harness.store, first.id, 'done');
    const second = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, second.id, 'done');
    expect(harness.store.listWorks()).toHaveLength(2);
  });

  test('speech releases the lock after failure', async () => {
    const harness = await createHarness();
    harness.speech.generate.mockRejectedValueOnce(new Error('injected inference failure'));

    const failed = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, failed.id, 'failed');
    await vi.waitFor(() => expect(harness.jobCoordinator.activeCount).toBe(0));

    const next = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, next.id, 'done');
  });

  test('speech cancellation closes the active process and releases the lock', async () => {
    const harness = await createHarness();
    const gate = deferred<Uint8Array<ArrayBuffer>>();
    harness.speech.generate.mockReturnValueOnce(gate.promise);
    harness.speech.close.mockImplementationOnce(async () => {
      gate.reject(new Error('speech process stopped'));
    });

    const cancelled = await harness.startSpeech(harness.customRequest);
    await vi.waitFor(() => expect(harness.speech.generate).toHaveBeenCalledTimes(1));
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, cancelled.id, 'failed');

    expect(work.error).toMatch(/cancel/i);
    expect(harness.speech.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.jobCoordinator.activeCount).toBe(0));

    const next = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, next.id, 'done');
  });

  test('speech cancellation passes the job signal into runtime preparation', async () => {
    let firstPreparation = true;
    let observedSignal: AbortSignal | undefined;
    const preparationStarted = deferred<void>();
    const ensureReady = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      if (!firstPreparation) return Promise.resolve();
      firstPreparation = false;
      return new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
        preparationStarted.resolve();
      });
    });
    const harness = await createHarness({ ensureReady });

    const cancelled = await harness.startSpeech(harness.customRequest);
    await preparationStarted.promise;
    await harness.jobCoordinator.cancelActive();

    const work = await waitForWork(harness.store, cancelled.id, 'failed');
    expect(work.error).toMatch(/cancel/i);
    expect(observedSignal?.aborted).toBe(true);

    const next = await harness.startSpeech(harness.customRequest);
    await waitForWork(harness.store, next.id, 'done');
    expect(ensureReady).toHaveBeenCalledTimes(2);
  });

  test('speech and video reject each other while active without adding works', async () => {
    const harness = await createHarness();
    const photoPath = join(harness.directory, 'avatar.png');
    await writeFile(photoPath, 'avatar');
    const avatar = harness.store.createAvatar({ name: 'Presenter', photoPath });
    const comfy = {
      uploadFile: vi.fn(),
      submit: vi.fn(),
      waitForCompletion: vi.fn(),
      history: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ComfyClient;
    const startVideo = createGenerationHandler({
      store: harness.store,
      comfy,
      jobCoordinator: harness.jobCoordinator,
      workflowsDirectory: harness.directory,
      outputDirectory: harness.outputDirectory,
      mediaRegistry: harness.mediaRegistry,
      uploadsDirectory: join(harness.directory, 'uploads'),
      durationReader: async () => 10,
    });
    const videoRequest: VideoGenerationRequest = {
      mode: 'text',
      avatarId: avatar.id,
      prompt: 'video',
      duration: 8,
      seed: 1,
      steps: 8,
    };
    const speechGate = deferred<Uint8Array<ArrayBuffer>>();
    harness.speech.generate.mockReturnValueOnce(speechGate.promise);
    harness.speech.close.mockImplementationOnce(async () => {
      speechGate.reject(new Error('speech process stopped'));
    });

    const speechWork = await harness.startSpeech(harness.customRequest);
    await vi.waitFor(() => expect(harness.speech.generate).toHaveBeenCalledTimes(1));
    await expect(startVideo(videoRequest)).rejects.toThrow(/another generation/i);
    expect(harness.store.listWorks()).toHaveLength(1);
    await harness.jobCoordinator.cancelActive();
    await waitForWork(harness.store, speechWork.id, 'failed');

    const videoWork = harness.store.addWork({
      id: 'active-video',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'pending',
    });
    const videoGate = deferred<void>();
    void harness.jobCoordinator
      .enqueue({
        id: videoWork.id,
        run: async () => {
          await videoGate.promise;
          throw new Error('Generation cancelled');
        },
        cancel: () => videoGate.resolve(),
      })
      .catch(() => undefined);
    await expect(harness.startSpeech(harness.customRequest)).rejects.toThrow(
      /another generation/i,
    );
    expect(harness.store.listWorks()).toHaveLength(2);
    await harness.jobCoordinator.cancelActive();
  });
});

describe('speech retry', () => {
  test('speech retry preserves the failed request and revalidates reference authorization and readiness', async () => {
    const harness = await createHarness();
    harness.speech.generate.mockRejectedValueOnce(new Error('retryable inference failure'));
    const request: SpeechGenerationRequest = {
      mode: 'speech',
      speechMode: 'clone',
      prompt: '失败重试保留完整请求',
      language: 'Auto',
      outputFormat: 'flac',
      referenceAudioPath: harness.referenceAudioPath,
      referenceText: '',
    };
    const videoHandler: GenerationHandler = async () => {
      throw new Error('speech retry must not route to video');
    };
    const startGeneration: GenerationHandler = (generationRequest, options) =>
      generationRequest.mode === 'speech'
        ? harness.startSpeech(generationRequest)
        : videoHandler(generationRequest, options);
    const retryWork = createRetryHandler({
      store: harness.store,
      mediaRegistry: harness.mediaRegistry,
      startGeneration,
    });

    const original = await harness.startSpeech(request);
    const failed = await waitForWork(harness.store, original.id, 'failed');
    expect(failed.metadata?.request).toEqual(request);
    const originalSnapshot = structuredClone(failed);
    const authorize = vi.spyOn(harness.mediaRegistry, 'authorizeSelectedFile');

    await rm(harness.referenceAudioPath);
    await expect(retryWork(original.id)).rejects.toThrow(/missing|exist|file/i);
    expect(harness.store.listWorks()).toHaveLength(1);

    await writeFile(harness.referenceAudioPath, 'restored reference audio');
    harness.setComponentStatus('missing');
    await expect(retryWork(original.id)).rejects.toThrow(/component.*ready|install/i);
    expect(harness.store.listWorks()).toHaveLength(1);

    harness.setComponentStatus('ready');
    const retried = await retryWork(original.id);
    const completed = await waitForWork(harness.store, retried.id, 'done');
    expect(retried.id).not.toBe(original.id);
    expect(completed.metadata).toMatchObject({
      request,
      retryOf: original.id,
    });
    expect(authorize).toHaveBeenCalledWith(harness.referenceAudioPath);
    expect(harness.store.getWork(original.id)).toEqual(originalSnapshot);
  });
});

describe('speech AppServices assembly', () => {
  test('speech creates a fresh process after a startup failure closes the first manager', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-speech-restart-'));
    vi.spyOn(MediaComponentService.prototype, 'getState').mockImplementation((id) => ({
      id,
      status: 'ready',
      downloadedBytes: 100,
      totalBytes: 100,
      currentFile: null,
      error: null,
      active: false,
    }));
    vi.spyOn(SpeechRuntime.prototype, 'prepare').mockResolvedValue({
      pythonPath: join(dataDirectory, 'speech-runtime', 'python.exe'),
      environment: {},
    });
    const children: FakeSpeechChild[] = [];
    const speechProcessFactory = vi.fn(() => {
      const child = new FakeSpeechChild();
      const attempt = children.length;
      children.push(child);
      return new SpeechProcessManager({
        pythonPath: 'fake-python.exe',
        serviceScript: 'fake-service.py',
        modelDirectory: dataDirectory,
        startupTimeoutMs: 100,
        healthTimeoutMs: 50,
        shutdownTimeoutMs: 5,
        pollIntervalMs: 1,
        spawnImpl: () => {
          queueMicrotask(() => {
            if (attempt === 0) child.stdout.end();
            else child.stdout.write('SMO_SPEECH_URL=http://127.0.0.1:43127\n');
          });
          return child as unknown as ChildProcessWithoutNullStreams;
        },
        fetchImpl: async (input) => {
          const url = new URL(
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          if (url.pathname === '/health') return Response.json({ ok: true });
          if (url.pathname === '/generate') return new Response(WAV);
          if (url.pathname === '/shutdown') {
            queueMicrotask(() => child.emitExit(0));
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 404 });
        },
      });
    });
    const services = await createAppServices({
      dataDirectory,
      outputDirectory: join(dataDirectory, 'output'),
      speechProcessFactory,
      speechDurationReader: async () => 1,
    });
    cleanups.push(async () => {
      await services.close().catch(() => undefined);
      await rm(dataDirectory, { recursive: true, force: true });
    });
    const request: SpeechGenerationRequest = {
      mode: 'speech',
      speechMode: 'custom',
      prompt: '启动失败后重建语音进程',
      language: 'Chinese',
      outputFormat: 'wav',
      speaker: 'Vivian',
      referenceAudioPath: join(dataDirectory, 'recordings', 'reference.wav'),
    };
    await mkdir(join(dataDirectory, 'recordings'), { recursive: true });
    await writeFile(request.referenceAudioPath!, 'reference');

    const first = await services.startGeneration(request);
    const failed = await waitForWork(services.store, first.id, 'failed');
    expect(failed.error).toMatch(/stdout ended|startup/i);

    const second = await services.startGeneration(request);
    await waitForWork(services.store, second.id, 'done');
    expect(speechProcessFactory).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
  });

  test('speech routes jobs:start away from video and prepares the isolated runtime', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-speech-services-'));
    vi.spyOn(MediaComponentService.prototype, 'getState').mockImplementation((id) => ({
      id,
      status: 'ready',
      downloadedBytes: 100,
      totalBytes: 100,
      currentFile: null,
      error: null,
      active: false,
    }));
    const prepare = vi.spyOn(SpeechRuntime.prototype, 'prepare').mockResolvedValue({
      pythonPath: join(dataDirectory, 'speech-runtime', 'python.exe'),
      environment: {},
    });
    const generate = vi
      .spyOn(SpeechProcessManager.prototype, 'generate')
      .mockResolvedValue(WAV);
    vi.spyOn(SpeechProcessManager.prototype, 'capabilities').mockResolvedValue({
      speakers: [],
      languages: ['Auto'],
    });
    const converter = vi.fn<AudioConverter>(async (input) => {
      await writeFile(input.destinationPath, 'mp3');
    });
    const videoHandler = vi.fn(async () => ({ id: 'injected-video' }));
    const services = await createAppServices({
      dataDirectory,
      outputDirectory: join(dataDirectory, 'output'),
      videoGenerationHandler: videoHandler,
      speechConverter: converter,
      speechDurationReader: async () => 2,
    });
    cleanups.push(async () => {
      await services.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });
    const request: SpeechGenerationRequest = {
      mode: 'speech',
      speechMode: 'custom',
      prompt: '服务装配语音',
      language: 'Chinese',
      outputFormat: 'mp3',
      speaker: 'Vivian',
      referenceAudioPath: join(dataDirectory, 'recordings', 'reference.wav'),
    };
    await mkdir(join(dataDirectory, 'recordings'), { recursive: true });
    await writeFile(request.referenceAudioPath!, 'reference');

    const result = await services.startGeneration(request);
    const work = await waitForWork(services.store, result.id, 'done');
    expect(work.mode).toBe('speech');
    expect(work.outputPath).toBe(
      join(dataDirectory, 'output', 'SMO-Speech', `${result.id}.mp3`),
    );
    expect(videoHandler).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(generate).toHaveBeenCalledWith({
      voiceMode: 'custom',
      text: request.prompt,
      language: 'Chinese',
      speaker: 'Vivian',
      instruct: '',
      referenceAudioPath: request.referenceAudioPath,
    });
    await expect(services.speech.getCapabilities('clone')).resolves.toEqual({
      speakers: [],
      languages: ['Auto'],
    });

    const videoRequest: VideoGenerationRequest = {
      mode: 'text',
      avatarId: 'injected-avatar',
      prompt: 'video',
      duration: 8,
      seed: 1,
      steps: 8,
    };
    await expect(services.startGeneration(videoRequest)).resolves.toEqual({
      id: 'injected-video',
    });
    expect(videoHandler).toHaveBeenCalledWith(videoRequest, undefined);
  });

  test('speech close runs after jobs and before the ComfyUI process', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-speech-close-'));
    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const order: string[] = [];
    vi.spyOn(services.jobCoordinator, 'close').mockImplementation(async () => {
      order.push('jobs');
    });
    vi.spyOn(SpeechRuntime.prototype, 'close').mockImplementation(async () => {
      order.push('speech-runtime');
    });
    vi.spyOn(SpeechProcessManager.prototype, 'close').mockImplementation(async () => {
      order.push('speech-process');
    });
    vi.spyOn(MediaComponentService.prototype, 'cancel').mockImplementation((id) => {
      order.push(`cancel-${id}`);
    });
    vi.spyOn(ComfyProcessManager.prototype, 'close').mockImplementation(async () => {
      order.push('comfy-process');
    });

    await services.close();

    expect(order).toEqual([
      'jobs',
      'speech-runtime',
      'speech-process',
      'cancel-speech',
      'cancel-image',
      'comfy-process',
    ]);
  });
});
