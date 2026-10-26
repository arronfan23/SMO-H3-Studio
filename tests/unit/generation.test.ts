// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, writeFile, type copyFile } from 'node:fs/promises';
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
import { FileService } from '../../src/main/files';
import { createGenerationHandler, createRetryHandler } from '../../src/main/generation';
import { JobCoordinator, type JobEvent } from '../../src/main/jobs';
import { MediaRegistry } from '../../src/main/media';
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
  readonly uploadedAudioContents: string[] = [];
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
  historyGate?: Deferred<void>;
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
    if (this.historyGate) {
      await this.historyGate.promise;
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

async function createHarness(
  options: {
    copyFile?: typeof copyFile;
    durationReader?: (filePath: string) => Promise<number>;
    workflowsDirectory?: string;
    removeFile?: typeof rm;
    cleanupErrorReporter?: (error: unknown) => void;
    workflowResolver?: (mode: GenerationRequest["mode"]) => string;
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
    copyFile: options.copyFile,
    durationReader: options.durationReader ?? (async () => 60),
    removeFile: options.removeFile,
    cleanupErrorReporter: options.cleanupErrorReporter,
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
      retryOf: original.id,
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
      retryOf: original.id,
    });
    const originalAfterRetry = harness.store.listWorks().find((work) => work.id === original.id);
    expect(originalAfterRetry?.status).toBe('failed');
    expect(originalAfterRetry?.metadata).toEqual({
      request: harness.textRequest,
      workflowVersion: 'text-ref2va.json',
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
    { scenario: 'invalid audioPath type', request: { mode: 'audio', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, audioPath: 123 } },
    { scenario: 'invalid trimStart', request: { mode: 'audio', avatarId: 'avatar-1', prompt: 'p', duration: 8, seed: 1, audioPath: 'a.mp3', trimStart: -1 } },
  ])('rejects a work with $scenario in metadata', async ({ request }) => {
    const harness = await createHarness();
    const work = harness.store.addWork({
      id: 'work-invalid-request',
      avatarId: harness.avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'failed',
      metadata: {
        request,
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
