import { createHash, type Hash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  type Stats,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  rename,
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
import type { EnvironmentArchivePart } from '../shared/environment';

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

export interface DownloadFileOptions {
  url: string;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  signal?: AbortSignal;
  onProgress?: DownloadProgressCallback;
  fetch?: DownloadFetch;
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

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
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

export async function downloadFile(
  options: DownloadFileOptions,
): Promise<DownloadReceipt> {
  const url = validateHttpsUrl(options.url);
  const expectedSize = validateExpectedSize(options.expectedSize);
  const expectedSha256 = validateExpectedSha256(options.expectedSha256);
  const destination = validateDestinationPath(options.destination);
  const partPath = `${destination}.part`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
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
  const response = await fetchWithValidatedRedirects(
    fetchImpl,
    url,
    canResume ? { Range: `bytes=${downloadedBytes}-` } : undefined,
    signal,
  );

  let append = false;
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
  await pipeline(
    body,
    output,
    { signal },
  );

  const actualSha256 = hash.digest('hex');
  if (downloadedBytes !== expectedSize) {
    throw new Error(
      `Downloaded size mismatch: expected ${expectedSize}, received ${downloadedBytes}`,
    );
  }
  if (actualSha256 !== expectedSha256) {
    throw new Error('Downloaded SHA256 does not match the expected SHA256');
  }

  signal?.throwIfAborted();
  await rename(partPath, destination);
  return { resumed: append, bytes: downloadedBytes, sha256: actualSha256 };
}

export async function downloadParts(
  options: DownloadPartsOptions,
): Promise<DownloadReceipt> {
  const expectedSize = validateExpectedSize(options.expectedSize);
  const expectedSha256 = validateExpectedSha256(options.expectedSha256);
  validateAbsolutePath(options.directory, 'Parts directory');
  const destination = resolve(validateDestinationPath(options.destination));
  const directory = resolve(options.directory);
  if (!isContainedPath(directory, destination)) {
    throw new Error('Destination must be contained within the parts directory');
  }
  if (!Array.isArray(options.parts) || options.parts.length === 0) {
    throw new Error('At least one archive part is required');
  }

  let declaredSize = 0;
  const occupiedPaths = [destination, `${destination}.part`];
  const parts = options.parts.map((part) => {
    validateHttpsUrl(part.url);
    validateExpectedSize(part.size);
    const partSha256 = validateExpectedSha256(part.sha256);
    const partPath = validatePartPath(part.path);
    const resolvedPartPath = resolve(directory, ...partPath.split('/'));
    if (!isContainedPath(directory, resolvedPartPath)) {
      throw new Error('Part path escapes the parts directory');
    }
    for (const path of [resolvedPartPath, `${resolvedPartPath}.part`]) {
      if (occupiedPaths.some((occupiedPath) => pathsCollide(occupiedPath, path))) {
        throw new Error('Part or destination path collision detected');
      }
      occupiedPaths.push(path);
    }
    declaredSize += part.size;
    if (!Number.isSafeInteger(declaredSize)) {
      throw new Error('Combined part size must be a safe integer');
    }
    return {
      ...part,
      sha256: partSha256,
      path: partPath,
      resolvedPartPath,
    };
  });
  if (declaredSize !== expectedSize) {
    throw new Error('Combined part size does not match the expected archive size');
  }

  const signal = options.signal;
  const fetchImpl = options.fetch ?? globalThis.fetch;
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
