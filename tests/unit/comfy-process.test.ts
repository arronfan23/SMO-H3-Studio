// @vitest-environment node

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ComfyProcessManager,
  DEFAULT_COMFY_ROOT,
  type ComfyProcessManagerOptions,
} from '../../src/main/comfy-process';
import type { ComfyClient, ComfySystemStats } from '../../src/main/comfy';

const STATS: ComfySystemStats = { system: { os: 'win' }, devices: [] };

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unref = vi.fn();
  kill = vi.fn();
}

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function createSpawnFake(implementation?: (child: FakeChild) => void) {
  const children: FakeChild[] = [];
  const calls: SpawnCall[] = [];
  const spawnFake = ((
    command: string,
    args: string[],
    options: SpawnCall['options'],
  ): ChildProcess => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args, options });
    implementation?.(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { children, calls, spawnFake };
}

describe('ComfyProcessManager', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'smo-comfy-process-'));
    logPath = join(tempDir, 'comfy.log');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createManager(
    overrides: Partial<ComfyProcessManagerOptions> & {
      client?: { health: () => Promise<ComfySystemStats> };
    } = {},
  ) {
    const { client: clientOverride, ...optionOverrides } = overrides;
    const health =
      clientOverride?.health ?? vi.fn(async () => STATS);
    const client: Pick<ComfyClient, 'health'> = { health };
    const options: ComfyProcessManagerOptions = {
      baseUrl: 'http://127.0.0.1:8188',
      logPath,
      startupTimeoutMs: 2_000,
      pollIntervalMs: 20,
      ...optionOverrides,
    };
    const manager = new ComfyProcessManager(options, client);
    return { manager, client, health };
  }

  test('returns health immediately without spawning when ComfyUI is up', async () => {
    const { children, calls, spawnFake } = createSpawnFake();
    const { manager, health } = createManager({ spawnProcess: spawnFake });

    const stats = await manager.ensureReady();

    expect(stats).toEqual(STATS);
    expect(health).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(children).toHaveLength(0);
  });

  test('reuses a healthy instance after a previous startup', async () => {
    const { calls, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({ spawnProcess: spawnFake, client: { health } });

    const first = manager.ensureReady();
    await vi.waitFor(() => expect(health.mock.calls.length).toBeGreaterThan(1));
    healthy = true;
    await expect(first).resolves.toEqual(STATS);

    await expect(manager.ensureReady()).resolves.toEqual(STATS);
    expect(calls).toHaveLength(1);
  });

  test('concurrent offline callers share one spawn and one startup', async () => {
    const { calls, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({ spawnProcess: spawnFake, client: { health } });

    const pending = [
      manager.ensureReady(),
      manager.ensureReady(),
      manager.ensureReady(),
    ];
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    healthy = true;

    const results = await Promise.all(pending);
    expect(results).toEqual([STATS, STATS, STATS]);
    expect(calls).toHaveLength(1);
  });

  test('allows retry after a failed startup', async () => {
    let spawned = 0;
    const { calls, spawnFake } = createSpawnFake((child) => {
      spawned += 1;
      if (spawned === 1) {
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
        });
      }
    });
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({ spawnProcess: spawnFake, client: { health } });

    await expect(manager.ensureReady()).rejects.toThrow(/exited/i);
    expect(calls).toHaveLength(1);

    const retry = manager.ensureReady();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    healthy = true;
    await expect(retry).resolves.toEqual(STATS);
    expect(calls).toHaveLength(2);
  });

  test('refuses to start a local process for a remote offline base URL', async () => {
    const { calls, spawnFake } = createSpawnFake();
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      throw new Error('ComfyUI is offline');
    });
    const { manager } = createManager({
      baseUrl: 'http://203.0.113.10:8188',
      spawnProcess: spawnFake,
      client: { health },
    });

    await expect(manager.ensureReady()).rejects.toThrow(/local/i);
    expect(calls).toHaveLength(0);
  });

  test('remote error messages never leak credentials', async () => {
    const { calls, spawnFake } = createSpawnFake();
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      throw new Error('ComfyUI is offline');
    });
    const { manager } = createManager({
      baseUrl: 'http://user:secret@203.0.113.10:8188',
      spawnProcess: spawnFake,
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
    expect(calls).toHaveLength(0);
  });

  test('treats [::1] as a local host', async () => {
    const { calls, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({
      baseUrl: 'http://[::1]:8199',
      spawnProcess: spawnFake,
      client: { health },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    healthy = true;
    await expect(pending).resolves.toEqual(STATS);
    expect(calls[0].args).toContain('8199');
  });

  test('spawns the default python launch script with the expected arguments', async () => {
    const { calls, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({
      baseUrl: 'http://127.0.0.1:8291',
      spawnProcess: spawnFake,
      client: { health },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0].command).toBe(join(DEFAULT_COMFY_ROOT, 'python_embeded', 'python.exe'));
    expect(calls[0].args).toEqual([
      '-I',
      '-X',
      'utf8',
      join(DEFAULT_COMFY_ROOT, 'tools', 'launch.py'),
      '--lowvram',
      '--port',
      '8291',
    ]);
    expect(calls[0].options.cwd).toBe(DEFAULT_COMFY_ROOT);
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].options.windowsHide).toBe(true);

    const stdio = calls[0].options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[1]).toBe(stdio[2]);

    // The log file is created (and appended) at the requested path.
    await expect(readFile(logPath, 'utf8')).resolves.toBe('');

    healthy = true;
    await expect(pending).resolves.toEqual(STATS);
  });

  test('honours rootDirectory, pythonPath, and launchScript overrides', async () => {
    const { calls, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const rootDirectory = join(tempDir, 'custom-root');
    const { manager } = createManager({
      rootDirectory,
      spawnProcess: spawnFake,
      client: { health },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0].command).toBe(join(rootDirectory, 'python_embeded', 'python.exe'));
    expect(calls[0].args[3]).toBe(join(rootDirectory, 'tools', 'launch.py'));
    expect(calls[0].options.cwd).toBe(rootDirectory);

    healthy = true;
    await expect(pending).resolves.toEqual(STATS);
  });

  test('honours explicit pythonPath and launchScript overrides', async () => {
    const { calls, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const pythonPath = join(tempDir, 'venv', 'python.exe');
    const launchScript = join(tempDir, 'run.py');
    const { manager } = createManager({
      pythonPath,
      launchScript,
      spawnProcess: spawnFake,
      client: { health },
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0].command).toBe(pythonPath);
    expect(calls[0].args).toEqual([
      '-I',
      '-X',
      'utf8',
      launchScript,
      '--lowvram',
      '--port',
      '8188',
    ]);

    healthy = true;
    await expect(pending).resolves.toEqual(STATS);
  });

  test('unrefs the detached child', async () => {
    const { children, spawnFake } = createSpawnFake();
    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({ spawnProcess: spawnFake, client: { health } });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0].unref).toHaveBeenCalledTimes(1);
    expect(children[0].kill).not.toHaveBeenCalled();

    healthy = true;
    await expect(pending).resolves.toEqual(STATS);
  });

  test('early exit reports the last 2000 characters of the log', async () => {
    const head = `HEAD-${'x'.repeat(1_500)}`;
    const tail = `TAIL-${'y'.repeat(1_500)}`;
    await writeFile(logPath, `${head}\n${tail}`, 'utf8');

    const { spawnFake } = createSpawnFake((child) => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
    });
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      throw new Error('ComfyUI is offline');
    });
    const { manager } = createManager({ spawnProcess: spawnFake, client: { health } });

    let message = '';
    try {
      await manager.ensureReady();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/exited/i);
    expect(message).toContain('TAIL-');
    expect(message).not.toContain('HEAD-');
  });

  test('startup timeout is configurable and reports a useful error', async () => {
    const { spawnFake } = createSpawnFake();
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      throw new Error('ComfyUI is offline');
    });
    const { manager } = createManager({
      spawnProcess: spawnFake,
      client: { health },
      startupTimeoutMs: 120,
      pollIntervalMs: 40,
    });

    const started = Date.now();
    await expect(manager.ensureReady()).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(health.mock.calls.length).toBeGreaterThan(0);
  });

  test('spawn error events reject the startup without unhandled errors', async () => {
    const { spawnFake } = createSpawnFake((child) => {
      queueMicrotask(() => {
        child.emit('error', new Error('spawn ENOENT'));
      });
    });
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      throw new Error('ComfyUI is offline');
    });
    const { manager } = createManager({ spawnProcess: spawnFake, client: { health } });

    await expect(manager.ensureReady()).rejects.toThrow(/spawn ENOENT/);
  });

  test('synchronous spawn failures reject and allow retry', async () => {
    let shouldThrow = true;
    const { calls, spawnFake } = createSpawnFake();
    const throwingSpawn = ((
      command: string,
      args: string[],
      options: SpawnCall['options'],
    ): ChildProcess => {
      if (shouldThrow) {
        throw new Error('python.exe is missing');
      }
      return spawnFake(command, args, options);
    }) as unknown as typeof spawn;

    let healthy = false;
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      if (!healthy) {
        throw new Error('ComfyUI is offline');
      }
      return STATS;
    });
    const { manager } = createManager({
      spawnProcess: throwingSpawn,
      client: { health },
    });

    await expect(manager.ensureReady()).rejects.toThrow(/python\.exe is missing/);

    shouldThrow = false;
    const retry = manager.ensureReady();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    healthy = true;
    await expect(retry).resolves.toEqual(STATS);
    expect(calls).toHaveLength(1);
  });

  test('close stops waiting without killing the detached child', async () => {
    const { children, spawnFake } = createSpawnFake();
    const health = vi.fn(async (): Promise<ComfySystemStats> => {
      throw new Error('ComfyUI is offline');
    });
    const { manager } = createManager({
      spawnProcess: spawnFake,
      client: { health },
      startupTimeoutMs: 60_000,
      pollIntervalMs: 25,
    });

    const pending = manager.ensureReady();
    await vi.waitFor(() => expect(children).toHaveLength(1));

    const closeStarted = Date.now();
    await manager.close();
    expect(Date.now() - closeStarted).toBeLessThan(2_000);
    expect(children[0].kill).not.toHaveBeenCalled();

    await expect(pending).rejects.toThrow(/closed/i);
  });

  test('ensureReady rejects after close without calling health or spawn', async () => {
    const { calls, spawnFake } = createSpawnFake();
    const { manager, health } = createManager({ spawnProcess: spawnFake });

    await manager.close();
    await expect(manager.ensureReady()).rejects.toThrow(/closed/i);
    expect(health).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
