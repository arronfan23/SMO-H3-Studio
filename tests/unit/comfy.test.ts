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
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ComfyClient } from '../../src/main/comfy';

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

      const handle = handler ?? ((_request, res) => json(res, { error: 'not found' }, 404));
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

  test('submits only the prompt envelope and returns validated identifiers', async () => {
    const prompt = {
      '1': { class_type: 'LoadImage', inputs: { image: 'tiny.png' } },
    };
    const upstream = await startComfy((_request, response) =>
      json(response, { prompt_id: 'prompt-1', number: 7, node_errors: {} }),
    );

    const result = await new ComfyClient(upstream.baseUrl).submit(prompt);

    expect(result).toEqual({ prompt_id: 'prompt-1', number: 7, node_errors: {} });
    expect(upstream.requests[0]).toMatchObject({ method: 'POST', url: '/prompt' });
    expect(upstream.requests[0].headers['content-type']).toContain('application/json');
    expect(JSON.parse(upstream.requests[0].body.toString('utf8'))).toEqual({ prompt });
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
