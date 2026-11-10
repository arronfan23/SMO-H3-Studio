// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppServices } from '../../src/main/app-services';
import type {
  ComfyClient,
  ComfyExecutionUpdate,
  ComfyOutputFile,
  ComfyProgress,
  ComfySubmitResult,
} from '../../src/main/comfy';
import { ComfyClient as ComfyClientClass } from '../../src/main/comfy';
import { ComfyProcessManager } from '../../src/main/comfy-process';
import {
  createRetryHandler,
  type GenerationHandler,
} from '../../src/main/generation';
import { HardwareWorkflowStore } from '../../src/main/hardware-workflows';
import {
  createImageGenerationHandler,
  type ImageGenerationHandlerOptions,
} from '../../src/main/image-generation';
import type { ImageWorkflowGraph } from '../../src/main/image-workflow';
import { JobCoordinator, type JobEvent } from '../../src/main/jobs';
import { MediaComponentService } from '../../src/main/media-components';
import { MediaRegistry } from '../../src/main/media';
import { Store } from '../../src/main/store';
import type { MediaComponentState } from '../../src/shared/media-components';
import type {
  ImageGenerationRequest,
  Work,
  WorkProgress,
  WorkStatus,
} from '../../src/shared/types';

const { protocolRegisterFileProtocol } = vi.hoisted(() => ({
  protocolRegisterFileProtocol: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => join(tmpdir(), 'smo-image-test-user-data'),
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

function pngOutput(
  workId: string,
  overrides: Partial<ComfyOutputFile> = {},
): ComfyOutputFile {
  return {
    nodeId: '461',
    kind: 'images',
    filename: `${workId}_00001.png`,
    subfolder: 'SMO-Image',
    type: 'output',
    ...overrides,
  };
}

class FakeComfyClient {
  readonly uploads: Parameters<ComfyClient['uploadFile']>[0][] = [];
  readonly submissions: ImageWorkflowGraph[] = [];
  readonly waits: string[] = [];
  readonly histories: string[] = [];
  readonly cancelRequests: Array<string | undefined> = [];
  readonly promptId = 'image-prompt-1';
  completionGate?: Deferred<void>;
  completionError?: Error;
  cancelError?: Error;
  submitError?: Error;
  progressEvents: ComfyProgress[] = [];
  executionUpdates: ComfyExecutionUpdate[] = [];
  outputFactory?: (workId: string) => ComfyOutputFile[];

  async uploadFile(input: Parameters<ComfyClient['uploadFile']>[0]): Promise<string> {
    this.uploads.push(input);
    return 'unexpected-upload.png';
  }

  async submit(prompt: unknown): Promise<ComfySubmitResult> {
    this.submissions.push(structuredClone(prompt) as ImageWorkflowGraph);
    if (this.submitError) throw this.submitError;
    return { prompt_id: this.promptId, number: 1, node_errors: {} };
  }

  async waitForCompletion(
    promptId: string,
    onProgress?: (progress: ComfyProgress) => void,
    onUpdate?: (update: ComfyExecutionUpdate) => void,
  ): Promise<void> {
    this.waits.push(promptId);
    for (const update of this.executionUpdates) onUpdate?.(update);
    for (const progress of this.progressEvents) onProgress?.(progress);
    if (this.completionGate) await this.completionGate.promise;
    if (this.completionError) throw this.completionError;
  }

  async history(promptId: string): Promise<ComfyOutputFile[]> {
    this.histories.push(promptId);
    const graph = this.submissions[this.submissions.length - 1];
    const prefix = String(graph['461'].inputs.filename_prefix);
    const workId = prefix.slice(prefix.lastIndexOf('/') + 1);
    return this.outputFactory?.(workId) ?? [pngOutput(workId)];
  }

  async cancel(promptId?: string): Promise<void> {
    this.cancelRequests.push(promptId);
    if (this.cancelError) throw this.cancelError;
    this.completionGate?.reject(new Error('ComfyUI execution interrupted'));
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
const workflowsDirectory = fileURLToPath(
  new URL('../../resources/workflows/', import.meta.url),
);

async function waitForWork(
  store: Store,
  id: string,
  status: WorkStatus,
): Promise<Work> {
  await vi.waitFor(() => expect(store.getWork(id)?.status).toBe(status), {
    timeout: 1_000,
    interval: 5,
  });
  return store.getWork(id)!;
}

async function createHarness(
  overrides: Partial<ImageGenerationHandlerOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'smo-image-generation-'));
  const store = new Store(':memory:');
  const outputDirectory = join(directory, 'output');
  const mediaRegistry = new MediaRegistry({
    avatarsDirectory: join(directory, 'avatars'),
    outputDirectory,
  });
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
  const comfy = new FakeComfyClient();
  const events: JobEvent[] = [];
  const terminalSnapshots: Array<{
    activeCount: number;
    progress: WorkProgress | undefined;
  }> = [];
  const jobCoordinator = new JobCoordinator({
    onEvent: (event) => {
      events.push(event);
      if (event.status === 'done' || event.status === 'failed') {
        terminalSnapshots.push({
          activeCount: jobCoordinator.activeCount,
          progress: store.getWork(event.id)?.metadata?.progress,
        });
      }
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
  const ensureReady = vi.fn(async () => ({ system: {}, devices: [] }));
  const startImage = createImageGenerationHandler({
    store,
    comfy,
    mediaComponents,
    jobCoordinator,
    workflowsDirectory,
    outputDirectory,
    ensureReady,
    ...overrides,
  });
  const request: ImageGenerationRequest = {
    mode: 'image',
    prompt: '雨后的玻璃温室，柔和晨光',
    width: 1344,
    height: 768,
    seed: 99,
    steps: 30,
  };

  cleanups.push(async () => {
    await jobCoordinator.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    comfy,
    directory,
    ensureReady,
    events,
    jobCoordinator,
    mediaComponents,
    mediaRegistry,
    outputDirectory,
    request,
    setComponentStatus: (status: MediaComponentState['status']) => {
      componentStatus = status;
    },
    startImage,
    store,
    terminalSnapshots,
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('image generation validation and submission', () => {
  test('image rejects a component that is not ready before creating a work', async () => {
    const harness = await createHarness();
    harness.setComponentStatus('missing');

    await expect(harness.startImage(harness.request)).rejects.toThrow(
      /image component.*ready/i,
    );

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.ensureReady).not.toHaveBeenCalled();
    expect(harness.comfy.submissions).toEqual([]);
  });

  test.each([
    { prompt: ' ' },
    { width: 1000 },
    { height: 1023 },
    { seed: -1 },
    { steps: 0 },
    { steps: 101 },
  ])('image rejects invalid request fields without creating a work: %j', async (override) => {
    const harness = await createHarness();

    await expect(
      harness.startImage({ ...harness.request, ...override }),
    ).rejects.toThrow();

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
  });

  test('image submits the patched frozen graph without uploading an avatar', async () => {
    const harness = await createHarness();
    const request = {
      ...harness.request,
      avatarId: 'must-not-be-persisted',
      hardwareProfile: 'must-not-be-persisted',
    } as ImageGenerationRequest;

    const result = await harness.startImage(request);
    const work = await waitForWork(harness.store, result.id, 'done');
    const graph = harness.comfy.submissions[0];

    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.ensureReady).toHaveBeenCalledTimes(1);
    expect(graph['452'].inputs.prompt).toBe(request.prompt);
    expect(graph['456'].inputs).toMatchObject({
      width: request.width,
      height: request.height,
      batch_size: 1,
    });
    expect(graph['458'].inputs).toMatchObject({
      seed: request.seed,
      steps: request.steps,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
    });
    expect(graph['461'].inputs).toMatchObject({
      filename_prefix: `SMO-Image/${result.id}`,
      format: 'png',
    });
    expect(graph['451'].inputs.unet_name).toBe(
      'qwen_image_2.1_int8_convrot.safetensors',
    );
    expect(work).toMatchObject({
      avatarId: null,
      mode: 'image',
      outputPath: join(
        harness.outputDirectory,
        'SMO-Image',
        `${result.id}_00001.png`,
      ),
      promptId: 'image-prompt-1',
      error: null,
    });
    expect(work.metadata?.request).toEqual(harness.request);
    expect(work.metadata?.workflowVersion).toBe('qwen-image-2-1.json');
    expect(work.completedAt).not.toBeNull();
    expect(Date.parse(work.completedAt!)).toBeGreaterThanOrEqual(
      Date.parse(work.createdAt),
    );
  });

  test('image rejects a workflow path escape before creating a work', async () => {
    const harness = await createHarness();

    await expect(
      harness.startImage(harness.request, { workflowPath: '../escape.json' }),
    ).rejects.toThrow(/workflow.*escape/i);

    expect(harness.store.listWorks()).toEqual([]);
  });
});

describe('image output safety', () => {
  test.each(['00001', '00002'])(
    'image accepts the SaveImageAdvanced _%s counter and stores the real path',
    async (counter) => {
      const harness = await createHarness();
      harness.comfy.outputFactory = (workId) => [
        pngOutput(workId, { filename: `${workId}_${counter}.png` }),
      ];

      const result = await harness.startImage(harness.request);
      const work = await waitForWork(harness.store, result.id, 'done');

      expect(work.outputPath).toBe(
        join(
          harness.outputDirectory,
          'SMO-Image',
          `${result.id}_${counter}.png`,
        ),
      );
    },
  );

  test.each([
    { name: 'wrong node', override: { nodeId: '999' } },
    { name: 'temporary output', override: { type: 'temp' } },
    { name: 'non-PNG output', override: { filename: 'result.jpg' } },
    { name: 'wrong workId', override: { filename: 'other_00001.png' } },
    { name: 'wrong subfolder', override: { subfolder: 'SMO-H3' } },
  ])('image rejects $name in history', async ({ override }) => {
    const harness = await createHarness();
    harness.comfy.outputFactory = (workId) => [pngOutput(workId, override)];

    const result = await harness.startImage(harness.request);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.outputPath).toBeNull();
    expect(work.completedAt).toBeNull();
    expect(work.error).toMatch(/PNG|output/i);
  });

  test.each([
    { subfolder: 'SMO-Image/../escape' },
    { subfolder: '../escape' },
    { subfolder: 'C:\\escape' },
    { filename: '../escape.png' },
    { filename: 'C:\\escape.png' },
  ])('image rejects a history path escape: %j', async (override) => {
    const harness = await createHarness();
    harness.comfy.outputFactory = (workId) => [pngOutput(workId, override)];

    const result = await harness.startImage(harness.request);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.outputPath).toBeNull();
    expect(work.error).toMatch(/PNG|output|escape|traversal/i);
  });

  test('image rejects an unsafe generated work id before adding a work', async () => {
    const harness = await createHarness({ idGenerator: () => '../escape' });

    await expect(harness.startImage(harness.request)).rejects.toThrow(
      /output.*escape|output.*directory/i,
    );

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
  });
});

describe('image progress, completion, and cancellation', () => {
  test('image throttles progress and preserves retry metadata through finalizing', async () => {
    const harness = await createHarness();
    const updateWork = vi.spyOn(harness.store, 'updateWork');
    harness.comfy.executionUpdates = [
      { stage: 'executing', queuePosition: 0 },
      { stage: 'finalizing' },
    ];
    harness.comfy.progressEvents = Array.from({ length: 10 }, (_, index) => ({
      value: index + 1,
      max: 30,
    }));

    const result = await harness.startImage({
      ...harness.request,
      retryOf: 'previous-image',
    });
    const work = await waitForWork(harness.store, result.id, 'done');

    const progressValues = updateWork.mock.calls
      .map(([, update]) => update.metadata?.progress)
      .filter((progress): progress is WorkProgress => progress !== undefined);
    const newFrameWrites = progressValues.filter(
      (progress, index) =>
        index === 0 ||
        progress.value !== progressValues[index - 1].value ||
        progress.max !== progressValues[index - 1].max,
    );
    expect(newFrameWrites.length).toBeLessThanOrEqual(2);
    expect(work.metadata).toMatchObject({
      request: harness.request,
      workflowVersion: 'qwen-image-2-1.json',
      retryOf: 'previous-image',
      progress: { value: 10, max: 30 },
      execution: { stage: 'finalizing' },
    });
    expect(harness.terminalSnapshots).toContainEqual({
      activeCount: 0,
      progress: { value: 10, max: 30 },
    });
  });

  test('image keeps running when a progress metadata write fails', async () => {
    const progressErrorReporter = vi.fn();
    const harness = await createHarness({ progressErrorReporter });
    const failure = new Error('SQLITE_BUSY');
    const originalUpdate = harness.store.updateWork.bind(harness.store);
    vi.spyOn(harness.store, 'updateWork').mockImplementation((id, update) => {
      if (update.metadata?.progress !== undefined) throw failure;
      return originalUpdate(id, update);
    });
    harness.comfy.progressEvents = [{ value: 4, max: 30 }];

    const result = await harness.startImage(harness.request);
    const work = await waitForWork(harness.store, result.id, 'done');

    expect(work.error).toBeNull();
    expect(progressErrorReporter).toHaveBeenCalledWith(failure);
  });

  test('image cancellation targets only the current submitted prompt', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();

    const result = await harness.startImage(harness.request);
    await vi.waitFor(() =>
      expect(harness.comfy.waits).toEqual(['image-prompt-1']),
    );
    await harness.jobCoordinator.cancel(result.id);
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toMatch(/cancel/i);
    expect(work.completedAt).toBeNull();
    expect(harness.comfy.cancelRequests).toEqual(['image-prompt-1']);
  });

  test('image cancellation before submit neither submits nor interrupts another prompt', async () => {
    const readyGate = deferred();
    const ensureReady = vi.fn(() => readyGate.promise);
    const harness = await createHarness({ ensureReady });

    const result = await harness.startImage(harness.request);
    await vi.waitFor(() => expect(ensureReady).toHaveBeenCalledTimes(1));
    await harness.jobCoordinator.cancel(result.id);
    readyGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work).toMatchObject({
      status: 'failed',
      error: 'Generation cancelled',
      outputPath: null,
      completedAt: null,
      promptId: null,
    });
    expect(harness.comfy.submissions).toEqual([]);
    expect(harness.comfy.cancelRequests).toEqual([]);
    expect(harness.jobCoordinator.activeCount).toBe(0);
  });

  test('image repeated cancellation cleans up the current prompt only once', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();

    const result = await harness.startImage(harness.request);
    await vi.waitFor(() =>
      expect(harness.comfy.waits).toEqual(['image-prompt-1']),
    );
    await Promise.all([
      harness.jobCoordinator.cancel(result.id),
      harness.jobCoordinator.cancel(result.id),
    ]);
    const work = await waitForWork(harness.store, result.id, 'failed');
    await harness.jobCoordinator.cancel(result.id);

    expect(work).toMatchObject({
      status: 'failed',
      error: 'Generation cancelled',
      outputPath: null,
      completedAt: null,
      promptId: 'image-prompt-1',
    });
    expect(harness.comfy.cancelRequests).toEqual(['image-prompt-1']);
    expect(harness.jobCoordinator.activeCount).toBe(0);
  });

  test('image cancellation request failure cannot publish a done work', async () => {
    const harness = await createHarness();
    harness.comfy.completionGate = deferred();
    harness.comfy.cancelError = new Error('injected cancel request failure');

    const result = await harness.startImage(harness.request);
    await vi.waitFor(() =>
      expect(harness.comfy.waits).toEqual(['image-prompt-1']),
    );
    await expect(harness.jobCoordinator.cancel(result.id)).rejects.toThrow(
      'injected cancel request failure',
    );
    harness.comfy.completionGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work).toMatchObject({
      status: 'failed',
      error: 'Generation cancelled',
      outputPath: null,
      completedAt: null,
      promptId: 'image-prompt-1',
    });
    expect(harness.comfy.cancelRequests).toEqual(['image-prompt-1']);
    expect(harness.comfy.histories).toEqual([]);
    expect(harness.jobCoordinator.activeCount).toBe(0);
  });
});

describe('image retry and single-job coordination', () => {
  test('image retries a failed work without media authorization', async () => {
    const harness = await createHarness();
    harness.comfy.completionError = new Error('retryable image failure');
    const startImage = vi.fn(harness.startImage);
    const startGeneration: GenerationHandler = (request, options) => {
      if (request.mode === 'image') return startImage(request, options);
      throw new Error('image retry routed to the wrong handler');
    };
    const retryWork = createRetryHandler({
      store: harness.store,
      mediaRegistry: harness.mediaRegistry,
      startGeneration,
    });
    const authorize = vi.spyOn(
      harness.mediaRegistry,
      'authorizeSelectedFile',
    );

    const original = await harness.startImage(harness.request);
    const failed = await waitForWork(harness.store, original.id, 'failed');
    const originalSnapshot = structuredClone(failed);
    harness.comfy.completionError = undefined;

    const retried = await retryWork(original.id);
    const completed = await waitForWork(harness.store, retried.id, 'done');

    expect(retried.id).not.toBe(original.id);
    expect(completed.metadata).toMatchObject({
      request: harness.request,
      workflowVersion: 'qwen-image-2-1.json',
      retryOf: original.id,
    });
    expect(startImage).toHaveBeenLastCalledWith(
      { ...harness.request, retryOf: original.id },
      { workflowPath: 'qwen-image-2-1.json' },
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(harness.store.getWork(original.id)).toEqual(originalSnapshot);
  });

  test.each(['speech', 'text'] as const)(
    'image does not add a work while a %s generation is active',
    async (mode) => {
      const harness = await createHarness();
      const activeWork = harness.store.addWork({
        id: `active-${mode}`,
        avatarId: null,
        mode,
        outputPath: null,
        status: 'pending',
      });
      const gate = deferred();
      const active = harness.jobCoordinator.enqueue({
        id: activeWork.id,
        run: () => gate.promise,
      });

      await expect(harness.startImage(harness.request)).rejects.toThrow(
        /another generation/i,
      );

      expect(harness.store.listWorks()).toHaveLength(1);
      expect(harness.comfy.submissions).toEqual([]);
      gate.resolve();
      await active;
    },
  );
});

describe('image AppServices assembly', () => {
  test('image uses component readiness and active ComfyUI without hardware apply', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-image-services-'));
    vi.spyOn(MediaComponentService.prototype, 'getState').mockImplementation(
      (id): MediaComponentState => ({
        id,
        status: 'ready',
        downloadedBytes: 100,
        totalBytes: 100,
        currentFile: null,
        error: null,
        active: false,
      }),
    );
    const ensureReady = vi
      .spyOn(ComfyProcessManager.prototype, 'ensureReady')
      .mockResolvedValue({ system: {}, devices: [] });
    const upload = vi
      .spyOn(ComfyClientClass.prototype, 'uploadFile')
      .mockResolvedValue('unexpected.png');
    let submitted: ImageWorkflowGraph | undefined;
    vi.spyOn(ComfyClientClass.prototype, 'submit').mockImplementation(
      async (graph) => {
        submitted = structuredClone(graph) as ImageWorkflowGraph;
        return { prompt_id: 'services-image-prompt', number: 1, node_errors: {} };
      },
    );
    vi.spyOn(ComfyClientClass.prototype, 'waitForCompletion').mockImplementation(
      async (_promptId, onProgress) => {
        onProgress?.({ value: 30, max: 30 });
      },
    );
    vi.spyOn(ComfyClientClass.prototype, 'history').mockImplementation(
      async () => {
        const prefix = String(submitted!['461'].inputs.filename_prefix);
        const workId = prefix.slice(prefix.lastIndexOf('/') + 1);
        return [pngOutput(workId)];
      },
    );
    const apply = vi
      .spyOn(HardwareWorkflowStore.prototype, 'apply')
      .mockRejectedValue(new Error('image must not apply hardware workflows'));
    const services = await createAppServices({
      dataDirectory,
      outputDirectory: join(dataDirectory, 'output'),
    });
    cleanups.push(async () => {
      await services.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });
    const request: ImageGenerationRequest = {
      mode: 'image',
      prompt: '服务装配图像任务',
      width: 1024,
      height: 1024,
      seed: 42,
      steps: 25,
    };

    const result = await services.startGeneration(request);
    const work = await waitForWork(services.store, result.id, 'done');

    expect(work.mode).toBe('image');
    expect(work.outputPath).toBe(
      join(dataDirectory, 'output', 'SMO-Image', `${result.id}_00001.png`),
    );
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
