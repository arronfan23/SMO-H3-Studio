import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ComfyClient,
  ComfyExecutionUpdate,
  ComfyOutputFile,
} from './comfy';
import type { GenerationExecutionOptions } from './generation';
import {
  patchQwenImageWorkflow,
  type ImageWorkflowGraph,
} from './image-workflow';
import type { JobCoordinator } from './jobs';
import type { MediaComponentService } from './media-components';
import type { Store } from './store';
import type {
  GenerationStartResult,
  ImageGenerationRequest,
  WorkExecutionState,
  WorkMetadata,
  WorkProgress,
  WorkStage,
} from '../shared/types';

const IMAGE_WORKFLOW_FILENAME = 'qwen-image-2-1.json';
const PROGRESS_FLUSH_INTERVAL_MS = 200;

export interface ImageGenerationHandlerOptions {
  store: Pick<Store, 'addWork' | 'updateWork'>;
  comfy: Pick<
    ComfyClient,
    'submit' | 'waitForCompletion' | 'history' | 'cancel'
  >;
  mediaComponents: Pick<MediaComponentService, 'getState'>;
  jobCoordinator: Pick<JobCoordinator, 'activeCount' | 'enqueue'>;
  workflowsDirectory: string;
  outputDirectory: string;
  ensureReady?: () => Promise<unknown>;
  idGenerator?: () => string;
  progressErrorReporter?: (error: unknown) => void;
}

export type ImageGenerationHandler = (
  request: ImageGenerationRequest,
  options?: GenerationExecutionOptions,
) => GenerationStartResult | Promise<GenerationStartResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 256 &&
    value <= 4096 &&
    value % 32 === 0
  );
}

export function validateImageGenerationRequest(
  request: ImageGenerationRequest,
): void {
  if (request?.mode !== 'image') {
    throw new Error('Invalid image generation mode');
  }
  if (!nonEmptyString(request.prompt)) {
    throw new Error('Image prompt must not be empty');
  }
  if (!validDimension(request.width)) {
    throw new Error('width must be an integer from 256 to 4096 and a multiple of 32');
  }
  if (!validDimension(request.height)) {
    throw new Error('height must be an integer from 256 to 4096 and a multiple of 32');
  }
  if (!Number.isSafeInteger(request.seed) || request.seed < 0) {
    throw new Error('Image seed must be a non-negative safe integer');
  }
  if (!Number.isInteger(request.steps) || request.steps < 1 || request.steps > 100) {
    throw new Error('Image steps must be an integer from 1 to 100');
  }
  if (request.retryOf !== undefined && !nonEmptyString(request.retryOf)) {
    throw new Error('retryOf must not be empty');
  }
}

export function isImageGenerationRequest(
  value: unknown,
): value is ImageGenerationRequest {
  if (typeof value !== 'object' || value === null) return false;
  try {
    validateImageGenerationRequest(value as ImageGenerationRequest);
    return true;
  } catch {
    return false;
  }
}

function sanitizeRequest(
  input: ImageGenerationRequest,
): ImageGenerationRequest {
  return {
    mode: 'image',
    prompt: input.prompt,
    width: input.width,
    height: input.height,
    seed: input.seed,
    steps: input.steps,
  };
}

function resolveWorkflowPath(
  workflowsDirectory: string,
  requestedWorkflowPath: string,
): string {
  if (isAbsolute(requestedWorkflowPath)) return requestedWorkflowPath;
  const root = resolve(workflowsDirectory);
  const workflowPath = resolve(root, requestedWorkflowPath);
  const child = relative(root, workflowPath);
  if (
    child.length === 0 ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error('Workflow path escapes workflowsDirectory');
  }
  return workflowPath;
}

function hasParentTraversal(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').includes('..');
}

function assertPathInside(root: string, outputPath: string): void {
  const child = relative(root, outputPath);
  if (
    child.length === 0 ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error('Image output path escapes the output directory');
  }
}

interface ImageOutputTarget {
  directory: string;
  filenamePrefix: string;
}

function imageOutputTarget(
  outputDirectory: string,
  workId: string,
): ImageOutputTarget {
  if (
    !nonEmptyString(workId) ||
    workId !== workId.trim() ||
    workId === '.' ||
    workId === '..' ||
    workId.includes('/') ||
    workId.includes('\\') ||
    workId.includes(':')
  ) {
    throw new Error('Image output path escapes the SMO-Image output directory');
  }
  const root = resolve(outputDirectory);
  const directory = resolve(root, 'SMO-Image');
  assertPathInside(root, directory);
  return { directory, filenamePrefix: `${workId}_` };
}

function resolveHistoryOutputPath(
  outputDirectory: string,
  file: ComfyOutputFile,
): string {
  if (
    file.filename.length === 0 ||
    file.filename === '.' ||
    file.filename === '..' ||
    file.filename.includes('/') ||
    file.filename.includes('\\') ||
    hasParentTraversal(file.filename) ||
    hasParentTraversal(file.subfolder)
  ) {
    throw new Error('ComfyUI image output path escapes the output directory');
  }
  const root = resolve(outputDirectory);
  const outputPath = resolve(root, file.subfolder, file.filename);
  assertPathInside(root, outputPath);
  return outputPath;
}

function selectImageOutput(
  files: ComfyOutputFile[],
  outputNodeId: string,
  target: ImageOutputTarget,
  outputDirectory: string,
): string {
  for (const file of files) {
    if (
      file.nodeId !== outputNodeId ||
      file.type !== 'output' ||
      file.kind !== 'images' ||
      !file.filename.toLowerCase().endsWith('.png')
    ) {
      continue;
    }
    const outputPath = resolveHistoryOutputPath(outputDirectory, file);
    const counter = file.filename.slice(target.filenamePrefix.length, -4);
    if (
      dirname(outputPath) === target.directory &&
      file.filename.startsWith(target.filenamePrefix) &&
      /^[0-9]{5}$/.test(counter)
    ) {
      return outputPath;
    }
  }
  throw new Error(
    'ComfyUI history did not contain the expected PNG for the image output node',
  );
}

function reportProgressError(error: unknown): void {
  console.warn('[SMO.H3 Studio] Failed to persist image generation progress', error);
}

export function createImageGenerationHandler(
  options: ImageGenerationHandlerOptions,
): ImageGenerationHandler {
  const { store, comfy, mediaComponents, jobCoordinator } = options;
  const createId = options.idGenerator ?? randomUUID;
  const progressErrorReporter =
    options.progressErrorReporter ?? reportProgressError;

  const requireReadyComponent = (): void => {
    if (mediaComponents.getState('image').status !== 'ready') {
      throw new Error('Image component must be installed and ready');
    }
  };

  return async (input, executionOptions = {}) => {
    validateImageGenerationRequest(input);
    requireReadyComponent();
    if (jobCoordinator.activeCount > 0) {
      throw new Error('Another generation is already running');
    }

    const request = sanitizeRequest(input);
    const originalRetryOf = input.retryOf;
    const workId = createId();
    const outputTarget = imageOutputTarget(
      options.outputDirectory,
      workId,
    );
    const defaultWorkflowPath = resolve(
      options.workflowsDirectory,
      IMAGE_WORKFLOW_FILENAME,
    );
    const requestedWorkflowPath =
      executionOptions.workflowPath ?? defaultWorkflowPath;
    const workflowPath = resolveWorkflowPath(
      options.workflowsDirectory,
      requestedWorkflowPath,
    );
    const workflowVersion =
      executionOptions.workflowPath !== undefined
        ? executionOptions.workflowPath
        : IMAGE_WORKFLOW_FILENAME;

    requireReadyComponent();
    if (jobCoordinator.activeCount > 0) {
      throw new Error('Another generation is already running');
    }

    const baseMetadata: WorkMetadata = {
      request,
      workflowVersion,
      ...(originalRetryOf === undefined ? {} : { retryOf: originalRetryOf }),
    };
    const nowIso = (): string => new Date().toISOString();
    let currentExecution: WorkExecutionState = {
      stage: 'local-queued',
      updatedAt: nowIso(),
      lastProgressAt: nowIso(),
    };
    let latestProgress: WorkProgress | null = null;
    let lastWrittenProgress: WorkProgress | null = null;
    let pendingProgress: WorkProgress | null = null;
    let progressTimer: ReturnType<typeof setTimeout> | null = null;

    const sameProgress = (
      previous: WorkProgress | null,
      next: WorkProgress,
    ): boolean =>
      previous !== null &&
      previous.value === next.value &&
      previous.max === next.max;

    const writeState = (): void => {
      const progressChanged =
        latestProgress !== null &&
        !sameProgress(lastWrittenProgress, latestProgress);
      try {
        store.updateWork(workId, {
          metadata: {
            ...baseMetadata,
            execution: currentExecution,
            ...(latestProgress === null ? {} : { progress: latestProgress }),
          },
        });
        if (progressChanged) lastWrittenProgress = latestProgress;
      } catch (error) {
        progressErrorReporter(error);
      }
    };

    const setExecution = (stage: WorkStage, queuePosition?: number): void => {
      const now = nowIso();
      const progressed =
        currentExecution.stage !== stage ||
        currentExecution.queuePosition !== queuePosition;
      currentExecution = {
        stage,
        updatedAt: now,
        lastProgressAt: progressed ? now : currentExecution.lastProgressAt,
        ...(queuePosition === undefined ? {} : { queuePosition }),
      };
      writeState();
    };

    const writeProgress = (progress: WorkProgress): void => {
      const now = nowIso();
      const stage: WorkStage =
        currentExecution.stage === 'executing' ||
        currentExecution.stage === 'sampling'
          ? 'sampling'
          : currentExecution.stage;
      currentExecution = {
        ...currentExecution,
        stage,
        updatedAt: now,
        lastProgressAt: now,
      };
      latestProgress = progress;
      try {
        store.updateWork(workId, {
          metadata: {
            ...baseMetadata,
            execution: currentExecution,
            progress,
          },
        });
        lastWrittenProgress = progress;
      } catch (error) {
        progressErrorReporter(error);
      }
    };

    const flushProgress = (progress: WorkProgress): void => {
      if (progressTimer !== null) {
        if (!sameProgress(lastWrittenProgress, progress)) {
          pendingProgress = progress;
        }
        return;
      }
      if (sameProgress(lastWrittenProgress, progress)) return;
      writeProgress(progress);
      progressTimer = setTimeout(() => {
        progressTimer = null;
        const latest = pendingProgress;
        pendingProgress = null;
        if (latest !== null && !sameProgress(lastWrittenProgress, latest)) {
          writeProgress(latest);
        }
      }, PROGRESS_FLUSH_INTERVAL_MS);
    };

    const flushPendingProgress = (): void => {
      if (progressTimer !== null) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      const latest = pendingProgress;
      pendingProgress = null;
      if (latest !== null && !sameProgress(lastWrittenProgress, latest)) {
        writeProgress(latest);
      }
    };

    store.addWork({
      id: workId,
      avatarId: null,
      mode: 'image',
      outputPath: null,
      status: 'pending',
      promptId: null,
      metadata: { ...baseMetadata, execution: currentExecution },
      error: null,
    });

    const execution = {
      cancelRequested: false,
      completed: false,
      cleanupSent: false,
    };
    let submittedPromptId: string | undefined;
    const throwIfCancelled = (): void => {
      if (execution.cancelRequested) throw new Error('Generation cancelled');
    };
    const cleanupSubmittedPrompt = async (): Promise<void> => {
      if (
        submittedPromptId === undefined ||
        execution.completed ||
        execution.cleanupSent
      ) {
        return;
      }
      execution.cleanupSent = true;
      await comfy.cancel(submittedPromptId);
    };
    const interruptIfRequested = async (): Promise<void> => {
      if (execution.cancelRequested) await cleanupSubmittedPrompt();
    };
    const handleExecutionUpdate = (update: ComfyExecutionUpdate): void => {
      setExecution(update.stage, update.queuePosition);
    };

    const run = async (): Promise<void> => {
      try {
        throwIfCancelled();
        await options.ensureReady?.();
        throwIfCancelled();
        const frozen = JSON.parse(
          await readFile(workflowPath, 'utf8'),
        ) as ImageWorkflowGraph;
        throwIfCancelled();
        const { graph, nodeIds } = patchQwenImageWorkflow(frozen, request);
        graph[nodeIds.output].inputs.filename_prefix = `SMO-Image/${workId}`;
        graph[nodeIds.output].inputs.format = 'png';
        throwIfCancelled();
        const submitted = await comfy.submit(graph);
        submittedPromptId = submitted.prompt_id;
        setExecution('backend-queued');
        store.updateWork(workId, { promptId: submitted.prompt_id });
        await interruptIfRequested();
        throwIfCancelled();
        await comfy.waitForCompletion(
          submitted.prompt_id,
          flushProgress,
          handleExecutionUpdate,
        );
        execution.completed = true;
        setExecution('finalizing');
        throwIfCancelled();
        const files = await comfy.history(submitted.prompt_id);
        throwIfCancelled();
        const outputPath = selectImageOutput(
          files,
          nodeIds.output,
          outputTarget,
          options.outputDirectory,
        );
        throwIfCancelled();
        store.updateWork(workId, {
          outputPath,
          completedAt: nowIso(),
          error: null,
        });
      } catch (error) {
        let failure = error;
        try {
          await interruptIfRequested();
        } catch (cancellationError) {
          failure = cancellationError;
        }
        if (execution.cancelRequested) {
          failure = new Error('Generation cancelled');
        } else {
          try {
            await cleanupSubmittedPrompt();
          } catch {
            // Preserve the generation failure if precise backend cleanup fails.
          }
        }
        store.updateWork(workId, {
          outputPath: null,
          completedAt: null,
          error: errorMessage(failure),
        });
        throw failure;
      } finally {
        flushPendingProgress();
      }
    };

    try {
      void jobCoordinator
        .enqueue({
          id: workId,
          run,
          cancel: async () => {
            execution.cancelRequested = true;
            await interruptIfRequested();
          },
        })
        .catch(() => undefined);
      return { id: workId };
    } catch (error) {
      store.updateWork(workId, {
        status: 'failed',
        error: errorMessage(error),
      });
      throw error;
    }
  };
}
