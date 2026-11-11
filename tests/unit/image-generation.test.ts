// @vitest-environment node

import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  readonly uploadedContents: string[] = [];
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
  uploadError?: Error;
  uploadGate?: Deferred<void>;

  async uploadFile(input: Parameters<ComfyClient['uploadFile']>[0]): Promise<string> {
    this.uploads.push(input);
    this.uploadedContents.push(await readFile(input.filePath, 'utf8'));
    if (this.uploadGate) await this.uploadGate.promise;
    if (this.uploadError) throw this.uploadError;
    return `uploaded-${this.uploads.length}.png`;
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
    mediaRegistry,
    jobCoordinator,
    workflowsDirectory,
    outputDirectory,
    uploadsDirectory: join(directory, 'uploads'),
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
  test.each([
    { referenceImagePaths: [''] },
    { referenceImagePaths: ['   '] },
    { referenceImagePaths: ['1.png', '2.png', '3.png', '4.png', '5.png'] },
    { referenceImagePaths: 'reference.png' },
    { referenceImagePaths: [42] },
  ])(
    'image validates referenceImagePaths before authorization: %j',
    async ({ referenceImagePaths }) => {
      const isSelectedImage = vi.fn(async () => true);
      const harness = await createHarness({
        mediaRegistry: { isSelectedImage },
      });

      await expect(
        harness.startImage({
          ...harness.request,
          referenceImagePaths,
        } as ImageGenerationRequest),
      ).rejects.toThrow(/referenceImagePaths/i);

      expect(isSelectedImage).not.toHaveBeenCalled();
      expect(harness.store.listWorks()).toEqual([]);
      expect(harness.comfy.uploads).toEqual([]);
      expect(harness.comfy.submissions).toEqual([]);
    },
  );

  test('image rejects an unauthorized reference before creating a work', async () => {
    const harness = await createHarness();
    const referencePath = join(harness.directory, 'unauthorized.png');
    await writeFile(referencePath, 'reference-image-bytes');

    await expect(
      harness.startImage({
        ...harness.request,
        referenceImagePaths: [referencePath],
      }),
    ).rejects.toThrow(/selected|authorized/i);

    expect(harness.store.listWorks()).toEqual([]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
  });

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
    await expect(
      readdir(join(harness.directory, 'uploads')),
    ).rejects.toThrow();
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

  test('image stages and submits one authorized reference in order', async () => {
    const harness = await createHarness();
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    const work = await waitForWork(harness.store, result.id, 'done');
    const graph = harness.comfy.submissions[0];
    const uploadsDirectory = join(harness.directory, 'uploads');

    expect(harness.comfy.uploads).toEqual([
      {
        filePath: join(uploadsDirectory, `${result.id}-0.png`),
        kind: 'image',
      },
    ]);
    expect(harness.comfy.uploadedContents).toEqual(['reference-image-bytes']);
    expect(await readdir(uploadsDirectory)).toEqual([]);
    expect(await readFile(referencePath, 'utf8')).toBe('reference-image-bytes');
    expect(graph.ref1).toEqual({
      class_type: 'LoadImage',
      inputs: { image: 'uploaded-1.png' },
    });
    expect(graph['452'].inputs).toMatchObject({
      prompt: harness.request.prompt,
      vae: ['454', 0],
      resolution: 1024,
      images: { image_1: ['ref1', 0] },
    });
    expect(graph['458'].inputs).toMatchObject({
      latent_image: ['452', 2],
      seed: harness.request.seed,
      steps: harness.request.steps,
    });
    expect(graph['456'].inputs).toMatchObject({
      width: harness.request.width,
      height: harness.request.height,
    });
    expect(graph['461'].inputs).toMatchObject({
      filename_prefix: `SMO-Image/${result.id}`,
      format: 'png',
    });
    expect(work.outputPath).toBe(
      join(
        harness.outputDirectory,
        'SMO-Image',
        `${result.id}_00001.png`,
      ),
    );
    expect(work.metadata?.request).toEqual({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
  });

  test('image uploads four references in array order with exclusive staged copies', async () => {
    const copy = vi.fn<typeof copyFile>(async (source, destination, mode) => {
      await copyFile(source, destination, mode);
    });
    const harness = await createHarness({ copyFile: copy });
    const extensions = ['.PNG', '.jpg', '.jpeg', '.webp'];
    const referencePaths: string[] = [];
    for (const [index, extension] of extensions.entries()) {
      const referencePath = join(
        harness.directory,
        `reference-${index}${extension}`,
      );
      await writeFile(referencePath, `reference-${index}-bytes`);
      await harness.mediaRegistry.authorizeSelectedImage(referencePath);
      referencePaths.push(referencePath);
    }

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: referencePaths,
    });
    await waitForWork(harness.store, result.id, 'done');
    const graph = harness.comfy.submissions[0];
    const uploadsDirectory = join(harness.directory, 'uploads');

    expect(copy).toHaveBeenCalledTimes(4);
    expect(copy.mock.calls.map(([source]) => source)).toEqual(referencePaths);
    expect(copy.mock.calls.map(([, , mode]) => mode)).toEqual(
      Array.from({ length: 4 }, () => constants.COPYFILE_EXCL),
    );
    expect(harness.comfy.uploads).toEqual(
      extensions.map((extension, index) => ({
        filePath: join(
          uploadsDirectory,
          `${result.id}-${index}${extension.toLowerCase()}`,
        ),
        kind: 'image',
      })),
    );
    expect(harness.comfy.uploadedContents).toEqual(
      extensions.map((_, index) => `reference-${index}-bytes`),
    );
    expect(graph['452'].inputs.vae).toEqual(['454', 0]);
    expect(graph['452'].inputs.images).toEqual({
      image_1: ['ref1', 0],
      image_2: ['ref2', 0],
      image_3: ['ref3', 0],
      image_4: ['ref4', 0],
    });
    expect(Object.keys(graph['452'].inputs.images as object)).toEqual([
      'image_1',
      'image_2',
      'image_3',
      'image_4',
    ]);
    for (const index of [0, 1, 2, 3]) {
      expect(graph[`ref${index + 1}`]).toEqual({
        class_type: 'LoadImage',
        inputs: { image: `uploaded-${index + 1}.png` },
      });
      expect(await readFile(referencePaths[index], 'utf8')).toBe(
        `reference-${index}-bytes`,
      );
    }
    expect(graph.ref5).toBeUndefined();
    expect(graph['458'].inputs.latent_image).toEqual(['452', 2]);
    expect(graph['461'].inputs).toMatchObject({
      filename_prefix: `SMO-Image/${result.id}`,
      format: 'png',
    });
    expect(await readdir(uploadsDirectory)).toEqual([]);
  });

  test('image cleans the staged reference when upload fails without submitting', async () => {
    const harness = await createHarness();
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);
    harness.comfy.uploadError = new Error('reference upload failed');

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('reference upload failed');
    expect(harness.comfy.submissions).toEqual([]);
    expect(await readdir(join(harness.directory, 'uploads'))).toEqual([]);
    expect(await readFile(referencePath, 'utf8')).toBe('reference-image-bytes');
  });

  test('image reports cleanup failure without masking the upload failure', async () => {
    const cleanupFailure = new Error('staged reference cleanup failed');
    const cleanupErrorReporter = vi.fn();
    const removeFile: typeof rm = async () => {
      throw cleanupFailure;
    };
    const harness = await createHarness({
      removeFile,
      cleanupErrorReporter,
    });
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);
    harness.comfy.uploadError = new Error('reference upload failed');

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('reference upload failed');
    expect(cleanupErrorReporter).toHaveBeenCalledWith(cleanupFailure);
    expect(harness.comfy.submissions).toEqual([]);
  });

  test('image removes a partial staged reference when copying fails', async () => {
    const copyFailure = Object.assign(new Error('reference copy failed'), {
      code: 'EIO',
    });
    const failingCopy: typeof copyFile = async (_source, destination) => {
      await writeFile(destination, 'partial-reference');
      throw copyFailure;
    };
    const harness = await createHarness({ copyFile: failingCopy });
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('reference copy failed');
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
    expect(await readdir(join(harness.directory, 'uploads'))).toEqual([]);
    expect(await readFile(referencePath, 'utf8')).toBe('reference-image-bytes');
  });

  test('image does not delete an existing staged path on an exclusive copy collision', async () => {
    const collision = Object.assign(new Error('staged reference exists'), {
      code: 'EEXIST',
    });
    let stagedPath = '';
    const collidingCopy: typeof copyFile = async (_source, destination) => {
      stagedPath = destination.toString();
      await writeFile(destination, 'existing-staged-file');
      throw collision;
    };
    const harness = await createHarness({ copyFile: collidingCopy });
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('staged reference exists');
    expect(await readFile(stagedPath, 'utf8')).toBe('existing-staged-file');
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
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
  test('image cancellation before reference upload neither uploads nor leaves staging', async () => {
    const copyStarted = deferred();
    const copyGate = deferred();
    const gatedCopy: typeof copyFile = async (source, destination, mode) => {
      await copyFile(source, destination, mode);
      copyStarted.resolve();
      await copyGate.promise;
    };
    const harness = await createHarness({ copyFile: gatedCopy });
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    await copyStarted.promise;
    await harness.jobCoordinator.cancel(result.id);
    copyGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');

    expect(work.error).toBe('Generation cancelled');
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.comfy.submissions).toEqual([]);
    expect(await readdir(join(harness.directory, 'uploads'))).toEqual([]);
    expect(await readFile(referencePath, 'utf8')).toBe('reference-image-bytes');
  });

  test('image cancellation during reference upload cleans staging without submitting', async () => {
    const removeFile = vi.fn<typeof rm>(async (...args) => rm(...args));
    const harness = await createHarness({ removeFile });
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);
    const uploadGate = deferred();
    harness.comfy.uploadGate = uploadGate;

    const result = await harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    await vi.waitFor(() => expect(harness.comfy.uploads).toHaveLength(1));
    await harness.jobCoordinator.cancel(result.id);
    uploadGate.resolve();
    const work = await waitForWork(harness.store, result.id, 'failed');
    const stagedPath = join(
      harness.directory,
      'uploads',
      `${result.id}-0.png`,
    );

    expect(work.error).toBe('Generation cancelled');
    expect(harness.comfy.submissions).toEqual([]);
    expect(harness.comfy.cancelRequests).toEqual([]);
    expect(removeFile).toHaveBeenCalledWith(stagedPath, { force: true });
    expect(removeFile).not.toHaveBeenCalledWith(referencePath, { force: true });
    expect(await readdir(join(harness.directory, 'uploads'))).toEqual([]);
    expect(await readFile(referencePath, 'utf8')).toBe('reference-image-bytes');
  });

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
  test('image retries references from the frozen workflow without accumulating nodes', async () => {
    const harness = await createHarness();
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);
    const workflowPath = join(workflowsDirectory, 'qwen-image-2-1.json');
    const frozenSource = await readFile(workflowPath, 'utf8');
    const request: ImageGenerationRequest = {
      ...harness.request,
      referenceImagePaths: [referencePath],
    };
    const startImage = vi.fn(harness.startImage);
    const startGeneration: GenerationHandler = (generationRequest, options) => {
      if (generationRequest.mode === 'image') {
        return startImage(generationRequest, options);
      }
      throw new Error('image retry routed to the wrong handler');
    };
    const retryWork = createRetryHandler({
      store: harness.store,
      mediaRegistry: harness.mediaRegistry,
      startGeneration,
    });
    harness.comfy.completionError = new Error('retryable reference failure');

    const original = await harness.startImage(request);
    const failed = await waitForWork(harness.store, original.id, 'failed');
    const originalSnapshot = structuredClone(failed);
    harness.comfy.completionError = undefined;

    const retried = await retryWork(original.id);
    const completed = await waitForWork(harness.store, retried.id, 'done');

    expect(harness.comfy.submissions).toHaveLength(2);
    for (const [index, graph] of harness.comfy.submissions.entries()) {
      expect(graph.ref1).toEqual({
        class_type: 'LoadImage',
        inputs: { image: `uploaded-${index + 1}.png` },
      });
      expect(graph.ref2).toBeUndefined();
      expect(graph['452'].inputs.images).toEqual({
        image_1: ['ref1', 0],
      });
      expect(graph['458'].inputs.latent_image).toEqual(['452', 2]);
    }
    expect(harness.comfy.uploads.map(({ filePath }) => filePath)).toEqual([
      join(harness.directory, 'uploads', `${original.id}-0.png`),
      join(harness.directory, 'uploads', `${retried.id}-0.png`),
    ]);
    expect(harness.comfy.uploadedContents).toEqual([
      'reference-image-bytes',
      'reference-image-bytes',
    ]);
    expect(completed.metadata).toMatchObject({
      request,
      workflowVersion: 'qwen-image-2-1.json',
      retryOf: original.id,
    });
    expect(startImage).toHaveBeenLastCalledWith(
      { ...request, retryOf: original.id },
      { workflowPath: 'qwen-image-2-1.json' },
    );
    expect(harness.store.getWork(original.id)).toEqual(originalSnapshot);
    expect(await readFile(workflowPath, 'utf8')).toBe(frozenSource);
    expect(await readdir(join(harness.directory, 'uploads'))).toEqual([]);
  });

  test('image rechecks single-job coordination after asynchronous authorization', async () => {
    const authorizationStarted = deferred();
    const authorizationGate = deferred();
    let harness: Awaited<ReturnType<typeof createHarness>>;
    const isSelectedImage = vi.fn(async (path: string) => {
      authorizationStarted.resolve();
      await authorizationGate.promise;
      return harness.mediaRegistry.isSelectedImage(path);
    });
    harness = await createHarness({
      mediaRegistry: { isSelectedImage },
    });
    const referencePath = join(harness.directory, 'reference.png');
    await writeFile(referencePath, 'reference-image-bytes');
    await harness.mediaRegistry.authorizeSelectedImage(referencePath);
    const completionGate = deferred();
    harness.comfy.completionGate = completionGate;

    const referenceStart = harness.startImage({
      ...harness.request,
      referenceImagePaths: [referencePath],
    });
    await authorizationStarted.promise;
    const occupying = await harness.startImage(harness.request);
    authorizationGate.resolve();

    await expect(referenceStart).rejects.toThrow(/another generation/i);
    expect(harness.store.listWorks().map((work) => work.id)).toEqual([
      occupying.id,
    ]);
    expect(harness.comfy.uploads).toEqual([]);
    expect(harness.jobCoordinator.activeId).toBe(occupying.id);

    completionGate.resolve();
    await waitForWork(harness.store, occupying.id, 'done');
  });

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
  test('image uses the real media registry and uploads directory without hardware apply', async () => {
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
    const uploadedContents: string[] = [];
    const upload = vi
      .spyOn(ComfyClientClass.prototype, 'uploadFile')
      .mockImplementation(async (input) => {
        uploadedContents.push(await readFile(input.filePath, 'utf8'));
        return 'services-reference.png';
      });
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
    const referencePath = join(dataDirectory, 'selected-reference.PNG');
    await writeFile(referencePath, 'services-reference-bytes');
    const authorizedReference =
      await services.files.authorizeDroppedImage(referencePath);
    const request: ImageGenerationRequest = {
      mode: 'image',
      prompt: '服务装配图像任务',
      width: 1024,
      height: 1024,
      seed: 42,
      steps: 25,
      referenceImagePaths: [authorizedReference],
    };

    const result = await services.startGeneration(request);
    const work = await waitForWork(services.store, result.id, 'done');

    expect(work.mode).toBe('image');
    expect(work.outputPath).toBe(
      join(dataDirectory, 'output', 'SMO-Image', `${result.id}_00001.png`),
    );
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toEqual({
      filePath: join(dataDirectory, 'uploads', `${result.id}-0.png`),
      kind: 'image',
    });
    expect(uploadedContents).toEqual(['services-reference-bytes']);
    expect(await readdir(join(dataDirectory, 'uploads'))).toEqual([]);
    expect(submitted!.ref1).toEqual({
      class_type: 'LoadImage',
      inputs: { image: 'services-reference.png' },
    });
    expect(submitted!['452'].inputs).toMatchObject({
      vae: ['454', 0],
      images: { image_1: ['ref1', 0] },
    });
    expect(submitted!['458'].inputs.latent_image).toEqual(['452', 2]);
    expect(work.metadata?.request).toEqual(request);
    expect(apply).not.toHaveBeenCalled();
  });
});
