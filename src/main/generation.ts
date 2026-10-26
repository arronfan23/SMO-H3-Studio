import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ComfyClient, ComfyOutputFile } from './comfy';
import type { GenerationHandler } from './ipc';
import type { JobCoordinator } from './jobs';
import type { Store } from './store';
import { patchWorkflow } from '../shared/workflow';
import type { GenerationRequest } from '../shared/types';

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

function isMp4(file: ComfyOutputFile): boolean {
  return extname(file.filename).toLowerCase() === '.mp4';
}

function selectVideoOutput(files: ComfyOutputFile[]): ComfyOutputFile {
  const videoFiles = files.filter((file) => file.kind === 'video' || file.kind === 'gifs');
  const output =
    videoFiles.find(isMp4) ??
    files.find(isMp4) ??
    videoFiles[0];
  if (!output) {
    throw new Error('ComfyUI history did not contain a video output');
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

export function createGenerationHandler(
  options: GenerationHandlerOptions,
): GenerationHandler {
  const { store, comfy, jobCoordinator, workflowsDirectory, outputDirectory } = options;

  return async (input) => {
    const avatar = store.listAvatars().find((candidate) => candidate.id === input.avatarId);
    if (!avatar) {
      throw new Error(`Avatar not found: ${input.avatarId}`);
    }
    validateRequest(input);
    const request = sanitizeRequest(input);
    const workId = randomUUID();
    const workflowFilename = WORKFLOW_FILENAMES[request.mode];
    store.addWork({
      id: workId,
      avatarId: request.avatarId,
      mode: request.mode,
      outputPath: null,
      status: 'pending',
      promptId: null,
      metadata: { request, workflowVersion: workflowFilename },
      error: null,
    });

    const run = async (): Promise<void> => {
      try {
        const image = await comfy.uploadFile({
          filePath: avatar.photoPath,
          kind: 'image',
        });
        const changes: Record<string, unknown> =
          request.mode === 'text'
            ? {
                '226.inputs.image': image,
                '136.inputs.prompt': request.prompt,
                '132.inputs.value': request.duration,
                '269.inputs.seed': request.seed,
                '180.inputs.filename_prefix': `SMO-H3/${workId}`,
              }
            : {
                '36.inputs.image': image,
                '34.inputs.audio': await comfy.uploadFile({
                  filePath: request.audioPath!,
                  kind: 'audio',
                }),
                '42.inputs.prompt': request.prompt,
                '85.inputs.start_index': request.trimStart ?? 0,
                '85.inputs.duration': request.duration,
                '86.inputs.seed': request.seed,
                '65.inputs.filename_prefix': `SMO-H3/${workId}`,
              };
        const frozen = JSON.parse(
          await readFile(join(workflowsDirectory, workflowFilename), 'utf8'),
        ) as WorkflowGraph;
        const submitted = await comfy.submit(patchWorkflow(frozen, changes));
        store.updateWork(workId, { promptId: submitted.prompt_id });
        await comfy.waitForCompletion(submitted.prompt_id);
        const output = selectVideoOutput(await comfy.history(submitted.prompt_id));
        store.updateWork(workId, {
          status: 'done',
          outputPath: resolveOutputPath(outputDirectory, output),
          error: null,
        });
      } catch (error) {
        store.updateWork(workId, {
          status: 'failed',
          error: errorMessage(error),
        });
        throw error;
      }
    };

    // Failures settle in Store and coordinator events; callers receive the queued id immediately.
    void jobCoordinator
      .enqueue({ id: workId, run, cancel: () => comfy.cancel() })
      .catch(() => undefined);
    return { id: workId };
  };
}
