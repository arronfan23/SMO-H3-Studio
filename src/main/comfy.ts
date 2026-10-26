import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 30 * 60_000;
const MAX_ERROR_BODY_LENGTH = 800;

const UPLOAD_EXTENSIONS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp']),
  audio: new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a']),
} as const;

const HISTORY_FILE_KINDS = new Set(['images', 'audio', 'video', 'gifs']);

export type ComfyUploadKind = keyof typeof UPLOAD_EXTENSIONS;

export interface ComfyClientOptions {
  requestTimeoutMs?: number;
  completionTimeoutMs?: number;
  clientId?: string;
}

export interface ComfySystemStats {
  system: Record<string, unknown>;
  devices: Record<string, unknown>[];
  [key: string]: unknown;
}

export type ComfyObjectInfo = Record<string, Record<string, unknown>>;

export interface ComfySubmitResult {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export interface ComfyOutputFile {
  nodeId: string;
  kind: string;
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyProgress {
  value: number;
  max: number;
}

type HistoryCompletion =
  | { kind: 'success' }
  | { kind: 'failure'; error: Error }
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBaseUrl(value: string): URL {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new Error('ComfyUI base URL must be a valid HTTP or HTTPS URL');
  }

  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    baseUrl.username.length > 0 ||
    baseUrl.password.length > 0 ||
    baseUrl.search.length > 0 ||
    baseUrl.hash.length > 0
  ) {
    throw new Error(
      'ComfyUI base URL must use HTTP or HTTPS without credentials, query, or fragment',
    );
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
  return baseUrl;
}

function validateTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ComfyUI ${name} must be a finite positive number`);
  }
  return value;
}

function createHttpError(status: number, body: string): Error {
  const excerpt = body.trim().replace(/\s+/g, ' ').slice(0, MAX_ERROR_BODY_LENGTH);
  return new Error(
    `ComfyUI request failed (HTTP ${status})${excerpt.length > 0 ? `: ${excerpt}` : ''}`,
  );
}

function hasTraversal(filePath: string): boolean {
  return filePath.replaceAll('\\', '/').split('/').includes('..');
}

function fileBasename(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isSafeSubfolder(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:/i.test(value) ||
    value.includes('\\')
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function parseUploadFilename(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name === '.' ||
    value.name === '..' ||
    value.name.includes('/') ||
    value.name.includes('\\') ||
    typeof value.subfolder !== 'string' ||
    !isSafeSubfolder(value.subfolder) ||
    value.type !== 'input'
  ) {
    throw new Error('ComfyUI returned an invalid upload response');
  }

  return value.subfolder.length > 0 ? `${value.subfolder}/${value.name}` : value.name;
}

function invalidHistoryResponse(): Error {
  return new Error('ComfyUI returned an invalid history response');
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString();
}

function createExecutionError(data: Record<string, unknown>): Error {
  const nodeId =
    typeof data.node_id === 'string' && data.node_id.length > 0
      ? ` at node ${data.node_id.slice(0, 100)}`
      : '';
  const detail =
    typeof data.exception_message === 'string' && data.exception_message.length > 0
      ? data.exception_message
      : 'Unknown execution error';
  return new Error(
    `ComfyUI execution failed${nodeId}: ${detail.slice(0, MAX_ERROR_BODY_LENGTH)}`,
  );
}

function createExecutionInterruptedError(data: Record<string, unknown>): Error {
  const nodeId =
    typeof data.node_id === 'string' && data.node_id.length > 0
      ? ` at node ${data.node_id.slice(0, 100)}`
      : '';
  return new Error(`ComfyUI execution interrupted${nodeId}`);
}

function historyEntry(value: unknown, promptId: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    throw invalidHistoryResponse();
  }
  const entry = value[promptId];
  if (entry === undefined) {
    return null;
  }
  if (!isRecord(entry)) {
    throw invalidHistoryResponse();
  }
  return entry;
}

function parseHistoryCompletion(value: unknown, promptId: string): HistoryCompletion {
  const entry = historyEntry(value, promptId);
  if (entry === null || entry.status === undefined || entry.status === null) {
    return null;
  }
  if (!isRecord(entry.status)) {
    throw invalidHistoryResponse();
  }

  const status = entry.status;
  if (
    typeof status.status_str !== 'string' ||
    typeof status.completed !== 'boolean' ||
    !Array.isArray(status.messages)
  ) {
    throw invalidHistoryResponse();
  }

  for (const message of status.messages) {
    if (
      !Array.isArray(message) ||
      message.length < 2 ||
      typeof message[0] !== 'string' ||
      !isRecord(message[1])
    ) {
      throw invalidHistoryResponse();
    }
    const [type, data] = message;
    if (data.prompt_id !== promptId) {
      continue;
    }
    if (type === 'execution_interrupted') {
      return { kind: 'failure', error: createExecutionInterruptedError(data) };
    }
    if (type === 'execution_error') {
      return { kind: 'failure', error: createExecutionError(data) };
    }
    if (type === 'execution_success') {
      return { kind: 'success' };
    }
  }

  if (status.status_str === 'success' && status.completed) {
    return { kind: 'success' };
  }
  if (status.status_str === 'error') {
    return {
      kind: 'failure',
      error: new Error('ComfyUI execution failed without an execution error message'),
    };
  }
  return null;
}

function collectHistoryFiles(value: unknown, promptId: string): ComfyOutputFile[] {
  const entry = historyEntry(value, promptId);
  if (entry === null) {
    return [];
  }
  if (!isRecord(entry) || !isRecord(entry.outputs)) {
    throw invalidHistoryResponse();
  }

  const files: ComfyOutputFile[] = [];
  for (const [nodeId, nodeOutputs] of Object.entries(entry.outputs)) {
    if (!isRecord(nodeOutputs)) {
      throw invalidHistoryResponse();
    }

    for (const [kind, outputs] of Object.entries(nodeOutputs)) {
      if (!Array.isArray(outputs)) {
        continue;
      }
      for (const output of outputs) {
        const isKnownFileKind = HISTORY_FILE_KINDS.has(kind);
        if (!isRecord(output) || (!isKnownFileKind && !('filename' in output))) {
          if (isKnownFileKind) {
            throw invalidHistoryResponse();
          }
          continue;
        }
        if (
          typeof output.filename !== 'string' ||
          output.filename.length === 0 ||
          typeof output.subfolder !== 'string' ||
          typeof output.type !== 'string'
        ) {
          throw invalidHistoryResponse();
        }
        files.push({
          nodeId,
          kind,
          filename: output.filename,
          subfolder: output.subfolder,
          type: output.type,
        });
      }
    }
  }
  return files;
}

export class ComfyClient {
  private readonly baseUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly completionTimeoutMs: number;
  private readonly clientId: string;

  constructor(baseUrl = DEFAULT_BASE_URL, options: ComfyClientOptions = {}) {
    this.baseUrl = parseBaseUrl(baseUrl);
    this.requestTimeoutMs = validateTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.completionTimeoutMs = validateTimeout(
      options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS,
      'completionTimeoutMs',
    );
    const clientId = options.clientId ?? randomUUID();
    if (clientId.trim().length === 0) {
      throw new Error('ComfyUI clientId must be non-empty');
    }
    this.clientId = clientId;
  }

  async health(): Promise<ComfySystemStats> {
    const value = await this.requestJson('system_stats');
    if (
      !isRecord(value) ||
      !isRecord(value.system) ||
      !Array.isArray(value.devices) ||
      !value.devices.every(isRecord)
    ) {
      throw new Error('ComfyUI returned invalid system stats');
    }
    return value as ComfySystemStats;
  }

  async objectInfo(): Promise<ComfyObjectInfo> {
    const value = await this.requestJson('object_info');
    if (!isRecord(value) || !Object.values(value).every(isRecord)) {
      throw new Error('ComfyUI returned invalid object info');
    }
    return value as ComfyObjectInfo;
  }

  async uploadFile(input: {
    filePath: string;
    kind: ComfyUploadKind;
  }): Promise<string> {
    const { filePath, kind } = input;
    if (kind !== 'image' && kind !== 'audio') {
      throw new Error('ComfyUI upload kind must be image or audio');
    }
    if (hasTraversal(filePath)) {
      throw new Error('ComfyUI upload path traversal is not allowed');
    }

    const filename = fileBasename(filePath);
    const extension = extname(filename).toLowerCase();
    if (!UPLOAD_EXTENSIONS[kind].has(extension)) {
      throw new Error(`Unsupported ${kind} upload file extension: ${extension || '(none)'}`);
    }

    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch {
      throw new Error('ComfyUI upload file does not exist or is not a file');
    }
    if (!fileStats.isFile()) {
      throw new Error('ComfyUI upload file does not exist or is not a file');
    }

    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('type', 'input');
    form.append('image', new Blob([bytes]), filename);

    const value = await this.requestJson('upload/image', { method: 'POST', body: form });
    return parseUploadFilename(value);
  }

  async submit(prompt: unknown): Promise<ComfySubmitResult> {
    const value = await this.requestJson('prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: this.clientId }),
    });
    if (
      !isRecord(value) ||
      typeof value.prompt_id !== 'string' ||
      value.prompt_id.trim().length === 0 ||
      typeof value.number !== 'number' ||
      !Number.isFinite(value.number) ||
      !isRecord(value.node_errors)
    ) {
      throw new Error('ComfyUI returned an invalid prompt response');
    }
    return {
      prompt_id: value.prompt_id,
      number: value.number,
      node_errors: value.node_errors,
    };
  }

  async history(promptId: string): Promise<ComfyOutputFile[]> {
    const value = await this.historyValue(promptId);
    return collectHistoryFiles(value, promptId);
  }

  async cancel(): Promise<void> {
    await this.request('interrupt', { method: 'POST' });
  }

  waitForCompletion(
    promptId: string,
    onProgress?: (progress: ComfyProgress) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(`ws?clientId=${encodeURIComponent(this.clientId)}`, this.baseUrl);
      endpoint.protocol = this.baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(endpoint);
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      socket.on('message', (data, isBinary) => {
        if (settled || isBinary) {
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(rawDataToString(data)) as unknown;
        } catch {
          finish(new Error('ComfyUI WebSocket returned invalid JSON'));
          return;
        }
        if (!isRecord(message) || typeof message.type !== 'string') {
          finish(new Error('ComfyUI WebSocket returned an invalid message'));
          return;
        }

        const payload = message.data;
        switch (message.type) {
          case 'status':
            if (!isRecord(payload)) {
              finish(new Error('ComfyUI WebSocket returned an invalid status'));
            }
            return;
          case 'progress': {
            if (!isRecord(payload)) {
              finish(new Error('ComfyUI WebSocket returned invalid progress'));
              return;
            }
            if (payload.prompt_id !== promptId) {
              return;
            }
            if (
              typeof payload.value !== 'number' ||
              !Number.isFinite(payload.value) ||
              typeof payload.max !== 'number' ||
              !Number.isFinite(payload.max) ||
              payload.max <= 0
            ) {
              finish(new Error('ComfyUI WebSocket returned invalid progress'));
              return;
            }
            try {
              onProgress?.({ value: payload.value, max: payload.max });
            } catch (error) {
              finish(
                error instanceof Error
                  ? error
                  : new Error('ComfyUI progress callback failed'),
              );
            }
            return;
          }
          case 'execution_success':
            if (!isRecord(payload)) {
              finish(new Error('ComfyUI WebSocket returned an invalid execution result'));
            } else if (payload.prompt_id === promptId) {
              finish();
            }
            return;
          case 'execution_error':
            if (!isRecord(payload)) {
              finish(new Error('ComfyUI WebSocket returned an invalid execution error'));
            } else if (payload.prompt_id === promptId) {
              finish(createExecutionError(payload));
            }
            return;
          case 'execution_interrupted':
            if (!isRecord(payload)) {
              finish(new Error('ComfyUI WebSocket returned an invalid interruption'));
            } else if (payload.prompt_id === promptId) {
              finish(createExecutionInterruptedError(payload));
            }
            return;
          default:
            return;
        }
      });
      socket.on('error', (error) => {
        finish(new Error(`ComfyUI WebSocket error: ${error.message.slice(0, 300)}`));
      });
      socket.on('close', (code) => {
        finish(new Error(`ComfyUI WebSocket closed before execution completed (${code})`));
      });
      socket.on('open', () => {
        void this.historyValue(promptId)
          .then((value) => {
            if (settled) {
              return;
            }
            const completion = parseHistoryCompletion(value, promptId);
            if (completion?.kind === 'success') {
              finish();
            } else if (completion?.kind === 'failure') {
              finish(completion.error);
            }
          })
          .catch((error: unknown) => {
            finish(
              error instanceof Error
                ? error
                : new Error('Could not reconcile ComfyUI execution history'),
            );
          });
      });

      timeout = setTimeout(() => {
        finish(
          new Error(`ComfyUI execution timed out after ${this.completionTimeoutMs} ms`),
        );
      }, this.completionTimeoutMs);
    });
  }

  private endpoint(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private async historyValue(promptId: string): Promise<unknown> {
    return this.requestJson(`history/${encodeURIComponent(promptId)}`);
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const body = await this.request(path, init);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('ComfyUI service returned invalid JSON');
    }
  }

  private async request(path: string, init: RequestInit): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(this.endpoint(path), {
        ...init,
        headers: { Accept: 'application/json', ...init.headers },
        signal: controller.signal,
      }).catch(() => {
        if (controller.signal.aborted) {
          throw new Error(`ComfyUI request timed out after ${this.requestTimeoutMs} ms`);
        }
        throw new Error('Could not connect to ComfyUI');
      });

      const body = await response.text().catch(() => {
        if (controller.signal.aborted) {
          throw new Error(`ComfyUI request timed out after ${this.requestTimeoutMs} ms`);
        }
        throw new Error('Could not read the ComfyUI response');
      });
      if (!response.ok) {
        throw createHttpError(response.status, body);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
