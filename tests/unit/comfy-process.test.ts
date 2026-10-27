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
    const openLauncherFake =
      openLauncher ??
      (async (path: string): Promise<string> => {
        openCalls.push(path);
        return '';
      });
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

  test('refuses to start a local process for a remote offline base URL', async () => {
    const { openCalls } = createManager({ baseUrl: 'http://203.0.113.10:8188' });
    const health = offlineHealth();
    const { manager } = createManager({
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
    expect(hidden).toContain(`start "" /min "${innerLauncherPath}"`);

    // The spawn itself must not create or hold the log file; the launcher
    // creates it via shell redirection when ComfyUI actually starts.
    expect(existsSync(logPath)).toBe(false);
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

  test('rejects CR/LF in launch paths before writing launcher files', async () => {
    const health = offlineHealth();
    const { manager, openCalls } = createManager({
      rootDirectory: 'C:\\evil\r\nwhoami',
      client: { health },
    });

    await expect(manager.ensureReady()).rejects.toThrow(/CR or LF/);
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
    expect(openCalls).toHaveLength(0); // custom fake records nothing
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
});
