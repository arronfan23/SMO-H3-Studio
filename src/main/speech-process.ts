import { spawn } from 'node:child_process';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from 'node:child_process';

const STARTUP_PREFIX = 'SMO_SPEECH_URL=';
const MAXIMUM_STARTUP_OUTPUT = 64 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

export type SpeechVoiceMode = 'custom' | 'clone';
export type SpeechFetch = typeof globalThis.fetch;
export type SpeechSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface SpeechGenerateRequest {
  voiceMode: SpeechVoiceMode;
  text: string;
  language: string;
  speaker?: string;
  instruct?: string;
  referenceAudioPath?: string;
  referenceText?: string;
}

export interface SpeechCapabilities {
  speakers: string[];
  languages: string[];
}

export interface SpeechProcessManagerOptions {
  pythonPath: string;
  serviceScript: string;
  modelDirectory: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  spawnImpl?: SpeechSpawn;
  fetchImpl?: SpeechFetch;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error('Speech process timeouts must be finite positive numbers');
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    ...options,
    stdio: 'pipe',
  }) as ChildProcessWithoutNullStreams;
}

function parseLoopbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Speech service reported an invalid URL');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTNAMES.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Speech service URL must use HTTP on a loopback actual port');
  }
  return new URL(url.origin);
}

export class SpeechProcessManager {
  private readonly startupTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly spawnImpl: SpeechSpawn;
  private readonly fetchImpl: SpeechFetch;
  private child: ChildProcessWithoutNullStreams | null = null;
  private baseUrl: URL | null = null;
  private exited = false;
  private processError: Error | null = null;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: SpeechProcessManagerOptions) {
    this.startupTimeoutMs = positiveTimeout(options.startupTimeoutMs, 30_000);
    this.healthTimeoutMs = positiveTimeout(options.healthTimeoutMs, 30_000);
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 600_000);
    this.shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs, 5_000);
    this.pollIntervalMs = positiveTimeout(options.pollIntervalMs, 100);
    this.spawnImpl = options.spawnImpl ?? defaultSpawn;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('SpeechProcessManager is closed');
    if (this.baseUrl !== null && !this.exited) return;
    if (this.startPromise === null) {
      const pending = this.startAndWait();
      this.startPromise = pending;
      try {
        await pending;
      } finally {
        if (this.startPromise === pending) this.startPromise = null;
      }
      return;
    }
    return this.startPromise;
  }

  async health(): Promise<{ ok: true }> {
    await this.start();
    const response = await this.fetchImpl(this.endpoint('/health'), {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Speech health failed with HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('ok' in value) ||
      value.ok !== true
    ) {
      throw new Error('Speech health returned an invalid response');
    }
    return { ok: true };
  }

  async capabilities(voiceMode: SpeechVoiceMode): Promise<SpeechCapabilities> {
    await this.start();
    const url = this.endpoint('/capabilities');
    url.searchParams.set('voiceMode', voiceMode);
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Speech capabilities failed with HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      !('speakers' in value) ||
      !('languages' in value) ||
      !this.isStringArray(value.speakers) ||
      !this.isStringArray(value.languages)
    ) {
      throw new Error('Speech capabilities returned an invalid response');
    }
    return { speakers: value.speakers, languages: value.languages };
  }

  async generate(request: SpeechGenerateRequest): Promise<Uint8Array> {
    await this.start();
    const body = this.generationBody(request);
    const response = await this.fetchImpl(this.endpoint('/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // The status is authoritative; an error body may contain request text.
      }
      throw new Error(`Speech generation failed with HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async startAndWait(): Promise<void> {
    try {
      this.exited = false;
      this.processError = null;
      const child = this.spawnImpl(
        this.options.pythonPath,
        [
          '-I',
          '-X',
          'utf8',
          this.options.serviceScript,
          '--model-root',
          this.options.modelDirectory,
        ],
        {
          env: {
            ...process.env,
            ...this.options.environment,
            PYTHONUNBUFFERED: '1',
            PYTHONUTF8: '1',
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            HF_HUB_DISABLE_TELEMETRY: '1',
          },
          windowsHide: true,
          shell: false,
          stdio: 'pipe',
        },
      );
      this.child = child;
      // Drain diagnostics without retaining or logging potentially sensitive text.
      child.stderr.on('data', () => undefined);
      child.once('exit', () => {
        this.exited = true;
      });
      child.once('error', (error) => {
        this.processError = error instanceof Error ? error : new Error(String(error));
      });
      this.baseUrl = await this.readStartupUrl(child);
      await this.waitUntilHealthy();
    } catch (error) {
      try {
        await this.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'Speech service startup failed and process cleanup failed',
        );
      }
      throw error;
    }
  }

  private readStartupUrl(child: ChildProcessWithoutNullStreams): Promise<URL> {
    return new Promise<URL>((resolve, reject) => {
      let output = '';
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error('Speech service startup timed out waiting for its port'));
      }, this.startupTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stdout.off('end', onEnd);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const finish = (error?: Error, url?: URL) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else if (url) resolve(url);
        else reject(new Error('Speech service startup ended without a URL'));
      };
      const onData = (chunk: Buffer | string) => {
        output += chunk.toString();
        if (output.length > MAXIMUM_STARTUP_OUTPUT) {
          finish(new Error('Speech service startup output exceeded its limit'));
          return;
        }
        const lines = output.split(/\r?\n/);
        output = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith(STARTUP_PREFIX)) continue;
          try {
            finish(undefined, parseLoopbackUrl(line.slice(STARTUP_PREFIX.length).trim()));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
      };
      const onEnd = () => finish(new Error('Speech service stdout ended before startup'));
      const onExit = (code: number | null) => {
        finish(new Error(`Speech service exited before startup (code ${code ?? 'unknown'})`));
      };
      const onError = () => finish(new Error('Speech service process failed to start'));

      child.stdout.on('data', onData);
      child.stdout.once('end', onEnd);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    for (;;) {
      if (this.closed) throw new Error('SpeechProcessManager is closed');
      if (this.exited) throw new Error('Speech service exited during its health check');
      try {
        const response = await this.fetchImpl(this.endpoint('/health'), {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (response.ok) {
          const value: unknown = await response.json();
          if (
            typeof value === 'object' &&
            value !== null &&
            'ok' in value &&
            value.ok === true
          ) {
            return;
          }
        } else {
          try {
            void response.body?.cancel().catch(() => undefined);
          } catch {
            // Continue polling until the bounded health deadline.
          }
        }
      } catch {
        // The process may still be initializing its HTTP listener.
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Speech service health check timed out');
      }
      await delay(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private generationBody(request: SpeechGenerateRequest): Record<string, unknown> {
    if (request.voiceMode === 'custom') {
      return {
        voice_mode: 'custom',
        text: request.text,
        language: request.language,
        speaker: request.speaker,
        instruct: request.instruct ?? '',
      };
    }
    if (request.voiceMode === 'clone') {
      const referenceText = request.referenceText ?? '';
      return {
        voice_mode: 'clone',
        text: request.text,
        language: request.language,
        ref_audio: request.referenceAudioPath,
        ref_text: referenceText,
        x_vector_only_mode: referenceText.trim().length === 0,
      };
    }
    throw new Error('Unsupported speech voice mode');
  }

  private endpoint(pathname: string): URL {
    if (this.baseUrl === null) throw new Error('Speech service has no listening URL');
    return new URL(pathname, this.baseUrl);
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child === null) return;
    if (this.baseUrl !== null && !this.exited) {
      try {
        await this.fetchImpl(this.endpoint('/shutdown'), {
          method: 'POST',
          signal: AbortSignal.timeout(this.shutdownTimeoutMs),
        });
      } catch {
        // Fall through to process termination.
      }
    }
    if (await this.waitForExit()) return;
    if (!this.exited) child.kill();
    if (await this.waitForExit()) return;
    throw new Error(
      `Speech service did not exit within ${this.shutdownTimeoutMs} ms after termination`,
    );
  }

  private async waitForExit(): Promise<boolean> {
    if (this.exited || this.child === null) return true;
    if (this.processError !== null) {
      throw new Error('Speech service process error while waiting for exit', {
        cause: this.processError,
      });
    }
    const child = this.child;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.exited);
      }, this.shutdownTimeoutMs);
      const onExit = () => {
        cleanup();
        resolve(true);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(
          new Error('Speech service process error while waiting for exit', {
            cause: error,
          }),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }
}
