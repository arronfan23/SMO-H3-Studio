import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type AudioConversionFormat = 'wav' | 'mp3' | 'flac' | 'm4a';

export interface AudioConvertInput {
  ffmpegPath: string;
  sourcePath: string;
  destinationPath: string;
  format: AudioConversionFormat;
  signal?: AbortSignal;
}

export interface AudioExecutorOptions {
  timeout: number;
  windowsHide: boolean;
  signal?: AbortSignal;
}

export interface AudioExecutor {
  (
    filePath: string,
    args: string[],
    options: AudioExecutorOptions,
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface AudioConvertOptions {
  execute?: AudioExecutor;
  timeoutMs?: number;
}

export type AudioConverter = (input: AudioConvertInput) => Promise<void>;

const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

const defaultExecute: AudioExecutor = async (filePath, args, options) =>
  execFileAsync(filePath, args, options) as Promise<{
    stdout: string;
    stderr: string;
  }>;

function codecArgs(format: AudioConversionFormat): string[] {
  switch (format) {
    case 'wav':
      return ['-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le'];
    case 'mp3':
      return ['-c:a', 'libmp3lame'];
    case 'flac':
      return ['-c:a', 'flac'];
    case 'm4a':
      return ['-c:a', 'aac'];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function convertAudio(
  input: AudioConvertInput,
  options: AudioConvertOptions = {},
): Promise<void> {
  input.signal?.throwIfAborted();
  const execute = options.execute ?? defaultExecute;
  try {
    await execute(
      input.ffmpegPath,
      [
        '-nostdin',
        '-y',
        '-i',
        input.sourcePath,
        ...codecArgs(input.format),
        input.destinationPath,
      ],
      {
        timeout: options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
        windowsHide: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    throw new Error(`FFmpeg conversion failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
