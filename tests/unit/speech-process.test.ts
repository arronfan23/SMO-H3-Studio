// @vitest-environment node

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  SpeechProcessManager,
  type SpeechProcessManagerOptions,
} from '../../src/main/speech-process';

class FakePythonProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  killed = false;

  readonly kill = vi.fn(() => {
    if (this.exitCode !== null) return false;
    this.killed = true;
    queueMicrotask(() => this.emitExit(null));
    return true;
  });

  emitExit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

type FetchHandler = (
  url: URL,
  init?: RequestInit,
) => Response | Promise<Response>;

const WAV = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4]);

function hangingCancelResponse(status: number, text: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    }),
    { status },
  );
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation did not settle within ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('SpeechProcessManager', () => {
  const managers: SpeechProcessManager[] = [];

  afterEach(async () => {
    await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  });

  function createSpeech(
    options: {
      startupLine?: string;
      fetchHandler?: FetchHandler;
      overrides?: Partial<SpeechProcessManagerOptions>;
      onSpawn?: (child: FakePythonProcess) => void;
      startupError?: Error;
    } = {},
  ) {
    const child = new FakePythonProcess();
    const startupLine =
      options.startupLine ?? 'SMO_SPEECH_URL=http://127.0.0.1:43127';
    const spawn = vi.fn(() => {
      options.onSpawn?.(child);
      if (options.startupError) {
        queueMicrotask(() => child.emit('error', options.startupError));
      } else {
        queueMicrotask(() => child.stdout.write(`${startupLine}\n`));
      }
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const defaultHandler: FetchHandler = (url) => {
      if (url.pathname === '/health') return Response.json({ ok: true });
      if (url.pathname === '/capabilities') {
        return Response.json({
          speakers: ['Vivian'],
          languages: ['Auto', 'Chinese'],
        });
      }
      if (url.pathname === '/generate') {
        return new Response(WAV, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        });
      }
      if (url.pathname === '/shutdown') {
        queueMicrotask(() => child.emitExit(0));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    };
    const fetchImpl = vi.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      requests.push({ url, init });
      return (options.fetchHandler ?? defaultHandler)(url, init);
    });
    const manager = new SpeechProcessManager({
      pythonPath: 'G:\\speech runtime\\python.exe',
      serviceScript: 'G:\\app\\resources\\speech\\index_tts_service.py',
      modelDirectory: 'G:\\data\\components\\speech\\models',
      startupTimeoutMs: 200,
      healthTimeoutMs: 60,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 30,
      spawnImpl: spawn,
      fetchImpl,
      ...options.overrides,
    });
    managers.push(manager);
    return { manager, child, spawn, fetchImpl, requests };
  }

  test('starts Python without a shell and reads the actual loopback port from stdout', async () => {
    const { manager, spawn, requests } = createSpeech();

    await manager.start();

    expect(spawn).toHaveBeenCalledWith(
      'G:\\speech runtime\\python.exe',
      [
        '-I',
        '-X',
        'utf8',
        'G:\\app\\resources\\speech\\index_tts_service.py',
        '--model-root',
        'G:\\data\\components\\speech\\models',
      ],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        cwd: 'G:\\data\\components\\speech\\models',
      }),
    );
    expect(requests[0]?.url.href).toBe('http://127.0.0.1:43127/health');
  });

  test.each([
    'SMO_SPEECH_URL=http://192.168.1.20:43127',
    'SMO_SPEECH_URL=http://127.0.0.1.evil.test:43127',
    'SMO_SPEECH_URL=https://127.0.0.1:43127',
  ])('rejects a non-loopback or non-HTTP startup URL: %s', async (startupLine) => {
    const { manager, child, fetchImpl } = createSpeech({ startupLine });

    await expect(manager.start()).rejects.toThrow(/loopback|http/i);

    expect(child.kill).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('closes the child when the health check times out', async () => {
    const { manager, child, requests } = createSpeech({
      fetchHandler: (url) => {
        if (url.pathname === '/health') {
          return Response.json({ ok: false }, { status: 503 });
        }
        return new Response(null, { status: 503 });
      },
      overrides: { healthTimeoutMs: 35 },
    });

    await expect(manager.start()).rejects.toThrow(/health.*timed out|timed out.*health/i);

    expect(child.kill).toHaveBeenCalled();
    expect(requests.some(({ url }) => url.pathname === '/shutdown')).toBe(true);
  });

  test('health deadline does not wait for a response body cancellation that never settles', async () => {
    const { manager, child } = createSpeech({
      fetchHandler: (url) => {
        if (url.pathname === '/health') {
          return hangingCancelResponse(503, 'unhealthy');
        }
        return new Response(null, { status: 503 });
      },
      overrides: { healthTimeoutMs: 40, shutdownTimeoutMs: 10 },
    });

    const started = Date.now();
    await expect(settleWithin(manager.start(), 250)).rejects.toThrow(
      /health.*timed out|timed out.*health/i,
    );

    expect(Date.now() - started).toBeLessThan(250);
    expect(child.kill).toHaveBeenCalled();
  });

  test('sends IndexTTS2 reference and emotion fields without a Qwen speaker', async () => {
    const { manager, requests } = createSpeech();

    await expect(
      manager.generate({
        voiceMode: 'custom',
        text: '固定音色测试',
        language: 'Chinese',
        speaker: 'Vivian',
        instruct: '温柔地说',
        referenceAudioPath: 'G:\\authorized.wav',
        speechRate: 1.5,
      }),
    ).resolves.toEqual(WAV);

    const request = requests.find(({ url }) => url.pathname === '/generate');
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      voice_mode: 'custom',
      text: '固定音色测试',
      language: 'Chinese',
      ref_audio: 'G:\\authorized.wav',
      instruct: '温柔地说',
      speech_rate: 1.5,
    });
  });

  test('drains large stderr output so health and generate can complete', async () => {
    let childRef!: FakePythonProcess;
    const afterStderrDrains = async (response: Response, init?: RequestInit) => {
      while (childRef.stderr.readableLength > 0) {
        if (init?.signal?.aborted) throw new Error('stderr pipe is blocked');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return response;
    };
    const { manager, child } = createSpeech({
      onSpawn: (child) => {
        childRef = child;
        const chunk = Buffer.alloc(64 * 1024, 120);
        for (let index = 0; index < 32; index += 1) child.stderr.write(chunk);
      },
      fetchHandler: (url, init) => {
        if (url.pathname === '/health') {
          return afterStderrDrains(Response.json({ ok: true }), init);
        }
        if (url.pathname === '/generate') {
          return afterStderrDrains(
            new Response(WAV, {
              status: 200,
              headers: { 'Content-Type': 'audio/wav' },
            }),
            init,
          );
        }
        if (url.pathname === '/shutdown') {
          queueMicrotask(() => childRef.emitExit(0));
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });

    await settleWithin(manager.start(), 250);
    await expect(
      settleWithin(
        manager.generate({
          voiceMode: 'custom',
          text: 'stderr 不应阻塞生成',
          language: 'Chinese',
          speaker: 'Vivian',
        }),
        250,
      ),
    ).resolves.toEqual(WAV);

    expect(child.stderr.readableLength).toBe(0);
  });

  test('sends clone fields with an authorized reference path', async () => {
    const { manager, requests } = createSpeech();

    await expect(
      manager.generate({
        voiceMode: 'clone',
        text: '测试',
        language: 'Auto',
        referenceAudioPath: 'G:\\authorized.wav',
        referenceText: '参考原文',
        speechRate: 0.75,
      }),
    ).resolves.toEqual(expect.any(Uint8Array));

    const request = requests.find(({ url }) => url.pathname === '/generate');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      voice_mode: 'clone',
      text: '测试',
      language: 'Auto',
      ref_audio: 'G:\\authorized.wav',
      speech_rate: 0.75,
    });
  });

  test('does not send Qwen-only clone fields when reference text is blank', async () => {
    const { manager, requests } = createSpeech();

    await manager.generate({
      voiceMode: 'clone',
      text: '没有参考文本',
      language: 'Auto',
      referenceAudioPath: 'G:\\authorized.wav',
      referenceText: '  ',
    });

    const request = requests.find(({ url }) => url.pathname === '/generate');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      voice_mode: 'clone',
      text: '没有参考文本',
      language: 'Auto',
      ref_audio: 'G:\\authorized.wav',
      speech_rate: 1,
    });
  });

  test('queries capabilities for the requested model without loading both models', async () => {
    const { manager, requests } = createSpeech();

    await expect(manager.capabilities('custom')).resolves.toEqual({
      speakers: ['Vivian'],
      languages: ['Auto', 'Chinese'],
    });

    const request = requests.find(({ url }) => url.pathname === '/capabilities');
    expect(request?.url.searchParams.get('voiceMode')).toBe('custom');
    expect(request?.init?.method ?? 'GET').toBe('GET');
  });

  test('does not expose narration or reference text in non-200 errors', async () => {
    const narration = '不能泄露的口播内容';
    const reference = '不能泄露的参考原文';
    const { manager } = createSpeech({
      fetchHandler: (url) => {
        if (url.pathname === '/health') return Response.json({ ok: true });
        return Response.json(
          { error: `model rejected ${narration} and ${reference}` },
          { status: 422 },
        );
      },
    });

    let message = '';
    try {
      await manager.generate({
        voiceMode: 'clone',
        text: narration,
        language: 'Auto',
        referenceAudioPath: 'G:\\authorized.wav',
        referenceText: reference,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/422|failed/i);
    expect(message).not.toContain(narration);
    expect(message).not.toContain(reference);
  });

  test('generate non-200 returns a sanitized error without waiting for body cancellation', async () => {
    const narration = '取消操作时不能泄露的口播';
    const reference = '取消操作时不能泄露的参考原文';
    const { manager } = createSpeech({
      fetchHandler: (url) => {
        if (url.pathname === '/health') return Response.json({ ok: true });
        if (url.pathname === '/generate') {
          return hangingCancelResponse(
            422,
            `model rejected ${narration} and ${reference}`,
          );
        }
        return new Response(null, { status: 503 });
      },
      overrides: { shutdownTimeoutMs: 10 },
    });

    let message = '';
    const started = Date.now();
    try {
      await settleWithin(
        manager.generate({
          voiceMode: 'clone',
          text: narration,
          language: 'Auto',
          referenceAudioPath: 'G:\\authorized.wav',
          referenceText: reference,
        }),
        250,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(Date.now() - started).toBeLessThan(250);
    expect(message).toMatch(/422|failed/i);
    expect(message).not.toContain(narration);
    expect(message).not.toContain(reference);
  });

  test('returns a model-switch failure instead of reusing the previous model', async () => {
    const { manager, requests } = createSpeech({
      fetchHandler: (url, init) => {
        if (url.pathname === '/health') return Response.json({ ok: true });
        if (url.pathname === '/generate') {
          const body = JSON.parse(String(init?.body)) as { voice_mode?: string };
          if (body.voice_mode === 'clone') {
            return Response.json({ error: 'clone load failed' }, { status: 500 });
          }
        }
        return new Response(WAV, {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        });
      },
    });

    await manager.generate({
      voiceMode: 'custom',
      text: 'first',
      language: 'Auto',
      speaker: 'Vivian',
    });

    await expect(
      manager.generate({
        voiceMode: 'clone',
        text: 'second',
        language: 'Auto',
        referenceAudioPath: 'G:\\authorized.wav',
        referenceText: '',
      }),
    ).rejects.toThrow(/500|failed/i);

    const secondRequest = requests.filter(({ url }) => url.pathname === '/generate')[1];
    expect(JSON.parse(String(secondRequest?.init?.body))).toMatchObject({
      voice_mode: 'clone',
    });
  });

  test('concurrent and repeated close calls share one shutdown', async () => {
    const { manager, requests, child } = createSpeech();
    await manager.start();

    await Promise.all([manager.close(), manager.close(), manager.close()]);
    await manager.close();

    expect(requests.filter(({ url }) => url.pathname === '/shutdown')).toHaveLength(1);
    expect(child.exitCode).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect((manager as unknown as { exited: boolean }).exited).toBe(true);
  });

  test('close retries termination after a timeout and succeeds on the second kill', async () => {
    const { manager, child } = createSpeech({
      fetchHandler: (url) => {
        if (url.pathname === '/health') return Response.json({ ok: true });
        return new Response(null, { status: 503 });
      },
      overrides: { shutdownTimeoutMs: 10 },
    });
    await manager.start();
    child.kill
      .mockImplementationOnce(() => {
        child.killed = true;
        return true;
      })
      .mockImplementationOnce(() => {
        child.killed = true;
        child.emitExit(0);
        return true;
      });

    const started = Date.now();
    await expect(settleWithin(manager.close(), 250)).rejects.toThrow(
      /did not exit|termination.*timed out|shutdown.*timed out/i,
    );

    expect(Date.now() - started).toBeLessThan(250);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(manager.close()).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.exitCode).toBe(0);
    await manager.close();
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  test('startup error permits cleanup and later close remains idempotent', async () => {
    const { manager, child } = createSpeech({
      startupError: new Error('injected startup error'),
      overrides: { shutdownTimeoutMs: 10 },
    });
    const state = manager as unknown as { exited: boolean };

    await expect(settleWithin(manager.start(), 250)).rejects.toThrow(
      /startup|failed to start/i,
    );

    expect(state.exited).toBe(true);
    await expect(manager.close()).resolves.toBeUndefined();
    expect(state.exited).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test('kill error can be retried and a real exit makes later close idempotent', async () => {
    const { manager, child } = createSpeech({
      fetchHandler: (url) => {
        if (url.pathname === '/health') return Response.json({ ok: true });
        return new Response(null, { status: 503 });
      },
      overrides: { shutdownTimeoutMs: 10 },
    });
    await manager.start();
    child.kill.mockImplementation(() => {
      child.killed = true;
      child.emit('error', new Error('injected kill error'));
      return true;
    });
    const state = manager as unknown as { exited: boolean };

    await expect(settleWithin(manager.close(), 250)).rejects.toThrow(
      /process.*error|failed|kill/i,
    );

    expect(state.exited).toBe(false);
    expect(child.exitCode).toBeNull();

    child.emitExit(0);
    expect(state.exited).toBe(true);
    await expect(manager.close()).resolves.toBeUndefined();
    await manager.close();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
