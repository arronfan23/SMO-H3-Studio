// @vitest-environment node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

interface RuntimeCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

function commandSequence(calls: RuntimeCall[]): string[] {
  return calls.map(({ command, args }) => {
    const executable = command.endsWith('uv.exe')
      ? 'uv'
      : command.endsWith('python.exe')
        ? 'venv-python'
        : command;
    return [executable, ...args].join(' ');
  });
}

async function writeValidVenv(venvDirectory: string): Promise<void> {
  const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
  await mkdir(dirname(pythonPath), { recursive: true });
  await writeFile(pythonPath, 'Python fixture');
  await writeFile(
    join(venvDirectory, 'pyvenv.cfg'),
    'include-system-site-packages = false\n',
  );
}

describe('SpeechRuntime mocked command orchestration', () => {
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
    const calls: RuntimeCall[] = [];
    const venvDirectory = join(runtimeDirectory, 'venv');
    const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
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
      if (command === pythonPath && args.length === 1 && args[0] === '--version') {
        return { stdout: 'Python 3.11.13\r\n', stderr: '' };
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
      if (command.endsWith('uv.exe') && args[0] === 'venv') {
        await writeValidVenv(venvDirectory);
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

  test('verifies uv and runs Python 3.11, venv, and locked sync without a shell', async () => {
    const { runtime, calls } = createRuntime();

    const result = await runtime.prepare();

    const venvDirectory = join(runtimeDirectory, 'venv');
    const uvCalls = calls.filter(({ command }) => command.endsWith('uv.exe'));
    expect(uvCalls).toHaveLength(4);
    expect(uvCalls[0]?.args).toEqual(['--version']);
    expect(uvCalls[1]?.args).toEqual(['python', 'install', '3.11']);
    expect(uvCalls[2]?.args).toEqual([
      'venv',
      '--python',
      '3.11',
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

  test('reuses a valid Python 3.11 venv and continues directly to locked sync', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    const venvDirectory = join(runtimeDirectory, 'venv');
    const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
    const modelPath = join(modelDirectory, 'user-model.safetensors');
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    await mkdir(dirname(pythonPath), { recursive: true });
    await writeFile(pythonPath, 'existing Python fixture');
    await writeFile(
      join(venvDirectory, 'pyvenv.cfg'),
      'include-system-site-packages = false\n',
    );
    await writeFile(modelPath, 'user model contents');
    const { runtime, calls } = createRuntime({
      execFileImpl: async (command, args) => {
        if (command === pythonPath && args.length === 1 && args[0] === '--version') {
          return { stdout: 'Python 3.11.13\r\n', stderr: '' };
        }
        if (command.endsWith('uv.exe') && args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    await expect(runtime.prepare()).resolves.toMatchObject({ pythonPath });

    expect(
      calls.filter(({ command }) => command.endsWith('uv.exe')).map(({ args }) => args),
    ).toEqual([
      ['--version'],
      ['sync', '--locked', '--project', projectDirectory],
    ]);
    expect(
      calls.filter(({ command }) => command === pythonPath).map(({ args }) => args),
    ).toEqual([['--version']]);
    expect(calls.some(({ args }) => args[0] === 'venv')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'python')).toBe(false);
    expect(await readFile(pythonPath, 'utf8')).toBe('existing Python fixture');
    expect(await readFile(modelPath, 'utf8')).toBe('user model contents');
  });

  test.each([
    { scenario: 'a missing interpreter', pythonState: 'missing' },
    { scenario: 'an interpreter startup failure', pythonState: 'error' },
    { scenario: 'a Python version mismatch', pythonState: '3.11' },
    { scenario: 'a missing pyvenv.cfg', pythonState: 'no-config' },
  ])(
    'quarantines a venv with $scenario before recreating it without clearing models',
    async ({ pythonState }) => {
      const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
      const venvDirectory = join(runtimeDirectory, 'venv');
      const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
      const oldEnvironmentPath = join(venvDirectory, 'old-environment.txt');
      const modelPath = join(modelDirectory, 'user-model.safetensors');
      await mkdir(toolDirectory, { recursive: true });
      await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
      await mkdir(venvDirectory, { recursive: true });
      await writeFile(oldEnvironmentPath, 'preserve invalid environment');
      if (pythonState !== 'no-config') {
        await writeFile(
          join(venvDirectory, 'pyvenv.cfg'),
          'include-system-site-packages = false\n',
        );
      }
      if (pythonState !== 'missing') {
        await mkdir(dirname(pythonPath), { recursive: true });
        await writeFile(pythonPath, 'invalid Python fixture');
      }
      await writeFile(modelPath, 'user model contents');
      let venvExistedAtCreation: boolean | undefined;
      let backupsAtCreation: string[] = [];
      const { runtime, calls } = createRuntime({
        execFileImpl: async (command, args) => {
          if (command === pythonPath && args.length === 1 && args[0] === '--version') {
            if (pythonState === 'error') throw new Error('broken Python installation');
            return {
              stdout: pythonState === 'no-config' ? 'Python 3.11.13\r\n' : 'Python 3.12.13\r\n',
              stderr: '',
            };
          }
          if (command.endsWith('uv.exe') && args.length === 1 && args[0] === '--version') {
            return { stdout: `uv ${UV_VERSION}`, stderr: '' };
          }
          if (command.endsWith('uv.exe') && args[0] === 'venv') {
            venvExistedAtCreation = existsSync(venvDirectory);
            backupsAtCreation = (await readdir(runtimeDirectory)).filter((entry) =>
              entry.startsWith('venv.invalid-'),
            );
            await writeValidVenv(venvDirectory);
          }
          return { stdout: '', stderr: '' };
        },
      });

      await expect(runtime.prepare()).resolves.toMatchObject({ pythonPath });

      expect(venvExistedAtCreation).toBe(false);
      expect(backupsAtCreation).toHaveLength(1);
      const backupDirectory = join(runtimeDirectory, backupsAtCreation[0]!);
      expect(await readFile(join(backupDirectory, 'old-environment.txt'), 'utf8')).toBe(
        'preserve invalid environment',
      );
      expect(await readFile(pythonPath, 'utf8')).toBe('Python fixture');
      expect(existsSync(join(venvDirectory, 'pyvenv.cfg'))).toBe(true);
      expect(await readFile(modelPath, 'utf8')).toBe('user model contents');
      expect(calls.some(({ args }) => args.includes('--clear'))).toBe(false);
      expect(calls.filter(({ args }) => args[0] === 'venv')).toHaveLength(1);
      expect(calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(1);
    },
  );

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
      expect(uvCalls[2]?.args).toEqual(['python', 'install', '3.11']);
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

  test('reuses the prepared result for repeated calls without duplicate commands', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    const venvDirectory = join(runtimeDirectory, 'venv');
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const { runtime, calls } = createRuntime();

    const first = await runtime.prepare();
    const second = await runtime.prepare();

    expect(second).toBe(first);
    expect(commandSequence(calls)).toEqual([
      'uv --version',
      'uv python install 3.11',
      `uv venv --python 3.11 ${venvDirectory}`,
      `uv sync --locked --project ${projectDirectory}`,
    ]);
    expect(existsSync(join(venvDirectory, 'pyvenv.cfg'))).toBe(true);
  });

  test('shares an in-flight prepare and runs one command sequence', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    const venvDirectory = join(runtimeDirectory, 'venv');
    const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const syncStarted = deferred<void>();
    const finishSync = deferred<void>();
    const { runtime, calls } = createRuntime({
      execFileImpl: async (command, args) => {
        if (command === pythonPath && args.length === 1 && args[0] === '--version') {
          return { stdout: 'Python 3.11.13\r\n', stderr: '' };
        }
        if (command.endsWith('uv.exe') && args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        if (command.endsWith('uv.exe') && args[0] === 'venv') {
          await writeValidVenv(venvDirectory);
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'sync') {
          syncStarted.resolve();
          await finishSync.promise;
        }
        return { stdout: '', stderr: '' };
      },
    });

    const first = runtime.prepare();
    const second = runtime.prepare();
    expect(second).toBe(first);
    await syncStarted.promise;
    finishSync.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toBe(firstResult);
    expect(commandSequence(calls)).toEqual([
      'uv --version',
      'uv python install 3.11',
      `uv venv --python 3.11 ${venvDirectory}`,
      `uv sync --locked --project ${projectDirectory}`,
    ]);
  });

  test('aborts uv sync and retries only locked sync with the valid venv', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    const venvDirectory = join(runtimeDirectory, 'venv');
    const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const syncStarted = deferred<void>();
    const controller = new AbortController();
    const cancellation = new Error('generation cancelled during uv sync');
    let syncAttempts = 0;
    let firstSyncSignal: AbortSignal | undefined;
    const { runtime, calls } = createRuntime({
      execFileImpl: async (command, args, options) => {
        if (command === pythonPath && args.length === 1 && args[0] === '--version') {
          return { stdout: 'Python 3.11.13\r\n', stderr: '' };
        }
        if (args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        if (command.endsWith('uv.exe') && args[0] === 'venv') {
          await writeValidVenv(venvDirectory);
          return { stdout: '', stderr: '' };
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
      pythonPath,
    });
    expect(syncAttempts).toBe(2);
    expect(commandSequence(calls)).toEqual([
      'uv --version',
      'uv python install 3.11',
      `uv venv --python 3.11 ${venvDirectory}`,
      `uv sync --locked --project ${projectDirectory}`,
      'uv --version',
      'venv-python --version',
      `uv sync --locked --project ${projectDirectory}`,
    ]);
    expect(calls.filter(({ args }) => args[0] === 'venv')).toHaveLength(1);
    expect(calls.filter(({ args }) => args[0] === 'python')).toHaveLength(1);
  });

  test('quarantines a partial venv when creation is interrupted before retrying', async () => {
    const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
    const venvDirectory = join(runtimeDirectory, 'venv');
    const pythonPath = join(venvDirectory, 'Scripts', 'python.exe');
    const partialPath = join(venvDirectory, 'partial-venv.txt');
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(join(toolDirectory, 'uv.exe'), 'uv fixture');
    const venvStarted = deferred<void>();
    const controller = new AbortController();
    const cancellation = new Error('generation cancelled during uv venv');
    let venvAttempts = 0;
    let firstVenvSignal: AbortSignal | undefined;
    let venvExistedAtRetry: boolean | undefined;
    let backupsAtRetry: string[] = [];
    const { runtime, calls } = createRuntime({
      execFileImpl: async (command, args, options) => {
        if (command === pythonPath && args.length === 1 && args[0] === '--version') {
          return { stdout: 'Python 3.11.13\r\n', stderr: '' };
        }
        if (command.endsWith('uv.exe') && args.length === 1 && args[0] === '--version') {
          return { stdout: `uv ${UV_VERSION}`, stderr: '' };
        }
        if (command.endsWith('uv.exe') && args[0] === 'venv') {
          venvAttempts += 1;
          if (venvAttempts > 1) {
            venvExistedAtRetry = existsSync(venvDirectory);
            backupsAtRetry = (await readdir(runtimeDirectory)).filter((entry) =>
              entry.startsWith('venv.invalid-'),
            );
            await writeValidVenv(venvDirectory);
            return { stdout: '', stderr: '' };
          }
          await mkdir(dirname(pythonPath), { recursive: true });
          await writeFile(pythonPath, 'partial Python fixture');
          await writeFile(partialPath, 'preserve interrupted venv');
          firstVenvSignal = options.signal;
          return new Promise((_resolve, reject) => {
            const rejectCancellation = () => reject(options.signal?.reason);
            if (options.signal?.aborted) {
              rejectCancellation();
              return;
            }
            options.signal?.addEventListener('abort', rejectCancellation, { once: true });
            venvStarted.resolve();
          });
        }
        return { stdout: '', stderr: '' };
      },
    });

    const firstPrepare = runtime.prepare(controller.signal);
    await venvStarted.promise;
    controller.abort(cancellation);
    await expect(firstPrepare).rejects.toBe(cancellation);
    expect(firstVenvSignal?.aborted).toBe(true);

    await expect(runtime.prepare()).resolves.toMatchObject({ pythonPath });

    expect(venvExistedAtRetry).toBe(false);
    expect(backupsAtRetry).toHaveLength(1);
    expect(
      await readFile(join(runtimeDirectory, backupsAtRetry[0]!, 'partial-venv.txt'), 'utf8'),
    ).toBe('preserve interrupted venv');
    expect(existsSync(join(venvDirectory, 'pyvenv.cfg'))).toBe(true);
    expect(commandSequence(calls)).toEqual([
      'uv --version',
      'uv python install 3.11',
      `uv venv --python 3.11 ${venvDirectory}`,
      'uv --version',
      'uv python install 3.11',
      `uv venv --python 3.11 ${venvDirectory}`,
      `uv sync --locked --project ${projectDirectory}`,
    ]);
    expect(calls.filter(({ args }) => args[0] === 'sync')).toHaveLength(1);
    expect(calls.some(({ args }) => args.includes('--clear'))).toBe(false);
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
        if (_command.endsWith('uv.exe') && args[0] === 'venv') {
          await writeValidVenv(join(runtimeDirectory, 'venv'));
          return { stdout: '', stderr: '' };
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
        if (_command.endsWith('uv.exe') && args[0] === 'venv') {
          await writeValidVenv(join(runtimeDirectory, 'venv'));
          return { stdout: '', stderr: '' };
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
