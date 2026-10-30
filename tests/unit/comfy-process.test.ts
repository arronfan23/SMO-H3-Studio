// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ComfyProcessManager,
  DEFAULT_COMFY_ROOT,
  type ComfyProcessManagerOptions,
} from '../../src/main/comfy-process';
import type { ComfyClient, ComfySystemStats } from '../../src/main/comfy';

const STATS: ComfySystemStats = { system: { os: 'win' }, devices: [] };

function offlineHealth() {
  return vi.fn(async (): Promise<ComfySystemStats> => {
    throw new Error('ComfyUI is offline');
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ComfyProcessManager', () => {
  let tempDir: string;
  let logPath: string;
  let statusPath: string;
  let innerLauncherPath: string;
  let hiddenLauncherPath: string;
  let pathsPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'smo-comfy-process-'));
    logPath = join(tempDir, 'comfy.log');
    statusPath = `${logPath}.exit`;
    innerLauncherPath = join(tempDir, 'start-comfyui.cmd');
    hiddenLauncherPath = join(tempDir, 'start-comfyui-hidden.cmd');
    pathsPath = join(tempDir, 'start-comfyui.paths');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createManager(
    overrides: Partial<ComfyProcessManagerOptions> & {
      client?: { health: () => Promise<ComfySystemStats> };
      openLauncher?: (path: string) => Promise<string>;
    } = {},
  ) {
    const { client: clientOverride, openLauncher, ...optionOverrides } = overrides;
    const health =
      clientOverride?.health ?? vi.fn(async () => STATS);
    const client: Pick<ComfyClient, 'health'> = { health };
    const openCalls: string[] = [];
    const openLauncherFake = async (path: string): Promise<string> => {
      openCalls.push(path);
      return openLauncher ? openLauncher(path) : '';
    };
    const options: ComfyProcessManagerOptions = {
      baseUrl: 'http://127.0.0.1:8188',
      logPath,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 20,
      openLauncher: openLauncherFake,
      ...optionOverrides,
    };
    const manager = new ComfyProcessManager(options, client);
    return { manager, client, health, openCalls, openLauncher: openLauncherFake };
  }

  test('returns health immediately without launching when ComfyUI is up', async () => {
    const { manager, health, openCalls } = createManager();

    const stats = await manager.ensureReady();

    expect(stats).toEqual(STATS);
    expect(health).toHaveBeenCalledTimes(1);
    expect(openCalls).toHaveLength(0);
  });

  test('reuses a healthy instance after a previous startup', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({ client: { health } });

    const first = manager.ensureReady();
    await vi.waitFor(() => expect(health.mock.calls.length).toBeGreaterThan(1));
    healthy = true;
    await expect(first).resolves.toEqual(STATS);

    await expect(manager.ensureReady()).resolves.toEqual(STATS);
    // The second ensureReady hits healthy ComfyUI directly: no second launch.
    expect(openCalls).toHaveLength(1);
  });

  test('launches through ShellExecute and stops polling once healthy', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({ client: { health } });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    expect(openCalls[0]).toBe(hiddenLauncherPath);
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);
  });

  test('concurrent offline callers share one launch and one startup', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({ client: { health } });

    const pending = [
      manager.ensureReady(),
      manager.ensureReady(),
      manager.ensureReady(),
    ];
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;

    const results = await Promise.all(pending);
    expect(results).toEqual([STATS, STATS, STATS]);
    expect(openCalls).toHaveLength(1);
  });

  test('records the exit code in the status file before exiting', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({ client: { health } });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(existsSync(hiddenLauncherPath)).toBe(true));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    // The inner launcher must forward the backend exit code for diagnosis.
    const inner = await readFile(innerLauncherPath, 'utf8');
    expect(inner).toContain('set "RESULT=%errorlevel%"');
    expect(inner).toContain('>"%SMO_COMFY_STATUS%" echo %RESULT%');
    expect(inner).toContain('exit /b %RESULT%');
  });

  test('allows retry after a recorded early exit', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({ client: { health } });

    const first = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    await writeFile(statusPath, '1\n', 'utf8');
    await expect(first).rejects.toThrow(/exited early \(code 1\)/);
    expect(openCalls).toHaveLength(1);

    const retry = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(2));
    healthy = true;
    await expect(retry).resolves.toEqual(STATS);
    expect(openCalls).toHaveLength(2);
  });

  test('reuses the still-starting backend after a startup timeout', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      client: { health },
      startupTimeoutMs: 80,
      pollIntervalMs: 30,
    });

    // First attempt times out while the backend is still starting.
    await expect(manager.ensureReady()).rejects.toThrow(/timed out/i);
    expect(openCalls).toHaveLength(1);

    // A retry must wait on the same backend instead of launching again.
    let healthy = false;
    health.mockImplementation(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const retry = manager.ensureReady();
    await vi.waitFor(() => expect(health.mock.calls.length).toBeGreaterThan(2));
    expect(openCalls).toHaveLength(1);

    healthy = true;
    await expect(retry).resolves.toEqual(STATS);
    expect(openCalls).toHaveLength(1);
  });

  test('discards a stale startup with no exit record and relaunches', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      client: { health },
      startupTimeoutMs: 60,
      pollIntervalMs: 20,
      staleStartupMs: 140,
    });

    // First attempt times out; the startup marker is kept for reuse.
    await expect(manager.ensureReady()).rejects.toThrow(/timed out/i);
    expect(openCalls).toHaveLength(1);

    // Past the stale deadline with no exit record (e.g. the backend was
    // killed externally without writing one), the next attempt must launch
    // a fresh backend instead of waiting forever.
    await delay(180);
    const retry = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(2));
    expect(openCalls[1]).toBe(hiddenLauncherPath);
    await expect(retry).rejects.toThrow(/timed out/i);
  });

  test('refuses to start a local process for a remote offline base URL', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      baseUrl: 'http://203.0.113.10:8188',
      client: { health },
    });

    await expect(manager.ensureReady()).rejects.toThrow(/local/i);
    expect(openCalls).toHaveLength(0);
  });

  test('remote error messages never leak credentials', async () => {
    const health = offlineHealth();
    const { manager } = createManager({
      baseUrl: 'http://user:secret@203.0.113.10:8188',
      client: { health },
    });

    let message = '';
    try {
      await manager.ensureReady();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('user:secret');
    expect(message).not.toContain('secret');
  });

  test('treats [::1] as a local host and writes the port to the paths file', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({
      baseUrl: 'http://[::1]:8199',
      client: { health },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const paths = await readFile(pathsPath, 'utf8');
    expect(paths).toContain('SMO_COMFY_PORT=8199');
  });

  test('writes launcher files in UTF-8 without BOM with CRLF endings', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({ client: { health } });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    for (const file of [innerLauncherPath, hiddenLauncherPath, pathsPath]) {
      const raw = await readFile(file);
      expect(raw[0]).not.toBe(0xef);
      expect(raw.toString('utf8')).toContain('\r\n');
    }

    const inner = await readFile(innerLauncherPath, 'utf8');
    expect(inner.startsWith('@echo off\r\n')).toBe(true);
    expect(inner).toContain('setlocal DisableDelayedExpansion');
    expect(inner).toContain('chcp 65001>nul');
    // chcp must run before the batch reads the UTF-8 paths file.
    expect(inner.indexOf('chcp 65001>nul')).toBeLessThan(
      inner.indexOf('for /f'),
    );
    expect(inner).toContain('cd /d "%SMO_COMFY_ROOT_DIR%"');
    expect(inner).toContain(
      '"%SMO_COMFY_PYTHON%" -I -X utf8 "%SMO_COMFY_LAUNCH%" --lowvram --port %SMO_COMFY_PORT% >> "%SMO_COMFY_LOG%" 2>&1',
    );

    const hidden = await readFile(hiddenLauncherPath, 'utf8');
    expect(hidden).toContain('start "" /min "%~dp0start-comfyui.cmd"');

    // The spawn itself must not create or hold the log file; the launcher
    // creates it via shell redirection when ComfyUI actually starts.
    expect(existsSync(logPath)).toBe(false);
  });

  test('hidden launcher references the inner script only via %~dp0', async () => {
    // Directory names deliberately contain %, !, spaces, and non-ASCII
    // characters; none of them may end up embedded in the hidden launcher.
    const specialDir = join(tempDir, 'smo 100%!整合 目录');
    const specialLogPath = join(specialDir, 'comfy.log');
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({
      client: { health },
      logPath: specialLogPath,
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const hidden = await readFile(
      join(specialDir, 'start-comfyui-hidden.cmd'),
      'utf8',
    );
    expect(hidden).toContain('setlocal DisableDelayedExpansion');
    expect(hidden).toContain('start "" /min "%~dp0start-comfyui.cmd"');
    expect(hidden).not.toContain(specialDir);
    expect(hidden).not.toContain('!');
  });

  test('paths file carries real values verbatim, including percent signs', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const rootDirectory = join(tempDir, '100% root');
    const { manager, openCalls } = createManager({
      rootDirectory,
      client: { health },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const paths = await readFile(pathsPath, 'utf8');
    // set "KEY=value" stores the value verbatim; a literal % is safe because
    // delayed expansion is disabled and values are never re-expanded.
    expect(paths).toContain(`SMO_COMFY_ROOT_DIR=${rootDirectory}`);
    expect(paths).toContain(
      `SMO_COMFY_PYTHON=${join(rootDirectory, 'python_embeded', 'python.exe')}`,
    );
  });

  test('omits --lowvram from the inner launcher when lowvram is false', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({
      client: { health },
      lowvram: false,
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const inner = await readFile(innerLauncherPath, 'utf8');
    expect(inner).not.toContain('--lowvram');
    expect(inner).toContain(
      '"%SMO_COMFY_PYTHON%" -I -X utf8 "%SMO_COMFY_LAUNCH%" --port %SMO_COMFY_PORT% >> "%SMO_COMFY_LOG%" 2>&1',
    );
  });

  test('passes the output directory through the paths file, never embedded in the launcher', async () => {
    // The output path deliberately contains spaces, non-ASCII characters,
    // percent signs, and exclamation marks; all of them must travel through
    // the UTF-8 paths file verbatim, not through the batch script.
    const outputDirectory = join(tempDir, 'smo 100%!整合 输出');
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({
      client: { health },
      outputDirectory,
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const inner = await readFile(innerLauncherPath, 'utf8');
    expect(inner).toContain('--output-directory "%SMO_COMFY_OUTPUT%"');
    expect(inner).not.toContain(outputDirectory);
    expect(inner).toContain('setlocal DisableDelayedExpansion');

    const paths = await readFile(pathsPath, 'utf8');
    expect(paths).toContain(`SMO_COMFY_OUTPUT=${outputDirectory}`);
  });

  test('omits --output-directory entirely when no output directory is configured', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager, openCalls } = createManager({ client: { health } });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const inner = await readFile(innerLauncherPath, 'utf8');
    expect(inner).not.toContain('--output-directory');
    const paths = await readFile(pathsPath, 'utf8');
    expect(paths).not.toContain('SMO_COMFY_OUTPUT');
  });

  test.each([
    { name: 'CR/LF', outputDirectory: 'C:\\evil\r\nwhoami' },
    { name: 'double quote', outputDirectory: 'C:\\evil" & whoami' },
  ])(
    'rejects $name in the output directory before writing launcher files',
    async ({ outputDirectory }) => {
      const health = offlineHealth();
      const { manager, openCalls } = createManager({
        client: { health },
        outputDirectory,
      });

      await expect(manager.ensureReady()).rejects.toThrow(/must not contain/);
      expect(openCalls).toHaveLength(0);
      expect(existsSync(innerLauncherPath)).toBe(false);
    },
  );

  test('rejects CR/LF in launch paths before writing launcher files', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      rootDirectory: 'C:\\evil\r\nwhoami',
      client: { health },
    });

    await expect(manager.ensureReady()).rejects.toThrow(/must not contain/);
    expect(openCalls).toHaveLength(0);
    expect(existsSync(innerLauncherPath)).toBe(false);
  });

  test('rejects double quotes in launch paths before writing launcher files', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      rootDirectory: 'C:\\evil" & whoami',
      client: { health },
    });

    await expect(manager.ensureReady()).rejects.toThrow(/must not contain/);
    expect(openCalls).toHaveLength(0);
    expect(existsSync(innerLauncherPath)).toBe(false);
  });

  test('a non-empty ShellExecute result rejects the startup', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      client: { health },
      openLauncher: async () => 'file not found',
    });

    await expect(manager.ensureReady()).rejects.toThrow(/file not found/);
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]).toBe(hiddenLauncherPath);
  });

  test('early exit reports the last 2000 characters of the log', async () => {
    const head = `HEAD-${'x'.repeat(1_500)}`;
    const tail = `TAIL-${'y'.repeat(1_500)}`;
    await writeFile(logPath, `${head}\n${tail}`, 'utf8');

    const health = offlineHealth();
    const { manager, openCalls } = createManager({ client: { health } });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    await writeFile(statusPath, '1\n', 'utf8');

    let message = '';
    try {
      await pending;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/exited/i);
    expect(message).toContain('TAIL-');
    expect(message).not.toContain('HEAD-');
  });

  test('startup timeout is configurable and reports a useful error', async () => {
    const health = offlineHealth();
    const { manager } = createManager({
      client: { health },
      startupTimeoutMs: 120,
      pollIntervalMs: 40,
    });

    const started = Date.now();
    await expect(manager.ensureReady()).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(health.mock.calls.length).toBeGreaterThan(0);
  });

  test('close during startup stops waiting without killing anything', async () => {
    const health = offlineHealth();
    const { manager } = createManager({
      client: { health },
      startupTimeoutMs: 60_000,
      pollIntervalMs: 25,
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(health.mock.calls.length).toBeGreaterThan(0));

    const closeStarted = Date.now();
    await manager.close();
    expect(Date.now() - closeStarted).toBeLessThan(2_000);

    await expect(pending).rejects.toThrow(/closed/i);
  });

  test('ensureReady rejects after close without calling health or launching', async () => {
    const { manager, health, openCalls } = createManager();

    await manager.close();
    await expect(manager.ensureReady()).rejects.toThrow(/closed/i);
    expect(health).not.toHaveBeenCalled();
    expect(openCalls).toHaveLength(0);
  });

  test('two managers with separate launch directories never overwrite each other', async () => {
    let healthyA = false;
    let healthyB = false;
    const healthA = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthyA) throw new Error('ComfyUI A is offline');
      return STATS;
    });
    const healthB = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthyB) throw new Error('ComfyUI B is offline');
      return STATS;
    });
    const launchDirectoryA = join(tempDir, 'launch-a');
    const launchDirectoryB = join(tempDir, 'launch-b');
    const rootA = join(tempDir, 'root-a');
    const rootB = join(tempDir, 'root-b');
    const a = createManager({
      client: { health: healthA },
      rootDirectory: rootA,
      logPath: join(tempDir, 'shared.log'),
      launchDirectory: launchDirectoryA,
    });
    const b = createManager({
      client: { health: healthB },
      baseUrl: 'http://127.0.0.1:8199',
      rootDirectory: rootB,
      logPath: join(tempDir, 'shared.log'),
      launchDirectory: launchDirectoryB,
    });

    // Interleave the two startups.
    const pendingA = a.manager.ensureReady();
    await vi.waitFor(() => expect(a.openCalls).toHaveLength(1));
    const pendingB = b.manager.ensureReady();
    await vi.waitFor(() => expect(b.openCalls).toHaveLength(1));
    healthyA = true;
    healthyB = true;
    await expect(pendingA).resolves.toEqual(STATS);
    await expect(pendingB).resolves.toEqual(STATS);

    const pathsA = await readFile(join(launchDirectoryA, 'start-comfyui.paths'), 'utf8');
    const pathsB = await readFile(join(launchDirectoryB, 'start-comfyui.paths'), 'utf8');
    expect(pathsA).toContain(`SMO_COMFY_ROOT_DIR=${rootA}`);
    expect(pathsA).toContain('SMO_COMFY_PORT=8188');
    expect(pathsA).not.toContain(rootB);
    expect(pathsB).toContain(`SMO_COMFY_ROOT_DIR=${rootB}`);
    expect(pathsB).toContain('SMO_COMFY_PORT=8199');
    expect(pathsB).not.toContain(rootA);
    expect(a.openCalls[0]).toBe(join(launchDirectoryA, 'start-comfyui-hidden.cmd'));
    expect(b.openCalls[0]).toBe(join(launchDirectoryB, 'start-comfyui-hidden.cmd'));
  });

  test('an owned manager launches through a pid-recording python worker', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) throw new Error('ComfyUI is offline');
      return STATS;
    });
    const { manager, openCalls } = createManager({
      client: { health },
      ownedProcess: true,
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    const inner = await readFile(innerLauncherPath, 'utf8');
    expect(inner).toContain(
      '"%SMO_COMFY_PYTHON%" -I -X utf8 "%~dp0comfy-worker.py" --lowvram --port %SMO_COMFY_PORT% >> "%SMO_COMFY_LOG%" 2>&1',
    );
    expect(inner).not.toContain('%-worker%');

    const paths = await readFile(pathsPath, 'utf8');
    expect(paths).toContain(`SMO_COMFY_PID=${join(tempDir, 'comfy-worker.pid')}`);

    // The worker must not embed any user-controlled path; everything comes
    // from the UTF-8 paths file via the environment.
    const worker = await readFile(join(tempDir, 'comfy-worker.py'), 'utf8');
    expect(worker).toContain('Popen');
    expect(worker).toContain('SMO_COMFY_LAUNCH');
    expect(worker).toContain('SMO_COMFY_PID');
    expect(worker).not.toContain(tempDir);
  });

  test('terminate kills an owned backend this manager actually launched', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) throw new Error('ComfyUI is offline');
      return STATS;
    });
    const killProcessTree = vi.fn(async (_pid: number) => undefined);
    const { manager, openCalls } = createManager({
      client: { health },
      ownedProcess: true,
      killProcessTree,
      openLauncher: async () => {
        await writeFile(join(tempDir, 'comfy-worker.pid'), '4321', 'utf8');
        return '';
      },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    await manager.terminate();
    expect(killProcessTree).toHaveBeenCalledWith(4321);
  });

  test('terminate never kills a reused healthy backend', async () => {
    const killProcessTree = vi.fn(async (_pid: number) => undefined);
    const { manager, health, openCalls } = createManager({
      ownedProcess: true,
      killProcessTree,
    });

    // The backend is already healthy: no launch, no pid file, nothing to kill.
    await expect(manager.ensureReady()).resolves.toEqual(STATS);
    expect(health).toHaveBeenCalledTimes(1);
    expect(openCalls).toHaveLength(0);

    await manager.terminate();
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  test('terminate skips the kill when the backend already exited', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) throw new Error('ComfyUI is offline');
      return STATS;
    });
    const killProcessTree = vi.fn(async (_pid: number) => undefined);
    const { manager, openCalls } = createManager({
      client: { health },
      ownedProcess: true,
      killProcessTree,
      openLauncher: async () => {
        await writeFile(join(tempDir, 'comfy-worker.pid'), '4321', 'utf8');
        return '';
      },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    // The backend recorded its exit before the terminate request.
    await writeFile(statusPath, '0\n', 'utf8');
    await manager.terminate();
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  test('terminate and close never kill for a non-owned manager', async () => {
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) throw new Error('ComfyUI is offline');
      return STATS;
    });
    const killProcessTree = vi.fn(async (_pid: number) => undefined);
    const { manager, openCalls } = createManager({
      client: { health },
      killProcessTree,
      openLauncher: async () => {
        await writeFile(join(tempDir, 'comfy-worker.pid'), '4321', 'utf8');
        return '';
      },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(openCalls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);

    await manager.terminate();
    expect(killProcessTree).not.toHaveBeenCalled();

    const owned = createManager({
      client: { health },
      ownedProcess: true,
      killProcessTree,
    });
    await owned.manager.ensureReady();
    await owned.manager.close();
    expect(killProcessTree).not.toHaveBeenCalled();
  });
});
