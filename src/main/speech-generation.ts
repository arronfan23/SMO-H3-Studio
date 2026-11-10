import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  convertAudio,
  type AudioConverter,
} from './audio-converter';
import {
  createFfprobeDurationReader,
  type AudioDurationReader,
} from './audio-duration';
import type { JobCoordinator } from './jobs';
import type { MediaComponentService } from './media-components';
import type { MediaRegistry } from './media';
import type { SpeechProcessManager } from './speech-process';
import type { Store } from './store';
import type {
  GenerationStartResult,
  SpeechGenerationRequest,
  WorkMetadata,
} from '../shared/types';

export interface SpeechGenerationHandlerOptions {
  store: Pick<Store, 'addWork' | 'updateWork'>;
  speech: Pick<SpeechProcessManager, 'generate' | 'close'>;
  mediaComponents: Pick<MediaComponentService, 'getState'>;
  mediaRegistry: Pick<MediaRegistry, 'isSelectedFile'>;
  jobCoordinator: Pick<JobCoordinator, 'activeCount' | 'enqueue'>;
  outputDirectory: string;
  temporaryDirectory: string;
  ffmpegPath: string | (() => string);
  converter?: AudioConverter;
  durationReader?: AudioDurationReader;
  removeFile?: typeof rm;
  ensureReady?: (signal: AbortSignal) => Promise<unknown>;
  idGenerator?: () => string;
}

export type SpeechGenerationHandler = (
  request: SpeechGenerationRequest,
) => GenerationStartResult | Promise<GenerationStartResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineFailures(errors: unknown[]): AggregateError {
  return new AggregateError(errors, errors.map(errorMessage).join('; '));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateSpeechGenerationRequest(
  request: SpeechGenerationRequest,
): void {
  if (request?.mode !== 'speech') {
    throw new Error('Invalid speech generation mode');
  }
  if (request.speechMode !== 'custom' && request.speechMode !== 'clone') {
    throw new Error('Invalid speech voice mode');
  }
  if (!nonEmptyString(request.prompt)) {
    throw new Error('Speech prompt must not be empty');
  }
  if (!nonEmptyString(request.language)) {
    throw new Error('Speech language must not be empty');
  }
  if (!['wav', 'mp3', 'flac', 'm4a'].includes(request.outputFormat)) {
    throw new Error('Invalid speech output format');
  }
  for (const field of ['speaker', 'instruct', 'referenceText', 'retryOf'] as const) {
    if (request[field] !== undefined && typeof request[field] !== 'string') {
      throw new Error(`${field} must be a string`);
    }
  }
  if (
    request.referenceAudioPath !== undefined &&
    !nonEmptyString(request.referenceAudioPath)
  ) {
    throw new Error('referenceAudioPath must not be empty');
  }
  if (request.speechMode === 'custom' && !nonEmptyString(request.speaker)) {
    throw new Error('speaker is required for custom speech generation');
  }
  if (
    request.speechMode === 'clone' &&
    !nonEmptyString(request.referenceAudioPath)
  ) {
    throw new Error('referenceAudioPath is required for clone speech generation');
  }
}

export function isSpeechGenerationRequest(
  value: unknown,
): value is SpeechGenerationRequest {
  if (typeof value !== 'object' || value === null) return false;
  try {
    validateSpeechGenerationRequest(value as SpeechGenerationRequest);
    return true;
  } catch {
    return false;
  }
}

function sanitizeRequest(
  input: SpeechGenerationRequest,
): SpeechGenerationRequest {
  const request: SpeechGenerationRequest = {
    mode: 'speech',
    speechMode: input.speechMode,
    prompt: input.prompt,
    language: input.language,
    outputFormat: input.outputFormat,
  };
  for (const field of [
    'speaker',
    'instruct',
    'referenceAudioPath',
    'referenceText',
  ] as const) {
    if (input[field] !== undefined) request[field] = input[field];
  }
  return request;
}

function speechOutputPath(
  outputDirectory: string,
  workId: string,
  format: SpeechGenerationRequest['outputFormat'],
): { directory: string; path: string } {
  const directory = resolve(outputDirectory, 'SMO-Speech');
  const outputPath = resolve(directory, `${workId}.${format}`);
  const child = relative(directory, outputPath);
  if (
    !nonEmptyString(workId) ||
    workId.includes('/') ||
    workId.includes('\\') ||
    child.length === 0 ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error('Speech output path escapes the SMO-Speech output directory');
  }
  return { directory, path: outputPath };
}

export function createSpeechGenerationHandler(
  options: SpeechGenerationHandlerOptions,
): SpeechGenerationHandler {
  const {
    store,
    speech,
    mediaComponents,
    mediaRegistry,
    jobCoordinator,
  } = options;
  const converter = options.converter ?? convertAudio;
  const readDuration = options.durationReader ?? createFfprobeDurationReader();
  const remove = options.removeFile ?? rm;
  const createId = options.idGenerator ?? randomUUID;

  const requireReadyComponent = (): void => {
    if (mediaComponents.getState('speech').status !== 'ready') {
      throw new Error('Speech component must be installed and ready');
    }
  };

  return async (input) => {
    validateSpeechGenerationRequest(input);
    requireReadyComponent();
    if (jobCoordinator.activeCount > 0) {
      throw new Error('Another generation is already running');
    }
    if (
      input.speechMode === 'clone' &&
      !(await mediaRegistry.isSelectedFile(input.referenceAudioPath!))
    ) {
      throw new Error('referenceAudioPath must be an authorized selected media file');
    }
    requireReadyComponent();
    if (jobCoordinator.activeCount > 0) {
      throw new Error('Another generation is already running');
    }

    const request = sanitizeRequest(input);
    const workId = createId();
    const output = speechOutputPath(
      options.outputDirectory,
      workId,
      request.outputFormat,
    );
    const metadata: WorkMetadata = {
      request,
      ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
    };
    store.addWork({
      id: workId,
      avatarId: null,
      mode: 'speech',
      outputPath: null,
      status: 'pending',
      metadata,
      error: null,
    });

    const controller = new AbortController();
    let cancelRequested = false;
    let temporaryPath: string | undefined;
    let outputCreated = false;
    const throwIfCancelled = (): void => {
      if (cancelRequested) throw new Error('Generation cancelled');
    };
    const removeOutput = async (): Promise<Error | null> => {
      if (!outputCreated) return null;
      try {
        await remove(output.path, { force: true });
        outputCreated = false;
        return null;
      } catch (error) {
        try {
          await stat(output.path);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            outputCreated = false;
          }
        }
        return new Error(`Speech output cleanup failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    };

    const run = async (): Promise<void> => {
      let failure: { error: unknown } | null = null;
      try {
        throwIfCancelled();
        await options.ensureReady?.(controller.signal);
        throwIfCancelled();
        const wav = await speech.generate(
          request.speechMode === 'custom'
            ? {
                voiceMode: 'custom',
                text: request.prompt,
                language: request.language,
                speaker: request.speaker,
                instruct: request.instruct ?? '',
              }
            : {
                voiceMode: 'clone',
                text: request.prompt,
                language: request.language,
                referenceAudioPath: request.referenceAudioPath,
                referenceText: request.referenceText ?? '',
              },
        );
        throwIfCancelled();
        await Promise.all([
          mkdir(options.temporaryDirectory, { recursive: true }),
          mkdir(output.directory, { recursive: true }),
        ]);
        temporaryPath = join(options.temporaryDirectory, `${randomUUID()}.wav`);
        await writeFile(temporaryPath, wav, { flag: 'wx' });
        throwIfCancelled();

        if (request.outputFormat === 'wav') {
          await copyFile(temporaryPath, output.path, constants.COPYFILE_EXCL);
          outputCreated = true;
        } else {
          // Reserve the unique destination before FFmpeg, whose -y flag would
          // otherwise overwrite an existing work after an id collision.
          await writeFile(output.path, new Uint8Array(), { flag: 'wx' });
          outputCreated = true;
          const ffmpegPath =
            typeof options.ffmpegPath === 'function'
              ? options.ffmpegPath()
              : options.ffmpegPath;
          await converter({
            ffmpegPath,
            sourcePath: temporaryPath,
            destinationPath: output.path,
            format: request.outputFormat,
            signal: controller.signal,
          });
        }
        throwIfCancelled();
        const duration = await readDuration(output.path);
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error('Speech output duration must be a finite positive number');
        }
        throwIfCancelled();
        store.updateWork(workId, {
          outputPath: output.path,
          completedAt: new Date().toISOString(),
          error: null,
        });
      } catch (error) {
        failure = {
          error: cancelRequested ? new Error('Generation cancelled') : error,
        };
        const outputCleanupFailure = await removeOutput();
        if (outputCleanupFailure !== null) {
          failure.error = combineFailures([failure.error, outputCleanupFailure]);
        }
        store.updateWork(workId, {
          outputPath: outputCreated ? output.path : null,
          completedAt: null,
          error: errorMessage(failure.error),
        });
      } finally {
        if (temporaryPath !== undefined) {
          try {
            await remove(temporaryPath, { force: true });
          } catch (cleanupError) {
            const cleanupFailure = new Error(
              `Temporary WAV cleanup failed: ${errorMessage(cleanupError)}`,
              { cause: cleanupError },
            );
            const outputCleanupFailure = await removeOutput();
            const failures: unknown[] = [cleanupFailure];
            if (failure !== null) failures.unshift(failure.error);
            if (outputCleanupFailure !== null) failures.push(outputCleanupFailure);
            failure = {
              error: combineFailures(failures),
            };
            store.updateWork(workId, {
              outputPath: outputCreated ? output.path : null,
              completedAt: null,
              error: errorMessage(failure.error),
            });
          }
        }
      }
      if (failure !== null) throw failure.error;
    };

    try {
      void jobCoordinator
        .enqueue({
          id: workId,
          run,
          cancel: async () => {
            cancelRequested = true;
            controller.abort(new Error('Generation cancelled'));
            await speech.close();
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
