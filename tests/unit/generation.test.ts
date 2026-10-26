// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ComfyClient,
  ComfyOutputFile,
  ComfySubmitResult,
} from '../../src/main/comfy';
import { createGenerationHandler } from '../../src/main/generation';
import { JobCoordinator, type JobEvent } from '../../src/main/jobs';
import { Store } from '../../src/main/store';
import type {
  GenerationRequest,
  Work,
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
  readonly submissions: unknown[] = [];
  readonly waits: string[] = [];
  readonly histories: string[] = [];
  readonly uploadErrors: Partial<Record<'image' | 'audio', Error>> = {};
  promptId = 'prompt-1';
  submitError?: Error;
  completionError?: Error;
  historyError?: Error;
  completionGate?: Deferred<void>;
  uploadGate?: Deferred<void>;
  submitGate?: Deferred<ComfySubmitResult>;
  cancellations = 0;
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

  async waitForCompletion(promptId: string): Promise<void> {
    this.waits.push(promptId);
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
    return this.outputs;
  }

  async cancel(): Promise<void> {
    this.cancellations += 1;
    this.completionGate?.reject(new Error('ComfyUI execution interrupted'));
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
const workflowsDirectory = fileURLToPath(
  new URL('../../resources/workflows/', import.meta.url),
);

async function createHarness() {
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
    workflowsDirectory,
    outputDirectory,
  });
  const textRequest: GenerationRequest = {
    mode: 'text',
    avatarId: avatar.id,
    prompt: 'A quiet studio shot.',
    duration: 8,
    seed: 42,
  };
  const audioRequest: GenerationRequest = {
    ...textRequest,
    mode: 'audio',
    prompt: 'Natural lip movement and a steady camera.',
    duration: 6.5,
    seed: 99,
    audioPath,
  };

  cleanups.push(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    audioRequest,
    avatar,
    comfy,
    events,
    jobCoordinator,
    outputDirectory,
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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('GenerationHandler workflows', () => {
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
      promptId: 'prompt-1',
      error: null,
      metadata: { request, workflowVersion: 'text-ref2va.json' },
    });
    expect(harness.events.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: result.id, status: 'pending' },
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
        { filePath: harness.audioRequest.audioPath, kind: 'audio' },
      ]);
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
      expected['65'].inputs.filename_prefix = `SMO-H3/${result.id}`;
      expect(harness.comfy.submissions).toEqual([expected]);
      expect(work.status).toBe('done');
      expect(work.outputPath).toBe(
        join(harness.outputDirectory, 'SMO-H3', 'audio-result.mp4'),
      );
      expect(await readFile(workflowPath, 'utf8')).toBe(frozenSource);
    },
  );

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

  test('creates a unique work id for each request', async () => {
    const harness = await createHarness();

    const first = await harness.startGeneration(harness.textRequest);
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

  test('stores only declared request fields in work metadata', async () => {
    const harness = await createHarness();
    const apiKey = 'sk-must-not-be-stored';
    const request = { ...harness.textRequest, apiKey } as GenerationRequest;

    const result = await harness.startGeneration(request);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
    });
    expect(JSON.stringify(work.metadata)).not.toContain(apiKey);
  });
});

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

  test('cancels the active ComfyUI execution and records the interruption', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();

    const result = await harness.startGeneration(harness.textRequest);
    await vi.waitFor(() => expect(harness.comfy.waits).toEqual(['prompt-1']));
    await harness.jobCoordinator.cancelActive();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(harness.comfy.cancellations).toBe(1);
    expect(work).toMatchObject({
      status: 'failed',
      error: 'ComfyUI execution interrupted',
      outputPath: null,
    });
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
