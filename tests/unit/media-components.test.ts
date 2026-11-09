// @vitest-environment node

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import rawManifest from '../../resources/environment/media-components.json';
import {
  downloadFile as realDownloadFile,
  type DownloadFileOptions,
} from '../../src/main/download';
import {
  MediaComponentService,
  parseMediaComponentManifest,
} from '../../src/main/media-components';
import type {
  MediaComponentFile,
  MediaComponentManifest,
  MediaComponentState,
} from '../../src/shared/media-components';

type Fetch = typeof globalThis.fetch;
type DownloadFile = typeof realDownloadFile;
type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;
type EditableManifest = any;

const FIRST_REPOSITORY = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice';
const SECOND_REPOSITORY = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';
const TOKENIZER_REPOSITORY = 'Qwen/Qwen3-TTS-Tokenizer-12Hz';
const UV_REPOSITORY = 'astral-sh/uv';
const UV_VERSION = '0.11.13';
const UV_ASSET_NAME = 'uv-x86_64-pc-windows-msvc.zip';
const [testCertificate, testPrivateKey] = await Promise.all([
  readFile(new URL('../fixtures/localhost-test-cert.pem', import.meta.url), 'utf8'),
  readFile(new URL('../fixtures/localhost-test-key.pem', import.meta.url), 'utf8'),
]);
const testTlsDispatcher = new Agent({ connect: { ca: testCertificate } });

let directory: string;
let dataDirectory: string;
let server: Server;
let localOrigin: string;
let handler: RequestHandler;
let requests: Array<{ path: string; range?: string }>;
let payloads: Record<string, Buffer>;

const firstData = Buffer.from('first verified speech component payload');
const secondData = Buffer.from('second verified speech component payload, resumed');

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function serveBuffer(data: Buffer): RequestHandler {
  return (request, response) => {
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-$/.exec(range);
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]);
      response.writeHead(206, {
        'Content-Length': data.length - start,
        'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}`,
      });
      response.end(data.subarray(start));
      return;
    }
    response.writeHead(200, { 'Content-Length': data.length });
    response.end(data);
  };
}

function makeFile(
  path: string,
  data: Buffer,
  source = FIRST_REPOSITORY,
): MediaComponentFile {
  return {
    url: `${localOrigin}/${path}`,
    path,
    size: data.length,
    sha256: sha256(data),
    source,
  };
}

function revisionsFor(...sources: string[]): Record<string, string> {
  return Object.fromEntries(
    sources.map((source) => [source, sha256(`revision:${source}`).slice(0, 40)]),
  );
}

function makeManifest(): EditableManifest {
  const files = [
    makeFile('CustomVoice/config.json', firstData),
    makeFile('Base/tokenizer.txt', secondData, SECOND_REPOSITORY),
  ];
  return {
    version: 1,
    components: {
      speech: {
        id: 'speech',
        revisions: revisionsFor(FIRST_REPOSITORY, SECOND_REPOSITORY),
        files,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
      },
    },
  };
}

function makeService(
  manifest: unknown = makeManifest(),
  downloadFile?: DownloadFile,
): { service: MediaComponentService; download: ReturnType<typeof vi.fn> } {
  const download = vi.fn<DownloadFile>(async (options: DownloadFileOptions) =>
    (downloadFile ?? realDownloadFile)({
      ...options,
      fetch: transport,
    }),
  );
  const service = new MediaComponentService({
    dataDirectory,
    manifest,
    downloadFile: download,
  });
  return { service, download };
}

function destination(path: string, id = 'speech'): string {
  return join(dataDirectory, 'components', id, 'models', ...path.split('/'));
}

const transport: Fetch = (input, init) => {
  const original = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (original.protocol !== 'https:' || original.hostname !== '127.0.0.1') {
    throw new Error('Test transport received an unexpected URL');
  }
  return undiciFetch(original, {
    ...init,
    dispatcher: testTlsDispatcher,
  } as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<Fetch>;
};

afterAll(async () => {
  await testTlsDispatcher.close();
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'smo-media-components-'));
  dataDirectory = join(directory, 'data');
  requests = [];
  payloads = {
    '/CustomVoice/config.json': firstData,
    '/Base/tokenizer.txt': secondData,
    '/Image/config.json': secondData,
  };
  handler = (request, response) => {
    const payload = payloads[request.url ?? ''];
    if (!payload) {
      response.writeHead(404);
      response.end();
      return;
    }
    serveBuffer(payload)(request, response);
  };
  server = createServer(
    { key: testPrivateKey, cert: testCertificate },
    (request, response) => {
      requests.push({ path: request.url ?? '', range: request.headers.range });
      handler(request, response);
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  localOrigin = `https://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(directory, { recursive: true, force: true });
});

describe('media component manifest', () => {
  test('parses the generated speech manifest without adding image entries', () => {
    const manifest = parseMediaComponentManifest(rawManifest);
    const files = manifest.components.speech?.files ?? [];
    const revisions = manifest.components.speech?.revisions ?? {};

    expect(manifest.version).toBe(1);
    expect(files.length).toBeGreaterThan(0);
    expect(manifest.components.image).toBeUndefined();
    expect(new Set(files.map((file) => file.source))).toEqual(
      new Set([FIRST_REPOSITORY, SECOND_REPOSITORY, TOKENIZER_REPOSITORY, UV_REPOSITORY]),
    );
    expect(Object.keys(revisions).sort()).toEqual(
      [FIRST_REPOSITORY, SECOND_REPOSITORY, TOKENIZER_REPOSITORY, UV_REPOSITORY].sort(),
    );
    for (const revision of Object.values(revisions)) {
      expect(revision).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(
      files.reduce((total, file) => total + file.size, 0),
    ).toBe(manifest.components.speech?.totalBytes);
    for (const file of files) {
      if (file.source === UV_REPOSITORY) {
        expect(file.url).toBe(
          `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET_NAME}`,
        );
      } else {
        expect(file.url).toMatch(/^https:\/\/huggingface\.co\//);
        expect(file.url).toContain(`/resolve/${revisions[file.source]}/`);
      }
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.path).not.toMatch(/README|\.gguf$|\.(?:png|jpe?g|webp|gif)$/i);
    }
  });

  test.each([
    ['plain HTTP', 'http://huggingface.co/model'],
    ['invalid URL', 'not a URL'],
    ['URL credentials', 'https://user:secret@huggingface.co/model'],
  ])('rejects %s', (_label, url) => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].url = url;

    expect(() => parseMediaComponentManifest(manifest)).toThrow(/https|url|credential/i);
  });

  test('rejects duplicate paths, including Windows casing differences', () => {
    for (const path of [
      'CustomVoice/config.json',
      'CUSTOMVOICE/CONFIG.JSON',
    ]) {
      const manifest = makeManifest();
      manifest.components.speech.files[1].path = path;

      expect(() => parseMediaComponentManifest(manifest)).toThrow(/duplicate/i);
    }
  });

  test.each([
    ['a', 'a/b'],
    ['a/b', 'a'],
    ['a', 'a.part'],
    ['a', 'a.part.chunks.json'],
    ['A', 'a.PART'],
  ])('rejects file and temporary-path collisions: %j and %j', (first, second) => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].path = first;
    manifest.components.speech.files[1].path = second;

    expect(() => parseMediaComponentManifest(manifest)).toThrow(/collision/i);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid file size %s', (size) => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].size = size;

    expect(() => parseMediaComponentManifest(manifest)).toThrow(/size|integer/i);
  });

  test('rejects a component byte total above the safe integer range', () => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].size = Number.MAX_SAFE_INTEGER;
    manifest.components.speech.files[1].size = Number.MAX_SAFE_INTEGER;
    manifest.components.speech.totalBytes = Number.MAX_SAFE_INTEGER;

    expect(() => parseMediaComponentManifest(manifest)).toThrow(/total|safe integer/i);
  });

  test.each(['', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65), 'A'.repeat(64)])(
    'rejects invalid SHA256 %s',
    (sha256) => {
      const manifest = makeManifest();
      manifest.components.speech.files[0].sha256 = sha256;

      expect(() => parseMediaComponentManifest(manifest)).toThrow(/sha256/i);
    },
  );

  test.each([
    '/absolute/model.safetensors',
    'C:/absolute/model.safetensors',
    'C:\\absolute\\model.safetensors',
    'C:drive-relative.safetensors',
    '\\\\server\\share\\model.safetensors',
    '../escape.safetensors',
    '..\\escape.safetensors',
    'models/../../escape.safetensors',
    'models/./model.safetensors',
    'models\\model.safetensors',
    'models/model.safetensors:stream',
    'models/file.',
    'models /file.safetensors',
    'CON',
    'models/NUL.txt',
  ])('rejects unsafe relative path %j', (path) => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].path = path;

    expect(() => parseMediaComponentManifest(manifest)).toThrow(/path|traversal/i);
  });

  test('rejects a declared total that differs from the file sizes', () => {
    const manifest = makeManifest();
    manifest.components.speech.totalBytes += 1;

    expect(() => parseMediaComponentManifest(manifest)).toThrow(/total|size/i);
  });
});

describe('MediaComponentService', () => {
  test('falls back from the Hugging Face mirror without changing verified downloads', async () => {
    const manifest = makeManifest();
    const originalUrl =
      'https://huggingface.co/Qwen/Qwen3-TTS/resolve/main/config.json?download=true';
    const mirrorUrl =
      'https://hf-mirror.com/Qwen/Qwen3-TTS/resolve/main/config.json?download=true';
    const nonHuggingFaceUrl = 'https://models.test/image/config.json?original=true';
    const speechFile = manifest.components.speech.files[0] as MediaComponentFile;
    speechFile.url = originalUrl;
    manifest.components.speech.files = [speechFile];
    manifest.components.speech.revisions = revisionsFor(FIRST_REPOSITORY);
    manifest.components.speech.totalBytes = speechFile.size;
    manifest.components.image = {
      id: 'image',
      revisions: revisionsFor(SECOND_REPOSITORY),
      files: [
        {
          ...makeFile('Image/config.json', secondData, SECOND_REPOSITORY),
          url: nonHuggingFaceUrl,
        },
      ],
      totalBytes: secondData.length,
    };
    const observedBytes: number[] = [];
    let service: MediaComponentService;
    const download = vi.fn<DownloadFile>(async (options) => {
      const isSpeech = options.destination === destination(speechFile.path);
      const report = (downloadedBytes: number) => {
        options.onProgress?.({
          downloadedBytes,
          totalBytes: options.expectedSize,
          path: options.destination,
        });
        if (isSpeech) observedBytes.push(service.getState('speech').downloadedBytes);
      };
      if (options.url === mirrorUrl) {
        report(4);
        throw new Error('mirror connect timeout');
      }
      report(1);
      report(options.expectedSize);
      return {
        resumed: false,
        bytes: options.expectedSize,
        sha256: options.expectedSha256,
      };
    });
    ({ service } = makeService(manifest, download));

    await Promise.all([service.install('speech'), service.install('image')]);

    const calls = download.mock.calls.map(([options]) => options);
    const speechCalls = calls.filter(
      (options) => options.destination === destination(speechFile.path),
    );
    const imageCalls = calls.filter(
      (options) => options.destination === destination('Image/config.json', 'image'),
    );
    expect(speechCalls.map((options) => options.url)).toEqual([mirrorUrl, originalUrl]);
    expect(speechCalls).toHaveLength(2);
    for (const options of speechCalls) {
      expect(options).toMatchObject({
        destination: destination(speechFile.path),
        expectedSize: speechFile.size,
        expectedSha256: speechFile.sha256,
      });
    }
    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0]).toMatchObject({
      url: nonHuggingFaceUrl,
      destination: destination('Image/config.json', 'image'),
      expectedSize: secondData.length,
    });
    expect(observedBytes.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < observedBytes.length; index += 1) {
      expect(observedBytes[index]).toBeGreaterThanOrEqual(observedBytes[index - 1]);
    }
    expect(service.getState('speech')).toMatchObject({
      status: 'ready',
      downloadedBytes: speechFile.size,
      active: false,
    });
    expect(service.getState('image')).toMatchObject({
      status: 'ready',
      downloadedBytes: secondData.length,
      active: false,
    });
  });

  test('stops before the official URL when a mirror download is cancelled', async () => {
    const manifest = makeManifest();
    const originalUrl = 'https://huggingface.co/Qwen/Qwen3-TTS/resolve/main/model.bin';
    const speechFile = manifest.components.speech.files[0] as MediaComponentFile;
    speechFile.url = originalUrl;
    manifest.components.speech.files = [speechFile];
    manifest.components.speech.revisions = revisionsFor(FIRST_REPOSITORY);
    manifest.components.speech.totalBytes = speechFile.size;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const download = vi.fn<DownloadFile>(async (options) => {
      notifyStarted?.();
      return new Promise((resolve, reject) => {
        const rejectAbort = () => reject(options.signal?.reason);
        if (options.signal?.aborted) rejectAbort();
        options.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    });
    const { service } = makeService(manifest, download);

    const installing = service.install('speech');
    await started;
    service.cancel('speech');

    await expect(installing).rejects.toThrow(/cancel|abort/i);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0].url).toBe(
      'https://hf-mirror.com/Qwen/Qwen3-TTS/resolve/main/model.bin',
    );
    expect(service.getState('speech')).toMatchObject({
      status: 'missing',
      active: false,
      error: null,
    });
  });

  test('preserves the official source error after the mirror also fails', async () => {
    const manifest = makeManifest();
    const originalUrl = 'https://huggingface.co/Qwen/Qwen3-TTS/resolve/main/model.bin';
    const speechFile = manifest.components.speech.files[0] as MediaComponentFile;
    speechFile.url = originalUrl;
    manifest.components.speech.files = [speechFile];
    manifest.components.speech.revisions = revisionsFor(FIRST_REPOSITORY);
    manifest.components.speech.totalBytes = speechFile.size;
    const mirrorError = new Error('mirror unavailable');
    const officialError = new Error('official source root cause');
    const download = vi.fn<DownloadFile>(async (options) => {
      throw new URL(options.url).hostname === 'hf-mirror.com'
        ? mirrorError
        : officialError;
    });
    const { service } = makeService(manifest, download);

    let rejection: unknown;
    try {
      await service.install('speech');
    } catch (error) {
      rejection = error;
    }

    expect(download.mock.calls.map(([options]) => options.url)).toEqual([
      'https://hf-mirror.com/Qwen/Qwen3-TTS/resolve/main/model.bin',
      originalUrl,
    ]);
    expect(rejection).toBe(officialError);
    expect(service.getState('speech')).toMatchObject({
      status: 'failed',
      error: officialError.message,
      active: false,
    });
  });

  test('installs two files with aggregate progress and verified download arguments', async () => {
    const observed: MediaComponentState[] = [];
    let service: MediaComponentService;
    const download = vi.fn<DownloadFile>(async (options) =>
      realDownloadFile({
        ...options,
        fetch: transport,
        onProgress: (progress) => {
          options.onProgress?.(progress);
          observed.push(structuredClone(service.getState('speech')));
        },
      }),
    );
    service = new MediaComponentService({
      dataDirectory,
      manifest: makeManifest(),
      downloadFile: download,
    });

    expect(service.getState('speech')).toEqual({
      id: 'speech',
      status: 'missing',
      downloadedBytes: 0,
      totalBytes: firstData.length + secondData.length,
      currentFile: null,
      error: null,
      active: false,
    });
    expect(service.getState('image')).toMatchObject({
      id: 'image',
      status: 'missing',
      totalBytes: 0,
      active: false,
    });

    await service.install('speech');

    expect(service.getState('speech')).toMatchObject({
      status: 'ready',
      active: false,
      downloadedBytes: firstData.length + secondData.length,
      currentFile: null,
      error: null,
    });
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(await readFile(destination('CustomVoice/config.json'))).toEqual(firstData);
    expect(await readFile(destination('Base/tokenizer.txt'))).toEqual(secondData);
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed.at(-1)).toMatchObject({
      downloadedBytes: firstData.length + secondData.length,
      totalBytes: firstData.length + secondData.length,
      currentFile: 'Base/tokenizer.txt',
      status: 'installing',
      active: true,
    });
    for (let index = 0; index < observed.length; index += 1) {
      expect(observed[index].totalBytes).toBe(firstData.length + secondData.length);
      expect(observed[index].downloadedBytes).toBeLessThanOrEqual(
        firstData.length + secondData.length,
      );
      if (index > 0) {
        expect(observed[index].downloadedBytes).toBeGreaterThanOrEqual(
          observed[index - 1].downloadedBytes,
        );
      }
    }
  });

  test('resumes a partial file and includes its existing bytes in component progress', async () => {
    const prefix = secondData.subarray(0, 11);
    const partialPath = `${destination('Base/tokenizer.txt')}.part`;
    await mkdir(dirname(partialPath), { recursive: true });
    await writeFile(partialPath, prefix);
    const { service } = makeService();

    await service.install('speech');

    expect(requests).toContainEqual({
      path: '/Base/tokenizer.txt',
      range: `bytes=${prefix.length}-`,
    });
    expect(await readFile(destination('Base/tokenizer.txt'))).toEqual(secondData);
    expect(service.getState('speech')).toMatchObject({
      status: 'ready',
      downloadedBytes: firstData.length + secondData.length,
    });
  });

  test('keeps progress monotonic when a >64MiB parallel download falls back', async () => {
    const data = Buffer.alloc(64 * 1024 * 1024 + 1, 23);
    const path = 'Base/large.safetensors';
    const file = makeFile(path, data, SECOND_REPOSITORY);
    const manifest = {
      version: 1,
      components: {
        speech: {
          id: 'speech',
          revisions: revisionsFor(SECOND_REPOSITORY),
          files: [file],
          totalBytes: data.length,
        },
      },
    };
    const observed: MediaComponentState[] = [];
    let releaseParallelFallback: (() => void) | undefined;
    const parallelProgress = new Promise<void>((resolve) => {
      releaseParallelFallback = resolve;
    });
    let released = false;
    let service: MediaComponentService;
    const download = vi.fn<DownloadFile>(async (options) =>
      realDownloadFile({
        ...options,
        fetch: transport,
        onProgress: (progress) => {
          options.onProgress?.(progress);
          observed.push(structuredClone(service.getState('speech')));
          if (!released && progress.downloadedBytes > 0) {
            released = true;
            releaseParallelFallback?.();
          }
        },
      }),
    );
    service = new MediaComponentService({
      dataDirectory,
      manifest,
      downloadFile: download,
    });
    handler = (request, response) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (range && Number(range[1]) === 0) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        response.writeHead(206, {
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
        });
        response.end(data.subarray(start, end + 1));
        return;
      }
      if (range) {
        void parallelProgress.then(() => {
          response.writeHead(200, { 'Content-Length': '0' });
          response.end();
        });
        return;
      }
      response.writeHead(200, { 'Content-Length': data.length });
      response.end(data);
    };

    await service.install('speech');

    expect(service.getState('speech')).toMatchObject({
      status: 'ready',
      downloadedBytes: data.length,
    });
    expect(released).toBe(true);
    expect(requests.some((request) => /^bytes=0-\d+$/.test(request.range ?? ''))).toBe(
      true,
    );
    const regressions = observed.slice(1).filter(
      (state, index) =>
        state.downloadedBytes < observed[index].downloadedBytes,
    );
    expect(regressions).toEqual([]);
  }, 20_000);

  test('revalidates every installed file before returning ready', async () => {
    for (const [path, data] of [
      ['CustomVoice/config.json', firstData],
      ['Base/tokenizer.txt', secondData],
    ] as const) {
      await mkdir(dirname(destination(path)), { recursive: true });
      await writeFile(destination(path), data);
    }
    const { service, download } = makeService();

    await service.install('speech');

    expect(download).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([]);
    expect(service.getState('speech').status).toBe('ready');

    await writeFile(destination('CustomVoice/config.json'), Buffer.alloc(firstData.length));
    await service.install('speech');

    expect(download).toHaveBeenCalledTimes(4);
    expect(requests).toEqual([
      { path: '/CustomVoice/config.json', range: undefined },
    ]);
    expect(await readFile(destination('CustomVoice/config.json'))).toEqual(firstData);
  });

  test('cancels the active download and permits a later retry', async () => {
    let notifyProgress: (() => void) | undefined;
    const progressed = new Promise<void>((resolve) => {
      notifyProgress = resolve;
    });
    let service: MediaComponentService;
    const download = vi.fn<DownloadFile>(async (options) =>
      realDownloadFile({
        ...options,
        fetch: transport,
        onProgress: (progress) => {
          options.onProgress?.(progress);
          notifyProgress?.();
        },
      }),
    );
    service = new MediaComponentService({
      dataDirectory,
      manifest: makeManifest(),
      downloadFile: download,
    });
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Length': firstData.length });
      response.write(firstData.subarray(0, 8));
    };

    const installing = service.install('speech');
    await progressed;
    service.cancel('speech');

    await expect(installing).rejects.toThrow(/abort|cancel/i);
    expect(service.getState('speech')).toMatchObject({
      status: 'missing',
      active: false,
      currentFile: null,
      error: null,
    });

    handler = (request, response) => {
      const payload = payloads[request.url ?? ''];
      if (!payload) {
        response.writeHead(404);
        response.end();
        return;
      }
      serveBuffer(payload)(request, response);
    };
    const retry = service.install('speech');
    await expect(retry).resolves.toMatchObject({ status: 'ready', active: false });
  });

  test('does not mark a component ready after a SHA256 mismatch', async () => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].sha256 = '0'.repeat(64);
    const { service } = makeService(manifest);

    await expect(service.install('speech')).rejects.toThrow(/sha256|hash/i);

    expect(service.getState('speech')).toMatchObject({
      status: 'failed',
      active: false,
      currentFile: null,
      error: expect.stringMatching(/sha256|hash/i),
    });
    expect(service.getState('speech').status).not.toBe('ready');
    expect(await exists(destination('CustomVoice/config.json'))).toBe(false);
  });

  test('keeps a failed component independent from another component', async () => {
    const manifest = makeManifest();
    manifest.components.speech.files[0].sha256 = '0'.repeat(64);
    manifest.components.image = {
      id: 'image',
      revisions: revisionsFor(FIRST_REPOSITORY),
      files: [makeFile('Image/config.json', secondData)],
      totalBytes: secondData.length,
    };
    const { service } = makeService(manifest);

    const [speech, image] = await Promise.allSettled([
      service.install('speech'),
      service.install('image'),
    ]);

    expect(speech.status).toBe('rejected');
    expect(image.status).toBe('fulfilled');
    expect(service.getState('speech')).toMatchObject({ status: 'failed', active: false });
    expect(service.getState('image')).toMatchObject({ status: 'ready', active: false });
    expect(await readFile(destination('Image/config.json', 'image'))).toEqual(secondData);
  });

  test('rejects a concurrent install of the same component without cancelling its flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const download = vi.fn<DownloadFile>(async (options) => {
      notifyStarted?.();
      await gate;
      return realDownloadFile({ ...options, fetch: transport });
    });
    const { service } = makeService(makeManifest(), download);

    const installing = service.install('speech');
    await started;
    await expect(service.install('speech')).rejects.toThrow(/already|progress/i);
    expect(service.getState('speech')).toMatchObject({
      status: 'installing',
      active: true,
    });

    release?.();
    await expect(installing).resolves.toMatchObject({ status: 'ready', active: false });
  });

  test('retains a retryable failed state after an injected download error', async () => {
    let failures = 1;
    const download = vi.fn<DownloadFile>(async (options) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('injected download failure');
      }
      return realDownloadFile({ ...options, fetch: transport });
    });
    const { service } = makeService(makeManifest(), download);

    await expect(service.install('speech')).rejects.toThrow('injected download failure');
    expect(service.getState('speech')).toMatchObject({
      status: 'failed',
      active: false,
      error: 'injected download failure',
    });

    await expect(service.install('speech')).resolves.toMatchObject({
      status: 'ready',
      active: false,
      error: null,
    });
  });

  test('rejects an unavailable component without creating an install flight', async () => {
    const { service, download } = makeService();

    await expect(service.install('image')).rejects.toThrow(/unavailable|manifest/i);
    expect(download).not.toHaveBeenCalled();
    expect(service.getState('image')).toMatchObject({ status: 'missing', active: false });
  });
});

describe('media component manifest generator', () => {
  const repositories = [FIRST_REPOSITORY, SECOND_REPOSITORY, TOKENIZER_REPOSITORY];
  type Failure = 'type' | 'timeout' | 'body';

  async function generate(fetchImpl: Fetch): Promise<MediaComponentManifest> {
    const generatorUrl = pathToFileURL(
      resolve('scripts/build-media-manifest.mjs'),
    ).href;
    const { buildMediaComponentManifest } = (await import(generatorUrl)) as {
      buildMediaComponentManifest: (options: {
        component: string;
        fetchImpl: Fetch;
      }) => Promise<MediaComponentManifest>;
    };
    return buildMediaComponentManifest({ component: 'speech', fetchImpl });
  }

  function createHarness(
    options: { failure?: Failure; hangingCancel?: boolean; status?: number } = {},
  ) {
    const revisions = Object.fromEntries(
      [...repositories, UV_REPOSITORY].map((repository) => [
        repository,
        sha256(`revision:${repository}`).slice(0, 40),
      ]),
    );
    const originalSmallFiles = new Map(
      repositories.map((repository) => [
        repository,
        Buffer.from(`{"repository":"${repository}"}`),
      ]),
    );
    const changedSmallFiles = new Map(
      repositories.map((repository) => [
        repository,
        Buffer.from(`{"repository":"${repository}","main":"changed"}`),
      ]),
    );
    const license = Buffer.from('Apache License 2.0 test fixture');
    const redirectedFiles = new Map<string, Buffer>();
    const requestedUrls: string[] = [];
    let mainChanged = false;
    let typeFailures = options.failure === 'type' ? 1 : 0;
    let timeoutFailures = options.failure === 'timeout' ? 1 : 0;
    let bodyFailures = options.failure === 'body' ? 1 : 0;

    const entriesFor = (repository: string, changed: boolean): unknown[] => {
      const smallFile = changed
        ? changedSmallFiles.get(repository)!
        : originalSmallFiles.get(repository)!;
      const entries: unknown[] = [
        {
          type: 'file',
          path: 'model.safetensors',
          size: 1024,
          lfs: { oid: sha256(repository) },
        },
        { type: 'file', path: 'generation_config.json', size: smallFile.length },
      ];
      if (repository === FIRST_REPOSITORY) {
        entries.push(
          { type: 'file', path: 'README.md', size: 100 },
          { type: 'file', path: 'image.png', size: 100 },
          {
            type: 'file',
            path: 'duplicate.gguf',
            size: 1024,
            lfs: { oid: 'f'.repeat(64) },
          },
        );
        if (changed) entries.push({ type: 'file', path: 'new-config.json', size: 4 });
      }
      if (repository === TOKENIZER_REPOSITORY) {
        entries.push({ type: 'file', path: 'LICENSE', size: license.length });
      }
      return entries;
    };

    const fetchMock: Fetch = async (input) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      requestedUrls.push(url.href);
      if (
        url.href ===
        `https://api.github.com/repos/astral-sh/uv/releases/tags/${UV_VERSION}`
      ) {
        return Response.json({
          tag_name: UV_VERSION,
          assets: [
            {
              name: UV_ASSET_NAME,
              size: 23_354_520,
              digest: `sha256:${sha256('official uv archive')}`,
              browser_download_url:
                `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET_NAME}`,
            },
          ],
        });
      }
      if (
        url.href ===
        `https://api.github.com/repos/astral-sh/uv/git/ref/tags/${UV_VERSION}`
      ) {
        return Response.json({ object: { sha: revisions[UV_REPOSITORY] } });
      }
      for (const repository of repositories) {
        const revision = revisions[repository];
        if (url.href === `https://huggingface.co/api/models/${repository}`) {
          return Response.json({ sha: revision });
        }
        if (
          url.href ===
            `https://huggingface.co/api/models/${repository}/tree/main?recursive=true` ||
          url.href ===
            `https://huggingface.co/api/models/${repository}/tree/${revision}?recursive=true`
        ) {
          const changed = url.pathname.endsWith('/tree/main') && mainChanged;
          return Response.json(entriesFor(repository, changed));
        }

        for (const candidateRevision of ['main', revision]) {
          const resolvePrefix = `/${repository}/resolve/${candidateRevision}/`;
          if (!url.pathname.startsWith(resolvePrefix)) continue;
          if (options.status) {
            return new Response(null, { status: options.status });
          }
          if (typeFailures > 0) {
            typeFailures -= 1;
            throw new TypeError('injected transient fetch failure');
          }
          if (timeoutFailures > 0) {
            timeoutFailures -= 1;
            throw new DOMException('injected timeout', 'TimeoutError');
          }
          const path = url.pathname
            .slice(resolvePrefix.length)
            .split('/')
            .map(decodeURIComponent)
            .join('/');
          const changed = candidateRevision === 'main' && mainChanged;
          const data =
            path === 'LICENSE'
              ? license
              : path === 'new-config.json'
                ? Buffer.from('new!')
                : (changed ? changedSmallFiles : originalSmallFiles).get(repository);
          if (!data) throw new Error(`Unexpected small file: ${repository}/${path}`);
          const location = `https://cdn.test/${redirectedFiles.size}`;
          redirectedFiles.set(location, data);
          const body = options.hangingCancel
            ? new ReadableStream<Uint8Array>({
                cancel() {
                  return new Promise<void>(() => undefined);
                },
              })
            : null;
          return new Response(body, { status: 307, headers: { location } });
        }
      }

      const redirected = redirectedFiles.get(url.href);
      if (redirected) {
        if (bodyFailures > 0) {
          bodyFailures -= 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error('injected arrayBuffer read failure'));
              },
            }),
            { status: 200 },
          );
        }
        return new Response(redirected, { status: 200 });
      }
      throw new Error(`Unexpected generator request: ${url.href}`);
    };

    return {
      fetchMock,
      requestedUrls,
      revisions,
      originalSmallFiles,
      moveMain: () => {
        mainChanged = true;
      },
    };
  }

  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Generator operation hung')), 300);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  test('pins revisions so later main changes do not alter regeneration', async () => {
    const harness = createHarness({ failure: 'type' });

    const first = await generate(harness.fetchMock);
    harness.moveMain();
    const second = await generate(harness.fetchMock);

    expect(second).toEqual(first);
    expect(first.components.speech?.revisions).toEqual(harness.revisions);
    const files = first.components.speech?.files ?? [];
    expect(files).toHaveLength(8);
    expect(files.find((file) => file.source === UV_REPOSITORY)).toMatchObject({
      path: `runtime/uv-${UV_VERSION}-x86_64-pc-windows-msvc.zip`,
      size: 23_354_520,
      sha256: sha256('official uv archive'),
      url:
        `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET_NAME}`,
    });
    expect(files.some((file) => file.path.endsWith('/LICENSE'))).toBe(true);
    expect(files.some((file) => /README|\.png$|\.gguf$/i.test(file.path))).toBe(false);
    for (const repository of repositories) {
      const revision = harness.revisions[repository];
      expect(
        files.find(
          (file) => file.source === repository && file.path.endsWith('.safetensors'),
        ),
      ).toMatchObject({
        sha256: sha256(repository),
        url: expect.stringContaining(`/resolve/${revision}/`),
      });
      expect(
        files.find(
          (file) =>
            file.source === repository && file.path.endsWith('generation_config.json'),
        )?.sha256,
      ).toBe(sha256(harness.originalSmallFiles.get(repository)!));
    }
    expect(
      harness.requestedUrls.some(
        (url) => url.includes('/tree/main') || url.includes('/resolve/main/'),
      ),
    ).toBe(false);
  });

  test.each(['timeout', 'body'] as const)(
    'retries a transient %s failure including response body reads',
    async (failure) => {
      const harness = createHarness({ failure });

      const manifest = await generate(harness.fetchMock);

      expect(manifest.components.speech?.files).toHaveLength(8);
      expect(
        harness.requestedUrls.filter((url) => url.includes('/resolve/')).length,
      ).toBeGreaterThan(4);
    },
  );

  test('does not wait for a redirect body cancellation that never settles', async () => {
    const harness = createHarness({ hangingCancel: true });

    const manifest = await bounded(generate(harness.fetchMock));

    expect(manifest.components.speech?.files).toHaveLength(8);
  });

  test.each([403, 404])('does not retry non-transient HTTP %s', async (status) => {
    const harness = createHarness({ status });

    await expect(generate(harness.fetchMock)).rejects.toThrow(String(status));

    expect(
      harness.requestedUrls.filter((url) => url.includes('/resolve/')),
    ).toHaveLength(1);
  });
});
