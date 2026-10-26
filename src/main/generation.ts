import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ComfyClient, ComfyOutputFile } from './comfy';
import {
  createFfprobeDurationReader,
  type AudioDurationReader,
} from './audio-duration';
export interface GenerationExecutionOptions {
  workflowPath?: string;
}

export type GenerationHandler = (
  request: GenerationRequest,
  options?: GenerationExecutionOptions,
) => GenerationStartResult | Promise<GenerationStartResult>;
import type { JobCoordinator } from './jobs';
import type { MediaRegistry } from './media';
import type { Store } from './store';
import { patchWorkflow } from '../shared/workflow';
import { WORKFLOW_NODES, WORKFLOW_PATHS } from '../shared/workflow-nodes';
import type { GenerationRequest, GenerationStartResult } from '../shared/types';

const WORKFLOW_FILENAMES = {
  text: 'text-ref2va.json',
  audio: 'audio-digital-human.json',
} as const;

type WorkflowGraph = Record<string, { inputs: Record<string, unknown> }>;

export interface GenerationHandlerOptions {
  store: Pick<Store, 'listAvatars' | 'addWork' | 'updateWork'>;
  comfy: Pick<
    ComfyClient,
    'uploadFile' | 'submit' | 'waitForCompletion' | 'history' | 'cancel'
  >;
  jobCoordinator: Pick<JobCoordinator, 'enqueue'>;
  workflowsDirectory: string;
  outputDirectory: string;
  mediaRegistry: Pick<MediaRegistry, 'isSelectedFile'>;
  uploadsDirectory: string;
  workflowResolver?: (mode: GenerationRequest["mode"]) => string;
  copyFile?: typeof copyFile;
  durationReader?: AudioDurationReader;
  removeFile?: typeof rm;
  cleanupErrorReporter?: (error: unknown) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeRequest(request: GenerationRequest): GenerationRequest {
  const sanitized: GenerationRequest = {
    mode: request.mode,
    avatarId: request.avatarId,
    prompt: request.prompt,
    duration: request.duration,
    seed: request.seed,
  };
  if (request.audioPath !== undefined) {
    sanitized.audioPath = request.audioPath;
  }
  if (request.trimStart !== undefined) {
    sanitized.trimStart = request.trimStart;
  }
  return sanitized;
}

function validateRequest(request: GenerationRequest): void {
  if (
    typeof request.avatarId !== 'string' ||
    request.avatarId.trim().length === 0
  ) {
    throw new Error('avatarId must not be empty');
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw new Error('Generation prompt must not be empty');
  }
  if (!Number.isInteger(request.seed) || request.seed < 0) {
    throw new Error('Generation seed must be a non-negative integer');
  }
  if (request.mode === 'text') {
    if (!Number.isFinite(request.duration) || request.duration < 4 || request.duration > 15) {
      throw new Error('Text duration must be between 4 and 15 seconds');
    }
    return;
  }
  if (request.mode !== 'audio') {
    throw new Error(`Invalid video mode: ${String(request.mode)}`);
  }
  if (typeof request.audioPath !== 'string' || request.audioPath.trim().length === 0) {
    throw new Error('audioPath is required for audio generation');
  }
  if (!Number.isFinite(request.duration) || request.duration <= 0) {
    throw new Error('Audio duration must be a finite positive number');
  }
  if (
    request.trimStart !== undefined &&
    (!Number.isFinite(request.trimStart) || request.trimStart < 0)
  ) {
    throw new Error('Audio trimStart must be a finite non-negative number');
  }
}

function selectVideoOutput(
  files: ComfyOutputFile[],
  mode: GenerationRequest['mode'],
): ComfyOutputFile {
  const outputNodeId = WORKFLOW_NODES[mode].output;
  const output = files.find(
    (file) =>
      file.type === 'output' &&
      file.nodeId === outputNodeId &&
      file.filename.toLowerCase().endsWith('.mp4'),
  );
  if (!output) {
    throw new Error(
      'ComfyUI history did not contain a video output in MP4 format for the current mode',
    );
  }
  return output;
}

function hasParentTraversal(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').includes('..');
}

function resolveOutputPath(
  outputDirectory: string,
  file: ComfyOutputFile,
): string {
  const invalidPathError = () =>
    new Error('ComfyUI output path escapes the output directory');
  if (
    file.filename.length === 0 ||
    file.filename === '.' ||
    file.filename === '..' ||
    file.filename.includes('/') ||
    file.filename.includes('\\') ||
    hasParentTraversal(file.subfolder) ||
    hasParentTraversal(file.filename)
  ) {
    throw invalidPathError();
  }

  const root = resolve(outputDirectory);
  const outputPath = resolve(root, file.subfolder, file.filename);
  const relativePath = relative(root, outputPath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw invalidPathError();
  }
  return outputPath;
}

async function stageAudioFile(
  sourcePath: string,
  workId: string,
  uploadsDirectory: string,
  copy: typeof copyFile,
): Promise<string> {
  await mkdir(uploadsDirectory, { recursive: true });
  const destination = join(uploadsDirectory, `${workId}${extname(sourcePath).toLowerCase()}`);
  try {
    await copy(sourcePath, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await rm(destination, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  return destination;
}

async function uploadStagedAudio(
  comfy: Pick<ComfyClient, 'uploadFile'>,
  stagedPath: string,
  remove: typeof rm,
): Promise<string> {
  try {
    return await comfy.uploadFile({ filePath: stagedPath, kind: 'audio' });
  } finally {
    await remove(stagedPath, { force: true });
  }
}

function reportCleanupError(error: unknown): void {
  console.error('[SMO.H3 Studio] Failed to clean staged audio', error);
}

async function cleanupStagedAudio(
  stagedPath: string | undefined,
  remove: typeof rm,
  reportError: (error: unknown) => void,
): Promise<void> {
  if (stagedPath === undefined) {
    return;
  }
  try {
    await remove(stagedPath, { force: true });
  } catch (error) {
    try {
      reportError(error);
    } catch {
      // Cleanup reporting must not replace the original job outcome.
    }
  }
}

async function validateStagedAudioDuration(
  request: GenerationRequest,
  stagedPath: string,
  readDuration: AudioDurationReader,
): Promise<void> {
  try {
    const actualDuration = await readDuration(stagedPath);
    if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
      throw new Error('Actual audio duration must be a finite positive number');
    }
    const trimStart = request.trimStart ?? 0;
    const epsilonSeconds = 0.001;
    if (trimStart > actualDuration + epsilonSeconds) {
      throw new Error('trimStart exceeds the actual audio duration');
    }
    if (trimStart + request.duration > actualDuration + epsilonSeconds) {
      throw new Error('Audio trim range exceeds the actual duration');
    }
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createGenerationHandler(
  options: GenerationHandlerOptions,
): GenerationHandler {
  const {
    store,
    comfy,
    jobCoordinator,
    workflowsDirectory,
    outputDirectory,
    mediaRegistry,
    uploadsDirectory,
  } = options;
  const copy = options.copyFile ?? copyFile;
  const readDuration = options.durationReader ?? createFfprobeDurationReader();
  const remove = options.removeFile ?? rm;
  const cleanupErrorReporter = options.cleanupErrorReporter ?? reportCleanupError;

  return async (input, executionOptions = {}) => {
    validateRequest(input);
    const avatar = store
      .listAvatars()
      .find((candidate) => candidate.id === input.avatarId);
    if (!avatar) {
      throw new Error(`Avatar not found: ${input.avatarId}`);
    }
    const request = sanitizeRequest(input);
    const originalRetryOf = input.retryOf;
    const workId = randomUUID();
    const workflowFilename = WORKFLOW_FILENAMES[request.mode];
    const defaultWorkflowPath = join(workflowsDirectory, workflowFilename);
    const requestedWorkflowPath =
      executionOptions.workflowPath ??
      options.workflowResolver?.(request.mode) ??
      defaultWorkflowPath;
    const workflowPath = isAbsolute(requestedWorkflowPath)
      ? requestedWorkflowPath
      : join(workflowsDirectory, requestedWorkflowPath);
    const workflowVersion =
      executionOptions.workflowPath !== undefined
        ? executionOptions.workflowPath
        : resolve(workflowPath) === resolve(defaultWorkflowPath)
          ? workflowFilename
          : requestedWorkflowPath;
    let stagedAudioPath: string | undefined;
    if (request.mode === 'audio') {
      const sourcePath = request.audioPath!;
      if (!(await mediaRegistry.isSelectedFile(sourcePath))) {
        throw new Error('Audio path must be explicitly selected through files.selectAudio');
      }
      stagedAudioPath = await stageAudioFile(
        sourcePath,
        workId,
        uploadsDirectory,
        copy,
      );
      await validateStagedAudioDuration(request, stagedAudioPath, readDuration);
    }
    store.addWork({
      id: workId,
      avatarId: request.avatarId,
      mode: request.mode,
      outputPath: null,
      status: 'pending',
      promptId: null,
      metadata: {
        request,
        workflowVersion,
        ...(originalRetryOf ? { retryOf: originalRetryOf } : {}),
      },
      error: null,
    });

    const execution = {
      cancelRequested: false,
      interruptible: false,
      cancelSent: false,
    };
    const throwIfCancelled = (): void => {
      if (execution.cancelRequested) {
        throw new Error('Generation cancelled');
      }
    };
    const interruptIfRequested = async (): Promise<void> => {
      if (
        !execution.cancelRequested ||
        !execution.interruptible ||
        execution.cancelSent
      ) {
        return;
      }
      execution.cancelSent = true;
      await comfy.cancel();
    };

    const run = async (): Promise<void> => {
      try {
        throwIfCancelled();
        const image = await comfy.uploadFile({
          filePath: avatar.photoPath,
          kind: 'image',
        });
        throwIfCancelled();
        const audio =
          request.mode === 'audio'
            ? await uploadStagedAudio(comfy, stagedAudioPath!, remove)
            : undefined;
        throwIfCancelled();
        const frozen = JSON.parse(
          await readFile(workflowPath, 'utf8'),
        ) as WorkflowGraph;
        throwIfCancelled();
        const changes: Record<string, unknown> =
          request.mode === 'text'
            ? {
                [WORKFLOW_PATHS.text.image]: image,
                [WORKFLOW_PATHS.text.prompt]: request.prompt,
                [WORKFLOW_PATHS.text.duration]: request.duration,
                [WORKFLOW_PATHS.text.seed]: request.seed,
                [WORKFLOW_PATHS.text.output]: `SMO-H3/${workId}`,
              }
            : {
                [WORKFLOW_PATHS.audio.image]: image,
                [WORKFLOW_PATHS.audio.audio]: audio,
                [WORKFLOW_PATHS.audio.prompt]: request.prompt,
                [WORKFLOW_PATHS.audio.trimStart]: request.trimStart ?? 0,
                [WORKFLOW_PATHS.audio.trimDuration]: request.duration,
                [WORKFLOW_PATHS.audio.seed]: request.seed,
                [WORKFLOW_PATHS.audio.output]: `SMO-H3/${workId}`,
              };
        const workflow = patchWorkflow(frozen, changes);
        throwIfCancelled();
        const submitted = await comfy.submit(workflow);
        execution.interruptible = true;
        store.updateWork(workId, { promptId: submitted.prompt_id });
        await interruptIfRequested();
        throwIfCancelled();
        try {
          await comfy.waitForCompletion(submitted.prompt_id);
        } finally {
          execution.interruptible = false;
        }
        throwIfCancelled();
        const files = await comfy.history(submitted.prompt_id);
        throwIfCancelled();
        const output = selectVideoOutput(files, request.mode);
        const outputPath = resolveOutputPath(outputDirectory, output);
        throwIfCancelled();
        store.updateWork(workId, {
          status: 'done',
          outputPath,
          error: null,
        });
      } catch (error) {
        let failure = error;
        try {
          await interruptIfRequested();
        } catch (cancellationError) {
          failure = cancellationError;
        }
        store.updateWork(workId, {
          status: 'failed',
          error: errorMessage(failure),
        });
        throw failure;
      } finally {
        execution.interruptible = false;
        await cleanupStagedAudio(stagedAudioPath, remove, cleanupErrorReporter);
      }
    };

    // Failures settle in Store and coordinator events; callers receive the queued id immediately.
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
  };
}

export interface RetryHandlerOptions {
  store: Pick<Store, 'getWork' | 'listAvatars'>;
  mediaRegistry: Pick<MediaRegistry, 'authorizeSelectedFile'>;
  startGeneration: GenerationHandler;
}

function isRetryableRequest(value: unknown): value is GenerationRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const request = value as Record<string, unknown>;
  if (request.mode !== 'text' && request.mode !== 'audio') {
    return false;
  }
  if (typeof request.avatarId !== 'string' || request.avatarId.trim().length === 0) {
    return false;
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    return false;
  }
  if (
    typeof request.duration !== 'number' ||
    !Number.isFinite(request.duration) ||
    request.duration <= 0
  ) {
    return false;
  }
  if (
    typeof request.seed !== 'number' ||
    !Number.isInteger(request.seed) ||
    request.seed < 0
  ) {
    return false;
  }
  if (request.audioPath !== undefined) {
    if (typeof request.audioPath !== 'string' || request.audioPath.trim().length === 0) {
      return false;
    }
  }
  if (request.trimStart !== undefined) {
    if (
      typeof request.trimStart !== 'number' ||
      !Number.isFinite(request.trimStart) ||
      request.trimStart < 0
    ) {
      return false;
    }
  }
  if (request.mode === 'audio' && request.audioPath === undefined) {
    return false;
  }
  return true;
}

function isRetryableMetadata(value: unknown): value is {
  request: GenerationRequest;
  workflowVersion: string;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.workflowVersion === 'string' &&
    record.workflowVersion.length > 0 &&
    isRetryableRequest(record.request)
  );
}

export function createRetryHandler(
  options: RetryHandlerOptions,
): (id: string) => Promise<GenerationStartResult> {
  const { store, mediaRegistry, startGeneration } = options;

  return async (id) => {
    const work = store.getWork(id);
    if (work === null) {
      throw new Error(`Work not found: ${id}`);
    }
    if (work.status !== 'failed') {
      throw new Error('Only failed works can be retried');
    }
    if (!isRetryableMetadata(work.metadata)) {
      throw new Error('Work metadata is missing request or workflowVersion');
    }

    const { request } = work.metadata;
    const avatar = store.listAvatars().find((candidate) => candidate.id === request.avatarId);
    if (avatar === undefined) {
      throw new Error(`Avatar not found: ${request.avatarId}`);
    }

    try {
      const photoStats = await stat(avatar.photoPath);
      if (!photoStats.isFile()) {
        throw new Error('Avatar photo is not a file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Original avatar photo is missing');
      }
      throw error;
    }

    if (request.mode === 'audio') {
      const audioPath = request.audioPath;
      if (typeof audioPath !== 'string' || audioPath.trim().length === 0) {
        throw new Error('audioPath is required for audio generation');
      }
      try {
        const audioStats = await stat(audioPath);
        if (!audioStats.isFile()) {
          throw new Error('Original audio is not a file');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('Original audio is missing');
        }
        throw error;
      }
      await mediaRegistry.authorizeSelectedFile(audioPath);
    }

    return startGeneration(
      { ...request, retryOf: id },
      { workflowPath: work.metadata.workflowVersion },
    );
  };
}
