import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

export interface ComfyMockOptions {
  outputDirectory: string;
  ffmpegPath?: string;
}

export interface ComfyMock {
  baseUrl: string;
  close: () => Promise<void>;
  failNext: () => void;
  submittedPromptIds: string[];
}

interface PromptRecord {
  promptId: string;
  outputNode: string;
  outputPrefix: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'interrupted';
  errorMessage?: string;
  outputFilename?: string;
  shouldFail: boolean;
}

interface MultipartPart {
  name: string;
  filename?: string;
  data: Buffer;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function parseMultipart(
  contentType: string,
  body: Buffer,
): { parts: MultipartPart[]; error?: string } {
  const match = /boundary=([^;\s]+)/i.exec(contentType);
  if (!match) {
    return { parts: [], error: 'Missing multipart boundary' };
  }
  let boundary = match[1];
  if (boundary.startsWith('"') && boundary.endsWith('"')) {
    boundary = boundary.slice(1, -1);
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let offset = 0;
  while (offset < body.length) {
    const index = body.indexOf(delimiter, offset);
    if (index === -1) break;
    const partStart = index + delimiter.length;
    if (partStart + 2 >= body.length) break;
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd === -1) break;
    const headerLines = body
      .slice(partStart + 2, headerEnd)
      .toString('utf8')
      .split('\r\n');
    let name: string | undefined;
    let filename: string | undefined;
    for (const line of headerLines) {
      const dispositionMatch = /Content-Disposition:\s*form-data(?:;\s*name="([^"]+)")?(?:;\s*filename="([^"]+)")?/i.exec(
        line,
      );
      if (dispositionMatch) {
        name = dispositionMatch[1];
        filename = dispositionMatch[2];
      }
    }
    const dataStart = headerEnd + 4;
    const nextDelimiter = body.indexOf(delimiter, dataStart);
    if (nextDelimiter === -1) break;
    const dataEnd = nextDelimiter - 2;
    if (name !== undefined) {
      parts.push({
        name,
        filename,
        data: body.slice(dataStart, dataEnd),
      });
    }
    offset = nextDelimiter;
  }
  return { parts };
}

async function createSampleMp4(
  outputPath: string,
  ffmpegPath?: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  if (!ffmpegPath) {
    throw new Error(`FFmpeg path not provided; cannot generate sample MP4 at ${outputPath}`);
  }
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=1',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ]);
}

function outputNodeFromPrompt(prompt: Record<string, unknown>): string | null {
  for (const node of Object.values(prompt)) {
    if (
      typeof node === 'object' &&
      node !== null &&
      'class_type' in node &&
      (node as { class_type: string }).class_type === 'VHS_VideoCombine'
    ) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'inputs' && typeof value === 'object' && value !== null) {
          const inputs = value as Record<string, unknown>;
          const prefix = typeof inputs.filename_prefix === 'string' ? inputs.filename_prefix : '';
          if (prefix.startsWith('SMO-H3/')) {
            return Object.keys(prompt).find((id) => prompt[id] === node) ?? null;
          }
        }
      }
    }
  }
  return null;
}

function outputPrefixFromPrompt(prompt: Record<string, unknown>): string {
  for (const node of Object.values(prompt)) {
    if (
      typeof node === 'object' &&
      node !== null &&
      'class_type' in node &&
      (node as { class_type: string }).class_type === 'VHS_VideoCombine'
    ) {
      const inputs = (node as { inputs?: Record<string, unknown> }).inputs;
      if (typeof inputs?.filename_prefix === 'string') {
        return inputs.filename_prefix;
      }
    }
  }
  return 'SMO-H3/unknown';
}

export async function startComfyMock(options: ComfyMockOptions): Promise<ComfyMock> {
  const { outputDirectory, ffmpegPath } = options;
  const records = new Map<string, PromptRecord>();
  const sockets = new Set<WebSocket>();
  const submittedPromptIds: string[] = [];
  let activePromptId: string | null = null;
  let shouldFailNext = false;

  const server = createServer((request, response) => {
    let body = Buffer.alloc(0);
    request.on('data', (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
    });
    request.on('end', async () => {
      try {
        const url = request.url ?? '';
        const method = request.method ?? '';

        if (method === 'GET' && url === '/system_stats') {
          sendJson(response, 200, {
            system: { os: 'Windows' },
            devices: [{ name: 'Mock GPU' }],
          });
          return;
        }

        if (method === 'GET' && url === '/object_info') {
          sendJson(response, 200, {
            'VHS_VideoCombine': { input: { required: {} } },
            'LoadImage': { input: { required: {} } },
          });
          return;
        }

        if (method === 'POST' && url === '/upload/image') {
          const contentType = request.headers['content-type'] ?? '';
          const parsed = parseMultipart(contentType, body);
          if (parsed.error) {
            sendJson(response, 400, { error: parsed.error });
            return;
          }
          const imagePart = parsed.parts.find((part) => part.name === 'image');
          if (!imagePart || !imagePart.filename) {
            sendJson(response, 400, { error: 'Missing image field' });
            return;
          }
          sendJson(response, 200, {
            name: imagePart.filename,
            subfolder: '',
            type: 'input',
          });
          return;
        }

        if (method === 'POST' && url === '/prompt') {
          const parsed = JSON.parse(body.toString('utf8')) as {
            prompt: Record<string, unknown>;
            client_id?: string;
          };
          const promptId = randomUUID();
          const outputNode = outputNodeFromPrompt(parsed.prompt) ?? '180';
          const outputPrefix = outputPrefixFromPrompt(parsed.prompt);
          const record: PromptRecord = {
            promptId,
            outputNode,
            outputPrefix,
            status: 'pending',
            shouldFail: shouldFailNext,
          };
          shouldFailNext = false;
          records.set(promptId, record);
          submittedPromptIds.push(promptId);
          activePromptId = promptId;
          sendJson(response, 200, {
            prompt_id: promptId,
            number: submittedPromptIds.length,
            node_errors: {},
          });

          // Simulate asynchronous execution.
          setTimeout(() => void runExecution(record), 50);
          return;
        }

        if (method === 'GET' && url.startsWith('/history/')) {
          const promptId = decodeURIComponent(url.slice('/history/'.length));
          const record = records.get(promptId);
          if (!record) {
            sendJson(response, 200, {});
            return;
          }
          const entry: Record<string, unknown> = {
            status: {
              status_str: record.status === 'completed' ? 'success' : record.status,
              completed: record.status === 'completed' || record.status === 'error',
              messages: buildMessages(record),
            },
          };
          if (record.status === 'completed' && record.outputFilename) {
            entry.outputs = {
              [record.outputNode]: {
                video: [
                  {
                    filename: record.outputFilename,
                    subfolder: record.outputPrefix,
                    type: 'output',
                  },
                ],
              },
            };
          }
          sendJson(response, 200, { [promptId]: entry });
          return;
        }

        if (method === 'POST' && url === '/interrupt') {
          if (activePromptId) {
            const record = records.get(activePromptId);
            if (record && record.status === 'running') {
              record.status = 'interrupted';
            }
          }
          sendJson(response, 200, {});
          return;
        }

        sendJson(response, 404, { error: 'Not found' });
      } catch {
        sendJson(response, 500, { error: 'Mock server error' });
      }
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  function broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(text);
      }
    }
  }

  function buildMessages(record: PromptRecord): unknown[] {
    if (record.status === 'interrupted') {
      return [['execution_interrupted', { prompt_id: record.promptId, node_id: record.outputNode }]];
    }
    if (record.status === 'error') {
      return [
        [
          'execution_error',
          {
            prompt_id: record.promptId,
            node_id: record.outputNode,
            exception_message: record.errorMessage ?? 'Mock execution error',
          },
        ],
      ];
    }
    if (record.status === 'completed') {
      return [['execution_success', { prompt_id: record.promptId }]];
    }
    return [];
  }

  async function runExecution(record: PromptRecord): Promise<void> {
    record.status = 'running';
    activePromptId = record.promptId;
    broadcast({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } });

    const frames = 24;
    for (let step = 1; step <= frames; step += 1) {
      if (record.status !== 'running') {
        broadcastFinal(record);
        return;
      }
      broadcast({
        type: 'progress',
        data: { prompt_id: record.promptId, value: step, max: frames },
      });
      await delay(10);
    }

    if (record.status !== 'running') {
      broadcastFinal(record);
      return;
    }

    if (record.shouldFail) {
      record.status = 'error';
      record.errorMessage = 'Mock execution failed (first attempt)';
      broadcastFinal(record);
      return;
    }

    const filename = `${record.promptId}.mp4`;
    const outputPath = join(outputDirectory, record.outputPrefix, filename);
    await createSampleMp4(outputPath, ffmpegPath);
    record.status = 'completed';
    record.outputFilename = filename;
    broadcastFinal(record);
  }

  function broadcastFinal(record: PromptRecord): void {
    if (record.status === 'completed') {
      broadcast({ type: 'execution_success', data: { prompt_id: record.promptId } });
    } else if (record.status === 'error') {
      broadcast({
        type: 'execution_error',
        data: {
          prompt_id: record.promptId,
          node_id: record.outputNode,
          exception_message: record.errorMessage ?? 'Mock execution error',
        },
      });
    } else if (record.status === 'interrupted') {
      broadcast({
        type: 'execution_interrupted',
        data: { prompt_id: record.promptId, node_id: record.outputNode },
      });
    }
    activePromptId = null;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  let closed = false;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) {
        socket.terminate();
      }
      sockets.clear();
      wss.close();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
    failNext: () => {
      shouldFailNext = true;
    },
    submittedPromptIds,
  };
}
