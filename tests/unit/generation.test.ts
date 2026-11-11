// @vitest-environment node

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ComfyClient,
  ComfyExecutionUpdate,
  ComfyOutputFile,
  ComfyProgress,
  ComfySubmitResult,
} from '../../src/main/comfy';
import { FileService } from '../../src/main/files';
import { createGenerationHandler, createRetryHandler } from '../../src/main/generation';
import { JobCoordinator, type JobEvent } from '../../src/main/jobs';
import { MediaRegistry } from '../../src/main/media';
import type { SparkAccelerationEnvironment } from '../../src/main/spark-acceleration';
import { Store } from '../../src/main/store';
import { createNoReferenceTextWorkflow } from '../../src/shared/workflow-nodes';
import type {
  GenerationRequest,
  VideoGenerationRequest,
  Work,
  WorkExecutionState,
  WorkProgress,
  WorkStatus,
} from '../../src/shared/types';

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

function outputFile(overrides: Partial<ComfyOutputFile> = {}): ComfyOutputFile {
  return {
    nodeId: '180',
    kind: 'gifs',
    filename: 'result.mp4',
    subfolder: 'SMO-H3',
    type: 'output',
    ...overrides,
  };
}

class FakeComfyClient {
  readonly uploads: Parameters<ComfyClient['uploadFile']>[0][] = [];
  readonly uploadedAudioContents: string[] = [];
  readonly submissions: unknown[] = [];
  readonly waits: string[] = [];
  readonly histories: string[] = [];
  readonly uploadErrors: Partial<Record<'image' | 'audio', Error>> = {};
  promptId = 'prompt-1';
  submitError?: Error;
  completionError?: Error;
  cancelError?: Error;
  historyError?: Error;
  completionGate?: Deferred<void>;
  uploadGate?: Deferred<void>;
  submitGate?: Deferred<ComfySubmitResult>;
  historyGate?: Deferred<void>;
  cancellations = 0;
  readonly cancelRequests: Array<string | undefined> = [];
  progressEvents: ComfyProgress[] = [];
  executionUpdates: ComfyExecutionUpdate[] = [];
  waitScript?: Array<
    | { kind: 'progress'; progress: ComfyProgress }
    | { kind: 'update'; update: ComfyExecutionUpdate }
  >;
  outputs: ComfyOutputFile[] = [
    outputFile({ nodeId: 'preview', kind: 'images', filename: 'cover.png' }),
    outputFile({ filename: 'result.webm' }),
    outputFile({ filename: 'result.mp4' }),
  ];

  async uploadFile(input: Parameters<ComfyClient['uploadFile']>[0]): Promise<string> {
    this.uploads.push(input);
    const error = this.uploadErrors[input.kind];
    if (error) {
      throw error;
    }
    if (this.uploadGate) {
      await this.uploadGate.promise;
    }
    if (input.kind === 'audio') {
      this.uploadedAudioContents.push(await readFile(input.filePath, 'utf8'));
    }
    return input.kind === 'image' ? 'uploaded/avatar.png' : 'uploaded/voice.mp3';
  }

  async submit(prompt: unknown): Promise<ComfySubmitResult> {
    this.submissions.push(structuredClone(prompt));
    if (this.submitError) {
      throw this.submitError;
    }
    if (this.submitGate) {
      return this.submitGate.promise;
    }
    return { prompt_id: this.promptId, number: 1, node_errors: {} };
  }

  async waitForCompletion(
    promptId: string,
    onProgress?: (progress: ComfyProgress) => void,
    onUpdate?: (update: ComfyExecutionUpdate) => void,
  ): Promise<void> {
    this.waits.push(promptId);
    const script =
      this.waitScript ?? [
        ...this.executionUpdates.map(
          (update) => ({ kind: 'update', update }) as const,
        ),
        ...this.progressEvents.map(
          (progress) => ({ kind: 'progress', progress }) as const,
        ),
      ];
    for (const event of script) {
      if (event.kind === 'update') {
        onUpdate?.(event.update);
      } else {
        onProgress?.(event.progress);
      }
    }
    if (this.completionGate) {
      await this.completionGate.promise;
    }
    if (this.completionError) {
      throw this.completionError;
    }
  }

  async history(promptId: string): Promise<ComfyOutputFile[]> {
    this.histories.push(promptId);
    if (this.historyError) {
      throw this.historyError;
    }
    if (this.historyGate) {
      await this.historyGate.promise;
    }
    return this.outputs;
  }

  async cancel(promptId?: string): Promise<void> {
    this.cancellations += 1;
    this.cancelRequests.push(promptId);
    this.completionGate?.reject(
      this.cancelError ?? new Error('ComfyUI execution interrupted'),
    );
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
const workflowsDirectory = fileURLToPath(
  new URL('../../resources/workflows/', import.meta.url),
);

async function createHarness(
  options: {
    copyFile?: typeof copyFile;
    durationReader?: (filePath: string) => Promise<number>;
    workflowsDirectory?: string;
    removeFile?: typeof rm;
    cleanupErrorReporter?: (error: unknown) => void;
    progressErrorReporter?: (error: unknown) => void;
    workflowResolver?: (mode: GenerationRequest["mode"]) => string;
    ensureReady?: () => Promise<unknown>;
    acceleration?: SparkAccelerationEnvironment;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'smo-h3-generation-'));
  const store = new Store(join(directory, 'studio.sqlite'));
  const photoPath = join(directory, 'avatar.png');
  const audioPath = join(directory, 'voice.mp3');
  await Promise.all([
    writeFile(photoPath, 'avatar-test-bytes'),
    writeFile(audioPath, 'audio-test-bytes'),
  ]);
  const avatar = store.createAvatar({ name: 'Lin', photoPath });
  const outputDirectory = join(directory, 'output');
  const uploadsDirectory = join(directory, 'uploads');
  const mediaRegistry = new MediaRegistry({
    avatarsDirectory: join(directory, 'avatars'),
    outputDirectory,
  });
  const files = new FileService({
    mediaRegistry,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [audioPath] }),
    },
    outputDirectory,
    dataDirectory: directory,
  });
  await files.selectAudio();
  const comfy = new FakeComfyClient();
  const events: JobEvent[] = [];
  const jobCoordinator = new JobCoordinator({
    onEvent: (event) => {
      events.push(event);
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
  const startGeneration = createGenerationHandler({
    store,
    comfy,
    jobCoordinator,
    workflowsDirectory: options.workflowsDirectory ?? workflowsDirectory,
    workflowResolver: options.workflowResolver,
    outputDirectory,
    mediaRegistry,
    uploadsDirectory,
    ensureReady: options.ensureReady,
    acceleration: options.acceleration,
    copyFile: options.copyFile,
    durationReader: options.durationReader ?? (async () => 60),
    removeFile: options.removeFile,
    cleanupErrorReporter: options.cleanupErrorReporter,
    progressErrorReporter: options.progressErrorReporter,
  });
  const textRequest: GenerationRequest = {
    mode: 'text',
    avatarId: avatar.id,
    prompt: 'A quiet studio shot.',
    duration: 8,
    seed: 42,
    steps: 12,
    referenceImagePaths: [],
  };
  const audioRequest: GenerationRequest = {
    ...textRequest,
    mode: 'audio',
    prompt: 'Natural lip movement and a steady camera.',
    duration: 6.5,
    seed: 99,
    steps: 9,
    audioPath,
  };

  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const retryWork = createRetryHandler({
    store,
    mediaRegistry,
    startGeneration,
  });

  return {
    audioRequest,
    avatar,
    comfy,
    directory,
    events,
    jobCoordinator,
    outputDirectory,
    uploadsDirectory,
    mediaRegistry,
    retryWork,
    startGeneration,
    store,
    textRequest,
  };
}

async function waitForWork(
  store: Store,
  id: string,
  status: WorkStatus,
): Promise<Work> {
  await vi.waitFor(
    () => {
      expect(store.listWorks().find((work) => work.id === id)?.status).toBe(status);
    },
    { timeout: 1_000, interval: 5 },
  );
  const work = store.listWorks().find((candidate) => candidate.id === id);
  if (!work) {
    throw new Error(`Expected work ${id} to exist`);
  }
  return work;
}

async function waitForJobEvent(
  events: JobEvent[],
  id: string,
  status: WorkStatus,
): Promise<void> {
  await vi.waitFor(() => {
    expect(events.some((event) => event.id === id && event.status === status)).toBe(true);
  });
}

function submittedPrompt(
  harness: Awaited<ReturnType<typeof createHarness>>,
  submissionIndex = 0,
): string {
  const submitted = harness.comfy.submissions[submissionIndex] as Record<
    string,
    { inputs: Record<string, unknown> }
  >;
  return String(submitted['136'].inputs.prompt);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('GenerationHandler prompt submission', () => {
  test('submits the original prompt without injecting subtitle guidance', async () => {
    const harness = await createHarness();
    const request = {
      ...harness.textRequest,
      prompt: '主播在摄影棚微笑',
      subtitles: true,
    } as GenerationRequest;

    const result = await harness.startGeneration(request);
    await waitForWork(harness.store, result.id, 'done');

    expect(submittedPrompt(harness)).toBe('主播在摄影棚微笑');

    const work = harness.store.listWorks().find((candidate) => candidate.id === result.id);
    expect(work?.metadata?.request).toEqual({
      ...harness.textRequest,
      prompt: '主播在摄影棚微笑',
    });
    expect(work?.metadata?.request).not.toHaveProperty('subtitles');
  });
});

describe('GenerationHandler progress metadata', () => {
  test('stores ComfyUI frame progress while keeping request and workflowVersion', async () => {
    const harness = await createHarness();
    harness.comfy.progressEvents = [
      { value: 6, max: 24 },
      { value: 12, max: 24 },
    ];

    const result = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, result.id, 'done');

    const work = harness.store.getWork(result.id);
    expect(work?.metadata).toMatchObject({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      progress: { value: 12, max: 24 },
    });
  });
});

describe('GenerationHandler progress resilience and throttling', () => {
  test('a transient progress persistence error does not fail the generation', async () => {
    const progressErrorReporter = vi.fn();
    const harness = await createHarness({ progressErrorReporter });
    const busyError = new Error('SQLITE_BUSY: database is locked');
    const originalUpdateWork = harness.store.updateWork.bind(harness.store);
    vi.spyOn(harness.store, 'updateWork').mockImplementation((id, update) => {
      if (
        update.metadata !== undefined &&
        (update.metadata as { progress?: unknown }).progress !== undefined
      ) {
        throw busyError;
      }
      return originalUpdateWork(id, update);
    });
    harness.comfy.progressEvents = [{ value: 4, max: 24 }];

    const result = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, result.id, 'done');

    expect(progressErrorReporter).toHaveBeenCalledWith(busyError);
    const work = harness.store.getWork(result.id);
    expect(work?.status).toBe('done');
    expect(work?.error).toBeNull();
    expect(work?.metadata).toMatchObject({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
    });
    expect(harness.comfy.submissions).toHaveLength(1);
    expect(harness.comfy.waits).toEqual(['prompt-1']);
  });

  test('throttles a synchronous burst of progress events to at most two writes', async () => {
    const harness = await createHarness();
    const updateWorkSpy = vi.spyOn(harness.store, 'updateWork');
    harness.comfy.progressEvents = Array.from({ length: 10 }, (_, index) => ({
      value: index + 1,
      max: 24,
    }));

    const result = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, result.id, 'done');

    // Stage updates may legitimately re-include the same progress value, so the
    // throttle budget is measured in writes that carry a new frame value.
    const progressValues = updateWorkSpy.mock.calls
      .map(
        ([, update]) =>
          (update as { metadata?: { progress?: WorkProgress } }).metadata?.progress,
      )
      .filter((progress): progress is WorkProgress => progress !== undefined);
    const newFrameWrites = progressValues.filter(
      (progress, index) =>
        index === 0 ||
        progress.value !== progressValues[index - 1].value ||
        progress.max !== progressValues[index - 1].max,
    );
    expect(newFrameWrites.length).toBeLessThanOrEqual(2);
    expect(harness.store.getWork(result.id)?.metadata).toMatchObject({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      progress: { value: 10, max: 24 },
    });
  });

  test('persists early progress while running and flushes the latest value on completion', async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    try {
      harness.comfy.completionGate = deferred();
      harness.comfy.progressEvents = [
        { value: 3, max: 24 },
        { value: 9, max: 24 },
      ];

      const result = await harness.startGeneration(harness.textRequest);
      const readStoredProgress = (): unknown =>
        harness.store.getWork(result.id)?.metadata?.progress;

      // Advance virtual time in small steps until the run reaches the
      // completion gate; the fake 200ms throttle timer must not fire yet, so
      // only the first progress event may be persisted.
      for (let step = 0; step < 100 && readStoredProgress() === undefined; step += 1) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(readStoredProgress()).toEqual({ value: 3, max: 24 });

      harness.comfy.completionGate.resolve();
      for (
        let step = 0;
        step < 500 && harness.store.getWork(result.id)?.status !== 'done';
        step += 1
      ) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(harness.store.getWork(result.id)?.status).toBe('done');
      expect(harness.store.getWork(result.id)?.metadata).toMatchObject({
        request: harness.textRequest,
        workflowVersion: 'text-ref2va.json',
        progress: { value: 9, max: 24 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GenerationHandler execution state metadata', () => {
  test('merges execution and progress without dropping request, workflowVersion, or retryOf', async () => {
    const harness = await createHarness();
    harness.comfy.waitScript = [
      { kind: 'update', update: { stage: 'backend-queued', queuePosition: 2 } },
      { kind: 'update', update: { stage: 'executing', queuePosition: 0 } },
      { kind: 'progress', progress: { value: 5, max: 24 } },
      { kind: 'progress', progress: { value: 11, max: 24 } },
      { kind: 'update', update: { stage: 'finalizing' } },
    ];
    const updateWorkSpy = vi.spyOn(harness.store, 'updateWork');

    const result = await harness.startGeneration({
      ...harness.textRequest,
      retryOf: 'previous-work',
    });
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work?.metadata).toMatchObject({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      retryOf: 'previous-work',
      progress: { value: 11, max: 24 },
      execution: { stage: 'finalizing' },
    });
    const execution = work?.metadata?.execution as WorkExecutionState | undefined;
    expect(execution).toBeDefined();
    expect(Number.isNaN(Date.parse(execution!.updatedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(execution!.lastProgressAt))).toBe(false);

    const recordedStates = updateWorkSpy.mock.calls
      .map(
        ([, update]) =>
          (update as { metadata?: { execution?: WorkExecutionState } }).metadata
            ?.execution,
      )
      .filter((state): state is WorkExecutionState => state !== undefined);
    expect(recordedStates.map((state) => state.stage)).toEqual(
      expect.arrayContaining(['uploading', 'backend-queued', 'executing', 'sampling']),
    );
    expect(
      recordedStates.some(
        (state) => state.stage === 'backend-queued' && state.queuePosition === 2,
      ),
    ).toBe(true);

    const metadataWrites = updateWorkSpy.mock.calls
      .map(([, update]) => (update as { metadata?: Record<string, unknown> }).metadata)
      .filter((metadata): metadata is Record<string, unknown> => metadata !== undefined);
    for (const metadata of metadataWrites) {
      expect(metadata).toMatchObject({
        request: harness.textRequest,
        workflowVersion: 'text-ref2va.json',
        retryOf: 'previous-work',
      });
    }
  });

  test('keeps the written frame progress across pure stage updates', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();
    harness.comfy.waitScript = [
      { kind: 'progress', progress: { value: 5, max: 24 } },
      { kind: 'update', update: { stage: 'executing', queuePosition: 0 } },
    ];

    const result = await harness.startGeneration({
      ...harness.textRequest,
      retryOf: 'previous-work',
    });
    await vi.waitFor(() => expect(harness.comfy.waits).toEqual(['prompt-1']));

    // The pure stage update must not drop the already persisted frame progress:
    // Store.updateWork replaces metadata wholesale.
    const midRun = harness.store.getWork(result.id);
    expect(midRun?.metadata?.execution).toMatchObject({
      stage: 'executing',
      queuePosition: 0,
    });
    expect(midRun?.metadata).toMatchObject({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      retryOf: 'previous-work',
      progress: { value: 5, max: 24 },
    });

    harness.comfy.completionGate.resolve();
    await waitForWork(harness.store, result.id, 'done');
  });

  test('cancels the submitted prompt by id instead of interrupting blindly', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.waits).toEqual(['prompt-1']));
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/interrupt|cancel/i);
    expect(harness.comfy.cancelRequests).toEqual(['prompt-1']);
  });

  test('cleans up the submitted prompt id when ComfyUI reports a timeout', async () => {
    const harness = await createHarness();
    harness.comfy.completionError = new Error(
      'ComfyUI execution timed out after 7200000 ms',
    );

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/timed out/i);
    expect(work.promptId).toBe('prompt-1');
    expect(work.completedAt).toBeNull();
    expect(harness.comfy.cancelRequests).toEqual(['prompt-1']);
  });
});

describe('GenerationHandler workflows', () => {
  test.each([0, 101, 1.5])(
    'rejects invalid video steps %s before queueing',
    async (steps) => {
      const harness = await createHarness();

      await expect(
        harness.startGeneration({ ...harness.textRequest, steps }),
      ).rejects.toThrow(/steps/i);
      expect(harness.store.listWorks()).toEqual([]);
    },
  );

  test('runs the complete text workflow and records the real mp4 output', async () => {
    const harness = await createHarness();
    const workflowPath = join(workflowsDirectory, 'text-ref2va.json');
    const frozenSource = await readFile(workflowPath, 'utf8');
    const request = { ...harness.textRequest, duration: 12, seed: 123 };

    const result = await harness.startGeneration(request);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(harness.comfy.uploads).toEqual([
      { filePath: harness.avatar.photoPath, kind: 'image' },
    ]);
    const expected = JSON.parse(frozenSource) as Record<
      string,
      { inputs: Record<string, unknown> }
    >;
    expected['226'].inputs.image = 'uploaded/avatar.png';
    expected['136'].inputs.prompt = request.prompt;
    expected['132'].inputs.value = 12;
    expected['269'].inputs.seed = 123;
    expected['124'].inputs.steps = request.steps;
    expected['180'].inputs.filename_prefix = `SMO-H3/${result.id}`;
    expect(harness.comfy.submissions).toEqual([expected]);
    expect(harness.comfy.waits).toEqual(['prompt-1']);
    expect(harness.comfy.histories).toEqual(['prompt-1']);
    expect(work).toMatchObject({
      id: result.id,
      avatarId: harness.avatar.id,
      mode: 'text',
      status: 'done',
      outputPath: join(harness.outputDirectory, 'SMO-H3', 'result.mp4'),
      title: null,
      promptId: 'prompt-1',
      error: null,
      metadata: { request, workflowVersion: 'text-ref2va.json' },
    });
    expect(work.completedAt).not.toBeNull();
    expect(new Date(work.completedAt!).toISOString()).toBe(work.completedAt);
    expect(Date.parse(work.completedAt!)).toBeGreaterThanOrEqual(
      Date.parse(work.createdAt),
    );
    expect(harness.events.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: result.id, status: 'running' },
      { id: result.id, status: 'done' },
    ]);
    expect(await readFile(workflowPath, 'utf8')).toBe(frozenSource);
  });

  test.each([
    { trimStart: undefined, expectedStart: 0 },
    { trimStart: 2.25, expectedStart: 2.25 },
  ])(
    'runs the complete audio workflow with trimStart=$trimStart',
    async ({ trimStart, expectedStart }) => {
      const harness = await createHarness();
      const workflowPath = join(workflowsDirectory, 'audio-digital-human.json');
      const frozenSource = await readFile(workflowPath, 'utf8');
      const request = { ...harness.audioRequest, trimStart };
      harness.comfy.outputs = [
        outputFile({ nodeId: '65', filename: 'audio-result.mp4' }),
      ];

      const result = await harness.startGeneration(request);
      const work = await waitForWork(harness.store, result.id, 'done');

      expect(harness.comfy.uploads).toEqual([
        { filePath: harness.avatar.photoPath, kind: 'image' },
        {
          filePath: join(harness.uploadsDirectory, `${result.id}.mp3`),
          kind: 'audio',
        },
      ]);
      expect(harness.comfy.uploads[1].filePath).not.toBe(request.audioPath);
      expect(harness.comfy.uploadedAudioContents).toEqual(['audio-test-bytes']);
      await expect(
        readFile(join(harness.uploadsDirectory, `${result.id}.mp3`), 'utf8'),
      ).rejects.toThrow();
      const expected = JSON.parse(frozenSource) as Record<
        string,
        { inputs: Record<string, unknown> }
      >;
      expected['36'].inputs.image = 'uploaded/avatar.png';
      expected['34'].inputs.audio = 'uploaded/voice.mp3';
      expected['42'].inputs.prompt = request.prompt;
      expected['85'].inputs.start_index = expectedStart;
      expected['85'].inputs.duration = request.duration;
      expected['86'].inputs.seed = request.seed;
      expected['51'].inputs.steps = request.steps;
      expected['65'].inputs.filename_prefix = `SMO-H3/${result.id}`;
      expect(harness.comfy.submissions).toEqual([expected]);
      expect(work.status).toBe('done');
      expect(work.outputPath).toBe(
        join(harness.outputDirectory, 'SMO-H3', 'audio-result.mp4'),
      );
      expect(await readFile(workflowPath, 'utf8')).toBe(frozenSource);
    },
  );

  test('uses the staged audio copy after the selected source is deleted', async () => {
    const harness = await createHarness();
    const completionGate = deferred();
    harness.comfy.completionGate = completionGate;
    harness.comfy.outputs = [
      outputFile({ nodeId: '65', filename: 'audio-result.mp4' }),
    ];

    const result = await harness.startGeneration(harness.audioRequest);
    const stagedPath = join(harness.uploadsDirectory, `${result.id}.mp3`);
    await rm(harness.audioRequest.audioPath!);
    completionGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work.status).toBe('done');
    expect(harness.comfy.uploads[1]).toEqual({ filePath: stagedPath, kind: 'audio' });
    expect(harness.comfy.uploadedAudioContents).toEqual(['audio-test-bytes']);
    await expect(readFile(stagedPath, 'utf8')).rejects.toThrow();
  });

  test('accepts a trim range within the actual duration read from staged audio', async () => {
    const durationReader = vi.fn(async () => 8.75);
    const harness = await createHarness({ durationReader });
    harness.comfy.outputs = [
      outputFile({ nodeId: '65', filename: 'audio-result.mp4' }),
    ];

    const result = await harness.startGeneration({
      ...harness.audioRequest,
      trimStart: 2.25,
      duration: 6.5,
    });
    await waitForWork(harness.store, result.id, 'done');

    expect(durationReader).toHaveBeenCalledWith(
      join(harness.uploadsDirectory, `${result.id}.mp3`),
    );
  });

  test.each([
    {
      scenario: 'trimStart beyond the actual duration',
      trimStart: 6,
      duration: 1,
    },
    {
      scenario: 'trimStart plus duration beyond the actual duration',
      trimStart: 4,
      duration: 2,
    },
  ])('rejects $scenario before pending and removes staged audio', async ({
    trimStart,
    duration,
  }) => {
    const harness = await createHarness({ durationReader: async () => 5 });

    await expect(
      harness.startGeneration({ ...harness.audioRequest, trimStart, duration }),
    ).rejects.toThrow(/actual.*duration|trim range/i);

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(await readdir(harness.uploadsDirectory)).toEqual([]);
  });

  test('removes staged audio without pending when duration reading fails', async () => {
    const failure = new Error('ffprobe timed out');
    const harness = await createHarness({
      durationReader: async () => {
        throw failure;
      },
    });

    await expect(harness.startGeneration(harness.audioRequest)).rejects.toBe(failure);

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(await readdir(harness.uploadsDirectory)).toEqual([]);
  });

  test('rejects unselected audio before creating pending work or a copy', async () => {
    const harness = await createHarness();
    const unselectedPath = join(harness.directory, 'unselected.mp3');
    await writeFile(unselectedPath, 'unselected-audio');

    await expect(
      harness.startGeneration({ ...harness.audioRequest, audioPath: unselectedPath }),
    ).rejects.toThrow(/selectAudio/i);

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    await expect(readdir(harness.uploadsDirectory)).rejects.toThrow();
  });

  test('submits audio from a managed speech output without explicit file selection', async () => {
    const harness = await createHarness();
    const speechDirectory = join(harness.outputDirectory, 'SMO-Speech');
    const speechPath = join(speechDirectory, 'existing-speech.wav');
    await mkdir(speechDirectory, { recursive: true });
    await writeFile(speechPath, 'managed-speech-audio');
    harness.comfy.outputs = [
      outputFile({ nodeId: '65', filename: 'audio-result.mp4' }),
    ];

    const result = await harness.startGeneration({
      ...harness.audioRequest,
      audioPath: speechPath,
    });
    await waitForWork(harness.store, result.id, 'done');

    expect(harness.comfy.uploadedAudioContents).toEqual(['managed-speech-audio']);
    expect(harness.comfy.submissions).toHaveLength(1);
    expect(harness.store.getWork(result.id)?.metadata?.request).toMatchObject({
      mode: 'audio',
      audioPath: speechPath,
    });
  });

  test('removes a partial audio copy when staging fails before pending work', async () => {
    const failure = Object.assign(new Error('Simulated copy failure'), { code: 'EIO' });
    const failingCopy: typeof copyFile = async (_source, destination) => {
      await writeFile(destination, 'partial-audio');
      throw failure;
    };
    const harness = await createHarness({ copyFile: failingCopy });

    await expect(harness.startGeneration(harness.audioRequest)).rejects.toBe(failure);

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(await readdir(harness.uploadsDirectory)).toEqual([]);
  });

  test('does not delete an existing destination when staging reports a collision', async () => {
    const collision = Object.assign(new Error('Destination already exists'), {
      code: 'EEXIST',
    });
    let destination = '';
    const collidingCopy: typeof copyFile = async (_source, target) => {
      destination = target.toString();
      await writeFile(target, 'existing-audio');
      throw collision;
    };
    const harness = await createHarness({ copyFile: collidingCopy });

    await expect(harness.startGeneration(harness.audioRequest)).rejects.toBe(collision);

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(await readFile(destination, 'utf8')).toBe('existing-audio');
  });

  test('returns the work id before ComfyUI execution completes', async () => {
    const harness = await createHarness();
    const gate = deferred();
    harness.comfy.completionGate = gate;

    const startPromise = Promise.resolve(harness.startGeneration(harness.textRequest));
    const earlyResult = await Promise.race([
      startPromise,
      delay(50).then(() => null),
    ]);
    gate.resolve();
    const result = await startPromise;
    await waitForWork(harness.store, result.id, 'done');

    expect(earlyResult).toEqual(result);
  });

  test('creates a unique work id for each sequential request', async () => {
    const harness = await createHarness();

    const first = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, first.id, 'done');
    const second = await harness.startGeneration(harness.textRequest);
    await Promise.all([
      waitForWork(harness.store, first.id, 'done'),
      waitForWork(harness.store, second.id, 'done'),
    ]);

    expect(second.id).not.toBe(first.id);
    expect(harness.store.listWorks().map((work) => work.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  test('rejects a second start while active without adding another work', async () => {
    const harness = await createHarness();
    const completionGate = deferred();
    harness.comfy.completionGate = completionGate;
    const addWork = vi.spyOn(harness.store, 'addWork');

    const firstStart = harness.startGeneration(harness.textRequest);
    try {
      const secondStart = harness.startGeneration(harness.textRequest);
      await expect(secondStart).rejects.toThrow(
        'Another generation is already running',
      );
      const first = await firstStart;
      expect(addWork).toHaveBeenCalledTimes(1);
      expect(harness.store.listWorks().map((work) => work.id)).toEqual([first.id]);
      expect(harness.jobCoordinator.activeId).toBe(first.id);
      expect(harness.events.map((event) => event.status)).not.toContain('pending');
    } finally {
      completionGate.resolve();
      await vi.waitFor(() => expect(harness.jobCoordinator.activeCount).toBe(0));
    }
  });

  test('rejects audio before staging when another generation is already active', async () => {
    const copy = vi.fn<typeof copyFile>();
    const durationReader = vi.fn(async () => 60);
    const harness = await createHarness({ copyFile: copy, durationReader });
    const completionGate = deferred();
    harness.comfy.completionGate = completionGate;
    const addWork = vi.spyOn(harness.store, 'addWork');
    const first = await harness.startGeneration(harness.textRequest);

    try {
      await expect(harness.startGeneration(harness.audioRequest)).rejects.toThrow(
        'Another generation is already running',
      );

      expect(copy).not.toHaveBeenCalled();
      expect(durationReader).not.toHaveBeenCalled();
      expect(addWork).toHaveBeenCalledTimes(1);
      expect(harness.store.listWorks().map((work) => work.id)).toEqual([first.id]);
    } finally {
      completionGate.resolve();
      await vi.waitFor(() => expect(harness.jobCoordinator.activeCount).toBe(0));
    }
  });

  test('cleans staged audio when another generation becomes active during staging', async () => {
    const copyStarted = deferred();
    const copyGate = deferred();
    const gatedCopy: typeof copyFile = async (source, destination, mode) => {
      await copyFile(source, destination, mode);
      copyStarted.resolve();
      await copyGate.promise;
    };
    const harness = await createHarness({ copyFile: gatedCopy });
    const completionGate = deferred();
    harness.comfy.completionGate = completionGate;
    const addWork = vi.spyOn(harness.store, 'addWork');
    const audioStart = Promise.resolve(harness.startGeneration(harness.audioRequest));
    audioStart.catch(() => undefined);

    try {
      await copyStarted.promise;
      const stagedFiles = await readdir(harness.uploadsDirectory);
      expect(stagedFiles).toHaveLength(1);
      const stagedPath = join(harness.uploadsDirectory, stagedFiles[0]!);

      const occupying = await harness.startGeneration(harness.textRequest);
      expect(harness.jobCoordinator.activeId).toBe(occupying.id);
      copyGate.resolve();

      await expect(audioStart).rejects.toThrow('Another generation is already running');
      expect(addWork).toHaveBeenCalledTimes(1);
      expect(harness.store.listWorks().map((work) => work.id)).toEqual([occupying.id]);
      await expect(readFile(stagedPath, 'utf8')).rejects.toThrow();
      expect(await readdir(harness.uploadsDirectory)).toEqual([]);
      expect(harness.jobCoordinator.activeId).toBe(occupying.id);
    } finally {
      copyGate.resolve();
      completionGate.resolve();
      await vi.waitFor(() => expect(harness.jobCoordinator.activeCount).toBe(0));
    }
  });

  test('stores only declared request fields in work metadata', async () => {
    const harness = await createHarness();
    const apiKey = 'sk-must-not-be-stored';
    const request = { ...harness.textRequest, apiKey } as GenerationRequest;

    const result = await harness.startGeneration(request);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      acceleration: 'none',
      execution: expect.objectContaining({ stage: 'finalizing' }),
    });
    expect(JSON.stringify(work.metadata)).not.toContain(apiKey);
  });
});

describe('GenerationHandler no reference text to video', () => {
  function noReferenceRequest(
    harness: Awaited<ReturnType<typeof createHarness>>,
  ): VideoGenerationRequest {
    return {
      ...harness.textRequest,
      mode: 'text',
      avatarId: null,
      referenceImagePaths: [],
    } as VideoGenerationRequest;
  }

  test('submits T2VA without avatar lookup or image upload and records the output', async () => {
    const harness = await createHarness();
    const listAvatars = vi.spyOn(harness.store, 'listAvatars');
    const workflowPath = join(workflowsDirectory, 'text-ref2va.json');
    const frozenSource = await readFile(workflowPath, 'utf8');
    const request = noReferenceRequest(harness);

    const result = await harness.startGeneration(request);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(listAvatars).not.toHaveBeenCalled();
    expect(harness.comfy.uploads).toEqual([]);
    const expected = JSON.parse(frozenSource) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    delete expected['226'];
    expected['136'].class_type = 'MiniMaxH3ImageToVideo';
    expected['136'].inputs = {
      clip: expected['136'].inputs.clip,
      vae: expected['136'].inputs.vae,
      prompt: request.prompt,
      width: expected['136'].inputs.width,
      height: expected['136'].inputs.height,
      length: expected['136'].inputs.length,
    };
    expected['132'].inputs.value = request.duration;
    expected['269'].inputs.seed = request.seed;
    expected['124'].inputs.steps = request.steps;
    expected['180'].inputs.filename_prefix = `SMO-H3/${result.id}`;
    expect(harness.comfy.submissions).toEqual([expected]);
    expect(work).toMatchObject({
      id: result.id,
      avatarId: null,
      mode: 'text',
      status: 'done',
      outputPath: join(harness.outputDirectory, 'SMO-H3', 'result.mp4'),
      promptId: 'prompt-1',
      metadata: { request, workflowVersion: 'text-ref2va.json' },
    });
    expect(await readFile(workflowPath, 'utf8')).toBe(frozenSource);
  });

  test('creates an immutable T2VA graph without flat or nested reference inputs', () => {
    const source = {
      '136': {
        class_type: 'MiniMaxH3ReferenceToVideo',
        inputs: {
          clip: ['128', 0],
          vae: ['194', 0],
          prompt: 'prompt',
          width: ['115', 0],
          height: ['115', 1],
          length: ['131', 1],
          audio_vae: ['184', 0],
          ref_image_size: 'match',
          'ref_images.ref_image_0': ['226', 0],
          ref_images: { ref_image_1: ['227', 0] },
        },
      },
      '226': { class_type: 'LoadImage', inputs: { image: 'avatar.png' } },
      '180': { class_type: 'SaveVideo', inputs: { filename_prefix: 'SMO-H3' } },
    };
    const snapshot = structuredClone(source);

    const converted = createNoReferenceTextWorkflow(source);

    expect(source).toEqual(snapshot);
    expect(converted).not.toBe(source);
    expect(converted['136']).toMatchObject({
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['128', 0],
        vae: ['194', 0],
        prompt: 'prompt',
        width: ['115', 0],
        height: ['115', 1],
        length: ['131', 1],
      },
    });
    expect(converted['136'].inputs).not.toHaveProperty('image');
    expect(converted).not.toHaveProperty('226');
    expect(converted['180']).toBe(source['180']);
  });

  test.each([
    null,
    'G:\\refs\\not-an-array.png',
    [''],
    ['   '],
    ['G:\\refs\\valid.png', 42],
    Array.from({ length: 10 }, (_, index) => `G:\\refs\\${index}.png`),
  ])('rejects invalid no reference paths before creating a work: %j', async (
    referenceImagePaths,
  ) => {
    const harness = await createHarness();
    const listAvatars = vi.spyOn(harness.store, 'listAvatars');
    const request = {
      ...noReferenceRequest(harness),
      referenceImagePaths,
    } as unknown as GenerationRequest;

    await expect(harness.startGeneration(request)).rejects.toThrow(
      /referenceImagePaths/i,
    );
    expect(harness.store.listWorks()).toEqual([]);
    expect(listAvatars).not.toHaveBeenCalled();
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
  });

  test('rejects a reference image explicitly instead of silently using T2VA', async () => {
    const harness = await createHarness();
    const listAvatars = vi.spyOn(harness.store, 'listAvatars');
    const request = {
      ...noReferenceRequest(harness),
      referenceImagePaths: ['G:\\refs\\one.png'],
    };

    await expect(harness.startGeneration(request)).rejects.toThrow(
      /reference images.*not supported/i,
    );
    expect(harness.store.listWorks()).toEqual([]);
    expect(listAvatars).not.toHaveBeenCalled();
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
  });

  test.each([
    { avatarId: null, referenceImagePaths: [] },
    { avatarId: 'avatar-1', referenceImagePaths: ['G:\\refs\\one.png'] },
  ])('keeps direct audio avatar and reference validation: %j', async (override) => {
    const harness = await createHarness();
    const request = {
      ...harness.audioRequest,
      ...override,
    } as GenerationRequest;

    await expect(harness.startGeneration(request)).rejects.toThrow(
      /avatarId|reference images/i,
    );
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
  });

  test('keeps the legacy avatar Ref2VA workflow when reference paths are omitted', async () => {
    const harness = await createHarness();
    const {
      referenceImagePaths: _referenceImagePaths,
      ...legacyRequest
    } = harness.textRequest;

    const result = await harness.startGeneration(legacyRequest);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work.avatarId).toBe(harness.avatar.id);
    expect(work.metadata?.request).toEqual({
      ...legacyRequest,
      referenceImagePaths: [],
    });
    expect(harness.comfy.uploads).toEqual([
      { filePath: harness.avatar.photoPath, kind: 'image' },
    ]);
    const graph = harness.comfy.submissions[0] as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(graph['136'].class_type).toBe('MiniMaxH3ReferenceToVideo');
    expect(graph['226'].inputs.image).toBe('uploaded/avatar.png');
  });

  test('cancels no reference execution by prompt id without an image upload', async () => {
    const harness = await createHarness();
    const listAvatars = vi.spyOn(harness.store, 'listAvatars');
    harness.comfy.completionGate = deferred();

    const result = await harness.startGeneration(noReferenceRequest(harness));
    await vi.waitFor(() => expect(harness.comfy.waits).toEqual(['prompt-1']));
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('Generation cancelled');
    expect(harness.comfy.cancelRequests).toEqual(['prompt-1']);
    expect(harness.comfy.uploads).toEqual([]);
    expect(listAvatars).not.toHaveBeenCalled();
  });

  test('retries a new no reference work without avatar lookup or upload', async () => {
    const harness = await createHarness();
    const original = await harness.startGeneration(noReferenceRequest(harness));
    await waitForWork(harness.store, original.id, 'done');
    harness.store.updateWork(original.id, { status: 'failed', error: 'forced failure' });
    const listAvatars = vi.spyOn(harness.store, 'listAvatars');
    await rm(harness.avatar.photoPath);

    const retry = await harness.retryWork(original.id);
    const retryWork = await waitForWork(harness.store, retry.id, 'done');

    expect(retryWork).toMatchObject({
      avatarId: null,
      metadata: {
        request: noReferenceRequest(harness),
        retryOf: original.id,
      },
    });
    expect(listAvatars).not.toHaveBeenCalled();
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toHaveLength(2);
  });

  test('retries legacy no reference metadata without steps or reference paths', async () => {
    const harness = await createHarness();
    const legacyRequest = {
      mode: 'text',
      avatarId: null,
      prompt: 'Legacy no reference prompt',
      duration: 8,
      seed: 7,
    } as unknown as GenerationRequest;
    const original = harness.store.addWork({
      id: 'legacy-no-reference',
      avatarId: null,
      mode: 'text',
      outputPath: null,
      status: 'failed',
      metadata: { request: legacyRequest, workflowVersion: 'text-ref2va.json' },
    });
    const listAvatars = vi.spyOn(harness.store, 'listAvatars');
    await rm(harness.avatar.photoPath);

    const retry = await harness.retryWork(original.id);
    const retryWork = await waitForWork(harness.store, retry.id, 'done');

    expect(retryWork.metadata?.request).toEqual({
      ...legacyRequest,
      steps: 8,
      referenceImagePaths: [],
    });
    expect(listAvatars).not.toHaveBeenCalled();
    expect(harness.comfy.uploads).toEqual([]);
    const graph = harness.comfy.submissions[0] as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(graph['124'].inputs.steps).toBe(8);
    expect(graph['136'].class_type).toBe('MiniMaxH3ImageToVideo');
  });
});


describe('GenerationHandler Spark acceleration', () => {
  const sm120: SparkAccelerationEnvironment = {
    runtimeId: 'sm120',
    hardwareFingerprint: { cudaComputeCapability: '12.0' },
  };

  test.each(
    (['text', 'audio'] as const).flatMap((mode) =>
      [1, 2, 3, mode === 'text' ? 8 : 6, 100].map((steps) => ({ mode, steps })),
    ),
  )(
    'keeps Scheduler, Spark, and SelfLift transitions valid for $mode steps=$steps',
    async ({ mode, steps }) => {
      const harness = await createHarness({ acceleration: sm120 });
      const filename = mode === 'text' ? 'text-ref2va.json' : 'audio-digital-human.json';
      const workflowPath = join(workflowsDirectory, filename);
      const frozenSource = await readFile(workflowPath, 'utf8');
      if (mode === 'audio') {
        harness.comfy.outputs = [outputFile({ nodeId: '65', filename: 'low-steps.mp4' })];
      }
      const source = mode === 'text' ? harness.textRequest : harness.audioRequest;

      const result = await harness.startGeneration({ ...source, steps });
      await waitForWork(harness.store, result.id, 'done');

      const graph = harness.comfy.submissions[0] as Record<
        string,
        { class_type: string; inputs: Record<string, unknown> }
      >;
      const schedulerId = mode === 'text' ? '124' : '51';
      const samplerId = mode === 'text' ? '269' : '86';
      const defaultTransition = mode === 'text' ? 6 : 4;
      const expectedTransition = Math.min(defaultTransition, Math.max(1, steps - 1));
      const transition = graph[samplerId].inputs.transition_step;

      expect(graph[schedulerId].inputs.steps).toBe(steps);
      expect(graph.smo_spark.inputs.steps).toBe(steps);
      expect(transition).toBe(expectedTransition);
      // selflift-Avatar/nodes.py:_validate_schedule requires
      // 1 <= transition_step <= len(sigmas) - 2. For steps >= 2 the
      // unrefined BasicScheduler already provides this bound; steps=1 needs
      // one explicit refiner step so low- and high-resolution each get one NFE.
      expect(transition).toBeGreaterThanOrEqual(1);
      expect(transition).toBeLessThanOrEqual(Math.max(1, steps - 1));

      if (steps === 1 && mode === 'text') {
        expect(graph['147'].inputs).toMatchObject({
          extra_steps: 1,
          start_at_sigma: 20,
        });
        expect(graph[samplerId].inputs.sigmas).toEqual(['147', 0]);
      } else if (steps === 1) {
        const refiner = Object.entries(graph).find(
          ([, node]) => node.class_type === 'H3SigmaRefiner',
        );
        expect(refiner?.[1].inputs).toMatchObject({
          extra_steps: 1,
          start_at_sigma: 20,
          end_at_sigma: 0,
          sigmas: ['51', 0],
        });
        expect(graph[samplerId].inputs.sigmas).toEqual([refiner?.[0], 0]);
      } else {
        if (mode === 'text') {
          expect(graph['147'].inputs.start_at_sigma).toBe(0.7);
        } else {
          expect(
            Object.values(graph).some((node) => node.class_type === 'H3SigmaRefiner'),
          ).toBe(false);
        }
      }
      expect(await readFile(workflowPath, 'utf8')).toBe(frozenSource);
    },
  );

  test('submits the accelerated text graph with twelve scheduler steps and records Spark metadata', async () => {
    const harness = await createHarness({ acceleration: sm120 });

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'done');

    const graph = harness.comfy.submissions[0] as Record<string, any>;
    expect(graph['124'].inputs.steps).toBe(12);
    expect(graph.smo_spark).toMatchObject({
      class_type: 'MiniMaxH3SparkAttentionSM120',
      inputs: { model: ['153', 0], steps: 12 },
    });
    expect(graph['269'].inputs.low_res_model).toEqual(['smo_spark', 0]);
    expect(work.metadata?.acceleration).toBe('spark-sm120');
  });

  test('submits the accelerated audio graph with nine scheduler steps', async () => {
    const harness = await createHarness({ acceleration: sm120 });
    harness.comfy.outputs = [outputFile({ nodeId: '65', filename: 'audio.mp4' })];

    const result = await harness.startGeneration(harness.audioRequest);
    await waitForWork(harness.store, result.id, 'done');

    const graph = harness.comfy.submissions[0] as Record<string, any>;
    expect(graph['51'].inputs.steps).toBe(9);
    expect(graph.smo_spark).toMatchObject({
      class_type: 'MiniMaxH3SparkAttentionSM120',
      inputs: { model: ['62', 0], steps: 9 },
    });
    expect(graph['86'].inputs.low_res_model).toEqual(['smo_spark', 0]);
  });

  test('uses the same Spark acceleration when retrying a failed work', async () => {
    const harness = await createHarness({ acceleration: sm120 });
    const original = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, original.id, 'done');
    harness.store.updateWork(original.id, { status: 'failed', error: 'retry test' });

    const retry = await harness.retryWork(original.id);
    await waitForWork(harness.store, retry.id, 'done');

    expect(harness.comfy.submissions).toHaveLength(2);
    for (const submission of harness.comfy.submissions) {
      expect((submission as Record<string, any>).smo_spark).toBeDefined();
    }
  });

  test('keeps RTX 30 on the compatible graph without Spark', async () => {
    const harness = await createHarness({
      acceleration: {
        runtimeId: 'sm89',
        hardwareFingerprint: { cudaComputeCapability: '8.6' },
      },
    });

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(harness.comfy.submissions[0]).not.toHaveProperty('smo_spark');
    expect(work.metadata?.acceleration).toBe('none');
  });
});


describe("GenerationHandler workflow selection", () => {
  async function writeVariant(path: string, megapixels: number): Promise<void> {
    const graph = JSON.parse(
      await readFile(join(workflowsDirectory, "text-ref2va.json"), "utf8"),
    ) as Record<string, { inputs: Record<string, unknown> }>;
    graph["115"].inputs.megapixels = megapixels;
    await writeFile(path, JSON.stringify(graph));
  }

  test("uses the resolver active copy and records its actual path", async () => {
    let activePath = "";
    const harness = await createHarness({ workflowResolver: () => activePath });
    activePath = join(harness.directory, "active-text.json");
    await writeVariant(activePath, 0.4);

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, "done");

    expect(work.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: activePath,
      acceleration: 'none',
      execution: expect.objectContaining({ stage: 'finalizing' }),
    });
    expect(harness.comfy.submissions[0]).toMatchObject({
      "115": { inputs: { megapixels: 0.4 } },
    });
  });

  test("retry keeps the original workflowVersion after the active copy changes", async () => {
    let activePath = "";
    const harness = await createHarness({ workflowResolver: () => activePath });
    const originalCopy = join(harness.directory, "original-active.json");
    const replacementCopy = join(harness.directory, "replacement-active.json");
    activePath = originalCopy;
    await writeVariant(originalCopy, 0.4);
    await writeVariant(replacementCopy, 1);
    const original = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, original.id, "done");
    harness.store.updateWork(original.id, { status: "failed", error: "retry" });

    activePath = replacementCopy;
    const retry = await harness.retryWork(original.id);
    const retryWork = await waitForWork(harness.store, retry.id, "done");

    expect(retryWork.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: originalCopy,
      acceleration: 'none',
      retryOf: original.id,
      execution: expect.objectContaining({ stage: 'finalizing' }),
    });
    expect(harness.comfy.submissions).toHaveLength(2);
    for (const submission of harness.comfy.submissions) {
      expect(submission).toMatchObject({ "115": { inputs: { megapixels: 0.4 } } });
    }
  });

  test("resolves a relative internal workflowVersion against workflowsDirectory", async () => {
    const customDirectory = await mkdtemp(join(tmpdir(), "smo-h3-workflow-retry-"));
    cleanups.push(() => rm(customDirectory, { recursive: true, force: true }));
    const frozen = await readFile(join(workflowsDirectory, "text-ref2va.json"), "utf8");
    await writeFile(join(customDirectory, "text-ref2va.json"), frozen);
    await writeVariant(join(customDirectory, "custom-text.json"), 0.4);
    const harness = await createHarness({ workflowsDirectory: customDirectory });

    const result = await harness.startGeneration(harness.textRequest, {
      workflowPath: "custom-text.json",
    });
    const work = await waitForWork(harness.store, result.id, "done");

    expect(work.metadata).toMatchObject({ workflowVersion: "custom-text.json" });
    expect(harness.comfy.submissions[0]).toMatchObject({
      "115": { inputs: { megapixels: 0.4 } },
    });
  });
});

  test.each(["../outside.json", "..\\outside.json"])(
    "rejects a relative workflowVersion that escapes workflowsDirectory: %s",
    async (workflowPath) => {
      const customDirectory = await mkdtemp(join(tmpdir(), "smo-h3-workflow-escape-"));
      cleanups.push(() => rm(customDirectory, { recursive: true, force: true }));
      const frozen = await readFile(join(workflowsDirectory, "text-ref2va.json"), "utf8");
      await writeFile(join(customDirectory, "text-ref2va.json"), frozen);
      const harness = await createHarness({ workflowsDirectory: customDirectory });

      const outcome = await Promise.resolve(
        harness.startGeneration(harness.textRequest, { workflowPath }),
      ).then(
        (result) => ({ id: result.id, error: null as string | null }),
        (error: unknown) => ({
          id: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

      if (outcome.id !== null) {
        const work = await waitForWork(harness.store, outcome.id, "failed");
        expect(work.error).toMatch(/workflow.*escapes/i);
      } else {
        expect(outcome.error).toMatch(/workflow.*escapes/i);
      }
      expect(harness.comfy.submissions).toEqual([]);
    },
  );

describe('GenerationHandler validation', () => {
  test.each(['', '   '])('rejects an empty avatarId %j before creating a work', async (avatarId) => {
    const harness = await createHarness();

    await expect(
      harness.startGeneration({ ...harness.textRequest, avatarId }),
    ).rejects.toThrow(/avatarId.*empty/i);
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
  });

  test.each(['', '   '])('rejects an empty prompt %j before creating a work', async (prompt) => {
    const harness = await createHarness();

    await expect(
      harness.startGeneration({ ...harness.textRequest, prompt }),
    ).rejects.toThrow(/prompt.*empty/i);
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid seed %s before creating a work',
    async (seed) => {
      const harness = await createHarness();

      await expect(
        harness.startGeneration({ ...harness.textRequest, seed }),
      ).rejects.toThrow(/seed.*non-negative integer/i);
      expect(harness.store.listWorks()).toEqual([]);
      expect(harness.comfy.uploads).toEqual([]);
    },
  );

  test('rejects a missing avatar before creating a work or uploading', async () => {
    const harness = await createHarness();

    await expect(
      harness.startGeneration({ ...harness.textRequest, avatarId: 'missing' }),
    ).rejects.toThrow(/avatar not found/i);
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
  });

  test.each([0, 3.99, 15.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid text duration %s',
    async (duration) => {
      const harness = await createHarness();

      await expect(
        harness.startGeneration({ ...harness.textRequest, duration }),
      ).rejects.toThrow(/duration.*4.*15/i);
      expect(harness.store.listWorks()).toEqual([]);
      expect(harness.comfy.uploads).toEqual([]);
    },
  );

  test.each([
    { audioPath: undefined },
    { audioPath: '' },
    { audioPath: '   ' },
    { duration: 0 },
    { duration: -1 },
    { duration: Number.NaN },
    { duration: Number.POSITIVE_INFINITY },
    { trimStart: -0.1 },
    { trimStart: Number.NaN },
    { trimStart: Number.POSITIVE_INFINITY },
  ])('rejects an invalid audio request: %j', async (override) => {
    const harness = await createHarness();
    const request = { ...harness.audioRequest, ...override } as GenerationRequest;

    await expect(harness.startGeneration(request)).rejects.toThrow(
      /audioPath|duration|trimStart/i,
    );
    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
  });
});

describe('GenerationHandler output selection', () => {
  test('selects the final output MP4 when a temp MP4 appears first', async () => {
    const harness = await createHarness();
    harness.comfy.outputs = [
      outputFile({ type: 'temp', filename: 'preview.mp4' }),
      outputFile({ type: 'output', filename: 'final.mp4' }),
    ];

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work.outputPath).toBe(
      join(harness.outputDirectory, 'SMO-H3', 'final.mp4'),
    );
  });

  test('fails when history contains only a temp MP4', async () => {
    const harness = await createHarness();
    harness.comfy.outputs = [outputFile({ type: 'temp', filename: 'preview.mp4' })];

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/MP4/i);
    expect(work.outputPath).toBeNull();
  });

  test('fails when history contains only a final WebM', async () => {
    const harness = await createHarness();
    harness.comfy.outputs = [outputFile({ type: 'output', filename: 'result.webm' })];

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/MP4/i);
    expect(work.outputPath).toBeNull();
  });

  test.each([
    { mode: 'text', wrongNodeId: '65' },
    { mode: 'audio', wrongNodeId: '180' },
  ] as const)('rejects an MP4 from the wrong node for $mode mode', async ({
    mode,
    wrongNodeId,
  }) => {
    const harness = await createHarness();
    harness.comfy.outputs = [
      outputFile({ nodeId: wrongNodeId, type: 'output', filename: 'wrong-node.mp4' }),
    ];
    const request = mode === 'text' ? harness.textRequest : harness.audioRequest;

    const result = await harness.startGeneration(request);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/MP4/i);
    expect(work.outputPath).toBeNull();
  });
});

describe('GenerationHandler failures and cancellation', () => {
  test('cleans staged audio when image upload fails before audio upload', async () => {
    const harness = await createHarness();
    harness.comfy.uploadErrors.image = new Error('image upload failed');

    const result = await harness.startGeneration(harness.audioRequest);
    await waitForJobEvent(harness.events, result.id, 'failed');

    await expect(
      readFile(join(harness.uploadsDirectory, `${result.id}.mp3`), 'utf8'),
    ).rejects.toThrow();
    expect(harness.store.listWorks().find((work) => work.id === result.id)).toMatchObject({
      status: 'failed',
      error: 'image upload failed',
    });
    expect(harness.comfy.submissions).toEqual([]);
  });

  test('keeps staged cleanup safe when workflow reading fails', async () => {
    const harness = await createHarness({
      workflowsDirectory: join(tmpdir(), 'smo-workflows-that-do-not-exist'),
    });

    const result = await harness.startGeneration(harness.audioRequest);
    await waitForJobEvent(harness.events, result.id, 'failed');

    await expect(
      readFile(join(harness.uploadsDirectory, `${result.id}.mp3`), 'utf8'),
    ).rejects.toThrow();
    expect(harness.store.listWorks().find((work) => work.id === result.id)?.status).toBe(
      'failed',
    );
    expect(harness.comfy.submissions).toEqual([]);
  });

  test('cleans staged audio when cancellation happens before audio upload and submit', async () => {
    const harness = await createHarness();
    const uploadGate = deferred();
    harness.comfy.uploadGate = uploadGate;

    const result = await harness.startGeneration(harness.audioRequest);
    await vi.waitFor(() => expect(harness.comfy.uploads).toHaveLength(1));
    await harness.jobCoordinator.cancelActive();
    uploadGate.resolve();
    await waitForJobEvent(harness.events, result.id, 'failed');

    await expect(
      readFile(join(harness.uploadsDirectory, `${result.id}.mp3`), 'utf8'),
    ).rejects.toThrow();
    expect(harness.store.listWorks().find((work) => work.id === result.id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/cancel/i),
    });
    expect(harness.comfy.submissions).toEqual([]);
  });

  test('reports final cleanup failure without changing a done result', async () => {
    const cleanupFailure = new Error('final cleanup failed');
    const cleanupErrorReporter = vi.fn();
    let removals = 0;
    const removeFile: typeof rm = async (...args) => {
      removals += 1;
      if (removals === 2) {
        throw cleanupFailure;
      }
      return rm(...args);
    };
    const harness = await createHarness({ removeFile, cleanupErrorReporter });
    harness.comfy.outputs = [
      outputFile({ nodeId: '65', filename: 'audio-result.mp4' }),
    ];

    const result = await harness.startGeneration(harness.audioRequest);
    await waitForJobEvent(harness.events, result.id, 'done');

    expect(cleanupErrorReporter).toHaveBeenCalledWith(cleanupFailure);
    expect(harness.store.listWorks().find((work) => work.id === result.id)).toMatchObject({
      status: 'done',
      error: null,
    });
  });

  test('reports final cleanup failure without masking the original job error', async () => {
    const cleanupFailure = new Error('final cleanup failed');
    const cleanupErrorReporter = vi.fn();
    const removeFile: typeof rm = async () => {
      throw cleanupFailure;
    };
    const harness = await createHarness({ removeFile, cleanupErrorReporter });
    harness.comfy.uploadErrors.image = new Error('image upload failed');

    const result = await harness.startGeneration(harness.audioRequest);
    await waitForJobEvent(harness.events, result.id, 'failed');

    expect(cleanupErrorReporter).toHaveBeenCalledWith(cleanupFailure);
    expect(harness.store.listWorks().find((work) => work.id === result.id)).toMatchObject({
      status: 'failed',
      error: 'image upload failed',
    });
  });

  test.each(['image', 'audio'] as const)(
    'records an %s upload failure without submitting',
    async (kind) => {
      const harness = await createHarness();
      harness.comfy.uploadErrors[kind] = new Error(`${kind} upload failed`);
      const request = kind === 'audio' ? harness.audioRequest : harness.textRequest;

      const result = await harness.startGeneration(request);
      const work = await waitForWork(harness.store, result.id, 'failed');

      expect(work.error).toBe(`${kind} upload failed`);
      expect(work.outputPath).toBeNull();
      expect(harness.comfy.submissions).toEqual([]);
      if (kind === 'audio') {
        await expect(
          readFile(join(harness.uploadsDirectory, `${result.id}.mp3`), 'utf8'),
        ).rejects.toThrow();
      }
    },
  );

  test('records a submit failure without a prompt id or output', async () => {
    const harness = await createHarness();
    harness.comfy.submitError = new Error('submit rejected');

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work).toMatchObject({
      status: 'failed',
      error: 'submit rejected',
      promptId: null,
      outputPath: null,
    });
    expect(harness.comfy.waits).toEqual([]);
    expect(harness.comfy.histories).toEqual([]);
  });

  test('records an execution failure after retaining the prompt id', async () => {
    const harness = await createHarness();
    harness.comfy.completionError = new Error('GPU execution failed');

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work).toMatchObject({
      status: 'failed',
      error: 'GPU execution failed',
      promptId: 'prompt-1',
      outputPath: null,
    });
    expect(harness.comfy.histories).toEqual([]);
  });

  test('fails instead of fabricating an output when history has no video', async () => {
    const harness = await createHarness();
    harness.comfy.outputs = [
      outputFile({ kind: 'images', filename: 'cover.png', subfolder: '' }),
    ];

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/video output/i);
    expect(work.outputPath).toBeNull();
  });

  test('cancels during upload without interrupting ComfyUI or submitting', async () => {
    const harness = await createHarness();
    const uploadGate = deferred();
    harness.comfy.uploadGate = uploadGate;

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.uploads).toHaveLength(1));
    await harness.jobCoordinator.cancelActive();
    const cancellationsBeforeUploadFinished = harness.comfy.cancellations;
    uploadGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(cancellationsBeforeUploadFinished).toBe(0);
    expect(harness.comfy.cancellations).toBe(0);
    expect(harness.comfy.submissions).toEqual([]);
    expect(work.error).toMatch(/cancel/i);
    expect(work.outputPath).toBeNull();
  });

  test('cancels before submit without reading a prompt id or interrupting ComfyUI', async () => {
    const harness = await createHarness();

    const result = await harness.startGeneration(harness.textRequest);
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(harness.comfy.cancellations).toBe(0);
    expect(harness.comfy.submissions).toEqual([]);
    expect(work).toMatchObject({
      status: 'failed',
      promptId: null,
      outputPath: null,
    });
    expect(work.error).toMatch(/cancel/i);
  });

  test('interrupts immediately after a submit that finishes while cancellation is requested', async () => {
    const harness = await createHarness();
    const submitGate = deferred<ComfySubmitResult>();
    harness.comfy.submitGate = submitGate;

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.submissions).toHaveLength(1));
    await harness.jobCoordinator.cancelActive();
    const cancellationsBeforeSubmitFinished = harness.comfy.cancellations;
    submitGate.resolve({ prompt_id: 'cancelled-prompt', number: 1, node_errors: {} });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(cancellationsBeforeSubmitFinished).toBe(0);
    expect(harness.comfy.cancellations).toBe(1);
    expect(harness.comfy.waits).toEqual([]);
    expect(harness.comfy.histories).toEqual([]);
    expect(work).toMatchObject({
      status: 'failed',
      promptId: 'cancelled-prompt',
      outputPath: null,
    });
    expect(work.error).toMatch(/cancel/i);
  });

  test('cancels the active ComfyUI execution and records Generation cancelled', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.waits).toEqual(['prompt-1']));
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(harness.comfy.cancellations).toBe(1);
    expect(work).toMatchObject({
      status: 'failed',
      error: 'Generation cancelled',
      outputPath: null,
    });
  });

  test('records Generation cancelled when the cancelled prompt vanishes from the backend queue', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();
    harness.comfy.cancelError = new Error(
      'ComfyUI prompt is no longer queued and has no recorded result',
    );

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.waits).toEqual(['prompt-1']));
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(harness.comfy.cancellations).toBe(1);
    expect(work).toMatchObject({
      status: 'failed',
      promptId: 'prompt-1',
      error: 'Generation cancelled',
      outputPath: null,
    });
  });

  test('cancels during history without interrupting completed execution or writing done', async () => {
    const harness = await createHarness();
    const historyGate = deferred();
    harness.comfy.historyGate = historyGate;

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.histories).toEqual(['prompt-1']));
    await harness.jobCoordinator.cancelActive();
    const cancellationsDuringHistory = harness.comfy.cancellations;
    historyGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(cancellationsDuringHistory).toBe(0);
    expect(harness.comfy.cancellations).toBe(0);
    expect(work).toMatchObject({ status: 'failed', outputPath: null });
    expect(work.error).toMatch(/cancel/i);
  });

  test('does not write done when cancelled after the last async step', async () => {
    const harness = await createHarness();
    const originalHistory = harness.comfy.history.bind(harness.comfy);
    harness.comfy.history = async (promptId) => {
      const result = await originalHistory(promptId);
      void harness.jobCoordinator.cancelActive();
      return result;
    };

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.status).toBe('failed');
    expect(work.error).toMatch(/cancel/i);
    expect(work.outputPath).toBeNull();
  });

  test.each([
    { subfolder: '../outside', filename: 'escape.mp4' },
    { subfolder: 'SMO-H3', filename: '../escape.mp4' },
    { subfolder: 'SMO-H3', filename: '..\\escape.mp4' },
    { subfolder: 'C:\\outside', filename: 'escape.mp4' },
    { subfolder: '/outside', filename: 'escape.mp4' },
  ])('rejects an output outside outputDirectory: %j', async ({ subfolder, filename }) => {
    const harness = await createHarness();
    harness.comfy.outputs = [outputFile({ subfolder, filename })];

    const result = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/output path|output directory|traversal/i);
    expect(work.outputPath).toBeNull();
  });
});


describe('GenerationHandler retry', () => {
  test.each([
    { mode: 'text', expectedSteps: 8, schedulerId: '124' },
    { mode: 'audio', expectedSteps: 6, schedulerId: '51' },
  ] as const)(
    'retries legacy $mode request metadata with $expectedSteps steps',
    async ({ mode, expectedSteps, schedulerId }) => {
      const harness = await createHarness();
      const source = mode === 'text' ? harness.textRequest : harness.audioRequest;
      const legacyRequest: Partial<GenerationRequest> = { ...source };
      delete legacyRequest.steps;
      delete legacyRequest.referenceImagePaths;
      if (mode === 'audio') {
        harness.comfy.outputs = [
          outputFile({ nodeId: '65', filename: 'legacy-audio.mp4' }),
        ];
      }
      const original = harness.store.addWork({
        id: `legacy-${mode}-steps`,
        avatarId: harness.avatar.id,
        mode,
        outputPath: null,
        status: 'failed',
        metadata: {
          request: legacyRequest as GenerationRequest,
          workflowVersion:
            mode === 'text' ? 'text-ref2va.json' : 'audio-digital-human.json',
        },
      });

      const retry = await harness.retryWork(original.id);
      const retryWork = await waitForWork(harness.store, retry.id, 'done');

      const graph = harness.comfy.submissions[0] as Record<
        string,
        { inputs: Record<string, unknown> }
      >;
      expect(graph[schedulerId].inputs.steps).toBe(expectedSteps);
      expect(retryWork.metadata?.request?.steps).toBe(expectedSteps);
      expect(harness.store.getWork(original.id)?.metadata?.request).not.toHaveProperty(
        'steps',
      );
    },
  );

  test('retries legacy subtitle metadata without injecting subtitle guidance', async () => {
    const harness = await createHarness();
    const legacyRequest = {
      ...harness.textRequest,
      prompt: '旧作品原始提示词',
      subtitles: true,
    } as GenerationRequest;
    const original = harness.store.addWork({
      id: 'legacy-subtitle-work',
      avatarId: harness.avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'failed',
      metadata: {
        request: legacyRequest,
        workflowVersion: 'text-ref2va.json',
      },
    });

    const retry = await harness.retryWork(original.id);
    const retryWork = await waitForWork(harness.store, retry.id, 'done');

    expect(submittedPrompt(harness)).toBe('旧作品原始提示词');
    expect(retryWork.metadata?.request).not.toHaveProperty('subtitles');
    expect(harness.store.getWork(original.id)?.metadata?.request).toHaveProperty(
      'subtitles',
      true,
    );
  });

  test('creates a new work with retryOf and leaves the original unchanged', async () => {
    const harness = await createHarness();
    const original = await harness.startGeneration(harness.textRequest);
    await waitForWork(harness.store, original.id, 'done');
    harness.store.updateWork(original.id, { status: 'failed', error: 'forced failure' });

    const retry = await harness.retryWork(original.id);
    const retryWork = await waitForWork(harness.store, retry.id, 'done');

    expect(retry.id).not.toBe(original.id);
    expect(retryWork.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      acceleration: 'none',
      retryOf: original.id,
      execution: expect.objectContaining({ stage: 'finalizing' }),
    });
    const originalAfterRetry = harness.store.listWorks().find((work) => work.id === original.id);
    expect(originalAfterRetry?.status).toBe('failed');
    expect(originalAfterRetry?.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
      acceleration: 'none',
      execution: expect.objectContaining({ stage: 'finalizing' }),
    });
  });

  test('re-authorizes original audio and retries an audio work', async () => {
    const harness = await createHarness();
    harness.comfy.outputs = [outputFile({ nodeId: '65', filename: 'audio-result.mp4' })];

    const original = await harness.startGeneration(harness.audioRequest);
    await waitForWork(harness.store, original.id, 'done');
    harness.store.updateWork(original.id, { status: 'failed', error: 'forced failure' });

    const retry = await harness.retryWork(original.id);
    const retryWork = await waitForWork(harness.store, retry.id, 'done');

    expect(retryWork.mode).toBe('audio');
    expect(retryWork.metadata).toMatchObject({ retryOf: original.id });
    expect(harness.comfy.uploadedAudioContents.slice(-1)).toEqual(['audio-test-bytes']);
  });

  test('fails when the original work is missing metadata', async () => {
    const harness = await createHarness();
    const work = harness.store.addWork({
      id: 'work-no-metadata',
      avatarId: harness.avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'failed',
    });

    await expect(harness.retryWork(work.id)).rejects.toThrow(/metadata/i);
    expect(harness.store.listWorks()).toHaveLength(1);
  });

  test('fails when the original avatar photo is missing', async () => {
    const harness = await createHarness();
    const work = harness.store.addWork({
      id: 'work-missing-photo',
      avatarId: harness.avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'failed',
      metadata: {
        request: harness.textRequest,
        workflowVersion: 'text-ref2va.json',
      },
    });
    await rm(harness.avatar.photoPath);

    await expect(harness.retryWork(work.id)).rejects.toThrow(/photo|missing/i);
  });

  test('fails when the original audio is missing for an audio work', async () => {
    const harness = await createHarness();
    const work = harness.store.addWork({
      id: 'work-missing-audio',
      avatarId: harness.avatar.id,
      mode: 'audio',
      outputPath: null,
      status: 'failed',
      metadata: {
        request: harness.audioRequest,
        workflowVersion: 'audio-digital-human.json',
      },
    });
    await rm(harness.audioRequest.audioPath!);

    await expect(harness.retryWork(work.id)).rejects.toThrow(/audio|missing/i);
  });

  test.each([
    { scenario: 'missing mode', request: { avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1 } },
    { scenario: 'invalid mode', request: { mode: 'video', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1 } },
    { scenario: 'empty avatarId', request: { mode: 'text', avatarId: '', prompt: 'p', duration: 8, seed: 1 } },
    { scenario: 'empty prompt', request: { mode: 'text', avatarId: 'avatar-1', prompt: '  ', duration: 8, seed: 1 } },
    { scenario: 'invalid duration', request: { mode: 'text', avatarId: 'avatar-1', prompt: 'p', duration: -1, seed: 1 } },
    { scenario: 'invalid seed', request: { mode: 'text', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1.5 } },
    { scenario: 'zero steps', request: { mode: 'text', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, steps: 0 } },
    { scenario: 'too many steps', request: { mode: 'text', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, steps: 101 } },
    { scenario: 'fractional steps', request: { mode: 'text', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, steps: 1.5 } },
    { scenario: 'invalid audioPath type', request: { mode: 'audio', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, audioPath: 123 } },
    { scenario: 'invalid trimStart', request: { mode: 'audio', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, audioPath: 'a.mp3', trimStart: -1 } },
    { scenario: 'invalid subtitles type', request: { mode: 'text', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, subtitles: 'yes' } },
    { scenario: 'null reference paths', request: { mode: 'text', avatarId: null, prompt: 'p', duration: 8, seed: 1, referenceImagePaths: null } },
    { scenario: 'blank reference path', request: { mode: 'text', avatarId: null, prompt: 'p', duration: 8, seed: 1, referenceImagePaths: [' '] } },
    { scenario: 'too many reference paths', request: { mode: 'text', avatarId: null, prompt: 'p', duration: 8, seed: 1, referenceImagePaths: Array.from({ length: 10 }, (_, index) => `${index}.png`) } },
    { scenario: 'unsupported reference image', request: { mode: 'text', avatarId: null, prompt: 'p', duration: 8, seed: 1, referenceImagePaths: ['a.png'] } },
    { scenario: 'audio null avatar', request: { mode: 'audio', avatarId: null, prompt: 'p', duration: 8, seed: 1, audioPath: 'a.mp3', referenceImagePaths: [] } },
    { scenario: 'audio reference image', request: { mode: 'audio', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, audioPath: 'a.mp3', referenceImagePaths: ['a.png'] } },
  ])('rejects a work with $scenario in metadata', async ({ request }) => {
    const harness = await createHarness();
    const work = harness.store.addWork({
      id: 'work-invalid-request',
      avatarId: harness.avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'failed',
      metadata: {
        request: request as GenerationRequest,
        workflowVersion: 'text-ref2va.json',
      },
    });

    await expect(harness.retryWork(work.id)).rejects.toThrow(/invalid|metadata/i);
    expect(harness.store.listWorks()).toHaveLength(1);
  });

  test.each(['pending', 'running', 'done'] as const)(
    'rejects retrying a %s work before reading metadata',
    async (status) => {
      const harness = await createHarness();
      const work = harness.store.addWork({
        id: `work-${status}`,
        avatarId: harness.avatar.id,
        mode: 'text',
        outputPath: status === 'done' ? join(harness.outputDirectory, 'done.mp4') : null,
        status,
        metadata: {
          request: harness.textRequest,
          workflowVersion: 'text-ref2va.json',
        },
      });

      await expect(harness.retryWork(work.id)).rejects.toThrow(/failed/i);
      expect(harness.store.listWorks()).toHaveLength(1);
    },
  );
});

describe('GenerationHandler ComfyUI startup', () => {
  test('marks a new work failed when the coordinator is already closed', async () => {
    const harness = await createHarness();
    await harness.jobCoordinator.close();

    await expect(harness.startGeneration(harness.textRequest)).rejects.toThrow(
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

  test('fails the queued work without uploading when ComfyUI startup fails', async () => {
    const ensureReady = vi
      .fn()
      .mockRejectedValue(new Error('ComfyUI startup timed out after 180000 ms'));
    const harness = await createHarness({ ensureReady });

    const { id } = await harness.startGeneration(harness.textRequest);
    const work = await waitForWork(harness.store, id, 'failed');

    expect(work.error).toContain('ComfyUI startup timed out');
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(harness.comfy.uploads).toHaveLength(0);
    expect(harness.comfy.submissions).toHaveLength(0);
  });
});
