// @vitest-environment node

import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ComfyClient, type ComfyExecutionUpdate } from '../../src/main/comfy';
import { JobCoordinator } from '../../src/main/jobs';

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

interface LocalComfy {
  baseUrl: string;
  requests: RecordedRequest[];
  webSockets: WebSocketServer;
  close: () => Promise<void>;
}

const servers: LocalComfy[] = [];
const temporaryDirectories: string[] = [];

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function startComfy(handler?: RequestHandler): Promise<LocalComfy> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });

      const handle =
        handler ??
        ((req, res) => {
          if (req.url?.startsWith('/history/')) {
            json(res, {});
          } else {
            json(res, { error: 'not found' }, 404);
          }
        });
      Promise.resolve(handle(request, response, body)).catch(() => response.destroy());
    });
  });
  const webSockets = new WebSocketServer({ server });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address() as AddressInfo;
  let closed = false;
  const local: LocalComfy = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    webSockets,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;

      for (const socket of webSockets.clients) {
        socket.terminate();
      }
      const webSocketsClosed = new Promise<void>((resolve) => {
        webSockets.close(() => resolve());
      });
      const serverClosed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await Promise.all([webSocketsClosed, serverClosed]);
    },
  };
  servers.push(local);
  return local;
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'smo-h3-comfy-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeTemporaryFile(name: string, contents: string | Uint8Array): string {
  const filePath = join(makeTemporaryDirectory(), name);
  writeFileSync(filePath, contents);
  return filePath;
}

async function expectRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<Error> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error('Expected the operation to reject with an Error');
  }
  expect(error.message).toMatch(pattern);
  return error;
}

function send(socket: WebSocket, type: string, data: unknown): void {
  socket.send(JSON.stringify({ type, data }));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ComfyClient base URL and REST requests', () => {
  test.each([
    'file:///tmp/comfy',
    'ftp://example.com',
    'https://user:secret@example.com',
    'not a URL',
  ])('rejects an unsupported base URL: %s', (baseUrl) => {
    expect(() => new ComfyClient(baseUrl)).toThrow(/base URL/i);
  });

  test.each(['', '   ', '\t'])('rejects an empty injected client id: %j', (clientId) => {
    expect(() => new ComfyClient('http://127.0.0.1:8188', { clientId })).toThrow(
      /clientId.*non-empty/i,
    );
  });

  test.each([
    { requestTimeoutMs: Number.NaN },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: -1 },
    { requestTimeoutMs: Number.POSITIVE_INFINITY },
    { completionTimeoutMs: Number.NaN },
    { completionTimeoutMs: 0 },
    { completionTimeoutMs: -1 },
    { completionTimeoutMs: Number.POSITIVE_INFINITY },
    { inactivityTimeoutMs: Number.NaN },
    { inactivityTimeoutMs: 0 },
    { inactivityTimeoutMs: -1 },
    { inactivityTimeoutMs: Number.POSITIVE_INFINITY },
    { reconcileIntervalMs: Number.NaN },
    { reconcileIntervalMs: 0 },
    { reconcileIntervalMs: -1 },
    { reconcileIntervalMs: Number.POSITIVE_INFINITY },
  ])('rejects a non-finite or non-positive timeout: %j', (options) => {
    expect(() => new ComfyClient('http://127.0.0.1:8188', options)).toThrow(
      /must be a finite positive number/i,
    );
  });

  test('checks health through GET /system_stats and validates the response', async () => {
    const stats = {
      system: { os: 'nt', comfyui_version: 'test' },
      devices: [{ name: 'cpu', type: 'cpu' }],
    };
    const upstream = await startComfy((_request, response) => json(response, stats));

    await expect(new ComfyClient(upstream.baseUrl).health()).resolves.toEqual(stats);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', url: '/system_stats' });
  });

  test.each([
    null,
    [],
    {},
    { system: {}, devices: 'not-an-array' },
    { system: {}, devices: [null] },
  ])('rejects invalid health data: %j', async (payload) => {
    const upstream = await startComfy((_request, response) => json(response, payload));

    await expectRejection(new ComfyClient(upstream.baseUrl).health(), /invalid system stats/i);
  });

  test('reads object info through GET /object_info', async () => {
    const objectInfo = {
      LoadImage: { input: { required: { image: [] } } },
      LoadAudio: { input: { required: { audio: [] } } },
    };
    const upstream = await startComfy((_request, response) => json(response, objectInfo));

    await expect(new ComfyClient(upstream.baseUrl).objectInfo()).resolves.toEqual(objectInfo);
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', url: '/object_info' });
  });

  test.each([
    null,
    [],
    { LoadImage: null },
    { LoadImage: [] },
  ])('rejects invalid object info: %j', async (payload) => {
    const upstream = await startComfy((_request, response) => json(response, payload));

    await expectRejection(
      new ComfyClient(upstream.baseUrl).objectInfo(),
      /invalid object info/i,
    );
  });

  test('submits the prompt and injected client id and returns validated identifiers', async () => {
    const prompt = {
      '1': { class_type: 'LoadImage', inputs: { image: 'tiny.png' } },
    };
    const upstream = await startComfy((_request, response) =>
      json(response, { prompt_id: 'prompt-1', number: 7, node_errors: {} }),
    );

    const result = await new ComfyClient(upstream.baseUrl, { clientId: 'client-1' }).submit(
      prompt,
    );

    expect(result).toEqual({ prompt_id: 'prompt-1', number: 7, node_errors: {} });
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', url: '/prompt' });
    expect(upstream.requests[0].headers['content-type']).toContain('application/json');
    expect(JSON.parse(upstream.requests[0].body.toString('utf8'))).toEqual({
      prompt,
      client_id: 'client-1',
    });
  });

  test.each([
    null,
    { prompt_id: '', number: 1, node_errors: {} },
    { prompt_id: 'prompt-1', number: '1', node_errors: {} },
    { prompt_id: 'prompt-1', number: 1, node_errors: [] },
  ])('rejects an invalid submit response: %j', async (payload) => {
    const upstream = await startComfy((_request, response) => json(response, payload));

    await expectRejection(
      new ComfyClient(upstream.baseUrl).submit({}),
      /invalid prompt response/i,
    );
  });

  test('collects output file metadata from history', async () => {
    const promptId = 'prompt/a ?';
    const upstream = await startComfy((_request, response) =>
      json(response, {
        [promptId]: {
          outputs: {
            '3': {
              images: [{ filename: 'frame.png', subfolder: 'smo', type: 'output' }],
            },
            '4': {
              audio: [{ filename: 'voice.wav', subfolder: '', type: 'temp' }],
            },
            '5': {
              video: [{ filename: 'movie.mp4', subfolder: 'smo', type: 'output' }],
            },
            '6': { text: ['not a file'] },
          },
        },
      }),
    );

    await expect(new ComfyClient(upstream.baseUrl).history(promptId)).resolves.toEqual([
      { nodeId: '3', kind: 'images', filename: 'frame.png', subfolder: 'smo', type: 'output' },
      { nodeId: '4', kind: 'audio', filename: 'voice.wav', subfolder: '', type: 'temp' },
      { nodeId: '5', kind: 'video', filename: 'movie.mp4', subfolder: 'smo', type: 'output' },
    ]);
    expect(upstream.requests[0]).toMatchObject({
      method: 'GET',
      url: '/history/prompt%2Fa%20%3F',
    });
  });

  test('rejects malformed output metadata in history', async () => {
    const upstream = await startComfy((_request, response) =>
      json(response, {
        'prompt-1': {
          outputs: {
            '3': { images: [{ filename: 42, subfolder: '', type: 'output' }] },
          },
        },
      }),
    );

    await expectRejection(
      new ComfyClient(upstream.baseUrl).history('prompt-1'),
      /invalid history response/i,
    );
  });

  test('interrupts execution through POST /interrupt', async () => {
    const upstream = await startComfy((_request, response) => {
      response.end();
    });

    await new ComfyClient(upstream.baseUrl).cancel();

    expect(upstream.requests[0]).toMatchObject({ method: 'POST', url: '/interrupt' });
    expect(upstream.requests[0].body).toHaveLength(0);
  });

  test('reports a bounded HTTP error with a useful response excerpt', async () => {
    const upstream = await startComfy((_request, response) => {
      response.writeHead(400, { 'Content-Type': 'text/plain' });
      response.end(`Invalid prompt: ${'x'.repeat(5000)}`);
    });

    const error = await expectRejection(
      new ComfyClient(upstream.baseUrl).submit({}),
      /HTTP 400.*Invalid prompt/i,
    );
    expect(error.message.length).toBeLessThanOrEqual(1000);
    expect(error.message).not.toContain('x'.repeat(801));
  });

  test('rejects invalid JSON without returning it as data', async () => {
    const upstream = await startComfy((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('not-json');
    });

    await expectRejection(new ComfyClient(upstream.baseUrl).health(), /invalid JSON/i);
  });

  test('aborts a stalled REST request', async () => {
    const upstream = await startComfy(() => {
      // Deliberately leave the response open until fixture cleanup.
    });

    await expectRejection(
      new ComfyClient(upstream.baseUrl, { requestTimeoutMs: 25 }).health(),
      /timed out after 25 ms/i,
    );
  });
});

describe('ComfyClient uploads', () => {
  test('uploads an image as multipart image/input data with only its basename', async () => {
    const upstream = await startComfy((_request, response) =>
      json(response, { name: 'tiny.png', subfolder: 'references', type: 'input' }),
    );
    const filePath = makeTemporaryFile('tiny.png', 'small-png-test-bytes');

    const filename = await new ComfyClient(upstream.baseUrl).uploadFile({
      filePath,
      kind: 'image',
    });

    expect(filename).toBe('references/tiny.png');
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', url: '/upload/image' });
    expect(upstream.requests[0].headers['content-type']).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    const multipart = upstream.requests[0].body.toString('latin1');
    expect(multipart).toContain('name="type"\r\n\r\ninput');
    expect(multipart).toContain('name="image"; filename="tiny.png"');
    expect(multipart).toContain('small-png-test-bytes');
    expect(multipart).not.toContain(filePath);
  });

  test('uploads audio through /upload/image using the same image field', async () => {
    const upstream = await startComfy((_request, response) =>
      json(response, { name: 'voice.mp3', subfolder: '', type: 'input' }),
    );
    const filePath = makeTemporaryFile('voice.mp3', Uint8Array.from([0, 1, 2, 3, 255]));

    const filename = await new ComfyClient(upstream.baseUrl).uploadFile({
      filePath,
      kind: 'audio',
    });

    expect(filename).toBe('voice.mp3');
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', url: '/upload/image' });
    const body = upstream.requests[0].body;
    expect(body.toString('latin1')).toContain('name="image"; filename="voice.mp3"');
    expect(body.includes(Buffer.from([0, 1, 2, 3, 255]))).toBe(true);
  });

  test('rejects traversal, missing files, unsupported extensions, and kinds before upload', async () => {
    const upstream = await startComfy();
    const client = new ComfyClient(upstream.baseUrl);
    const directory = makeTemporaryDirectory();
    const textPath = makeTemporaryFile('notes.txt', 'not an upload');

    await expectRejection(
      client.uploadFile({ filePath: `${directory}/../outside.png`, kind: 'image' }),
      /traversal/i,
    );
    await expectRejection(
      client.uploadFile({ filePath: join(directory, 'missing.png'), kind: 'image' }),
      /does not exist|not a file/i,
    );
    await expectRejection(
      client.uploadFile({ filePath: textPath, kind: 'image' }),
      /extension|file type/i,
    );
    await expectRejection(
      client.uploadFile({ filePath: textPath, kind: 'video' as 'image' }),
      /image or audio/i,
    );
    expect(upstream.requests).toHaveLength(0);
  });

  test.each([
    { name: '', subfolder: '', type: 'input' },
    { name: '../tiny.png', subfolder: '', type: 'input' },
    { name: 'tiny.png', subfolder: '../outside', type: 'input' },
    { name: 'tiny.png', subfolder: null, type: 'input' },
    { name: 'tiny.png', subfolder: '', type: 'output' },
  ])('rejects an unsafe or invalid upload response: %j', async (payload) => {
    const upstream = await startComfy((_request, response) => json(response, payload));
    const filePath = makeTemporaryFile('tiny.png', 'small-png-test-bytes');

    await expectRejection(
      new ComfyClient(upstream.baseUrl).uploadFile({ filePath, kind: 'image' }),
      /invalid upload response/i,
    );
  });
});

describe('ComfyClient WebSocket completion', () => {
  test('handles status and progress and resolves only for the requested execution', async () => {
    const upstream = await startComfy();
    upstream.webSockets.on('connection', (socket) => {
      send(socket, 'status', { status: { exec_info: { queue_remaining: 1 } } });
      send(socket, 'progress', { prompt_id: 'other', value: 1, max: 5 });
      send(socket, 'progress', { prompt_id: 'prompt-1', value: 2, max: 5 });
      send(socket, 'execution_success', { prompt_id: 'other' });
      send(socket, 'execution_success', { prompt_id: 'prompt-1' });
      send(socket, 'progress', { prompt_id: 'prompt-1', value: 3, max: 5 });
    });
    const progress: unknown[] = [];

    await new ComfyClient(upstream.baseUrl, {
      clientId: 'client-1',
      completionTimeoutMs: 500,
    }).waitForCompletion('prompt-1', (value) => progress.push(value));

    expect(progress).toEqual([{ value: 2, max: 5 }]);
  });

  test('connects to the derived WebSocket endpoint with the client id', async () => {
    const upstream = await startComfy();
    let websocketUrl: string | undefined;
    upstream.webSockets.on('connection', (socket, request) => {
      websocketUrl = request.url;
      send(socket, 'execution_success', { prompt_id: 'prompt-1' });
    });

    await new ComfyClient(upstream.baseUrl, {
      clientId: 'client/with space',
      completionTimeoutMs: 500,
    }).waitForCompletion('prompt-1');

    expect(websocketUrl).toBe('/ws?clientId=client%2Fwith%20space');
  });

  test('resolves from history when execution completed before subscription without replay', async () => {
    const upstream = await startComfy((_request, response) =>
      json(response, {
        'prompt-1': {
          outputs: {},
          status: { status_str: 'success', completed: true, messages: [] },
        },
      }),
    );

    await expect(
      new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 100 }).waitForCompletion(
        'prompt-1',
      ),
    ).resolves.toBeUndefined();
    expect(upstream.requests.some((request) => request.url === '/history/prompt-1')).toBe(true);
  });

  test.each([
    {
      scenario: 'execution error',
      event: 'execution_error',
      data: {
        prompt_id: 'prompt-1',
        node_id: 'node-7',
        exception_message: 'model missing',
      },
      pattern: /execution failed.*node-7.*model missing/i,
    },
    {
      scenario: 'interruption',
      event: 'execution_interrupted',
      data: { prompt_id: 'prompt-1', node_id: 'node-8' },
      pattern: /execution interrupted.*node-8/i,
    },
  ])('settles a pre-subscription $scenario from history messages', async ({
    event,
    data,
    pattern,
  }) => {
    const upstream = await startComfy((_request, response) =>
      json(response, {
        'prompt-1': {
          outputs: {},
          status: {
            status_str: 'error',
            completed: false,
            messages: [[event, data]],
          },
        },
      }),
    );

    await expectRejection(
      new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 100 }).waitForCompletion(
        'prompt-1',
      ),
      pattern,
    );
  });

  test('ignores binary preview frames and accepts a later execution success', async () => {
    const upstream = await startComfy();
    upstream.webSockets.on('connection', (socket) => {
      socket.send(Buffer.from([0, 1, 2, 255]), { binary: true });
      send(socket, 'execution_success', { prompt_id: 'prompt-1' });
    });

    await expect(
      new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 100 }).waitForCompletion(
        'prompt-1',
      ),
    ).resolves.toBeUndefined();
  });

  test('rejects execution errors with a bounded message', async () => {
    const upstream = await startComfy();
    upstream.webSockets.on('connection', (socket) => {
      send(socket, 'execution_error', {
        prompt_id: 'prompt-1',
        node_id: 'node-9',
        exception_message: `bad input ${'x'.repeat(5000)}`,
      });
    });

    const error = await expectRejection(
      new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 500 }).waitForCompletion(
        'prompt-1',
      ),
      /execution failed.*node-9.*bad input/i,
    );
    expect(error.message.length).toBeLessThanOrEqual(1000);
  });

  test('rejects malformed WebSocket messages', async () => {
    const upstream = await startComfy();
    upstream.webSockets.on('connection', (socket) => socket.send('not-json'));

    await expectRejection(
      new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 500 }).waitForCompletion(
        'prompt-1',
      ),
      /invalid JSON/i,
    );
  });

  test('rejects a socket that closes before execution succeeds', async () => {
    const upstream = await startComfy();
    upstream.webSockets.on('connection', (socket) => socket.close(1011, 'stopped'));

    await expectRejection(
      new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 500 }).waitForCompletion(
        'prompt-1',
      ),
      /closed before execution completed/i,
    );
  });

  test(
    'times out and closes a socket that never reports completion',
    async () => {
      const upstream = await startComfy();

      await expectRejection(
        new ComfyClient(upstream.baseUrl, { completionTimeoutMs: 25 }).waitForCompletion(
          'prompt-1',
        ),
        /timed out after 25 ms/i,
      );
    },
    500,
  );
});

describe('ComfyClient and JobCoordinator cancellation', () => {
  test('fails promptly on interruption and starts the next job after the cancellation barrier', async () => {
    let socket: WebSocket | undefined;
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve;
    });
    const upstream = await startComfy((request, response) => {
      if (request.url === '/history/prompt-1') {
        json(response, {});
      } else if (request.url === '/interrupt') {
        send(socket!, 'execution_interrupted', {
          prompt_id: 'prompt-1',
          node_id: 'node-cancel',
        });
        response.end();
      } else {
        json(response, { error: 'not found' }, 404);
      }
    });
    upstream.webSockets.on('connection', (connectedSocket) => {
      socket = connectedSocket;
      markConnected();
    });

    const client = new ComfyClient(upstream.baseUrl, {
      requestTimeoutMs: 100,
      completionTimeoutMs: 100,
    });
    const coordinator = new JobCoordinator();
    const calls: string[] = [];
    let releaseCancellation!: () => void;
    const cancellationBarrier = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });

    const first = coordinator.enqueue({
      id: 'first',
      run: () => client.waitForCompletion('prompt-1'),
      cancel: async () => {
        calls.push('cancel started');
        await client.cancel();
        await cancellationBarrier;
        calls.push('cancel finished');
      },
    });
    const second = coordinator.enqueue({
      id: 'second',
      run: async () => {
        calls.push('second started');
      },
    });

    await connected;
    const cancellation = coordinator.cancelActive();
    let assertionFailure: unknown;
    try {
      await expectRejection(first, /execution interrupted.*node-cancel/i);
      expect(calls).toEqual(['cancel started']);
      expect(coordinator.activeCount).toBe(1);
    } catch (error) {
      assertionFailure = error;
    } finally {
      releaseCancellation();
    }

    await cancellation;
    await second;
    if (assertionFailure !== undefined) {
      throw assertionFailure;
    }

    expect(calls).toEqual(['cancel started', 'cancel finished', 'second started']);
    expect(coordinator.completedIds).toEqual(['second']);
    expect(coordinator.activeCount).toBe(0);
  });
});

describe('ComfyClient targeted cancellation', () => {
  test('deletes only the requested pending prompt without interrupting', async () => {
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        json(response, {
          queue_running: [[11, 'running-other']],
          queue_pending: [
            [12, 'pending-id'],
            [13, 'pending-other'],
          ],
        });
        return;
      }
      if (request.url === '/queue' && request.method === 'POST') {
        json(response, {});
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await new ComfyClient(upstream.baseUrl).cancel('pending-id');

    const posts = upstream.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/queue');
    expect(JSON.parse(posts[0].body.toString('utf8'))).toEqual({
      delete: ['pending-id'],
    });
    expect(upstream.requests.some((request) => request.url === '/interrupt')).toBe(false);
  });

  test('interrupts only when the requested prompt is running', async () => {
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        json(response, {
          queue_running: [[11, 'running-id']],
          queue_pending: [[12, 'pending-other']],
        });
        return;
      }
      if (request.url === '/interrupt') {
        response.end();
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await new ComfyClient(upstream.baseUrl).cancel('running-id');

    expect(
      upstream.requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual(['GET /queue', 'POST /interrupt']);
  });

  test('does not send any cancellation request for a prompt that is gone', async () => {
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        json(response, {
          queue_running: [[11, 'unrelated-running']],
          queue_pending: [[12, 'unrelated-pending']],
        });
        return;
      }
      if (request.url === '/interrupt' || request.url === '/queue') {
        json(response, {});
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await new ComfyClient(upstream.baseUrl).cancel('missing-id');

    // A later unrelated task must not be killed by a stale prompt id.
    expect(
      upstream.requests.map((request) => `${request.method} ${request.url}`),
    ).toEqual(['GET /queue']);
  });

  test('interrupts when a deleted pending prompt raced into running', async () => {
    let promoted = false;
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        json(
          response,
          promoted
            ? { queue_running: [[11, 'race-id']], queue_pending: [] }
            : { queue_running: [], queue_pending: [[12, 'race-id']] },
        );
        return;
      }
      if (request.url === '/queue' && request.method === 'POST') {
        // The backend accepted the delete, but the prompt had already been
        // promoted to running before the delete took effect.
        promoted = true;
        json(response, {});
        return;
      }
      if (request.url === '/interrupt') {
        response.end();
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await new ComfyClient(upstream.baseUrl).cancel('race-id');

    expect(upstream.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /queue',
      'POST /queue',
      'GET /queue',
      'POST /interrupt',
    ]);
  });

  test('does not interrupt when a deleted pending prompt stays gone', async () => {
    let deleted = false;
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        json(
          response,
          deleted
            ? { queue_running: [], queue_pending: [] }
            : { queue_running: [], queue_pending: [[12, 'pending-id']] },
        );
        return;
      }
      if (request.url === '/queue' && request.method === 'POST') {
        deleted = true;
        json(response, {});
        return;
      }
      if (request.url === '/interrupt') {
        response.end();
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await new ComfyClient(upstream.baseUrl).cancel('pending-id');

    expect(upstream.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /queue',
      'POST /queue',
      'GET /queue',
    ]);
  });
});

describe('ComfyClient queue reconciliation', () => {
  function startQueuedComfy(options: {
    queue: () => { running: string[]; pending: string[] };
    history?: (promptId: string, calls: number) => unknown;
  }): Promise<LocalComfy> {
    let historyCalls = 0;
    return startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        const snapshot = options.queue();
        json(response, {
          queue_running: snapshot.running.map((id, index) => [index + 1, id]),
          queue_pending: snapshot.pending.map((id, index) => [index + 100, id]),
        });
        return;
      }
      if (request.url === '/queue' && request.method === 'POST') {
        json(response, {});
        return;
      }
      if (request.url === '/interrupt') {
        response.end();
        return;
      }
      const historyMatch = /^\/history\/(.+)$/.exec(request.url ?? '');
      if (historyMatch) {
        historyCalls += 1;
        const promptId = decodeURIComponent(historyMatch[1]);
        json(response, options.history?.(promptId, historyCalls) ?? {});
        return;
      }
      json(response, { error: 'not found' }, 404);
    });
  }

  function historySuccess(promptId: string): unknown {
    return {
      [promptId]: {
        outputs: {},
        status: { status_str: 'success', completed: true, messages: [] },
      },
    };
  }

  test('reports backend-queued, executing, and finalizing with queue positions', async () => {
    let phase: 'pending' | 'running' | 'done' = 'pending';
    const upstream = await startQueuedComfy({
      queue: () =>
        phase === 'pending'
          ? { running: ['other'], pending: ['prompt-1'] }
          : phase === 'running'
            ? { running: ['prompt-1'], pending: [] }
            : { running: [], pending: [] },
      history: (promptId) => (phase === 'done' ? historySuccess(promptId) : {}),
    });
    const updates: ComfyExecutionUpdate[] = [];
    const client = new ComfyClient(upstream.baseUrl, {
      clientId: 'client-1',
      inactivityTimeoutMs: 5_000,
      reconcileIntervalMs: 20,
      completionTimeoutMs: 5_000,
    });

    const completion = client.waitForCompletion('prompt-1', undefined, (update) =>
      updates.push(update),
    );
    await vi.waitFor(() =>
      expect(updates.some((update) => update.stage === 'backend-queued')).toBe(true),
    );
    phase = 'running';
    await vi.waitFor(() =>
      expect(updates.some((update) => update.stage === 'executing')).toBe(true),
    );
    phase = 'done';
    await completion;

    expect(updates.map((update) => update.stage)).toEqual([
      'backend-queued',
      'executing',
      'finalizing',
    ]);
    expect(updates[0]).toMatchObject({ stage: 'backend-queued', queuePosition: 1 });
    expect(updates[1]).toMatchObject({ stage: 'executing', queuePosition: 0 });
  });

  test('treats WebSocket executing signals as executing updates', async () => {
    const upstream = await startQueuedComfy({
      queue: () => ({ running: ['prompt-1'], pending: [] }),
    });
    upstream.webSockets.on('connection', (socket) => {
      send(socket, 'execution_start', { prompt_id: 'other' });
      send(socket, 'executing', { prompt_id: 'prompt-1', node_id: '5' });
      send(socket, 'execution_success', { prompt_id: 'prompt-1' });
    });
    const updates: ComfyExecutionUpdate[] = [];

    await new ComfyClient(upstream.baseUrl, {
      clientId: 'client-1',
      inactivityTimeoutMs: 5_000,
      reconcileIntervalMs: 1_000,
      completionTimeoutMs: 2_000,
    }).waitForCompletion('prompt-1', undefined, (update) => updates.push(update));

    expect(updates.map((update) => update.stage)).toEqual(['executing', 'finalizing']);
  });

  test('completes through periodic history reconciliation when the socket stays silent', async () => {
    const upstream = await startQueuedComfy({
      queue: () => ({ running: ['prompt-1'], pending: [] }),
      history: (promptId, calls) => (calls >= 3 ? historySuccess(promptId) : {}),
    });

    await expect(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 5_000,
        reconcileIntervalMs: 20,
        completionTimeoutMs: 3_000,
      }).waitForCompletion('prompt-1'),
    ).resolves.toBeUndefined();

    const historyRequests = upstream.requests.filter((request) =>
      request.url?.startsWith('/history/'),
    );
    expect(historyRequests.length).toBeGreaterThanOrEqual(3);
  });

  test('tolerates a single reconciliation gap before the prompt reappears', async () => {
    let queueCalls = 0;
    const upstream = await startQueuedComfy({
      queue: () => {
        queueCalls += 1;
        // The first poll races the backend enqueue; afterwards the prompt is running.
        return queueCalls === 1
          ? { running: [], pending: [] }
          : { running: ['prompt-1'], pending: [] };
      },
      history: (promptId, calls) => (calls >= 4 ? historySuccess(promptId) : {}),
    });

    await expect(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 5_000,
        reconcileIntervalMs: 20,
        completionTimeoutMs: 3_000,
      }).waitForCompletion('prompt-1'),
    ).resolves.toBeUndefined();
  });

  test('fails clearly when the prompt vanishes from the queue without a history result', async () => {
    let queueCalls = 0;
    const upstream = await startQueuedComfy({
      queue: () => {
        queueCalls += 1;
        return { running: [], pending: [] };
      },
    });

    await expectRejection(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 5_000,
        reconcileIntervalMs: 20,
        completionTimeoutMs: 5_000,
      }).waitForCompletion('prompt-1'),
      /no longer queued/i,
    );
    // One race grace poll, then the second consecutive miss fails.
    expect(queueCalls).toBeGreaterThanOrEqual(2);
  });

  test('deletes the stale pending prompt precisely when execution makes no progress', async () => {
    const upstream = await startQueuedComfy({
      queue: () => ({ running: [], pending: ['stale-id', 'other'] }),
    });

    await expectRejection(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 60,
        reconcileIntervalMs: 20,
        completionTimeoutMs: 5_000,
      }).waitForCompletion('stale-id'),
      /no progress/i,
    );

    const deletes = upstream.requests.filter(
      (request) => request.method === 'POST' && request.url === '/queue',
    );
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(deletes[0].body.toString('utf8'))).toEqual({ delete: ['stale-id'] });
    expect(upstream.requests.some((request) => request.url === '/interrupt')).toBe(false);
  });

  test('interrupts the timed-out running prompt and keeps the total timeout message', async () => {
    const upstream = await startQueuedComfy({
      queue: () => ({ running: ['running-id'], pending: [] }),
    });

    await expectRejection(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 5_000,
        reconcileIntervalMs: 1_000,
        completionTimeoutMs: 60,
      }).waitForCompletion('running-id'),
      /timed out after 60 ms/i,
    );

    const posts = upstream.requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => request.url)).toEqual(['/interrupt']);
  });

  test('unchanged polls do not extend the inactivity budget but frame progress does', async () => {
    const upstream = await startQueuedComfy({
      queue: () => ({ running: ['prompt-1'], pending: [] }),
    });
    let frame = 0;
    let frameTimer: NodeJS.Timeout | undefined;
    upstream.webSockets.on('connection', (socket) => {
      frameTimer = setInterval(() => {
        frame += 1;
        send(socket, 'progress', { prompt_id: 'prompt-1', value: frame, max: 1000 });
      }, 40);
    });
    const client = new ComfyClient(upstream.baseUrl, {
      clientId: 'client-1',
      inactivityTimeoutMs: 120,
      reconcileIntervalMs: 25,
      completionTimeoutMs: 5_000,
    });

    const completion = client.waitForCompletion('prompt-1');
    const early = await Promise.race([
      completion.then(
        () => 'settled',
        () => 'settled',
      ),
      delay(300).then(() => 'pending'),
    ]);
    // Distinct frames kept the execution alive past the 120ms inactivity budget.
    expect(early).toBe('pending');

    clearInterval(frameTimer);
    await expectRejection(completion, /no progress/i);
  });

  test('queue movement refreshes the inactivity budget', async () => {
    let queueCalls = 0;
    const movable = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        queueCalls += 1;
        const ahead = Math.max(0, 5 - Math.floor((queueCalls - 1) / 2));
        json(response, {
          queue_running: [],
          queue_pending: [
            ...Array.from({ length: ahead }, (_, index) => [index + 1, `other-${index}`]),
            [99, 'prompt-1'],
          ],
        });
        return;
      }
      if (request.url?.startsWith('/history/')) {
        json(response, {});
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    const completion = new ComfyClient(movable.baseUrl, {
      clientId: 'client-1',
      inactivityTimeoutMs: 120,
      reconcileIntervalMs: 20,
      completionTimeoutMs: 5_000,
    }).waitForCompletion('prompt-1');
    const early = await Promise.race([
      completion.then(
        () => 'settled',
        () => 'settled',
      ),
      delay(240).then(() => 'pending'),
    ]);
    // Shrinking queue positions kept refreshing the 120ms inactivity budget.
    expect(early).toBe('pending');

    await expectRejection(completion, /no progress/i);
  });

  test('retries transient reconciliation failures and resets the count after a success', async () => {
    let queueCalls = 0;
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        queueCalls += 1;
        // fail, fail, ok, fail, fail, ok — a cumulative (non-resetting)
        // counter would trip at the fourth call.
        const failed =
          queueCalls <= 2 || (queueCalls >= 4 && queueCalls <= 5);
        if (failed) {
          json(response, { error: 'temporarily unavailable' }, 500);
        } else {
          json(response, { queue_running: [[1, 'prompt-1']], queue_pending: [] });
        }
        return;
      }
      if (request.url?.startsWith('/history/')) {
        json(response, queueCalls >= 6 ? historySuccess('prompt-1') : {});
        return;
      }
      if (request.url === '/interrupt') {
        response.end();
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await expect(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 5_000,
        reconcileIntervalMs: 20,
        completionTimeoutMs: 3_000,
      }).waitForCompletion('prompt-1'),
    ).resolves.toBeUndefined();

    expect(queueCalls).toBeGreaterThanOrEqual(6);
    // Transient reconciliation failures must never trigger prompt cleanup.
    expect(upstream.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  test('fails only after three consecutive reconciliation errors', async () => {
    let queueCalls = 0;
    const upstream = await startComfy((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        queueCalls += 1;
        json(response, { error: 'still broken' }, 500);
        return;
      }
      if (request.url?.startsWith('/history/')) {
        json(response, {});
        return;
      }
      json(response, { error: 'not found' }, 404);
    });

    await expectRejection(
      new ComfyClient(upstream.baseUrl, {
        clientId: 'client-1',
        inactivityTimeoutMs: 5_000,
        reconcileIntervalMs: 20,
        completionTimeoutMs: 5_000,
      }).waitForCompletion('prompt-1'),
      /HTTP 500/i,
    );
    expect(queueCalls).toBe(3);
  });

  test('WebSocket activity resets the missing-from-queue strike count', async () => {
    let socket: WebSocket | undefined;
    let queueCalls = 0;
    let historyCalls = 0;
    const secondPoll = deferred();
    const upstream = await startComfy(async (request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        queueCalls += 1;
        if (queueCalls === 2) {
          await secondPoll.promise;
        }
        // The prompt never appears in the queue in this scenario.
        json(response, { queue_running: [], queue_pending: [] });
        return;
      }
      if (request.url?.startsWith('/history/')) {
        historyCalls += 1;
        json(response, historyCalls >= 4 ? historySuccess('prompt-1') : {});
        return;
      }
      json(response, { error: 'not found' }, 404);
    });
    upstream.webSockets.on('connection', (connected) => {
      socket = connected;
    });
    const progressSeen = deferred();
    const completion = new ComfyClient(upstream.baseUrl, {
      clientId: 'client-1',
      inactivityTimeoutMs: 5_000,
      reconcileIntervalMs: 20,
      completionTimeoutMs: 3_000,
    }).waitForCompletion(
      'prompt-1',
      () => progressSeen.resolve(),
      undefined,
    );

    // First poll: one miss. Without a reset, the second consecutive miss
    // would reject the wait before the history result arrives.
    await vi.waitFor(() => expect(historyCalls).toBe(2));
    await vi.waitFor(() => expect(socket).toBeDefined());
    send(socket!, 'progress', { prompt_id: 'prompt-1', value: 1, max: 10 });
    await progressSeen.promise;
    secondPoll.resolve();

    await expect(completion).resolves.toBeUndefined();
  });

  test('reports finalizing when the initial history check resolves the wait', async () => {
    const upstream = await startComfy((_request, response) =>
      json(response, historySuccess('prompt-1')),
    );
    const updates: ComfyExecutionUpdate[] = [];

    await new ComfyClient(upstream.baseUrl, {
      clientId: 'client-1',
      completionTimeoutMs: 500,
    }).waitForCompletion('prompt-1', undefined, (update) => updates.push(update));

    expect(updates.map((update) => update.stage)).toEqual(['finalizing']);
  });
});
