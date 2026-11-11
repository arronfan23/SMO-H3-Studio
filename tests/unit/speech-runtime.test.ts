// @vitest-environment node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import defaultManifest from '../../resources/environment/media-components.json';
import {
  defaultSpeechExecFile,
  SpeechRuntime,
  type SpeechExecFile,
} from '../../src/main/speech-runtime';
import type { MediaComponentManifest } from '../../src/shared/media-components';

const UV_SOURCE = 'astral-sh/uv';
const UV_VERSION = '0.11.13';
const UV_REVISION = '4512a39319dbd9ad96e0b0a22223eb263dbf5d16';
const UV_PATH = `runtime/uv-${UV_VERSION}-x86_64-pc-windows-msvc.zip`;

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('SpeechRuntime', () => {
  let directory: string;
  let modelDirectory: string;
  let runtimeDirectory: string;
  let projectDirectory: string;
  let archive: Buffer;
  let manifest: MediaComponentManifest;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-speech-runtime-'));
    modelDirectory = join(directory, 'models');
    runtimeDirectory = join(directory, 'speech runtime & isolated');
    projectDirectory = join(directory, 'speech project');
    archive = Buffer.from('fake uv zip fixture');
    const archivePath = join(modelDirectory, ...UV_PATH.split('/'));
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, archive);
    await mkdir(projectDirectory, { recursive: true });
    manifest = {
      version: 1,
      components: {
        speech: {
          id: 'speech',
          revisions: { [UV_SOURCE]: UV_REVISION },
          files: [
            {
              url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
              path: UV_PATH,
              size: archive.length,
              sha256: sha256(archive),
              source: UV_SOURCE,
            },
          ],
          totalBytes: archive.length,
        },
      },
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  function createRuntime(
    harness: {
      invalidInitialVersion?: 'mismatch' | 'error';
      execFileImpl?: SpeechExecFile;
      pythonInstallDirectory?: string;
    } = {},
  ) {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    let versionChecks = 0;
    const execFile: SpeechExecFile = vi.fn(async (command, args, options) => {
      calls.push({ command, args, options: { ...options } });
      if (harness.execFileImpl) {
        return harness.execFileImpl(command, args, options);
      }
      if (command === 'tar') {
        const outputDirectory = args[args.indexOf('-C') + 1];
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, 'uv.exe'), 'uv fixture');
      }
      if (command.endsWith('uv.exe') && args.length === 1 && args[0] === '--version') {
        versionChecks += 1;
        if (versionChecks === 1 && harness.invalidInitialVersion === 'error') {
          throw new Error('injected broken uv executable');
        }
        if (versionChecks === 1 && harness.invalidInitialVersion === 'mismatch') {
          return { stdout: 'uv 0.0.1 (broken)', stderr: '' };
        }
        return {
          stdout: `uv ${UV_VERSION} (${UV_REVISION.slice(0, 9)} x86_64-pc-windows-msvc)`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const runtime = new SpeechRuntime({
      modelDirectory,
      runtimeDirectory,
      projectDirectory,
      manifest,
      execFile,
      pythonInstallDirectory: harness.pythonInstallDirectory,
    });
    return { runtime, execFile, calls, versionChecks: () => versionChecks };
  }

  test('verifies uv and runs Python 3.12, venv, and locked sync without a shell', async () => {
    const { runtime, calls } = createRuntime();

    const result = await runtime.prepare();

    const venvDirectory = join(runtimeDirectory, 'venv');
    const uvCalls = calls.filter(({ command }) => command.endsWith('uv.exe'));
    expect(uvCalls).toHaveLength(4);
    expect(uvCalls[0]?.args).toEqual(['--version']);
    expect(uvCalls[1]?.args).toEqual(['python', 'install', '3.12']);
    expect(uvCalls[2]?.args).toEqual([
      'venv',
      '--python',
      '3.12',
      venvDirectory,
    ]);
    expect(uvCalls[3]?.args).toEqual([
      'sync',
      '--locked',
      '--project',
      projectDirectory,
    ]);
    for (const call of calls) {
      expect(call.options).toMatchObject({
        shell: false,
        windowsHide: true,
        signal: expect.any(AbortSignal),
      });
    }
    expect(uvCalls[3]?.options.env).toMatchObject({
      UV_PROJECT_ENVIRONMENT: venvDirectory,
    });
    expect(result).toEqual({
      pythonPath: join(venvDirectory, 'Scripts', 'python.exe'),
      environment: expect.objectContaining({
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        UV_PROJECT_ENVIRONMENT: venvDirectory,
      }),
    });
    expect(result.environment.PYTHONHOME).toBeUndefined();
  });

  test('NTFS Python defaults to LOCALAPPDATA without moving component paths', async () => {
    const localAppData = join(directory, 'NTFS LocalAppData');
    vi.stubEnv('LOCALAPPDATA', localAppData);
    const { runtime, calls } = createRuntime();

    const result = await runtime.prepare();

    const venvDirectory = join(runtimeDirectory, 'venv');
    for (const call of calls.filter(({ command }) => command.endsWith('uv.exe'))) {
      expect(call.options.env).toMatchObject({
        UV_PYTHON_INSTALL_DIR: join(localAppData, 'SMO-H3-Runtime', 'python'),
        UV_PROJECT_ENVIRONMENT: venvDirectory,
        UV_CACHE_DIR: join(runtimeDirectory, 'uv-cache'),
      });
    }
    expect(result.pythonPath).toBe(join(venvDirectory, 'Scripts', 'python.exe'));
    expect(calls.find(({ command }) => command === 'tar')?.args).toContain(
      join(modelDirectory, ...UV_PATH.split('/')),
    );
  });

  test('NTFS Python install directory supports an explicit override', async () => {
    const pythonInstallDirectory = join(directory, 'explicit NTFS Python');
    vi.stubEnv('LOCALAPPDATA', join(directory, 'ignored LocalAppData'));
    const { runtime, calls } = createRuntime({ pythonInstallDirectory });

    await runtime.prepare();

    const installCall = calls.find(({ args }) => args[0] === 'python');
    expect(installCall?.options.env).toMatchObject({
      UV_PYTHON_INSTALL_DIR: pythonInstallDirectory,
      UV_PROJECT_ENVIRONMENT: join(runtimeDirectory, 'venv'),
      UV_CACHE_DIR: join(runtimeDirectory, 'uv-cache'),
    });
  });

  test.each(['', 'relative-local-app-data'])(
    'NTFS Python falls back to the component directory when LOCALAPPDATA is %s',
    async (localAppData) => {
      vi.stubEnv('LOCALAPPDATA', localAppData);
      const { runtime, calls } = createRuntime();

      await runtime.prepare();

      const installCall = calls.find(({ args }) => args[0] === 'python');
      expect(installCall?.options.env).toMatchObject({
        UV_PYTHON_INSTALL_DIR: join(runtimeDirectory, 'python'),
      });
    },
  );

  test('extracts uv without restoring timestamps for exFAT compatibility', async () => {
    const { runtime, calls } = createRuntime();

    await runtime.prepare();

    const tarCall = calls.find(({ command }) => command === 'tar');
    expect(tarCall?.args.slice(0, 2)).toEqual(['-m', '-xf']);
  });

  test('activates the extracted uv before executing its version check', async () => {
    const { runtime, calls } = createRuntime();

    await runtime.prepare();

    const versionCall = calls.find(
      ({ command, args }) => command.endsWith('uv.exe') && args[0] === '--version',
    );
    expect(versionCall?.command).toBe(
      join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`, 'uv.exe'),
    );
  });

  test('rejects a modified uv archive before executing any command', async () => {
    await writeFile(join(modelDirectory, ...UV_PATH.split('/')), 'tampered');
    const { runtime, execFile } = createRuntime();

    await expect(runtime.prepare()).rejects.toThrow(/sha256|size|hash/i);

    expect(execFile).not.toHaveBeenCalled();
  });

  test.each(['mismatch', 'error'] as const)(
    're-extracts and repairs an existing uv after a version %s',
    async (invalidInitialVersion) => {
      const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
      const uvPath = join(toolDirectory, 'uv.exe');
      await mkdir(toolDirectory, { recursive: true });
      await writeFile(uvPath, 'broken uv fixture');
      const { runtime, calls, versionChecks } = createRuntime({
        invalidInitialVersion,
      });

      await runtime.prepare();

      expect(versionChecks()).toBe(2);
      expect(calls.filter(({ command }) => command === 'tar')).toHaveLength(1);
      expect(await readFile(uvPath, 'utf8')).toBe('uv fixture');
      const uvCalls = calls.filter(({ command }) => command.endsWith('uv.exe'));
      expect(uvCalls[0]?.args).toEqual(['--version']);
      expect(uvCalls[1]?.args).toEqual(['--version']);
      expect(uvCalls[2]?.args).toEqual(['python', 'install', '3.12']);
    },
  );

  test('pins the official Windows x64 uv release commit, version, and SHA256', () => {
    const speech = defaultManifest.components.speech;
    const uv = speech?.files.find((file) => file.source === UV_SOURCE);

    expect(speech?.revisions[UV_SOURCE]).toBe(UV_REVISION);
    expect(uv).toMatchObject({
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
      path: UV_PATH,
      size: 23_354_520,
      sha256: '0953ac2ef4fbe47ad469bfa80b658a577a02c4d73a2fb9c4c7c70dda432efded',
      source: UV_SOURCE,
    });
  });

  test('aborts uv sync, stops the failed attempt, and permits a fresh prepare', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const syncStarted = deferred<void>();
    const controller = new AbortController();
    const cancellation = new Error('generation cancelled during uv sync');
    let syncAttempts = 0;
    let firstSyncSignal: AbortSignal | undefined;
    const { runtime, calls } = createRuntime({
      execFileImpl: async (_command, args, options) => {
        if (args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        if (args[0] !== 'sync') return { stdout: '', stderr: '' };
        syncAttempts += 1;
        if (syncAttempts > 1) return { stdout: '', stderr: '' };
        firstSyncSignal = options.signal;
        return new Promise((_resolve, reject) => {
          const rejectCancellation = () => reject(options.signal?.reason);
          if (options.signal?.aborted) {
            rejectCancellation();
            return;
          }
          options.signal?.addEventListener('abort', rejectCancellation, {
            once: true,
          });
          syncStarted.resolve();
        });
      },
    });

    const firstPrepare = runtime.prepare(controller.signal);
    await syncStarted.promise;
    controller.abort(cancellation);

    await expect(firstPrepare).rejects.toBe(cancellation);
    expect(firstSyncSignal?.aborted).toBe(true);
    expect(syncAttempts).toBe(1);

    await expect(runtime.prepare()).resolves.toMatchObject({
      pythonPath: join(runtimeDirectory, 'venv', 'Scripts', 'python.exe'),
    });
    expect(syncAttempts).toBe(2);
    expect(calls.filter(({ args }) => args[0] === 'venv')).toHaveLength(2);
  });

  test('close aborts an unattached preparation and waits for command cleanup', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const syncStarted = deferred<void>();
    const abortCleanup = deferred<void>();
    let syncSignal: AbortSignal | undefined;
    const { runtime } = createRuntime({
      execFileImpl: async (_command, args, options) => {
        if (args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        if (args[0] !== 'sync') return { stdout: '', stderr: '' };
        syncSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              void abortCleanup.promise.then(() => reject(options.signal?.reason));
            },
            { once: true },
          );
          syncStarted.resolve();
        });
      },
    });

    const preparing = runtime.prepare();
    const preparingOutcome = preparing.catch((error: unknown) => error);
    await syncStarted.promise;
    const closing = runtime.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });

    await vi.waitFor(() => expect(syncSignal?.aborted).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    abortCleanup.resolve();
    expect(await preparingOutcome).toMatchObject({
      message: expect.stringMatching(/cancel/i),
    });
    await closing;
    expect(closeSettled).toBe(true);
    expect(syncSignal?.aborted).toBe(true);
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  test('close terminates a real execFile child before preparation settles', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const syncStarted = deferred<void>();
    const pidPath = join(directory, 'uv-sync-child.pid');
    const { runtime } = createRuntime({
      execFileImpl: async (_command, args, options) => {
        if (args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        if (args[0] !== 'sync') return { stdout: '', stderr: '' };
        const script =
          "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); " +
          'setInterval(() => undefined, 1000)';
        const pending = defaultSpeechExecFile(
          process.execPath,
          ['-e', script, pidPath],
          options,
        );
        syncStarted.resolve();
        return pending;
      },
    });

    const preparing = runtime.prepare();
    const preparingOutcome = preparing.catch((error: unknown) => error);
    let pid: number | undefined;
    try {
      await syncStarted.promise;
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
      pid = Number(await readFile(pidPath, 'utf8'));
      expect(Number.isInteger(pid)).toBe(true);
      const closing = runtime.close();

      expect(await preparingOutcome).toMatchObject({ name: 'AbortError' });
      await closing;
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 0);
          process.kill(pid);
        } catch {
          // The expected final state is an exited child.
        }
      }
      await preparingOutcome;
    }
  });
});

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
