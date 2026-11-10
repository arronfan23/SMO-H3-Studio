import { createHash, type Hash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createReadStream,
  createWriteStream,
  type Stats,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type {
  ClientRequest,
  IncomingMessage as ElectronIncomingMessage,
  Net,
} from 'electron';
import type { EnvironmentArchivePart, EnvironmentModelFile } from '../shared/environment';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  path: string;
}

export interface DownloadReceipt {
  resumed: boolean;
  bytes: number;
  sha256: string;
}

export type DownloadFetch = typeof globalThis.fetch;
export type DownloadProgressCallback = (progress: DownloadProgress) => void;
const requireElectron = createRequire(import.meta.url);

/**
 * Hugging Face is unreachable on some networks where its community mirror is
 * reachable. SHA256 verification still protects every downloaded byte.
 */
export function modelDownloadUrls(model: EnvironmentModelFile): string[] {
  const source = new URL(model.url);
  if (source.hostname !== 'huggingface.co') return [model.url];
  return [
    `https://hf-mirror.com${source.pathname}${source.search}`,
    model.url,
  ];
}

/** GitHub is preferred; the mirror is a fallback and SHA256 verifies every byte. */
export function runtimeDownloadUrls(url: string): string[] {
  const source = new URL(url);
  if (source.hostname !== 'github.com') return [url];
  return [url, `https://ghproxy.net/${url}`];
}

export function downloadArtifactPaths(destination: string): string[] {
  return [
    `${destination}.part`,
    `${destination}.part.chunks.json`,
    `${destination}.part.chunks.json.tmp`,
    `${destination}.part.source`,
  ];
}

export async function clearTemporaryDownload(destination: string): Promise<void> {
  await Promise.all(
    downloadArtifactPaths(destination).map((path) => rm(path, { force: true })),
  );
}

export async function prepareDownloadSource(destination: string, url: string): Promise<void> {
  const sourcePath = `${destination}.part.source`;
  let previousSource: string | undefined;
  try {
    previousSource = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previousSource !== url) await clearTemporaryDownload(destination);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(sourcePath, url, 'utf8');
}

function electronResponseHeaders(
  input: Record<string, string | string[]>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

function electronResponseBody(
  response: ElectronIncomingMessage,
  request: ClientRequest,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      const finish = (complete: () => void) => {
        if (finished) return;
        finished = true;
        complete();
      };
      response.on('data', (chunk) => {
        if (!finished) controller.enqueue(chunk);
      });
      response.once('end', () => finish(() => controller.close()));
      response.once('aborted', () =>
        finish(() => controller.error(new Error('Download response was aborted'))),
      );
      response.once('error', (error) => finish(() => controller.error(error)));
    },
    cancel() {
      request.abort();
    },
  });
}

export function createElectronDownloadFetch(net: Net): DownloadFetch {
  return (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });

    return new Promise<Response>((resolve, reject) => {
      const request = net.request({
        method: init?.method ?? 'GET',
        url,
        headers,
        redirect: 'manual',
      });
      let settled = false;
      const abort = () => {
        if (!settled) {
          settled = true;
          reject(init?.signal?.reason ?? new Error('Download was aborted'));
        }
        request.abort();
      };

      request.once('error', (error) => {
        // Manual redirects are cancelled by Chromium before the next request.
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
        if (settled) return;
        settled = true;
        const redirectHeaders = electronResponseHeaders(responseHeaders);
        if (redirectUrl && !redirectHeaders.has('location')) {
          redirectHeaders.set('location', redirectUrl);
        }
        resolve(
          new Response(null, {
            status: statusCode,
            headers: redirectHeaders,
          }),
        );
      });
      request.on('response', (response) => {
        if (settled) return;
        settled = true;
        const hasBody = ![204, 205, 304].includes(response.statusCode);
        resolve(
          new Response(hasBody ? electronResponseBody(response, request) : null, {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: electronResponseHeaders(response.headers),
          }),
        );
      });

      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () => {
        init?.signal?.removeEventListener('abort', abort);
      });
      request.end();
    });
  };
}

const defaultDownloadFetch: DownloadFetch = (input, init) => {
  if (process.versions.electron) {
    const { net } = requireElectron('electron') as typeof import('electron');
    return createElectronDownloadFetch(net)(input, init);
  }
  return globalThis.fetch(input, init);
};

export interface DownloadFileOptions {
  url: string;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  signal?: AbortSignal;
  onProgress?: DownloadProgressCallback;
  fetch?: DownloadFetch;
  stallTimeoutMs?: number;
  parallelThresholdBytes?: number;
  chunkSizeBytes?: number;
  maxConnections?: number;
}

export interface DownloadPartsOptions {
  parts: EnvironmentArchivePart[];
  directory: string;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  signal?: AbortSignal;
  onProgress?: DownloadProgressCallback;
  fetch?: DownloadFetch;
}

const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:[ .]|$)/i;
const WINDOWS_ILLEGAL_CHARACTER_PATTERN = /[<>"|?*\x00-\x1F]/;
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAXIMUM_REDIRECTS = 20;
const DOWNLOAD_STALL_TIMEOUT_MS = 20_000;
const PARALLEL_DOWNLOAD_THRESHOLD_BYTES = 64 * 1024 * 1024;
const PARALLEL_DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const PARALLEL_DOWNLOAD_CONNECTIONS = 6;

class RangeDownloadUnsupportedError extends Error {}

interface ParallelChunk {
  index: number;
  start: number;
  end: number;
}

interface ParallelChunkLedger {
  version: 1;
  expectedSize: number;
  expectedSha256: string;
  chunkSize: number;
  baseBytes: number;
  completed: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateExpectedSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Expected size must be a positive safe integer');
  }
  return value;
}

function validateExpectedSha256(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('Expected SHA256 must contain exactly 64 hexadecimal characters');
  }
  return value.toLowerCase();
}

function validateHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Download URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Download URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Download URL must not contain credentials');
  }
  return url;
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    WINDOWS_ILLEGAL_CHARACTER_PATTERN.test(value) ||
    /^(?:\\\\[?.]\\|\/\/[?.]\/)/.test(value)
  ) {
    throw new Error(`${label} is not a safe Windows path`);
  }

  const hasDriveRoot = /^[A-Za-z]:[\\/]/.test(value);
  const hasUncRoot = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
  if (!win32.isAbsolute(value) || (!hasDriveRoot && !hasUncRoot)) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  if ((hasDriveRoot ? value.slice(2) : value).includes(':')) {
    throw new Error(`${label} must not contain an alternate data stream`);
  }

  for (const segment of value.split(/[\\/]+/)) {
    if (!segment) continue;
    if (segment === '.' || segment === '..') {
      throw new Error(`${label} must not contain traversal segments`);
    }
    if (/^[A-Za-z]:$/.test(segment)) continue;
    if (/[. ]$/.test(segment) || WINDOWS_DEVICE_NAME_PATTERN.test(segment)) {
      throw new Error(`${label} contains an unsafe Windows path segment`);
    }
  }
  return value;
}

function validateDestinationPath(value: string): string {
  validateAbsolutePath(value, 'Destination');
  if (/[\\/]$/.test(value) || win32.dirname(value) === win32.normalize(value)) {
    throw new Error('Destination must name a file, not a directory');
  }
  return value;
}

function validatePartPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    WINDOWS_ILLEGAL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error('Part path must be a safe relative path');
  }

  for (const segment of value.split('/')) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      /[. ]$/.test(segment) ||
      WINDOWS_DEVICE_NAME_PATTERN.test(segment)
    ) {
      throw new Error('Part path must be a safe relative path without traversal');
    }
  }
  return value;
}

function isContainedPath(directory: string, candidate: string): boolean {
  const child = relative(resolve(directory), resolve(candidate));
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function isSameOrAncestorPath(ancestor: string, candidate: string): boolean {
  const child = win32.relative(ancestor, candidate);
  return (
    child === '' ||
    (child !== '..' &&
      !child.startsWith(`..${win32.sep}`) &&
      !win32.isAbsolute(child))
  );
}

function pathsCollide(first: string, second: string): boolean {
  return (
    isSameOrAncestorPath(first, second) ||
    isSameOrAncestorPath(second, first)
  );
}

async function regularFileStats(path: string): Promise<Stats | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`Expected a regular file: ${path}`);
    }
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function hashExistingFile(
  path: string,
  hash: Hash,
  signal?: AbortSignal,
): Promise<number> {
  let bytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        hash.update(chunk);
        bytes += chunk.length;
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await pipeline(createReadStream(path), sink, { signal });
  return bytes;
}

async function verifyExistingFile(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<DownloadReceipt | null> {
  const stats = await regularFileStats(path);
  if (!stats || stats.size !== expectedSize) return null;

  const hash = createHash('sha256');
  const bytes = await hashExistingFile(path, hash, signal);
  const actualSha256 = hash.digest('hex');
  if (bytes !== expectedSize || actualSha256 !== expectedSha256) return null;
  return { resumed: false, bytes, sha256: actualSha256 };
}

function discardResponse(response: Response): void {
  try {
    // Some network stacks never settle cancel() after a failed or redirected
    // request. Cleanup must not hold the download state machine hostage.
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The original HTTP/status error is more useful than a body-cleanup error.
  }
}

async function fetchWithValidatedRedirects(
  fetchImpl: DownloadFetch,
  initialUrl: URL,
  headers: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;
  let redirectCount = 0;

  while (true) {
    const response = await fetchImpl(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount >= MAXIMUM_REDIRECTS) {
      await discardResponse(response);
      throw new Error('Download exceeded the maximum number of redirects');
    }

    await discardResponse(response);
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error('Redirect Location must be a valid HTTPS URL');
    }
    currentUrl = validateHttpsUrl(nextUrl.href);
    redirectCount += 1;
  }
}

function validateContentRange(header: string | null, expectedStart: number): void {
  const match = header ? CONTENT_RANGE_PATTERN.exec(header.trim()) : null;
  if (!match || Number(match[1]) !== expectedStart) {
    throw new Error('Server returned an invalid Content-Range for the resumed download');
  }
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < expectedStart) {
    throw new Error('Server returned an invalid Content-Range for the resumed download');
  }
}

function positiveDownloadOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return selected;
}

function makeParallelChunks(
  baseBytes: number,
  expectedSize: number,
  chunkSize: number,
): ParallelChunk[] {
  const chunks: ParallelChunk[] = [];
  let index = 0;
  for (let start = baseBytes; start < expectedSize; start += chunkSize) {
    chunks.push({ index, start, end: Math.min(start + chunkSize, expectedSize) });
    index += 1;
  }
  return chunks;
}

function isParallelChunkLedger(value: unknown): value is ParallelChunkLedger {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.expectedSize === 'number' &&
    Number.isSafeInteger(value.expectedSize) &&
    value.expectedSize > 0 &&
    typeof value.expectedSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.expectedSha256) &&
    typeof value.chunkSize === 'number' &&
    Number.isSafeInteger(value.chunkSize) &&
    value.chunkSize > 0 &&
    typeof value.baseBytes === 'number' &&
    Number.isSafeInteger(value.baseBytes) &&
    value.baseBytes >= 0 &&
    value.baseBytes < value.expectedSize &&
    Array.isArray(value.completed) &&
    value.completed.every(
      (index) => Number.isSafeInteger(index) && index >= 0,
    )
  );
}

async function readParallelChunkLedger(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  chunkSize: number,
): Promise<ParallelChunkLedger | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !isParallelChunkLedger(value) ||
      value.expectedSize !== expectedSize ||
      value.expectedSha256 !== expectedSha256 ||
      value.chunkSize !== chunkSize
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function writeParallelChunkLedger(
  path: string,
  ledger: ParallelChunkLedger,
): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(ledger), 'utf8');
  await rename(temporaryPath, path);
}

function validateChunkContentRange(
  header: string | null,
  chunk: ParallelChunk,
  expectedSize: number,
): void {
  const match = header ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim()) : null;
  if (
    !match ||
    Number(match[1]) !== chunk.start ||
    Number(match[2]) !== chunk.end - 1 ||
    (match[3] !== '*' && Number(match[3]) !== expectedSize)
  ) {
    throw new Error('Server returned an invalid Content-Range for a download chunk');
  }
}

async function downloadParallelChunk(input: {
  url: URL;
  fetchImpl: DownloadFetch;
  signal: AbortSignal;
  stallTimeoutMs: number;
  expectedSize: number;
  handle: FileHandle;
  chunk: ParallelChunk;
  onBytes: (bytes: number) => void;
}): Promise<void> {
  const { chunk, signal } = input;
  const expectedBytes = chunk.end - chunk.start;
  const chunkController = new AbortController();
  const forwardAbort = () => chunkController.abort(signal.reason);
  let stallTimer: NodeJS.Timeout | undefined;
  let stallError: Error | undefined;
  const refreshStallTimeout = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallError = new Error(
        `Download timed out after ${input.stallTimeoutMs} ms without progress`,
      );
      chunkController.abort(stallError);
    }, input.stallTimeoutMs);
  };
  if (signal.aborted) forwardAbort();
  signal.addEventListener('abort', forwardAbort, { once: true });
  refreshStallTimeout();

  try {
    const response = await fetchWithValidatedRedirects(
      input.fetchImpl,
      input.url,
      {
        Range: `bytes=${chunk.start}-${chunk.end - 1}`,
        'Accept-Encoding': 'identity',
      },
      chunkController.signal,
    );
    if (response.status === 200) {
      await discardResponse(response);
      throw new RangeDownloadUnsupportedError(
        'Server does not support parallel Range downloads',
      );
    }
    if (response.status !== 206) {
      await discardResponse(response);
      throw new Error(`Download failed with unexpected HTTP status ${response.status}`);
    }
    try {
      validateChunkContentRange(
        response.headers.get('content-range'),
        chunk,
        input.expectedSize,
      );
    } catch (error) {
      await discardResponse(response);
      throw error;
    }
    if (!response.body) throw new Error('Download response did not include a body');

    const buffers: Buffer[] = [];
    let receivedBytes = 0;
    const collector = new Writable({
      write(data: Buffer, _encoding, callback) {
        try {
          if (receivedBytes + data.length > expectedBytes) {
            throw new Error('Downloaded chunk exceeds its requested range');
          }
          buffers.push(Buffer.from(data));
          receivedBytes += data.length;
          refreshStallTimeout();
          input.onBytes(receivedBytes);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    const body = Readable.fromWeb(
      response.body as unknown as NodeReadableStream<Uint8Array>,
    );
    await pipeline(body, collector, { signal: chunkController.signal });
    if (receivedBytes !== expectedBytes) {
      throw new Error(
        `Downloaded chunk size mismatch: expected ${expectedBytes}, received ${receivedBytes}`,
      );
    }

    const data = Buffer.concat(buffers, receivedBytes);
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await input.handle.write(
        data,
        offset,
        data.length - offset,
        chunk.start + offset,
      );
      if (bytesWritten <= 0) throw new Error('Could not write downloaded chunk');
      offset += bytesWritten;
    }
  } catch (error) {
    if (stallError) throw stallError;
    throw error;
  } finally {
    clearTimeout(stallTimer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

async function downloadFileParallel(
  options: DownloadFileOptions,
): Promise<DownloadReceipt> {
  const url = validateHttpsUrl(options.url);
  const expectedSize = validateExpectedSize(options.expectedSize);
  const expectedSha256 = validateExpectedSha256(options.expectedSha256);
  const destination = validateDestinationPath(options.destination);
  const partPath = `${destination}.part`;
  const ledgerPath = `${partPath}.chunks.json`;
  const fetchImpl = options.fetch ?? defaultDownloadFetch;
  const signal = options.signal;
  const chunkSize = positiveDownloadOption(
    options.chunkSizeBytes,
    PARALLEL_DOWNLOAD_CHUNK_BYTES,
    'Chunk size',
  );
  const maxConnections = positiveDownloadOption(
    options.maxConnections,
    PARALLEL_DOWNLOAD_CONNECTIONS,
    'Maximum connections',
  );
  const stallTimeoutMs = options.stallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS;

  signal?.throwIfAborted();
  const existingDestination = await verifyExistingFile(
    destination,
    expectedSize,
    expectedSha256,
    signal,
  );
  if (existingDestination) return existingDestination;
  await mkdir(dirname(partPath), { recursive: true });
  const partStats = await regularFileStats(partPath);
  const storedLedger =
    partStats?.size === expectedSize
      ? await readParallelChunkLedger(ledgerPath, expectedSize, expectedSha256, chunkSize)
      : null;
  const completePart = storedLedger
    ? null
    : await verifyExistingFile(partPath, expectedSize, expectedSha256, signal);
  if (completePart) {
    await rename(partPath, destination);
    await rm(ledgerPath, { force: true });
    return completePart;
  }

  const baseBytes = storedLedger
    ? storedLedger.baseBytes
    : partStats && partStats.size < expectedSize
      ? partStats.size
      : 0;
  const chunks = makeParallelChunks(baseBytes, expectedSize, chunkSize);
  const chunkCount = chunks.length;
  const completed = new Set(
    (storedLedger?.completed ?? []).filter(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < chunkCount,
    ),
  );
  const resumed = baseBytes > 0 || completed.size > 0;
  const ledger: ParallelChunkLedger = {
    version: 1,
    expectedSize,
    expectedSha256,
    chunkSize,
    baseBytes,
    completed: [],
  };
  let completedBytes = baseBytes;
  for (const chunk of chunks) {
    if (completed.has(chunk.index)) completedBytes += chunk.end - chunk.start;
  }

  const operationController = new AbortController();
  const forwardAbort = () => operationController.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let handle: FileHandle | undefined;
  let operationError: unknown;
  try {
    handle = await open(partPath, partStats ? 'r+' : 'w+');
    await handle.truncate(expectedSize);
    await writeParallelChunkLedger(ledgerPath, {
      ...ledger,
      completed: [...completed].sort((left, right) => left - right),
    });

    const activeBytes = new Map<number, number>();
    const reportProgress = () => {
      let downloadedBytes = completedBytes;
      for (const bytes of activeBytes.values()) downloadedBytes += bytes;
      options.onProgress?.({
        downloadedBytes,
        totalBytes: expectedSize,
        path: destination,
      });
    };
    reportProgress();

    let saveChain: Promise<void> = Promise.resolve();
    const queueLedgerSave = () => {
      const snapshot = {
        ...ledger,
        completed: [...completed].sort((left, right) => left - right),
      };
      const operation = saveChain.then(() => writeParallelChunkLedger(ledgerPath, snapshot));
      saveChain = operation.catch(() => undefined);
      return operation;
    };

    let cursor = 0;
    let firstError: unknown;
    const worker = async () => {
      while (firstError === undefined) {
        const chunk = chunks[cursor];
        cursor += 1;
        if (!chunk) return;
        if (completed.has(chunk.index)) continue;
        try {
          operationController.signal.throwIfAborted();
          await downloadParallelChunk({
            url,
            fetchImpl,
            signal: operationController.signal,
            stallTimeoutMs,
            expectedSize,
            handle: handle!,
            chunk,
            onBytes: (bytes) => {
              activeBytes.set(chunk.index, bytes);
              reportProgress();
            },
          });
          activeBytes.delete(chunk.index);
          completed.add(chunk.index);
          completedBytes += chunk.end - chunk.start;
          await queueLedgerSave();
          reportProgress();
        } catch (error) {
          activeBytes.delete(chunk.index);
          if (firstError === undefined) firstError = error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(maxConnections, chunkCount) }, () => worker()),
    );
    await saveChain;
    if (firstError !== undefined) throw firstError;
    operationController.signal.throwIfAborted();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
    if (handle) {
      await handle.close().catch((error) => {
        if (operationError === undefined) throw error;
      });
    }
  }

  signal?.throwIfAborted();
  const hash = createHash('sha256');
  const hashedBytes = await hashExistingFile(partPath, hash, signal);
  const actualSha256 = hash.digest('hex');
  if (hashedBytes !== expectedSize || actualSha256 !== expectedSha256) {
    await rm(partPath, { force: true });
    await rm(ledgerPath, { force: true });
    throw new Error('Downloaded SHA256 does not match the expected SHA256');
  }
  await rename(partPath, destination);
  await rm(ledgerPath, { force: true });
  return { resumed, bytes: expectedSize, sha256: actualSha256 };
}

async function downloadFileSequential(
  options: DownloadFileOptions,
): Promise<DownloadReceipt> {
  const url = validateHttpsUrl(options.url);
  const expectedSize = validateExpectedSize(options.expectedSize);
  const expectedSha256 = validateExpectedSha256(options.expectedSha256);
  const destination = validateDestinationPath(options.destination);
  const partPath = `${destination}.part`;
  const fetchImpl = options.fetch ?? defaultDownloadFetch;
  const signal = options.signal;

  signal?.throwIfAborted();
  const existingDestination = await verifyExistingFile(
    destination,
    expectedSize,
    expectedSha256,
    signal,
  );
  if (existingDestination) return existingDestination;

  const completePart = await verifyExistingFile(
    partPath,
    expectedSize,
    expectedSha256,
    signal,
  );
  if (completePart) {
    signal?.throwIfAborted();
    await rename(partPath, destination);
    return completePart;
  }

  const partStats = await regularFileStats(partPath);
  let downloadedBytes = partStats?.size ?? 0;
  const canResume = downloadedBytes > 0 && downloadedBytes < expectedSize;
  let hash = createHash('sha256');

  if (canResume) {
    const hashedBytes = await hashExistingFile(partPath, hash, signal);
    if (hashedBytes !== downloadedBytes) {
      throw new Error('Part file changed while it was being prepared for resume');
    }
  }

  signal?.throwIfAborted();
  await mkdir(dirname(partPath), { recursive: true });
  const stallTimeoutMs = options.stallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS;
  const timeoutController = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  let stallError: Error | undefined;
  const forwardAbort = () => timeoutController.abort(signal?.reason);
  const refreshStallTimeout = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallError = new Error(
        `Download timed out after ${stallTimeoutMs} ms without progress`,
      );
      timeoutController.abort(stallError);
    }, stallTimeoutMs);
  };
  if (signal?.aborted) forwardAbort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  refreshStallTimeout();

  let append = false;
  try {
    const response = await fetchWithValidatedRedirects(
      fetchImpl,
      url,
      canResume ? { Range: `bytes=${downloadedBytes}-` } : undefined,
      timeoutController.signal,
    );

    if (response.status === 200) {
      downloadedBytes = 0;
      hash = createHash('sha256');
    } else if (response.status === 206 && canResume) {
      try {
        validateContentRange(response.headers.get('content-range'), downloadedBytes);
      } catch (error) {
        await discardResponse(response);
        throw error;
      }
      append = true;
    } else {
      await discardResponse(response);
      throw new Error(`Download failed with unexpected HTTP status ${response.status}`);
    }

    if (!response.body) {
      throw new Error('Download response did not include a body');
    }

    if (append) {
      try {
        options.onProgress?.({
          downloadedBytes,
          totalBytes: expectedSize,
          path: destination,
        });
      } catch (error) {
        await discardResponse(response);
        throw error;
      }
    }

    let handle: FileHandle | undefined;
    const output = new Writable({
      autoDestroy: true,
      construct(callback) {
        open(partPath, append ? 'a' : 'w').then(
          (opened) => {
            handle = opened;
            callback();
          },
          (error) => callback(error as Error),
        );
      },
      write(chunk: Buffer, _encoding, callback) {
        void (async () => {
          if (downloadedBytes + chunk.length > expectedSize) {
            throw new Error('Downloaded size exceeds the expected size');
          }
          const currentHandle = handle;
          if (!currentHandle) throw new Error('Part file is not open');

          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await currentHandle.write(
              chunk,
              offset,
              chunk.length - offset,
              null,
            );
            if (bytesWritten <= 0) throw new Error('Could not write downloaded data');
            offset += bytesWritten;
          }

          hash.update(chunk);
          downloadedBytes += chunk.length;
          refreshStallTimeout();
          options.onProgress?.({
            downloadedBytes,
            totalBytes: expectedSize,
            path: destination,
          });
        })().then(
          () => callback(),
          (error) => callback(error as Error),
        );
      },
      destroy(error, callback) {
        const currentHandle = handle;
        handle = undefined;
        if (!currentHandle) {
          callback(error);
          return;
        }
        currentHandle.close().then(
          () => callback(error),
          (closeError) => callback(error ?? closeError),
        );
      },
    });

    const body = Readable.fromWeb(
      response.body as unknown as NodeReadableStream<Uint8Array>,
    );
    await pipeline(body, output, { signal: timeoutController.signal });
  } catch (error) {
    if (stallError) throw stallError;
    throw error;
  } finally {
    clearTimeout(stallTimer);
    signal?.removeEventListener('abort', forwardAbort);
  }

  const actualSha256 = hash.digest('hex');
  if (downloadedBytes !== expectedSize) {
    throw new Error(
      `Downloaded size mismatch: expected ${expectedSize}, received ${downloadedBytes}`,
    );
  }
  if (actualSha256 !== expectedSha256) {
    await rm(partPath, { force: true });
    throw new Error('Downloaded SHA256 does not match the expected SHA256');
  }

  signal?.throwIfAborted();
  await rename(partPath, destination);
  return { resumed: append, bytes: downloadedBytes, sha256: actualSha256 };
}

export async function downloadFile(
  options: DownloadFileOptions,
): Promise<DownloadReceipt> {
  const parallelThresholdBytes = positiveDownloadOption(
    options.parallelThresholdBytes,
    PARALLEL_DOWNLOAD_THRESHOLD_BYTES,
    'Parallel download threshold',
  );
  if (options.expectedSize < parallelThresholdBytes) {
    return downloadFileSequential(options);
  }

  try {
    return await downloadFileParallel(options);
  } catch (error) {
    if (!(error instanceof RangeDownloadUnsupportedError) || options.signal?.aborted) {
      throw error;
    }

    const destination = validateDestinationPath(options.destination);
    await rm(`${destination}.part.chunks.json`, { force: true });
    await rm(`${destination}.part.chunks.json.tmp`, { force: true });
    await rm(`${destination}.part`, { force: true });
    return downloadFileSequential(options);
  }
}

export function validateDownloadPartPaths(
  options: Pick<DownloadPartsOptions, 'parts' | 'directory' | 'destination'>,
): {
  directory: string;
  destination: string;
  parts: Array<EnvironmentArchivePart & { resolvedPartPath: string }>;
} {
  validateAbsolutePath(options.directory, 'Parts directory');
  const destination = resolve(validateDestinationPath(options.destination));
  const directory = resolve(options.directory);
  if (!isContainedPath(directory, destination)) {
    throw new Error('Destination must be contained within the parts directory');
  }
  if (!Array.isArray(options.parts) || options.parts.length === 0) {
    throw new Error('At least one archive part is required');
  }

  const occupiedPaths = [destination, ...downloadArtifactPaths(destination)];
  const parts = options.parts.map((part) => {
    validateHttpsUrl(part.url);
    validateExpectedSize(part.size);
    const partSha256 = validateExpectedSha256(part.sha256);
    const partPath = validatePartPath(part.path);
    const resolvedPartPath = resolve(directory, ...partPath.split('/'));
    if (!isContainedPath(directory, resolvedPartPath)) {
      throw new Error('Part path escapes the parts directory');
    }
    for (const path of [resolvedPartPath, ...downloadArtifactPaths(resolvedPartPath)]) {
      if (occupiedPaths.some((occupiedPath) => pathsCollide(occupiedPath, path))) {
        throw new Error('Part or destination path collision detected');
      }
      occupiedPaths.push(path);
    }
    return {
      ...part,
      sha256: partSha256,
      path: partPath,
      resolvedPartPath,
    };
  });
  return { directory, destination, parts };
}

export async function downloadParts(
  options: DownloadPartsOptions,
): Promise<DownloadReceipt> {
  const expectedSize = validateExpectedSize(options.expectedSize);
  const expectedSha256 = validateExpectedSha256(options.expectedSha256);
  const { directory, destination, parts } = validateDownloadPartPaths(options);
  let declaredSize = 0;
  for (const part of parts) {
    declaredSize += part.size;
    if (!Number.isSafeInteger(declaredSize)) {
      throw new Error('Combined part size must be a safe integer');
    }
  }
  if (declaredSize !== expectedSize) {
    throw new Error('Combined part size does not match the expected archive size');
  }

  const signal = options.signal;
  const fetchImpl = options.fetch ?? defaultDownloadFetch;
  const mergedPartPath = `${destination}.part`;
  signal?.throwIfAborted();
  const existingDestination = await verifyExistingFile(
    destination,
    expectedSize,
    expectedSha256,
    signal,
  );
  if (existingDestination) return existingDestination;

  const completeMergedPart = await verifyExistingFile(
    mergedPartPath,
    expectedSize,
    expectedSha256,
    signal,
  );
  if (completeMergedPart) {
    signal?.throwIfAborted();
    await rename(mergedPartPath, destination);
    return completeMergedPart;
  }

  let resumed = false;
  let completedBytes = 0;
  for (const part of parts) {
    const receipt = await downloadFile({
      url: part.url,
      destination: part.resolvedPartPath,
      expectedSize: part.size,
      expectedSha256: part.sha256,
      signal,
      fetch: fetchImpl,
      onProgress: (progress) => {
        options.onProgress?.({
          downloadedBytes: completedBytes + progress.downloadedBytes,
          totalBytes: expectedSize,
          path: progress.path,
        });
      },
    });
    resumed ||= receipt.resumed;
    completedBytes += receipt.bytes;
    options.onProgress?.({
      downloadedBytes: completedBytes,
      totalBytes: expectedSize,
      path: part.resolvedPartPath,
    });
  }

  signal?.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  options.onProgress?.({
    downloadedBytes: completedBytes,
    totalBytes: expectedSize,
    path: destination,
  });

  const output = createWriteStream(mergedPartPath, { flags: 'w' });
  const hash = createHash('sha256');
  let mergedBytes = 0;
  try {
    for (const part of parts) {
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (mergedBytes + chunk.length > expectedSize) {
            callback(new Error('Merged archive size exceeds the expected size'));
            return;
          }
          try {
            hash.update(chunk);
            mergedBytes += chunk.length;
            callback(null, chunk);
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      await pipeline(createReadStream(part.resolvedPartPath), meter, output, {
        signal,
        end: false,
      });
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    await finished(output).catch(() => undefined);
    throw error;
  }

  const actualSha256 = hash.digest('hex');
  if (mergedBytes !== expectedSize) {
    throw new Error(
      `Merged archive size mismatch: expected ${expectedSize}, received ${mergedBytes}`,
    );
  }
  if (actualSha256 !== expectedSha256) {
    throw new Error('Merged archive SHA256 does not match the expected SHA256');
  }

  signal?.throwIfAborted();
  await rename(mergedPartPath, destination);
  return { resumed, bytes: mergedBytes, sha256: actualSha256 };
}
