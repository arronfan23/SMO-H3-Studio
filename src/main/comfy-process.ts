import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComfyClient, ComfySystemStats } from './comfy';

export const DEFAULT_COMFY_ROOT =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130';

const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const LOG_TAIL_LENGTH = 2_000;

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface ComfyProcessManagerOptions {
  baseUrl: string;
  rootDirectory?: string;
  pythonPath?: string;
  launchScript?: string;
  logPath: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnProcess?: typeof spawn;
}

function validateTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ComfyUI ${name} must be a finite positive number`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayUrl(baseUrl: URL): string {
  const url = new URL(baseUrl.href);
  url.username = '';
  url.password = '';
  return url.toString();
}

export class ComfyProcessManager {
  private readonly baseUrl: URL;
  private readonly rootDirectory: string;
  private readonly pythonPath: string;
  private readonly launchScript: string;
  private readonly logPath: string;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly client: Pick<ComfyClient, 'health'>;
  private startPromise: Promise<ComfySystemStats> | null = null;
  private closed = false;

  constructor(
    options: ComfyProcessManagerOptions,
    client: Pick<ComfyClient, 'health'>,
  ) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new Error('ComfyUI base URL must be a valid HTTP or HTTPS URL');
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error('ComfyUI base URL must be a valid HTTP or HTTPS URL');
    }
    if (typeof options.logPath !== 'string' || options.logPath.trim().length === 0) {
      throw new Error('ComfyUI log path must be non-empty');
    }
    this.baseUrl = baseUrl;
    this.rootDirectory = options.rootDirectory ?? DEFAULT_COMFY_ROOT;
    this.pythonPath =
      options.pythonPath ?? join(this.rootDirectory, 'python_embeded', 'python.exe');
    this.launchScript =
      options.launchScript ?? join(this.rootDirectory, 'tools', 'launch.py');
    this.logPath = options.logPath;
    this.startupTimeoutMs = validateTimeout(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      'startupTimeoutMs',
    );
    this.pollIntervalMs = validateTimeout(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    );
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.client = client;
  }

  async ensureReady(): Promise<ComfySystemStats> {
    if (this.closed) {
      throw new Error('ComfyProcessManager is closed');
    }
    try {
      return await this.client.health();
    } catch {
      // Fall through and start the local process when possible.
    }
    if (this.closed) {
      throw new Error('ComfyProcessManager is closed');
    }
    if (!LOCAL_HOSTNAMES.has(this.baseUrl.hostname)) {
      throw new Error(
        `ComfyUI at ${displayUrl(this.baseUrl)} is not reachable and does not ` +
          'point at a local host, so no local ComfyUI process was started',
      );
    }

    let pending = this.startPromise;
    if (pending === null) {
      pending = this.startAndWait();
      this.startPromise = pending;
    }
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) {
        this.startPromise = null;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async startAndWait(): Promise<ComfySystemStats> {
    const port =
      this.baseUrl.port.length > 0
        ? this.baseUrl.port
        : this.baseUrl.protocol === 'https:'
          ? '443'
          : '80';
    const logHandle = await open(this.logPath, 'a');
    let child: ChildProcess;
    try {
      child = this.spawnProcess(
        this.pythonPath,
        ['-I', '-X', 'utf8', this.launchScript, '--lowvram', '--port', port],
        {
          cwd: this.rootDirectory,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logHandle.fd, logHandle.fd],
        },
      );
    } catch (error) {
      await logHandle.close();
      throw error instanceof Error
        ? error
        : new Error('Failed to start the ComfyUI process');
    }
    child.unref();
    try {
      return await this.waitUntilHealthy(child);
    } finally {
      await logHandle.close();
    }
  }

  private async waitUntilHealthy(child: ChildProcess): Promise<ComfySystemStats> {
    const state: {
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      spawnFailure: Error | null;
    } = { exitCode: null, exitSignal: null, spawnFailure: null };
    child.once('exit', (code, signal) => {
      state.exitCode = code;
      state.exitSignal = signal;
    });
    child.once('error', (error) => {
      state.spawnFailure = error;
    });

    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      if (this.closed) {
        throw new Error('ComfyProcessManager is closed');
      }
      if (state.spawnFailure !== null) {
        throw await this.startupError(
          `ComfyUI process failed: ${state.spawnFailure.message}`,
        );
      }
      if (
        state.exitCode !== null ||
        state.exitSignal !== null ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        const detail =
          state.exitSignal !== null || child.signalCode !== null
            ? `signal ${state.exitSignal ?? child.signalCode}`
            : `code ${state.exitCode ?? child.exitCode}`;
        throw await this.startupError(`ComfyUI process exited early (${detail})`);
      }
      try {
        return await this.client.health();
      } catch {
        // ComfyUI is not up yet; keep polling.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw await this.startupError(
          `ComfyUI startup timed out after ${this.startupTimeoutMs} ms`,
        );
      }
      await delay(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async startupError(prefix: string): Promise<Error> {
    let tail = '';
    try {
      const content = await readFile(this.logPath, 'utf8');
      tail = content.slice(-LOG_TAIL_LENGTH);
    } catch {
      // The log tail is best-effort context for the error message.
    }
    const trimmed = tail.trim();
    return new Error(
      trimmed.length > 0
        ? `${prefix}. Last log output:\n${trimmed}`
        : prefix,
    );
  }
}
