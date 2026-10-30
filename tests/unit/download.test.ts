// @vitest-environment node

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  downloadFile,
  downloadParts,
  type DownloadProgress,
} from '../../src/main/download';
import type { EnvironmentArchivePart } from '../../src/shared/environment';

type Fetch = typeof globalThis.fetch;
type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

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
    url: `https://download.test/${path}`,
    path,
    size: data.length,
    sha256: sha256(data),
  };
}

const transport: Fetch = (input, init) => {
  const original = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (original.protocol !== 'https:' || original.hostname !== 'download.test') {
    throw new Error('Test transport received an unexpected URL');
  }
  const mapped = new URL(`${original.pathname}${original.search}`, localOrigin);
  return globalThis.fetch(mapped, init);
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'smo-download-'));
  handler = (_request, response) => {
    response.writeHead(404);
    response.end();
  };
  server = createServer((request, response) => handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  localOrigin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(directory, { recursive: true, force: true });
});

describe('downloadFile', () => {
  test('downloads a complete 200 response and verifies the receipt and destination', async () => {
    const payload = Buffer.from('complete verified download');
    const destination = join(directory, 'model.bin');
    handler = serveBuffer(payload);

    const receipt = await downloadFile({
      url: 'https://download.test/model.bin',
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
      url: 'https://download.test/model.bin',
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
        url: 'https://download.test/model.bin',
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
      url: 'https://download.test/model.bin',
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
        url: 'https://download.test/start',
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256(payload),
        fetch: transport,
      }),
    ).resolves.toMatchObject({ bytes: payload.length, sha256: sha256(payload) });
    expect(await readFile(destination)).toEqual(payload);
  });

  test('keeps the part file and never creates the destination on a hash mismatch', async () => {
    const payload = Buffer.from('untrusted contents');
    const destination = join(directory, 'model.bin');
    handler = serveBuffer(payload);

    await expect(
      downloadFile({
        url: 'https://download.test/model.bin',
        destination,
        expectedSize: payload.length,
        expectedSha256: sha256('different contents'),
        fetch: transport,
      }),
    ).rejects.toThrow(/sha256|hash/i);

    expect(await exists(destination)).toBe(false);
    expect(await readFile(`${destination}.part`)).toEqual(payload);
  });

  test('keeps the part file and never creates the destination on a size mismatch', async () => {
    const payload = Buffer.from('short response');
    const destination = join(directory, 'model.bin');
    handler = serveBuffer(payload);

    await expect(
      downloadFile({
        url: 'https://download.test/model.bin',
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
        url: 'https://download.test/large.bin',
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
      url: 'https://download.test/large.bin',
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
      url: 'https://download.test/model.bin',
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
      url: 'https://download.test/model.bin',
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
      url: 'https://download.test/model.bin',
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
      url: 'https://download.test/model.bin',
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
      url: 'https://download.test/progress.bin',
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
        url: 'https://download.test/model.bin',
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
          url: 'https://download.test/model.bin',
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
          url: 'https://download.test/model.bin',
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
        url: 'https://download.test/model.bin',
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
});
