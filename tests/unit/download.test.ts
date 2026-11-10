// @vitest-environment node

import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { access, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls, rootCertificates } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  downloadFile,
  downloadParts,
  modelDownloadUrls,
  runtimeDownloadUrls,
  type DownloadProgress,
} from '../../src/main/download';
import type { EnvironmentArchivePart } from '../../src/shared/environment';

type Fetch = typeof globalThis.fetch;
type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;
const [testCertificate, testPrivateKey] = await Promise.all([
  readFile(new URL('../fixtures/localhost-test-cert.pem', import.meta.url), 'utf8'),
  readFile(new URL('../fixtures/localhost-test-key.pem', import.meta.url), 'utf8'),
]);
const testTlsDispatcher = new Agent({ connect: { ca: testCertificate } });

let directory: string;
let server: Server;
let localOrigin: string;
let handler: RequestHandler;

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

function serveBuffer(
  data: Buffer,
  options: { ignoreRange?: boolean } = {},
): RequestHandler {
  return (_request, response) => {
    const range = _request.headers.range;
    if (range && !options.ignoreRange) {
      const match = /^bytes=(\d+)-$/.exec(range);
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]);
      if (start >= data.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        response.end();
        return;
      }
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

function makePart(path: string, data: Buffer): EnvironmentArchivePart {
  return {
    url: testUrl(`/${path}`),
    path,
    size: data.length,
    sha256: sha256(data),
  };
}

function testUrl(path: string): string {
  return new URL(path, localOrigin).href;
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
  directory = await mkdtemp(join(tmpdir(), 'smo-download-'));
  handler = (_request, response) => {
    response.writeHead(404);
    response.end();
  };
  server = createServer(
    { key: testPrivateKey, cert: testCertificate },
    (request, response) => handler(request, response),
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

describe('downloadFile', () => {
  test('rejects a wrong CA and a mismatched hostname with normal TLS verification', async () => {
    const wrongCaDispatcher = new Agent({ connect: { ca: [...rootCertificates] } });
    try {
      await expect(
        undiciFetch(testUrl('/model.bin'), {
          dispatcher: wrongCaDispatcher,
        } as Parameters<typeof undiciFetch>[1]),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: expect.stringMatching(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i),
        }),
      });
    } finally {
      await wrongCaDispatcher.close();
    }

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server port');
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connectTls({
          host: '127.0.0.1',
          port: address.port,
          servername: 'wrong.example',
          ca: testCertificate,
        });
        socket.once('secureConnect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
      }),
    ).rejects.toThrow(/altname|hostname|certificate/i);
  });

  test('times out when the connection never returns a response', async () => {
    const destination = join(directory, 'unreachable.bin');
    const fetchMock = vi.fn<Fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    });

    await expect(
      downloadFile({
        url: testUrl('/unreachable.bin'),
        destination,
        expectedSize: 20,
        expectedSha256: 'a'.repeat(64),
        stallTimeoutMs: 20,
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/20 ms without progress/i);
  });

  test('times out when the response body stalls before sending data', async () => {
    const destination = join(directory, 'stalled.bin');
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { 'Content-Length': '20' },
      }),
    );

    await expect(
      downloadFile({
        url: testUrl('/stalled.bin'),
        destination,
        expectedSize: 20,
        expectedSha256: 'a'.repeat(64),
        stallTimeoutMs: 20,
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/20 ms without progress/i);
  });

  test('downloads a complete 200 response and verifies the receipt and destination', async () => {
    const payload = Buffer.from('complete verified download');
    const destination = join(directory, 'model.bin');
    handler = serveBuffer(payload);

    const receipt = await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(receipt).toEqual({
      resumed: false,
      bytes: payload.length,
      sha256: sha256(payload),
    });
    expect(await readFile(destination)).toEqual(payload);
    expect((await stat(destination)).size).toBe(payload.length);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test('downloads large files through concurrent bounded range requests', async () => {
    const payload = Buffer.alloc(128 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    const destination = join(directory, 'parallel.bin');
    const ranges: string[] = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    handler = async (request, response) => {
      const range = request.headers.range ?? '';
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]) + 1;
      ranges.push(range);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        response.writeHead(206, {
          'Content-Length': end - start,
          'Content-Range': `bytes ${start}-${end - 1}/${payload.length}`,
        });
        response.end(payload.subarray(start, end));
      } finally {
        activeRequests -= 1;
      }
    };

    const receipt = await downloadFile({
      url: testUrl('/parallel.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
      parallelThresholdBytes: 1,
      chunkSizeBytes: 16 * 1024,
      maxConnections: 4,
    });

    expect(receipt.bytes).toBe(payload.length);
    expect(await readFile(destination)).toEqual(payload);
    expect(ranges).toHaveLength(8);
    expect(maximumActiveRequests).toBeGreaterThan(1);
    expect(ranges).toContain('bytes=0-16383');
    expect(ranges).toContain('bytes=114688-131071');
  });

  test('uses the existing sequential part prefix for parallel chunk downloads', async () => {
    const payload = Buffer.alloc(64 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 241;
    const destination = join(directory, 'legacy-resume.bin');
    const prefix = payload.subarray(0, 5000);
    const ranges: string[] = [];
    await writeFile(`${destination}.part`, prefix);
    handler = (request, response) => {
      const range = request.headers.range ?? '';
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]) + 1;
      ranges.push(range);
      response.writeHead(206, {
        'Content-Length': end - start,
        'Content-Range': `bytes ${start}-${end - 1}/${payload.length}`,
      });
      response.end(payload.subarray(start, end));
    };

    await downloadFile({
      url: testUrl('/legacy-resume.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
      parallelThresholdBytes: 1,
      chunkSizeBytes: 16 * 1024,
      maxConnections: 3,
    });

    expect(ranges).toContain('bytes=5000-21383');
    expect(await readFile(destination)).toEqual(payload);
  });

  test('falls back to a sequential download when a server ignores Range requests', async () => {
    const payload = Buffer.alloc(32 * 1024, 7);
    const destination = join(directory, 'range-fallback.bin');
    const ranges: Array<string | undefined> = [];
    handler = (request, response) => {
      ranges.push(request.headers.range);
      response.writeHead(200, { 'Content-Length': payload.length });
      response.end(payload);
    };

    const receipt = await downloadFile({
      url: testUrl('/range-fallback.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
      parallelThresholdBytes: 1,
      chunkSizeBytes: 8 * 1024,
      maxConnections: 2,
    });

    expect(receipt.resumed).toBe(false);
    expect(ranges.at(-1)).toBeUndefined();
    expect(await readFile(destination)).toEqual(payload);
    expect(await exists(`${destination}.part.chunks.json`)).toBe(false);
  });

  test('does not redownload chunks completed before a parallel connection drops', async () => {
    const payload = Buffer.alloc(64 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 239;
    const destination = join(directory, 'parallel-resume.bin');
    const completedFirstAttempt = new Set<string>();
    const secondAttemptRanges: string[] = [];
    let firstAttempt = true;
    handler = async (request, response) => {
      const range = request.headers.range ?? '';
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match) {
        response.writeHead(400);
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]) + 1;
      if (!firstAttempt) secondAttemptRanges.push(range);
      if (firstAttempt && start === 0) {
        while (completedFirstAttempt.size === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        response.writeHead(206, {
          'Content-Length': end - start,
          'Content-Range': `bytes ${start}-${end - 1}/${payload.length}`,
        });
        response.write(payload.subarray(start, start + 1024));
        request.socket.destroy();
        return;
      }
      response.writeHead(206, {
        'Content-Length': end - start,
        'Content-Range': `bytes ${start}-${end - 1}/${payload.length}`,
      });
      response.end(payload.subarray(start, end));
      if (firstAttempt) completedFirstAttempt.add(range);
    };
    const options = {
      url: testUrl('/parallel-resume.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
      parallelThresholdBytes: 1,
      chunkSizeBytes: 16 * 1024,
      maxConnections: 2,
    } as const;

    await expect(downloadFile(options)).rejects.toThrow();
    firstAttempt = false;
    await downloadFile(options);

    expect(completedFirstAttempt.size).toBeGreaterThan(0);
    for (const range of completedFirstAttempt) {
      expect(secondAttemptRanges).not.toContain(range);
    }
    expect(await readFile(destination)).toEqual(payload);
  });

  test('resumes a non-empty part file only with a matching 206 Content-Range', async () => {
    const payload = Buffer.from('prefix-and-remaining-data');
    const prefix = payload.subarray(0, 7);
    const destination = join(directory, 'model.bin');
    const ranges: Array<string | undefined> = [];
    handler = (request, response) => {
      ranges.push(request.headers.range);
      serveBuffer(payload)(request, response);
    };
    await writeFile(`${destination}.part`, prefix);

    const receipt = await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(ranges).toEqual([`bytes=${prefix.length}-`]);
    expect(receipt.resumed).toBe(true);
    expect(receipt.bytes).toBe(payload.length);
    expect(receipt.sha256).toBe(sha256(payload));
    expect(await readFile(destination)).toEqual(payload);
  });

  test('cancels the resumed response body when initial progress reporting throws', async () => {
    const payload = Buffer.from('prefix-and-remaining-data');
    const prefix = payload.subarray(0, 7);
    const destination = join(directory, 'model.bin');
    const progressError = new Error('progress callback failed');
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload.subarray(prefix.length));
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    const fetchMock = vi.fn<Fetch>().mockResolvedValue(
      new Response(body, {
        status: 206,
        headers: {
          'Content-Length': String(payload.length - prefix.length),
          'Content-Range': `bytes ${prefix.length}-${payload.length - 1}/${payload.length}`,
        },
      }),
    );
    await writeFile(`${destination}.part`, prefix);

    await expect(
      downloadFile({
        url: testUrl('/model.bin'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        fetch: fetchMock,
        onProgress: () => {
          throw progressError;
        },
      }),
    ).rejects.toBe(progressError);

    expect(bodyCancelled).toBe(true);
    expect(await readFile(`${destination}.part`)).toEqual(prefix);
    expect(await exists(destination)).toBe(false);
  });

  test('rejects a 206 response whose Content-Range starts at the wrong offset', async () => {
    const payload = Buffer.from('prefix-and-remaining-data');
    const prefix = payload.subarray(0, 7);
    const destination = join(directory, 'model.bin');
    await writeFile(`${destination}.part`, prefix);
    handler = (_request, response) => {
      response.writeHead(206, {
        'Content-Length': payload.length - prefix.length,
        'Content-Range': `bytes ${prefix.length + 1}-${payload.length - 1}/${payload.length}`,
      });
      response.end(payload.subarray(prefix.length));
    };

    await expect(
      downloadFile({
        url: testUrl('/model.bin'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        fetch: transport,
      }),
    ).rejects.toThrow(/content-range/i);

    expect(await readFile(`${destination}.part`)).toEqual(prefix);
    expect(await exists(destination)).toBe(false);
  });

  test('truncates and restarts when the server ignores Range with a 200 response', async () => {
    const payload = Buffer.from('correct-full-response');
    const destination = join(directory, 'model.bin');
    await writeFile(`${destination}.part`, Buffer.from('stale-prefix'));
    handler = serveBuffer(payload, { ignoreRange: true });

    const receipt = await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(receipt.resumed).toBe(false);
    expect(await readFile(destination)).toEqual(payload);
  });

  test('follows redirects and verifies the downloaded content', async () => {
    const payload = Buffer.from('redirected payload');
    const destination = join(directory, 'redirected.bin');
    handler = (request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/payload' });
        response.end();
        return;
      }
      serveBuffer(payload)(request, response);
    };

    await expect(
      downloadFile({
        url: testUrl('/start'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        fetch: transport,
      }),
    ).resolves.toMatchObject({ bytes: payload.length, sha256: sha256(payload) });
    expect(await readFile(destination)).toEqual(payload);
  });

  test('uses Electron net.request to complete a download across a cancelled redirect', async () => {
    const payload = Buffer.from('GitHub release payload');
    const destination = join(directory, 'electron-redirect.bin');
    const downloadModule = await import('../../src/main/download');
    const createElectronDownloadFetch = (
      downloadModule as unknown as {
        createElectronDownloadFetch?: (net: unknown) => Fetch;
      }
    ).createElectronDownloadFetch;
    expect(createElectronDownloadFetch).toBeTypeOf('function');
    if (!createElectronDownloadFetch) return;

    const requests: Array<{
      options: Record<string, unknown>;
      request: InstanceType<typeof EventEmitter>;
      abort: ReturnType<typeof vi.fn>;
    }> = [];
    const net = {
      request(options: Record<string, unknown>) {
        const request = Object.assign(new EventEmitter(), {
          abort: vi.fn(),
          end: vi.fn(),
        });
        const entry = { options, request, abort: request.abort };
        requests.push(entry);
        const requestIndex = requests.length - 1;
        request.end.mockImplementation(() => {
          queueMicrotask(() => {
            if (requestIndex === 0) {
              const redirectUrl = 'https://objects.githubusercontent.com/runtime.zip';
              request.emit('redirect', 302, 'GET', redirectUrl, {
                location: [redirectUrl],
              });
              request.emit('error', new Error('Redirect was cancelled'));
              return;
            }

            const response = Object.assign(new EventEmitter(), {
              statusCode: 200,
              statusMessage: 'OK',
              headers: { 'content-length': String(payload.length) },
            });
            request.emit('response', response);
            queueMicrotask(() => {
              response.emit('data', payload);
              response.emit('end');
            });
          });
        });
        return request;
      },
    };

    const receipt = await downloadFile({
      url: 'https://github.com/example/runtime/releases/download/v1/runtime.zip',
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: createElectronDownloadFetch(net),
    });

    expect(receipt.bytes).toBe(payload.length);
    expect(await readFile(destination)).toEqual(payload);
    expect(requests).toHaveLength(2);
    expect(requests.map((entry) => entry.options)).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: 'https://github.com/example/runtime/releases/download/v1/runtime.zip',
        redirect: 'manual',
      }),
      expect.objectContaining({
        method: 'GET',
        url: 'https://objects.githubusercontent.com/runtime.zip',
        redirect: 'manual',
      }),
    ]);
  });

  test('does not wait forever when redirect body cancellation never settles', async () => {
    const payload = Buffer.from('redirect without cleanup deadlock');
    const destination = join(directory, 'redirect-cleanup.bin');
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('redirect'));
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const fetchMock = vi.fn<Fetch>()
      .mockResolvedValueOnce(
        new Response(redirectBody, {
          status: 302,
          headers: { Location: testUrl('/payload') },
        }),
      )
      .mockResolvedValueOnce(new Response(payload, { status: 200 }));
    let watchdog: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('Redirect cleanup hung')), 250);
    });

    try {
      const receipt = await Promise.race([
        downloadFile({
          url: testUrl('/start'),
          destination,
          expectedSize: payload.length,
          expectedSha256: sha256(payload),
          fetch: fetchMock,
        }),
        timeout,
      ]);

      expect(receipt.bytes).toBe(payload.length);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await readFile(destination)).toEqual(payload);
    } finally {
      clearTimeout(watchdog);
    }
  });

  test('rejects an HTTPS to HTTP redirect without making the follow-up request', async () => {
    const payload = Buffer.from('must not be reached');
    const destination = join(directory, 'redirected.bin');
    const requests: string[] = [];
    handler = (request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/start') {
        response.writeHead(302, { Location: 'http://127.0.0.1/insecure' });
        response.end('discarded redirect body');
        return;
      }
      serveBuffer(payload)(request, response);
    };

    await expect(
      downloadFile({
        url: testUrl('/start'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        fetch: transport,
      }),
    ).rejects.toThrow(/https/i);

    expect(requests).toEqual(['/start']);
    expect(await exists(destination)).toBe(false);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test('follows multiple validated HTTPS redirects for every redirect status', async () => {
    const payload = Buffer.from('multi-hop payload');
    const destination = join(directory, 'redirected.bin');
    const requests: string[] = [];
    const redirects: Record<string, [number, string]> = {
      '/start': [301, '/second'],
      '/second': [302, '/third'],
      '/third': [303, '/fourth'],
      '/fourth': [307, '/fifth'],
      '/fifth': [308, '/payload'],
    };
    handler = (request, response) => {
      const path = request.url ?? '';
      requests.push(path);
      const redirect = redirects[path];
      if (redirect) {
        response.writeHead(redirect[0], { Location: redirect[1] });
        response.end('discarded redirect body');
        return;
      }
      serveBuffer(payload)(request, response);
    };

    await expect(
      downloadFile({
        url: testUrl('/start'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        fetch: transport,
      }),
    ).resolves.toMatchObject({ bytes: payload.length, sha256: sha256(payload) });

    expect(requests).toEqual([
      '/start',
      '/second',
      '/third',
      '/fourth',
      '/fifth',
      '/payload',
    ]);
    expect(await readFile(destination)).toEqual(payload);
  });

  test('discards the part file and never creates the destination on a hash mismatch', async () => {
    const payload = Buffer.from('untrusted contents');
    const destination = join(directory, 'model.bin');
    handler = serveBuffer(payload);

    await expect(
      downloadFile({
        url: testUrl('/model.bin'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256('different contents'),
        fetch: transport,
      }),
    ).rejects.toThrow(/sha256|hash/i);

    expect(await exists(destination)).toBe(false);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test('keeps the part file and never creates the destination on a size mismatch', async () => {
    const payload = Buffer.from('short response');
    const destination = join(directory, 'model.bin');
    handler = serveBuffer(payload);

    await expect(
      downloadFile({
        url: testUrl('/model.bin'),
        destination,
        expectedSize: payload.length + 1,
        expectedSha256: sha256(payload),
        fetch: transport,
      }),
    ).rejects.toThrow(/size/i);

    expect(await exists(destination)).toBe(false);
    expect(await readFile(`${destination}.part`)).toEqual(payload);
  });

  test('aborts the stream, closes the file, retains progress, and can resume later', async () => {
    const payload = Buffer.alloc(1024 * 1024, 7);
    const destination = join(directory, 'large.bin');
    const partPath = `${destination}.part`;
    const controller = new AbortController();
    let firstRequest = true;
    const ranges: Array<string | undefined> = [];
    handler = (request, response) => {
      ranges.push(request.headers.range);
      if (firstRequest) {
        firstRequest = false;
        response.writeHead(200, { 'Content-Length': payload.length });
        response.write(payload.subarray(0, 64 * 1024));
        request.on('close', () => response.destroy());
        return;
      }
      serveBuffer(payload)(request, response);
    };

    await expect(
      downloadFile({
        url: testUrl('/large.bin'),
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        signal: controller.signal,
        fetch: transport,
        onProgress: ({ downloadedBytes }) => {
          if (downloadedBytes > 0) controller.abort();
        },
      }),
    ).rejects.toThrow(/abort|cancel/i);

    const partialSize = (await stat(partPath)).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(payload.length);
    expect(await exists(destination)).toBe(false);

    const probePath = `${partPath}.probe`;
    await rename(partPath, probePath);
    await rename(probePath, partPath);

    const receipt = await downloadFile({
      url: testUrl('/large.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(ranges[1]).toBe(`bytes=${partialSize}-`);
    expect(receipt.resumed).toBe(true);
    expect(await readFile(destination)).toEqual(payload);
  });

  test('skips the network for an existing destination with the expected size and hash', async () => {
    const payload = Buffer.from('already installed');
    const destination = join(directory, 'model.bin');
    const fetchMock = vi.fn<Fetch>();
    await writeFile(destination, payload);

    const receipt = await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      resumed: false,
      bytes: payload.length,
      sha256: sha256(payload),
    });
  });

  test('atomically completes an already complete part file without a request', async () => {
    const payload = Buffer.from('complete part waiting for rename');
    const destination = join(directory, 'model.bin');
    const fetchMock = vi.fn<Fetch>();
    await writeFile(`${destination}.part`, payload);

    const receipt = await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(receipt.bytes).toBe(payload.length);
    expect(await readFile(destination)).toEqual(payload);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test('redownloads an existing destination whose contents do not match', async () => {
    const payload = Buffer.from('trusted');
    const destination = join(directory, 'model.bin');
    await writeFile(destination, Buffer.from('corrupt'));
    handler = serveBuffer(payload);

    await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(await readFile(destination)).toEqual(payload);
  });

  test.each([
    { label: 'a complete but invalid part', initial: (data: Buffer) => Buffer.alloc(data.length, 1) },
    { label: 'an oversized part', initial: (data: Buffer) => Buffer.concat([data, Buffer.from('extra')]) },
    { label: 'an empty part', initial: () => Buffer.alloc(0) },
  ])('starts fresh for $label', async ({ initial }) => {
    const payload = Buffer.from('fresh trusted payload');
    const destination = join(directory, 'model.bin');
    const ranges: Array<string | undefined> = [];
    await writeFile(`${destination}.part`, initial(payload));
    handler = (request, response) => {
      ranges.push(request.headers.range);
      serveBuffer(payload)(request, response);
    };

    await downloadFile({
      url: testUrl('/model.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(ranges).toEqual([undefined]);
    expect(await readFile(destination)).toEqual(payload);
  });

  test('reports actual monotonic progress including an existing resume offset', async () => {
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const prefix = payload.subarray(0, 10);
    const destination = join(directory, 'progress.bin');
    const events: DownloadProgress[] = [];
    await writeFile(`${destination}.part`, prefix);
    handler = (request, response) => {
      const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
      response.writeHead(start > 0 ? 206 : 200, {
        ...(start > 0
          ? { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` }
          : {}),
      });
      response.write(payload.subarray(start, start + 3));
      setImmediate(() => response.end(payload.subarray(start + 3)));
    };

    await downloadFile({
      url: testUrl('/progress.bin'),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
      onProgress: (event) => events.push(event),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].downloadedBytes).toBeGreaterThanOrEqual(prefix.length);
    expect(events.at(-1)).toEqual({
      downloadedBytes: payload.length,
      totalBytes: payload.length,
      path: destination,
    });
    for (let index = 0; index < events.length; index += 1) {
      expect(events[index].totalBytes).toBe(payload.length);
      expect(events[index].path).toBe(destination);
      expect(events[index].downloadedBytes).toBeGreaterThanOrEqual(0);
      expect(events[index].downloadedBytes).toBeLessThanOrEqual(payload.length);
      if (index > 0) {
        expect(events[index].downloadedBytes).toBeGreaterThanOrEqual(
          events[index - 1].downloadedBytes,
        );
      }
    }
  });

  test('rejects an abnormal HTTP status without replacing the partial data', async () => {
    const destination = join(directory, 'model.bin');
    const prefix = Buffer.from('partial');
    await writeFile(`${destination}.part`, prefix);
    handler = (_request, response) => {
      response.writeHead(503);
      response.end('unavailable');
    };

    await expect(
      downloadFile({
        url: testUrl('/model.bin'),
        destination,
        expectedSize: 20,
        expectedSha256: 'a'.repeat(64),
        fetch: transport,
      }),
    ).rejects.toThrow(/503|http/i);

    expect(await readFile(`${destination}.part`)).toEqual(prefix);
    expect(await exists(destination)).toBe(false);
  });
});

describe('modelDownloadUrls', () => {
  test('maps Hugging Face downloads to the mirror while preserving official fallback', () => {
    const model = {
      url: 'https://huggingface.co/repo/resolve/main/model.safetensors?download=true',
      path: 'models/model.safetensors',
      size: 1,
      sha256: '0'.repeat(64),
      source: 'test',
    };

    expect(modelDownloadUrls(model)).toEqual([
      'https://hf-mirror.com/repo/resolve/main/model.safetensors?download=true',
      'https://huggingface.co/repo/resolve/main/model.safetensors?download=true',
    ]);
    expect(modelDownloadUrls({
      ...model,
      url: 'https://models.test/model.safetensors',
    })).toEqual(['https://models.test/model.safetensors']);
  });
});

describe('runtimeDownloadUrls', () => {
  test('preserves the official GitHub URL before the runtime mirror fallback', () => {
    const officialUrl =
      'https://github.com/astral-sh/uv/releases/download/0.11.13/uv-x86_64-pc-windows-msvc.zip';

    expect(runtimeDownloadUrls(officialUrl)).toEqual([
      officialUrl,
      `https://ghproxy.net/${officialUrl}`,
    ]);
  });

  test.each([
    'https://huggingface.co/repo/resolve/main/model.safetensors?download=true',
    'https://downloads.test/runtime.zip?original=true',
  ])('leaves non-GitHub downloads unchanged: %s', (url) => {
    expect(runtimeDownloadUrls(url)).toEqual([url]);
  });
});

describe('download input validation', () => {
  test.each([
    { label: 'plain HTTP', url: 'http://download.test/model.bin', error: /https/i },
    {
      label: 'URL credentials',
      url: 'https://user:secret@download.test/model.bin',
      error: /credential|url/i,
    },
  ])('rejects $label before any request or write', async ({ url, error }) => {
    const destination = join(directory, 'model.bin');
    const fetchMock = vi.fn<Fetch>();

    await expect(
      downloadFile({
        url,
        destination,
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
        fetch: fetchMock,
      }),
    ).rejects.toThrow(error);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await exists(destination)).toBe(false);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expected size %s before any request',
    async (expectedSize) => {
      const fetchMock = vi.fn<Fetch>();
      await expect(
        downloadFile({
          url: testUrl('/model.bin'),
          destination: join(directory, 'model.bin'),
          expectedSize,
          expectedSha256: 'a'.repeat(64),
          fetch: fetchMock,
        }),
      ).rejects.toThrow(/size/i);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each(['', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65)])(
    'rejects invalid expected SHA256 %s before any request',
    async (expectedSha256) => {
      const fetchMock = vi.fn<Fetch>();
      await expect(
        downloadFile({
          url: testUrl('/model.bin'),
          destination: join(directory, 'model.bin'),
          expectedSize: 1,
          expectedSha256,
          fetch: fetchMock,
        }),
      ).rejects.toThrow(/sha256/i);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each([
    { label: 'relative path', make: () => 'model.bin' },
    { label: 'drive-relative path', make: () => 'C:model.bin' },
    { label: 'root-relative path', make: () => '\\model.bin' },
    { label: 'parent traversal', make: (root: string) => `${root}\\..\\escape.bin` },
    { label: 'forward-slash traversal', make: (root: string) => `${root}/../escape.bin` },
    { label: 'NUL', make: (root: string) => join(root, 'bad\0name.bin') },
    { label: 'ADS', make: (root: string) => join(root, 'model.bin:stream') },
    { label: 'device name', make: (root: string) => join(root, 'CON') },
    { label: 'trailing dot', make: (root: string) => join(root, 'model.bin.') },
    { label: 'illegal character', make: (root: string) => join(root, 'model?.bin') },
    { label: 'extended namespace', make: () => '\\\\?\\C:\\model.bin' },
  ])('rejects an unsafe destination: $label', async ({ make }) => {
    const destination = make(directory);
    const fetchMock = vi.fn<Fetch>();

    await expect(
      downloadFile({
        url: testUrl('/model.bin'),
        destination,
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/path|destination/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    '',
    '/absolute.bin',
    'C:/absolute.bin',
    'C:relative.bin',
    '../escape.bin',
    '..\\escape.bin',
    'nested/../../escape.bin',
    'nested\\part.bin',
    'part.bin:stream',
    'nested/part?.bin',
    'nested/part.bin.',
    'nested /part.bin',
    'CON',
    'nested/NUL.bin',
    'bad\0name.bin',
  ])('rejects unsafe part path %j before any request or write', async (path) => {
    const data = Buffer.from('x');
    const destination = join(directory, 'archive.bin');
    const fetchMock = vi.fn<Fetch>();

    await expect(
      downloadParts({
        parts: [{ ...makePart('part.bin', data), path }],
        directory,
        destination,
        expectedSize: data.length,
        expectedSha256: sha256(data),
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/path/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await exists(destination)).toBe(false);
  });

  test.each([
    { label: 'parent traversal', make: (root: string) => `${root}\\..\\outside.bin` },
    { label: 'normalized escape', make: (root: string) => join(root, '..', 'outside.bin') },
    { label: 'prefix sibling', make: (root: string) => `${root}-sibling\\archive.bin` },
    { label: 'directory itself', make: (root: string) => root },
  ])('rejects a destination outside the parts directory: $label', async ({ make }) => {
    const data = Buffer.from('x');
    const destination = make(directory);
    const fetchMock = vi.fn<Fetch>();

    await expect(
      downloadParts({
        parts: [makePart('part.bin', data)],
        directory,
        destination,
        expectedSize: data.length,
        expectedSha256: sha256(data),
        fetch: fetchMock,
      }),
    ).rejects.toThrow(/destination|contained|directory/i);

    expect(fetchMock).not.toHaveBeenCalled();
    if (destination !== directory) expect(await exists(destination)).toBe(false);
  });
});

describe('downloadParts', () => {
  const metadataTemporarySuffixes = [
    '.part.chunks.json',
    '.part.chunks.json.tmp',
    '.part.source',
  ] as const;

  test.each([
    ...metadataTemporarySuffixes.map((suffix) => ({
      label: `a part final path collides with the merged archive ${suffix}`,
      paths: [`archive.bin${suffix}`],
      destinationName: 'archive.bin',
    })),
    ...metadataTemporarySuffixes.map((suffix) => ({
      label: `a part final path collides with an earlier part ${suffix}`,
      paths: [`a${suffix}`, 'a'],
      destinationName: 'archive.bin',
    })),
    ...metadataTemporarySuffixes.map((suffix) => ({
      label: `a part final path collides with a later part ${suffix}`,
      paths: ['a', `a${suffix}`],
      destinationName: 'archive.bin',
    })),
    {
      label: 'a part final path collides with an earlier part temporary path',
      paths: ['a.part', 'a'],
      destinationName: 'archive.bin',
    },
    {
      label: 'a part final path collides with a later part temporary path',
      paths: ['a', 'a.part'],
      destinationName: 'archive.bin',
    },
    {
      label: 'part temporary path comparison is case-insensitive',
      paths: ['A.PART', 'a'],
      destinationName: 'archive.bin',
    },
    {
      label: 'a part temporary path collides with the destination',
      paths: ['archive'],
      destinationName: 'archive.part',
    },
    {
      label: 'an earlier part final path is an ancestor of a later part',
      paths: ['a', 'a/b'],
      destinationName: 'archive.bin',
    },
    {
      label: 'a later part final path is an ancestor of an earlier part',
      paths: ['a/b', 'a'],
      destinationName: 'archive.bin',
    },
    {
      label: 'an earlier part temporary path is an ancestor of a later part',
      paths: ['a', 'a.part/b'],
      destinationName: 'archive.bin',
    },
    {
      label: 'a later part temporary path is an ancestor of an earlier part',
      paths: ['a.part/b', 'a'],
      destinationName: 'archive.bin',
    },
    {
      label: 'the destination is an ancestor of a part',
      paths: ['a/b'],
      destinationName: 'a',
    },
    {
      label: 'a part is an ancestor of the destination',
      paths: ['a'],
      destinationName: 'a/b',
    },
    {
      label: 'the destination temporary path is an ancestor of a part',
      paths: ['a.part/b'],
      destinationName: 'a',
    },
    {
      label: 'a part is an ancestor of the destination temporary path',
      paths: ['a'],
      destinationName: 'a.part/b',
    },
    {
      label: 'ancestor path comparison is case-insensitive',
      paths: ['A', 'a/b'],
      destinationName: 'archive.bin',
    },
  ])('rejects $label before any request', async ({ paths, destinationName }) => {
    const data = Buffer.from('aaaaa');
    const parts = paths.map((path) => makePart(path, data));
    const archive = Buffer.concat(parts.map(() => data));
    const destination = join(directory, destinationName);
    const requests: string[] = [];
    handler = (request, response) => {
      requests.push(request.url ?? '');
      serveBuffer(data)(request, response);
    };

    await expect(
      downloadParts({
        parts,
        directory,
        destination,
        expectedSize: archive.length,
        expectedSha256: sha256(archive),
        fetch: transport,
      }),
    ).rejects.toThrow(/collision|collide/i);

    expect(requests).toEqual([]);
    expect(await exists(destination)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  test('allows part paths whose names only share a string prefix', async () => {
    const first = Buffer.from('first');
    const second = Buffer.from('second');
    const archive = Buffer.concat([first, second]);
    const destination = join(directory, 'archive.bin');
    handler = (request, response) => {
      serveBuffer(request.url === '/a' ? first : second)(request, response);
    };

    await downloadParts({
      parts: [makePart('a', first), makePart('ab', second)],
      directory,
      destination,
      expectedSize: archive.length,
      expectedSha256: sha256(archive),
      fetch: transport,
    });

    expect(await readFile(destination)).toEqual(archive);
  });

  test('downloads and merges verified parts in array order with aggregate progress', async () => {
    const first = Buffer.from('first-part-');
    const second = Buffer.from('second-part-');
    const third = Buffer.from('third-part');
    const archive = Buffer.concat([first, second, third]);
    const dataByUrl: Record<string, Buffer> = {
      '/part1.bin': first,
      '/part2.bin': second,
      '/part3.bin': third,
    };
    const requests: string[] = [];
    const events: DownloadProgress[] = [];
    const destination = join(directory, 'archive.bin');
    handler = (request, response) => {
      requests.push(request.url ?? '');
      serveBuffer(dataByUrl[request.url ?? ''])(request, response);
    };

    const receipt = await downloadParts({
      parts: [
        makePart('part1.bin', first),
        makePart('part2.bin', second),
        makePart('part3.bin', third),
      ],
      directory,
      destination,
      expectedSize: archive.length,
      expectedSha256: sha256(archive),
      fetch: transport,
      onProgress: (event) => events.push(event),
    });

    expect(requests).toEqual(['/part1.bin', '/part2.bin', '/part3.bin']);
    expect(receipt).toEqual({
      resumed: false,
      bytes: archive.length,
      sha256: sha256(archive),
    });
    expect(await readFile(destination)).toEqual(archive);
    expect(events.at(-1)?.downloadedBytes).toBe(archive.length);
    for (let index = 0; index < events.length; index += 1) {
      expect(events[index].totalBytes).toBe(archive.length);
      expect(events[index].downloadedBytes).toBeLessThanOrEqual(archive.length);
      if (index > 0) {
        expect(events[index].downloadedBytes).toBeGreaterThanOrEqual(
          events[index - 1].downloadedBytes,
        );
      }
    }
  });

  test('does not create the final archive when array order produces the wrong whole hash', async () => {
    const first = Buffer.from('first-part');
    const second = Buffer.from('second-part-longer');
    const archive = Buffer.concat([first, second]);
    const destination = join(directory, 'archive.bin');
    handler = (request, response) => {
      const data = request.url === '/part1.bin' ? first : second;
      serveBuffer(data)(request, response);
    };

    await expect(
      downloadParts({
        parts: [makePart('part2.bin', second), makePart('part1.bin', first)],
        directory,
        destination,
        expectedSize: archive.length,
        expectedSha256: sha256(archive),
        fetch: transport,
      }),
    ).rejects.toThrow(/sha256|hash/i);

    expect(await exists(destination)).toBe(false);
    expect(await readFile(`${destination}.part`)).toEqual(Buffer.concat([second, first]));
  });

  test('does not merge or create a final archive when a part hash is invalid', async () => {
    const first = Buffer.from('first-part');
    const second = Buffer.from('second-part');
    const destination = join(directory, 'archive.bin');
    handler = (request, response) => {
      serveBuffer(request.url === '/part1.bin' ? first : second)(request, response);
    };

    await expect(
      downloadParts({
        parts: [
          makePart('part1.bin', first),
          { ...makePart('part2.bin', second), sha256: '0'.repeat(64) },
        ],
        directory,
        destination,
        expectedSize: first.length + second.length,
        expectedSha256: sha256(Buffer.concat([first, second])),
        fetch: transport,
      }),
    ).rejects.toThrow(/sha256|hash/i);

    expect(await exists(destination)).toBe(false);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test('skips all requests when the merged destination is already valid', async () => {
    const first = Buffer.from('first-part');
    const second = Buffer.from('second-part');
    const archive = Buffer.concat([first, second]);
    const destination = join(directory, 'archive.bin');
    const fetchMock = vi.fn<Fetch>();
    await writeFile(destination, archive);

    const receipt = await downloadParts({
      parts: [makePart('part1.bin', first), makePart('part2.bin', second)],
      directory,
      destination,
      expectedSize: archive.length,
      expectedSha256: sha256(archive),
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(receipt.bytes).toBe(archive.length);
  });

  test('completes a verified merged part without downloading individual parts', async () => {
    const first = Buffer.from('first-part');
    const second = Buffer.from('second-part');
    const archive = Buffer.concat([first, second]);
    const destination = join(directory, 'archive.bin');
    const fetchMock = vi.fn<Fetch>();
    await writeFile(`${destination}.part`, archive);

    await downloadParts({
      parts: [makePart('part1.bin', first), makePart('part2.bin', second)],
      directory,
      destination,
      expectedSize: archive.length,
      expectedSha256: sha256(archive),
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(destination)).toEqual(archive);
    expect(await exists(`${destination}.part`)).toBe(false);
  });

  test('allows destination casing differences while retaining Windows containment', async () => {
    const payload = Buffer.from('archive');
    const destination = join(directory.toLowerCase(), 'nested', 'archive.bin');
    handler = serveBuffer(payload);

    await downloadParts({
      parts: [makePart('part.bin', payload)],
      directory: directory.toUpperCase(),
      destination,
      expectedSize: payload.length,
      expectedSha256: sha256(payload),
      fetch: transport,
    });

    expect(await readFile(destination)).toEqual(payload);
  });

  test('retains a closed merged part when aborted at merge start and retries without part requests', async () => {
    const first = Buffer.from('first-part');
    const second = Buffer.from('second-part');
    const archive = Buffer.concat([first, second]);
    const destination = join(directory, 'archive.bin');
    const mergedPartPath = `${destination}.part`;
    const controller = new AbortController();
    const requests: string[] = [];
    handler = (request, response) => {
      requests.push(request.url ?? '');
      serveBuffer(request.url === '/part1.bin' ? first : second)(request, response);
    };
    const options = {
      parts: [makePart('part1.bin', first), makePart('part2.bin', second)],
      directory,
      destination,
      expectedSize: archive.length,
      expectedSha256: sha256(archive),
      fetch: transport,
    };

    await expect(
      downloadParts({
        ...options,
        signal: controller.signal,
        onProgress: ({ path }) => {
          if (path === destination) controller.abort();
        },
      }),
    ).rejects.toThrow(/abort|cancel/i);

    expect(requests).toEqual(['/part1.bin', '/part2.bin']);
    expect(await exists(destination)).toBe(false);
    expect(await exists(mergedPartPath)).toBe(true);
    const probePath = `${mergedPartPath}.probe`;
    await rename(mergedPartPath, probePath);
    await rename(probePath, mergedPartPath);

    const receipt = await downloadParts(options);

    expect(requests).toEqual(['/part1.bin', '/part2.bin']);
    expect(receipt.bytes).toBe(archive.length);
    expect(await readFile(destination)).toEqual(archive);
    expect(await exists(mergedPartPath)).toBe(false);
  });
});
