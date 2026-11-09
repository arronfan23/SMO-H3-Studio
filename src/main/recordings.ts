import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  convertAudio,
  type AudioConverter,
} from './audio-converter';
import type { MediaRegistry } from './media';

export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

export interface RecordingSaveInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface RecordingServiceOptions {
  recordingsDirectory: string;
  mediaRegistry: Pick<MediaRegistry, 'authorizeSelectedFile' | 'revokeFile'>;
  ffmpegPath: string | (() => string);
  temporaryDirectory?: string;
  converter?: AudioConverter;
}

export class RecordingService {
  private readonly recordingsDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly mediaRegistry: Pick<
    MediaRegistry,
    'authorizeSelectedFile' | 'revokeFile'
  >;
  private readonly ffmpegPath: string | (() => string);
  private readonly converter: AudioConverter;
  private readonly pending = new Map<AbortController, Promise<void>>();
  private closed = false;

  constructor(options: RecordingServiceOptions) {
    this.recordingsDirectory = resolve(options.recordingsDirectory);
    this.temporaryDirectory = resolve(
      options.temporaryDirectory ?? join(options.recordingsDirectory, '.tmp'),
    );
    this.mediaRegistry = options.mediaRegistry;
    this.ffmpegPath = options.ffmpegPath;
    this.converter = options.converter ?? convertAudio;
  }

  async save(input: RecordingSaveInput): Promise<string> {
    if (!(input?.bytes instanceof Uint8Array)) {
      throw new Error('Recording bytes must be a Uint8Array');
    }
    if (input.bytes.byteLength === 0) {
      throw new Error('Recording bytes must not be empty');
    }
    if (input.bytes.byteLength > MAX_RECORDING_BYTES) {
      throw new Error('Recording bytes must not exceed 200 MiB');
    }
    if (this.closed) {
      throw new Error('Recording service is closed');
    }

    const controller = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.pending.set(controller, settled);

    const sourcePath = join(this.temporaryDirectory, `${randomUUID()}.webm`);
    const destinationPath = join(
      this.recordingsDirectory,
      `${randomUUID()}.wav`,
    );
    let authorized = false;
    try {
      await Promise.all([
        mkdir(this.temporaryDirectory, { recursive: true }),
        mkdir(this.recordingsDirectory, { recursive: true }),
      ]);
      await writeFile(sourcePath, input.bytes, { flag: 'wx' });
      const ffmpegPath =
        typeof this.ffmpegPath === 'function'
          ? this.ffmpegPath()
          : this.ffmpegPath;
      await this.converter({
        ffmpegPath,
        sourcePath,
        destinationPath,
        format: 'wav',
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      await this.mediaRegistry.authorizeSelectedFile(destinationPath);
      controller.signal.throwIfAborted();
      authorized = true;
      return destinationPath;
    } catch (error) {
      await rm(destinationPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(sourcePath, { force: true }).catch(() => undefined);
      this.pending.delete(controller);
      markSettled();
      if (!authorized) {
        controller.abort();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.pending.entries()];
    for (const [controller] of pending) {
      controller.abort(new Error('Recording service closed'));
    }
    await Promise.allSettled(pending.map(([, settled]) => settled));
  }

  async discard(filePath: string): Promise<void> {
    if (
      filePath.trim().length === 0 ||
      !isAbsolute(filePath) ||
      extname(filePath).toLowerCase() !== '.wav'
    ) {
      throw new Error('Recording path must be an absolute WAV path');
    }

    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(this.recordingsDirectory),
      realpath(filePath),
    ]);
    const relativePath = relative(canonicalRoot, canonicalPath);
    if (extname(canonicalPath).toLowerCase() !== '.wav') {
      throw new Error('Canonical recording path must be a WAV file');
    }
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath) ||
      !(await stat(canonicalPath)).isFile()
    ) {
      throw new Error('Recording path is outside the recordings directory');
    }

    this.mediaRegistry.revokeFile(canonicalPath);
    await rm(canonicalPath);
  }
}
