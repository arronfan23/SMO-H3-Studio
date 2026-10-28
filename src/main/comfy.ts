import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 7_200_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 1_800_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
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
  /** Fails the wait when no real stage, queue, or frame change is seen for this long. */
  inactivityTimeoutMs?: number;
  /** Interval between /queue and /history reconciliation polls. */
  reconcileIntervalMs?: number;
  clientId?: string;
}

export interface ComfyExecutionUpdate {
  stage: 'backend-queued' | 'executing' | 'finalizing';
  queuePosition?: number;
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

interface ComfyQueueSnapshot {
  running: string[];
  pending: string[];
}

function invalidQueueResponse(): Error {
  return new Error('ComfyUI returned an invalid queue response');
}

function queueEntryPromptId(value: unknown): string | null {
  // ComfyUI queue entries are [number, prompt_id, prompt, extra_data, outputs].
  // Only the prompt id is read; prompt contents never enter logs or errors.
  if (Array.isArray(value) && typeof value[1] === 'string') {
    return value[1];
  }
  return null;
}

function parseQueueIds(value: unknown): ComfyQueueSnapshot {
  if (!isRecord(value)) {
    throw invalidQueueResponse();
  }
  const extract = (key: 'queue_running' | 'queue_pending'): string[] => {
    const entries = value[key];
    if (!Array.isArray(entries)) {
      throw invalidQueueResponse();
    }
    const ids: string[] = [];
    for (const entry of entries) {
      const promptId = queueEntryPromptId(entry);
      if (promptId !== null) {
        ids.push(promptId);
      }
    }
    return ids;
  };
  return { running: extract('queue_running'), pending: extract('queue_pending') };
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
  private readonly inactivityTimeoutMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly clientId: string;
  private readonly abortController: AbortController;
  private activeSocket?: WebSocket;
  private closed = false;

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
    this.inactivityTimeoutMs = validateTimeout(
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      'inactivityTimeoutMs',
    );
    this.reconcileIntervalMs = validateTimeout(
      options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
      'reconcileIntervalMs',
    );
    const clientId = options.clientId ?? randomUUID();
    if (clientId.trim().length === 0) {
      throw new Error('ComfyUI clientId must be non-empty');
    }
    this.clientId = clientId;
    this.abortController = new AbortController();
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

  async cancel(promptId?: string): Promise<void> {
    if (promptId === undefined) {
      await this.request('interrupt', { method: 'POST' });
      return;
    }
    // Targeted cleanup: only touch the requested prompt, never whatever
    // unrelated task happens to be running when a stale id arrives.
    const snapshot = parseQueueIds(await this.requestJson('queue'));
    if (snapshot.pending.includes(promptId)) {
      await this.request('queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      });
      return;
    }
    if (snapshot.running.includes(promptId)) {
      await this.request('interrupt', { method: 'POST' });
    }
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    this.abortController.abort();
    if (this.activeSocket !== undefined) {
      const socket = this.activeSocket;
      this.activeSocket = undefined;
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }
    return Promise.resolve();
  }

  waitForCompletion(
    promptId: string,
    onProgress?: (progress: ComfyProgress) => void,
    onUpdate?: (update: ComfyExecutionUpdate) => void,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('ComfyClient is closed'));
    }
    return new Promise((resolve, reject) => {
      const endpoint = new URL(`ws?clientId=${encodeURIComponent(this.clientId)}`, this.baseUrl);
      endpoint.protocol = this.baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(endpoint);
      this.activeSocket = socket;
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let reconcileTimer: NodeJS.Timeout | undefined;
      let stopped = false;
      let lastActivityAt = Date.now();
      let lastUpdate: ComfyExecutionUpdate | undefined;
      let lastFrame: ComfyProgress | undefined;
      let missingReconciliations = 0;
      let cleanupPromise: Promise<void> | undefined;

      const onAbort = () => {
        queueMicrotask(() => finish(new Error('ComfyClient is closed')));
      };
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        stopped = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (reconcileTimer !== undefined) {
          clearTimeout(reconcileTimer);
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
        if (this.activeSocket === socket) {
          this.activeSocket = undefined;
        }
        this.abortController.signal.removeEventListener('abort', onAbort);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      // Only a real stage, queue position, or frame change counts as progress;
      // unchanged polls never extend the inactivity budget.
      const emitUpdate = (update: ComfyExecutionUpdate): void => {
        if (settled) {
          return;
        }
        const changed =
          lastUpdate === undefined ||
          lastUpdate.stage !== update.stage ||
          lastUpdate.queuePosition !== update.queuePosition;
        if (!changed) {
          return;
        }
        lastUpdate = { ...update };
        lastActivityAt = Date.now();
        try {
          onUpdate?.(update);
        } catch (callbackError) {
          finish(
            callbackError instanceof Error
              ? callbackError
              : new Error('ComfyUI execution update callback failed'),
          );
        }
      };

      const noteFrame = (progress: ComfyProgress): void => {
        if (
          lastFrame === undefined ||
          lastFrame.value !== progress.value ||
          lastFrame.max !== progress.max
        ) {
          lastFrame = progress;
          lastActivityAt = Date.now();
        }
      };

      // Best-effort targeted cleanup, memoized so the inactivity and total
      // timeout paths never cancel the same prompt twice.
      const preciseCleanup = (): Promise<void> => {
        cleanupPromise ??= this.cancel(promptId).catch(() => undefined);
        return cleanupPromise;
      };

      const reconcile = async (): Promise<void> => {
        if (settled || stopped) {
          return;
        }
        try {
          const snapshot = parseQueueIds(await this.requestJson('queue'));
          if (settled) {
            return;
          }
          const completion = parseHistoryCompletion(
            await this.historyValue(promptId),
            promptId,
          );
          if (settled) {
            return;
          }
          if (completion?.kind === 'success') {
            emitUpdate({ stage: 'finalizing' });
            finish();
            return;
          }
          if (completion?.kind === 'failure') {
            finish(completion.error);
            return;
          }
          if (snapshot.running.includes(promptId)) {
            missingReconciliations = 0;
            emitUpdate({ stage: 'executing', queuePosition: 0 });
          } else {
            const pendingIndex = snapshot.pending.indexOf(promptId);
            if (pendingIndex >= 0) {
              missingReconciliations = 0;
              emitUpdate({
                stage: 'backend-queued',
                queuePosition: snapshot.running.length + pendingIndex,
              });
            } else {
              // One race grace: the prompt may sit between enqueue and the
              // first queue snapshot. Only a second consecutive miss fails.
              missingReconciliations += 1;
              if (missingReconciliations >= 2) {
                finish(
                  new Error(
                    'ComfyUI prompt is no longer queued and has no recorded result',
                  ),
                );
                return;
              }
            }
          }
          if (Date.now() - lastActivityAt >= this.inactivityTimeoutMs) {
            stopped = true;
            await preciseCleanup();
            finish(
              new Error(
                `ComfyUI execution made no progress for ${this.inactivityTimeoutMs} ms`,
              ),
            );
            return;
          }
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error('Could not reconcile ComfyUI execution state'),
          );
          return;
        }
        if (!stopped && !settled) {
          reconcileTimer = setTimeout(() => {
            void reconcile();
          }, this.reconcileIntervalMs);
        }
      };
      // Chained timeouts keep reconciliation requests non-overlapping.
      reconcileTimer = setTimeout(() => {
        void reconcile();
      }, this.reconcileIntervalMs);

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
              noteFrame({ value: payload.value, max: payload.max });
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
              emitUpdate({ stage: 'finalizing' });
              finish();
            }
            return;
          case 'execution_start':
          case 'executing':
            if (isRecord(payload) && payload.prompt_id === promptId) {
              emitUpdate({ stage: 'executing', queuePosition: 0 });
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
        stopped = true;
        if (reconcileTimer !== undefined) {
          clearTimeout(reconcileTimer);
        }
        // Never leave a timed-out prompt running on the backend; the overall
        // timeout error keeps its existing message shape.
        void preciseCleanup().then(() => {
          finish(
            new Error(`ComfyUI execution timed out after ${this.completionTimeoutMs} ms`),
          );
        });
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
    if (this.closed) {
      throw new Error('ComfyClient is closed');
    }
    const body = await this.request(path, init);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('ComfyUI service returned invalid JSON');
    }
  }

  private async request(path: string, init: RequestInit): Promise<string> {
    if (this.closed) {
      throw new Error('ComfyClient is closed');
    }
    const controller = new AbortController();
    const signals = [this.abortController.signal, controller.signal];
    const signal = AbortSignal.any(signals);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let onAbort: (() => void) | undefined;
    const closeAbortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        queueMicrotask(() => reject(new Error('ComfyClient is closed')));
      };
      if (this.abortController.signal.aborted) {
        onAbort();
      } else {
        this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      const response = await Promise.race([
        fetch(this.endpoint(path), {
          ...init,
          headers: { Accept: 'application/json', ...init.headers },
          signal,
        }),
        closeAbortPromise,
      ]).catch((error) => {
        this.abortController.signal.removeEventListener('abort', onAbort!);
        if (this.closed) {
          throw new Error('ComfyClient is closed');
        }
        if (error instanceof Error && error.message === 'ComfyClient is closed') {
          throw error;
        }
        if (controller.signal.aborted) {
          throw new Error(`ComfyUI request timed out after ${this.requestTimeoutMs} ms`);
        }
        throw new Error('Could not connect to ComfyUI');
      });
      this.abortController.signal.removeEventListener('abort', onAbort!);

      const body = await response.text().catch((error) => {
        if (this.closed) {
          throw new Error('ComfyClient is closed');
        }
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
