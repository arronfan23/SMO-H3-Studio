// @vitest-environment node

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app, dialog } from 'electron';
import {
  createAppServices,
  createEnvironmentStartBackend,
  hasStartupEvidence,
  resolveStringOption,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_OUTPUT_DIRECTORY,
  DEFAULT_COMFYUI_BASE_URL,
} from '../../src/main/app-services';
import { ComfyClient } from '../../src/main/comfy';
import { ComfyProcessManager } from '../../src/main/comfy-process';
import { REQUIRED_COMFY_NODES } from '../../src/main/environment-setup';
import { detectHardware } from '../../src/main/hardware';
import type { EnvironmentBackendInput } from '../../src/main/environment-setup';
import type { EnvironmentPaths } from '../../src/shared/environment';

const { protocolRegisterFileProtocol, electronAppState, legacyEnvironment } =
  vi.hoisted(() => ({
    protocolRegisterFileProtocol: vi.fn(() => true),
    electronAppState: { userDataDirectory: '' },
    // Matches DEFAULT_DATA_DIRECTORY in src/main/app-services.ts; kept as a
    // literal because vi.mock factories cannot reference top-level imports.
    legacyEnvironment: { path: 'G:\\SMO-H3-Data', exists: true },
  }));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name !== 'userData') {
        throw new Error(`Unexpected getPath request: ${name}`);
      }
      return electronAppState.userDataDirectory;
    },
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  protocol: { registerFileProtocol: protocolRegisterFileProtocol },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: import('node:fs').PathLike) =>
      String(path) === legacyEnvironment.path
        ? legacyEnvironment.exists
        : actual.existsSync(path),
  };
});

vi.mock('../../src/main/hardware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/hardware')>();
  return { ...actual, detectHardware: vi.fn(actual.detectHardware) };
});

const cleanups: Array<() => void | Promise<void>> = [];

async function useDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-env-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startHttpServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ system: { os: 'test' }, devices: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  delete process.env.SMO_COMFYUI_BASE_URL;
  delete process.env.SMO_DATA_DIRECTORY;
  delete process.env.SMO_OUTPUT_DIRECTORY;
  delete process.env.SMO_TEST_FILE_DIALOG;
  legacyEnvironment.exists = true;
  electronAppState.userDataDirectory = '';
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  vi.mocked(dialog.showOpenDialog).mockReset();
});

function mockHardware(gpu = 'Env GPU') {
  vi.mocked(detectHardware).mockResolvedValue({
    gpu,
    vramGiB: 16,
    ramGiB: 64,
    windowsVersion: 'Windows 11',
    driverVersion: 'driver',
    cudaComputeCapability: '12.0',
    freeDiskGiB: 512,
  });
}

describe('createAppServices defaults', () => {
  beforeEach(() => {
    protocolRegisterFileProtocol.mockClear();
    vi.mocked(detectHardware).mockClear();
  });

  test('exposes default data directory constant', () => {
    expect(DEFAULT_DATA_DIRECTORY).toBe('G:\\SMO-H3-Data');
  });

  test('exposes default output directory constant', () => {
    expect(DEFAULT_OUTPUT_DIRECTORY).toBe(
      'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\ComfyUI\\output',
    );
  });

  test('exposes default ComfyUI base URL constant', () => {
    expect(DEFAULT_COMFYUI_BASE_URL).toBe('http://127.0.0.1:8188');
  });

  test('uses default ComfyUI base URL when no options or env are provided', async () => {
    const dataDirectory = await useDataDirectory();
    const upstream = await startHttpServer();
    cleanups.push(() => upstream.close());

    vi.stubGlobal('fetch', async (url: string | URL) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith(DEFAULT_COMFYUI_BASE_URL)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ system: { os: 'default' }, devices: [] }),
        } as Response;
      }
      throw new Error(`Unexpected fetch to ${requestUrl}`);
    });
    cleanups.push(() => {
      vi.unstubAllGlobals();
    });

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    await expect(services.comfy.health()).resolves.toMatchObject({
      system: { os: 'default' },
      devices: [],
    });
  });
});

describe('createAppServices environment integration', () => {
  beforeEach(() => {
    protocolRegisterFileProtocol.mockClear();
    vi.mocked(detectHardware).mockClear();
  });

  test('exposes the environment state with the data directory as default install root', async () => {
    const dataDirectory = await useDataDirectory();

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    const state = await services.environment.getState();
    expect(state).toMatchObject({
      config: null,
      hardware: null,
      installRoot: dataDirectory,
      stage: 'detect',
      error: null,
      active: false,
      healthy: false,
    });
  });

  test('detects hardware against the requested install root', async () => {
    const dataDirectory = await useDataDirectory();
    mockHardware('Detect GPU');

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    const state = await services.environment.detect('D:\\SMO-Environment');
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(
      undefined,
      'D:\\SMO-Environment',
    );
    expect(state.hardware).toMatchObject({ gpu: 'Detect GPU' });
    expect(state.installRoot).toBe('D:\\SMO-Environment');
  });

  test('rejects environment start input with an unknown profile', async () => {
    const dataDirectory = await useDataDirectory();
    mockHardware();

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    await expect(
      services.environment.start({
        profileId: 'unknown-profile' as never,
        installRoot: 'D:\\SMO-Environment',
      }),
    ).rejects.toThrow(/profile/i);
  });

  test('cancel resolves the current state when no install is active', async () => {
    const dataDirectory = await useDataDirectory();

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    const state = await services.environment.cancel();
    expect(state.active).toBe(false);
    expect(state.installRoot).toBe(dataDirectory);
  });

  test('a corrupt environment store surfaces an error state but keeps fallback paths', async () => {
    const dataDirectory = await useDataDirectory();
    await writeFile(join(dataDirectory, 'environment.json'), 'not json at all');
    mockHardware('Fallback GPU');

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    // The setup service restores the store asynchronously after construction.
    await vi.waitFor(async () => {
      const state = await services.environment.getState();
      expect(state.error).toMatch(/environment configuration/i);
    });
    const state = await services.environment.getState();
    expect(state.config).toBeNull();

    await expect(services.hardware.detect()).resolves.toMatchObject({
      gpu: 'Fallback GPU',
    });
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(
      undefined,
      DEFAULT_OUTPUT_DIRECTORY,
    );
  });

  test('a ready environment config wins over option and environment paths', async () => {
    const dataDirectory = await useDataDirectory();
    const runtimeRoot = await useDataDirectory();
    const modelDirectory = await useDataDirectory();
    const configOutputDirectory = await useDataDirectory();
    const optionOutputDirectory = await useDataDirectory();
    process.env.SMO_OUTPUT_DIRECTORY = await useDataDirectory();
    const config = {
      schemaVersion: 1,
      runtimeId: 'sm120',
      runtimeRoot,
      modelDirectory,
      outputDirectory: configOutputDirectory,
      profile: 'balanced-16gb',
      hardwareFingerprint: {
        gpu: 'Recorded GPU',
        vramGiB: 16,
        ramGiB: 64,
        cudaComputeCapability: '12.0',
      },
      manifestVersion: '1',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00+08:00',
      updatedAt: '2026-01-01T00:00:00+08:00',
    };
    await writeFile(
      join(dataDirectory, 'environment.json'),
      JSON.stringify(config),
    );
    mockHardware('Config GPU');

    const services = await createAppServices({
      dataDirectory,
      outputDirectory: optionOutputDirectory,
    });
    cleanups.push(() => services.close());

    // The setup service restores the store asynchronously after construction.
    await vi.waitFor(async () => {
      const state = await services.environment.getState();
      expect(state.config?.outputDirectory).toBe(configOutputDirectory);
    });

    await services.hardware.detect();
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(
      undefined,
      configOutputDirectory,
    );
  });

  test('uses the Electron userData directory when the legacy data root is absent', async () => {
    legacyEnvironment.exists = false;
    const userDataDirectory = await useDataDirectory();
    electronAppState.userDataDirectory = userDataDirectory;
    mockHardware('Fresh GPU');

    const services = await createAppServices({});
    cleanups.push(() => services.close());

    const dataDirectory = join(userDataDirectory, 'data');
    expect(existsSync(join(dataDirectory, 'studio.sqlite'))).toBe(true);

    await services.hardware.detect();
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(
      undefined,
      join(dataDirectory, 'output'),
    );

    const state = await services.environment.getState();
    expect(state.installRoot).toBe(dataDirectory);
  });
});

describe('packaged environment manifest', () => {
  test('electron-builder ships resources/environment with the app', async () => {
    const configPath = fileURLToPath(
      new URL('../../electron-builder.yml', import.meta.url),
    );
    const config = await readFile(configPath, 'utf8');

    const extraResources = config.split('\n').slice(
      config.split('\n').findIndex((line) => line.startsWith('extraResources:')),
    );
    expect(extraResources).toContainEqual(
      expect.stringMatching(/from:\s*resources\/environment/),
    );
    expect(extraResources).toContainEqual(
      expect.stringMatching(/to:\s*resources\/environment/),
    );

    const manifestPath = fileURLToPath(
      new URL('../../resources/environment/selflift-spark.json', import.meta.url),
    );
    expect(existsSync(manifestPath)).toBe(true);
  });
});

describe('createEnvironmentStartBackend', () => {
  const objectInfoFixture = Object.fromEntries(
    REQUIRED_COMFY_NODES.map((node) => [node, { input: {} }]),
  );

  function makeBackendInput(
    overrides: Partial<EnvironmentBackendInput> = {},
  ): EnvironmentBackendInput {
    return {
      runtimeRoot: 'D:\\Env\\runtime\\NewRoot',
      modelDirectory: 'D:\\Env\\models\\diffusion_models',
      outputDirectory: 'D:\\Env\\output',
      profile: 'balanced-16gb',
      runtime: {} as EnvironmentBackendInput['runtime'],
      pythonPath: 'D:\\Env\\runtime\\NewRoot\\python_embeded\\python.exe',
      launchScript: 'D:\\Env\\runtime\\NewRoot\\tools\\launch.py',
      ffprobePath: 'D:\\Env\\runtime\\NewRoot\\tools\\ffmpeg\\ffprobe.exe',
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  async function startBackendServer(
    options: {
      objectInfoGate?: { requested: Promise<void>; onRequest?: () => void };
      objectInfoValue?: unknown;
      systemStatsResponder?: (requestCount: number) => unknown;
    } = {},
  ): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    let systemStatsRequests = 0;
    const server: Server = createServer((request, response) => {
      const sendJson = (value: unknown) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/system_stats') {
        systemStatsRequests += 1;
        sendJson(
          options.systemStatsResponder?.(systemStatsRequests) ?? {
            system: { os: 'test' },
            devices: [],
          },
        );
        return;
      }
      if (request.url === '/object_info') {
        if (options.objectInfoGate) {
          options.objectInfoGate.onRequest?.();
          void options.objectInfoGate.requested.then(() =>
            sendJson(options.objectInfoValue ?? objectInfoFixture),
          );
          return;
        }
        sendJson(options.objectInfoValue ?? objectInfoFixture);
        return;
      }
      sendJson({ system: { os: 'test' }, devices: [] });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let closed = false;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: async () => {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
      },
    };
  }

  function createAdapterHarness(
    baseUrl: string,
    logDirectory: string,
    adapterOverrides: {
      startupEvidenceTimeoutMs?: number;
      onCreateManager?: (options: { logPath: string; launchDirectory?: string }) => void;
      openLauncher?: (path: string) => Promise<string>;
      activeOpenLauncher?: (path: string) => Promise<string>;
      killProcessTree?: (pid: number) => Promise<void>;
    } = {},
  ) {
    const comfy = new ComfyClient(baseUrl);
    const activePaths: EnvironmentPaths = {
      runtimeRoot: 'D:\\Env\\runtime\\OldRoot',
      modelDirectory: 'D:\\Env\\models\\diffusion_models',
      outputDirectory: 'D:\\Env\\output',
    };
    const createdManagers: ComfyProcessManager[] = [];
    const createdManagerCloseSpies: ReturnType<typeof vi.spyOn>[] = [];
    const createdManagerTerminateSpies: ReturnType<typeof vi.spyOn>[] = [];
    const kills: number[] = [];
    let activeManager: ComfyProcessManager | undefined = new ComfyProcessManager(
      {
        baseUrl,
        logPath: join(logDirectory, 'old.log'),
        startupTimeoutMs: 2_000,
        pollIntervalMs: 20,
        ...(adapterOverrides.activeOpenLauncher
          ? { openLauncher: adapterOverrides.activeOpenLauncher }
          : {}),
      },
      comfy,
    );
    const startBackend = createEnvironmentStartBackend({
      comfy,
      baseUrl,
      logPath: join(logDirectory, 'candidate.log'),
      activePaths,
      getActiveManager: () => activeManager,
      setActiveManager: (manager) => {
        activeManager = manager;
      },
      killProcessTree:
        adapterOverrides.killProcessTree ??
        (async (pid) => {
          kills.push(pid);
        }),
      createManager: (options, client) => {
        adapterOverrides.onCreateManager?.({
          logPath: options.logPath,
          launchDirectory: options.launchDirectory,
        });
        const manager = new ComfyProcessManager(
          {
            startupTimeoutMs: 2_000,
            pollIntervalMs: 20,
            ...options,
            ...(adapterOverrides.openLauncher
              ? { openLauncher: adapterOverrides.openLauncher }
              : {}),
          },
          client,
        );
        createdManagers.push(manager);
        createdManagerCloseSpies.push(vi.spyOn(manager, 'close'));
        createdManagerTerminateSpies.push(vi.spyOn(manager, 'terminate'));
        return manager;
      },
      ...(adapterOverrides.startupEvidenceTimeoutMs === undefined
        ? {}
        : { startupEvidenceTimeoutMs: adapterOverrides.startupEvidenceTimeoutMs }),
    });
    return {
      comfy,
      activePaths,
      createdManagers,
      createdManagerCloseSpies,
      createdManagerTerminateSpies,
      kills,
      startBackend,
      getActiveManager: () => activeManager,
    };
  }

  test('rejects a different candidate runtime while a healthy backend is running', async () => {
    const logDirectory = await useDataDirectory();
    const upstream = await startBackendServer();
    cleanups.push(() => upstream.close());
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory);
    const oldManager = harness.getActiveManager();

    await expect(harness.startBackend(makeBackendInput())).rejects.toThrow(
      /already running/i,
    );

    // The old manager and paths stay untouched, and no candidate was built.
    expect(harness.getActiveManager()).toBe(oldManager);
    expect(harness.activePaths.runtimeRoot).toBe('D:\\Env\\runtime\\OldRoot');
    expect(harness.createdManagers).toHaveLength(0);
    expect(harness.kills).toEqual([]);
  });

  test('reuses a healthy backend when the runtime roots match ignoring case', async () => {
    const logDirectory = await useDataDirectory();
    const upstream = await startBackendServer();
    cleanups.push(() => upstream.close());
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory);
    const oldManager = harness.getActiveManager()!;
    const oldClose = vi.spyOn(oldManager, 'close');

    const result = (await harness.startBackend(
      makeBackendInput({ runtimeRoot: 'd:\\env\\runtime\\oldroot' }),
    )) as { systemStats: unknown; objectInfo: Record<string, unknown> };

    expect(result.objectInfo).toEqual(objectInfoFixture);
    expect(harness.getActiveManager()).not.toBe(oldManager);
    expect(harness.createdManagers).toHaveLength(1);
    expect(oldClose).toHaveBeenCalled();
    expect(harness.activePaths.runtimeRoot).toBe('d:\\env\\runtime\\oldroot');
    // A reused healthy backend is never terminated.
    expect(harness.kills).toEqual([]);
  });

  test('aborting after a delayed objectInfo keeps the old manager and closes the candidate', async () => {
    const logDirectory = await useDataDirectory();
    let releaseObjectInfo!: () => void;
    let objectInfoRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      objectInfoRequested = resolve;
    });
    const gate = {
      requested: new Promise<void>((resolve) => {
        releaseObjectInfo = resolve;
      }),
      onRequest: () => objectInfoRequested(),
    };
    const upstream = await startBackendServer({ objectInfoGate: gate });
    cleanups.push(() => upstream.close());
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory);
    const oldManager = harness.getActiveManager();
    const controller = new AbortController();

    const pending = harness.startBackend(
      makeBackendInput({
        runtimeRoot: 'D:\\Env\\runtime\\OldRoot',
        signal: controller.signal,
      }),
    );
    // Wait until the backend health passed and objectInfo is in flight.
    await vi.waitFor(() => expect(harness.createdManagers).toHaveLength(1));
    await requested;
    controller.abort(new Error('Environment setup cancelled'));

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(harness.createdManagerTerminateSpies[0]).toHaveBeenCalled();
    expect(harness.getActiveManager()).toBe(oldManager);
    expect(harness.activePaths.runtimeRoot).toBe('D:\\Env\\runtime\\OldRoot');
    // The candidate never launched a process, so there was nothing to kill.
    expect(harness.kills).toEqual([]);

    releaseObjectInfo();
  });

  test('rejects when the old backend answers during a TOCTOU window without startup evidence', async () => {
    const logDirectory = await useDataDirectory();
    // Precise race: the pre-check health call fails (backend offline), but
    // the candidate's first health call inside ensureReady succeeds because
    // the OLD backend came online in between. The candidate never launches
    // anything, so its independent log never gains startup evidence.
    const upstream = await startBackendServer({
      systemStatsResponder: (requestCount) =>
        requestCount === 1 ? {} : { system: { os: 'test' }, devices: [] },
    });
    cleanups.push(() => upstream.close());
    const launches: string[] = [];
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory, {
      startupEvidenceTimeoutMs: 300,
      openLauncher: async (path) => {
        launches.push(path);
        return '';
      },
    });
    const oldManager = harness.getActiveManager();

    await expect(harness.startBackend(makeBackendInput())).rejects.toThrow(
      /startup|evidence|confirm/i,
    );

    // The candidate was closed, never launched a process, and the active
    // manager and paths still belong to the old runtime.
    expect(harness.createdManagers).toHaveLength(1);
    expect(harness.createdManagerTerminateSpies[0]).toHaveBeenCalled();
    expect(launches).toHaveLength(0);
    expect(harness.getActiveManager()).toBe(oldManager);
    expect(harness.activePaths.runtimeRoot).toBe('D:\\Env\\runtime\\OldRoot');
    expect(harness.kills).toEqual([]);
  });

  test('accepts a genuinely launched candidate once its own log proves the startup', async () => {
    const logDirectory = await useDataDirectory();
    let healthy = false;
    const upstream = await startBackendServer({
      systemStatsResponder: () =>
        healthy ? { system: { os: 'test' }, devices: [] } : {},
    });
    cleanups.push(() => upstream.close());
    const port = new URL(upstream.baseUrl).port;
    const candidateLogPaths: string[] = [];
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory, {
      startupEvidenceTimeoutMs: 2_000,
      onCreateManager: (options) => candidateLogPaths.push(options.logPath),
      openLauncher: async () => {
        // Simulate ComfyUI booting from the candidate runtime: it writes
        // its own startup lines into the candidate's independent log.
        healthy = true;
        const logPath = candidateLogPaths[candidateLogPaths.length - 1];
        await writeFile(
          logPath,
          `Starting server\nTo see the GUI go to: http://127.0.0.1:${port}\n`,
          'utf8',
        );
        return '';
      },
    });
    const oldManager = harness.getActiveManager()!;
    const oldClose = vi.spyOn(oldManager, 'close');

    const result = (await harness.startBackend(makeBackendInput())) as {
      systemStats: unknown;
      objectInfo: Record<string, unknown>;
    };

    expect(result.objectInfo).toEqual(objectInfoFixture);
    // A new runtime must use an independent log, never the shared one.
    expect(candidateLogPaths).toHaveLength(1);
    expect(candidateLogPaths[0]).toMatch(/environment-[0-9a-f-]+\.log$/);
    expect(harness.getActiveManager()).not.toBe(oldManager);
    expect(oldClose).toHaveBeenCalled();
    expect(harness.activePaths.runtimeRoot).toBe('D:\\Env\\runtime\\NewRoot');
    expect(harness.kills).toEqual([]);
  });

  test('terminates a launched candidate that lacks nodes; retry starts fresh', async () => {
    const logDirectory = await useDataDirectory();
    let healthy = false;
    const upstream = await startBackendServer({
      systemStatsResponder: () =>
        healthy ? { system: { os: 'test' }, devices: [] } : {},
      // The backend never offers the required nodes.
      objectInfoValue: {},
    });
    cleanups.push(() => upstream.close());
    const port = new URL(upstream.baseUrl).port;
    const launchDirs: string[] = [];
    const logPaths: string[] = [];
    let launchCount = 0;
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory, {
      startupEvidenceTimeoutMs: 2_000,
      onCreateManager: (options) => {
        launchDirs.push(options.launchDirectory ?? '');
        logPaths.push(options.logPath);
      },
      openLauncher: async () => {
        // Simulate ComfyUI booting: pid file plus startup evidence, and the
        // backend starts answering health checks.
        launchCount += 1;
        healthy = true;
        const pid = 5000 + launchCount;
        await writeFile(
          join(launchDirs[launchDirs.length - 1], 'comfy-worker.pid'),
          String(pid),
          'utf8',
        );
        await writeFile(
          logPaths[logPaths.length - 1],
          `Starting server\nTo see the GUI go to: http://127.0.0.1:${port}\n`,
          'utf8',
        );
        return '';
      },
      killProcessTree: async (pid) => {
        harness.kills.push(pid);
        // The tree is gone: the backend stops answering.
        healthy = false;
      },
    });
    const oldManager = harness.getActiveManager();

    await expect(harness.startBackend(makeBackendInput())).rejects.toThrow(
      /missing required nodes/i,
    );
    expect(harness.kills).toEqual([5001]);
    expect(harness.getActiveManager()).toBe(oldManager);

    // A retry must launch a fresh candidate into its own directories, not
    // trip over the terminated one's files.
    await expect(harness.startBackend(makeBackendInput())).rejects.toThrow(
      /missing required nodes/i,
    );
    expect(harness.kills).toEqual([5001, 5002]);
    expect(harness.createdManagers).toHaveLength(2);
    expect(new Set(launchDirs).size).toBe(2);
    expect(new Set(logPaths).size).toBe(2);
    expect(harness.getActiveManager()).toBe(oldManager);
    expect(harness.activePaths.runtimeRoot).toBe('D:\\Env\\runtime\\OldRoot');
  });

  test('aborting after a real launch terminates the candidate process tree', async () => {
    const logDirectory = await useDataDirectory();
    let healthy = false;
    let releaseObjectInfo!: () => void;
    let objectInfoRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      objectInfoRequested = resolve;
    });
    const upstream = await startBackendServer({
      systemStatsResponder: () =>
        healthy ? { system: { os: 'test' }, devices: [] } : {},
      objectInfoGate: {
        requested: new Promise<void>((resolve) => {
          releaseObjectInfo = resolve;
        }),
        onRequest: () => objectInfoRequested(),
      },
    });
    cleanups.push(() => upstream.close());
    const port = new URL(upstream.baseUrl).port;
    const launchDirs: string[] = [];
    const logPaths: string[] = [];
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory, {
      startupEvidenceTimeoutMs: 2_000,
      onCreateManager: (options) => {
        launchDirs.push(options.launchDirectory ?? '');
        logPaths.push(options.logPath);
      },
      openLauncher: async () => {
        healthy = true;
        await writeFile(
          join(launchDirs[launchDirs.length - 1], 'comfy-worker.pid'),
          '6001',
          'utf8',
        );
        await writeFile(
          logPaths[logPaths.length - 1],
          `Starting server\nTo see the GUI go to: http://127.0.0.1:${port}\n`,
          'utf8',
        );
        return '';
      },
      killProcessTree: async (pid) => {
        harness.kills.push(pid);
        healthy = false;
      },
    });
    const oldManager = harness.getActiveManager();
    const controller = new AbortController();

    const pending = harness.startBackend(
      makeBackendInput({ signal: controller.signal }),
    );
    await requested;
    controller.abort(new Error('Environment setup cancelled'));

    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(harness.kills).toEqual([6001]);
    expect(harness.getActiveManager()).toBe(oldManager);
    expect(harness.activePaths.runtimeRoot).toBe('D:\\Env\\runtime\\OldRoot');

    releaseObjectInfo();
  });

  test('a same-path offline candidate launches into its own chain next to the active manager', async () => {
    const logDirectory = await useDataDirectory();
    let healthy = false;
    const upstream = await startBackendServer({
      systemStatsResponder: () =>
        healthy ? { system: { os: 'test' }, devices: [] } : {},
    });
    cleanups.push(() => upstream.close());
    let releaseActiveOpen!: () => void;
    const activeOpenGate = new Promise<void>((resolve) => {
      releaseActiveOpen = resolve;
    });
    let markActiveOpen!: () => void;
    const activeOpenCalled = new Promise<void>((resolve) => {
      markActiveOpen = resolve;
    });
    const candidateLaunches: string[] = [];
    const candidateDirs: string[] = [];
    const harness = createAdapterHarness(upstream.baseUrl, logDirectory, {
      activeOpenLauncher: async () => {
        markActiveOpen();
        await activeOpenGate;
        return '';
      },
      openLauncher: async (path) => {
        candidateLaunches.push(path);
        return '';
      },
      onCreateManager: (options) => {
        candidateDirs.push(options.launchDirectory ?? '');
      },
    });
    const oldManager = harness.getActiveManager()!;

    // The active manager starts launching first and blocks inside
    // openLauncher after writing its launcher files into the log directory.
    const activePending = oldManager.ensureReady();
    await activeOpenCalled;

    // The candidate (same runtime root, backend offline) launches while the
    // active manager's launcher files sit in the shared log directory.
    const candidatePending = harness.startBackend(
      makeBackendInput({ runtimeRoot: 'D:\\Env\\runtime\\OldRoot' }),
    );
    await vi.waitFor(() => expect(candidateLaunches).toHaveLength(1));

    releaseActiveOpen();
    healthy = true;
    await expect(activePending).resolves.toBeDefined();
    await expect(candidatePending).resolves.toBeDefined();

    // The active manager's chain in the log directory was never overwritten.
    const activePaths = await readFile(
      join(logDirectory, 'start-comfyui.paths'),
      'utf8',
    );
    expect(activePaths).toContain(
      `SMO_COMFY_LOG=${join(logDirectory, 'old.log')}`,
    );
    expect(activePaths).not.toContain('environment-');

    // The candidate used its own UUID-isolated launch chain.
    expect(candidateDirs).toHaveLength(1);
    expect(candidateDirs[0]).toMatch(/environment-[0-9a-f-]+$/);
    const candidatePaths = await readFile(
      join(candidateDirs[0], 'start-comfyui.paths'),
      'utf8',
    );
    expect(candidatePaths).toContain('environment-');
    expect(candidatePaths).not.toContain('old.log');
    expect(harness.kills).toEqual([]);
  });
});

describe('startup evidence port matching', () => {
  test('matches the GUI URL port against the backend port, including IPv6', () => {
    const log = (url: string) =>
      `Starting server\nTo see the GUI go to: ${url}\n`;

    expect(hasStartupEvidence(log('http://127.0.0.1:8188'), '8188')).toBe(true);
    expect(hasStartupEvidence(log('http://[::1]:8199/'), '8199')).toBe(true);
    expect(hasStartupEvidence(log('http://[::1]:8199/'), '8188')).toBe(false);
    expect(hasStartupEvidence(log('http://127.0.0.1:18188'), '8188')).toBe(false);
    expect(hasStartupEvidence('To see the GUI go to: http://127.0.0.1:8188', '8188')).toBe(false);
    expect(hasStartupEvidence(log('not a url'), '8188')).toBe(false);
    expect(hasStartupEvidence('', '8188')).toBe(false);
  });
});

describe('createAppServices initial manager profile', () => {
  function writeEnvironmentConfig(
    dataDirectory: string,
    profile: string,
    runtimeRoot: string,
  ): Promise<void> {
    const config = {
      schemaVersion: 1,
      runtimeId: 'sm120',
      runtimeRoot,
      modelDirectory: join(dataDirectory, 'models'),
      outputDirectory: join(dataDirectory, 'output'),
      profile,
      hardwareFingerprint: {
        gpu: 'Recorded GPU',
        vramGiB: 24,
        ramGiB: 64,
        cudaComputeCapability: '12.0',
      },
      manifestVersion: '1',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00+08:00',
      updatedAt: '2026-01-01T00:00:00+08:00',
    };
    return writeFile(
      join(dataDirectory, 'environment.json'),
      JSON.stringify(config),
    );
  }

  test.each([
    { profile: 'high-memory-candidate', expectLowvram: false },
    { profile: 'balanced-16gb', expectLowvram: true },
  ])(
    'builds the launcher with lowvram=$expectLowvram for a $profile config',
    async ({ profile, expectLowvram }) => {
      const dataDirectory = await useDataDirectory();
      const runtimeRoot = await useDataDirectory();
      await writeEnvironmentConfig(dataDirectory, profile, runtimeRoot);

      const services = await createAppServices({
        dataDirectory,
        comfyBaseUrl: 'http://127.0.0.1:1',
      });
      cleanups.push(() => services.close());

      // The launch fails (no shell in the test mock), but the launcher
      // files are written before the open attempt.
      await expect(services.startComfy()).rejects.toThrow();

      const inner = await readFile(
        join(dataDirectory, 'logs', 'start-comfyui.cmd'),
        'utf8',
      );
      if (expectLowvram) {
        expect(inner).toContain('--lowvram');
      } else {
        expect(inner).not.toContain('--lowvram');
      }
    },
  );
});

describe('createAppServices test file dialog env', () => {
  test('unpackaged app uses SMO_TEST_FILE_DIALOG paths', async () => {
    const dataDirectory = await useDataDirectory();
    const testImagePath = join(dataDirectory, 'test.png');
    await writeFile(testImagePath, Buffer.from('dummy'));
    process.env.SMO_TEST_FILE_DIALOG = JSON.stringify([testImagePath]);

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    await expect(services.files.selectImage()).resolves.toBe(testImagePath);
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  test('packaged app ignores SMO_TEST_FILE_DIALOG and uses system dialog', async () => {
    const dataDirectory = await useDataDirectory();
  const testImagePath = join(dataDirectory, 'test.png');
  await writeFile(testImagePath, Buffer.from('dummy'));
  process.env.SMO_TEST_FILE_DIALOG = JSON.stringify([testImagePath]);
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });

    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    await expect(services.files.selectImage()).resolves.toBeNull();
    expect(dialog.showOpenDialog).toHaveBeenCalled();
  });
});

describe('createAppServices environment overrides', () => {
  beforeEach(() => {
    protocolRegisterFileProtocol.mockClear();
    vi.mocked(detectHardware).mockClear();
  });

  test('SMO_COMFYUI_BASE_URL overrides default ComfyUI base URL', async () => {
    const dataDirectory = await useDataDirectory();
    const upstream = await startHttpServer();
    cleanups.push(() => upstream.close());

    process.env.SMO_COMFYUI_BASE_URL = upstream.baseUrl;

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    await expect(services.comfy.health()).resolves.toMatchObject({
      system: { os: 'test' },
      devices: [],
    });
  });

  test('SMO_DATA_DIRECTORY overrides default data directory', async () => {
    const envDataDirectory = await useDataDirectory();
    process.env.SMO_DATA_DIRECTORY = envDataDirectory;

    const services = await createAppServices({});
    cleanups.push(() => services.close());

    expect(existsSync(join(envDataDirectory, 'studio.sqlite'))).toBe(true);
  });

  test('SMO_OUTPUT_DIRECTORY overrides default output directory', async () => {
    const outputDirectory = await useDataDirectory();
    process.env.SMO_OUTPUT_DIRECTORY = outputDirectory;

    const services = await createAppServices({ dataDirectory: await useDataDirectory() });
    cleanups.push(() => services.close());

    vi.mocked(detectHardware).mockResolvedValue({
      gpu: 'Env GPU',
      vramGiB: 8,
      ramGiB: 16,
      windowsVersion: 'Windows 10',
      driverVersion: 'driver',
      cudaComputeCapability: '8.0',
      freeDiskGiB: 64,
    });

    await expect(services.hardware.detect()).resolves.toMatchObject({ gpu: 'Env GPU' });
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(undefined, outputDirectory);
  });

  test('explicit options take precedence over environment variables', async () => {
    const optionDataDirectory = await useDataDirectory();
    const outputDirectory = await useDataDirectory();
    const envOutputDirectory = await useDataDirectory();
    const upstream = await startHttpServer();
    cleanups.push(() => upstream.close());

    process.env.SMO_DATA_DIRECTORY = await useDataDirectory();
    process.env.SMO_OUTPUT_DIRECTORY = envOutputDirectory;
    process.env.SMO_COMFYUI_BASE_URL = 'http://127.0.0.1:65534';

    const services = await createAppServices({
      dataDirectory: optionDataDirectory,
      outputDirectory,
      comfyBaseUrl: upstream.baseUrl,
    });
    cleanups.push(() => services.close());

    expect(existsSync(join(optionDataDirectory, 'studio.sqlite'))).toBe(true);

    vi.mocked(detectHardware).mockResolvedValue({
      gpu: 'Option GPU',
      vramGiB: 8,
      ramGiB: 16,
      windowsVersion: 'Windows 10',
      driverVersion: 'driver',
      cudaComputeCapability: '8.0',
      freeDiskGiB: 64,
    });
    await expect(services.hardware.detect()).resolves.toMatchObject({ gpu: 'Option GPU' });
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(undefined, outputDirectory);

    await expect(services.comfy.health()).resolves.toMatchObject({
      system: { os: 'test' },
      devices: [],
    });
  });
});

describe('createAppServices empty value fallback', () => {
  beforeEach(() => {
    protocolRegisterFileProtocol.mockClear();
  });

  test.each([
    { name: 'empty string', option: '', env: undefined },
    { name: 'whitespace', option: '   ', env: undefined },
    { name: 'tab', option: '\t', env: undefined },
    { name: 'empty env', option: undefined, env: '' },
    { name: 'whitespace env', option: undefined, env: '   ' },
  ])(
    'ignores $name dataDirectory value and falls back to default',
    ({ option, env }) => {
      expect(resolveStringOption(option, env, DEFAULT_DATA_DIRECTORY)).toBe(
        DEFAULT_DATA_DIRECTORY,
      );
    },
  );

  test('ignores empty outputDirectory option and falls back to default', async () => {
    const dataDirectory = await useDataDirectory();

    const services = await createAppServices({ dataDirectory, outputDirectory: '' });
    cleanups.push(() => services.close());

    vi.mocked(detectHardware).mockResolvedValue({
      gpu: 'Default Output',
      vramGiB: 8,
      ramGiB: 16,
      windowsVersion: 'Windows 10',
      driverVersion: 'driver',
      cudaComputeCapability: '8.0',
      freeDiskGiB: 64,
    });
    await services.hardware.detect();
    expect(vi.mocked(detectHardware)).toHaveBeenCalledWith(undefined, DEFAULT_OUTPUT_DIRECTORY);
  });

  test('ignores empty SMO_COMFYUI_BASE_URL env and falls back to default', async () => {
    const dataDirectory = await useDataDirectory();
    process.env.SMO_COMFYUI_BASE_URL = '';

    vi.stubGlobal('fetch', async (url: string | URL) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith(DEFAULT_COMFYUI_BASE_URL)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ system: { os: 'default' }, devices: [] }),
        } as Response;
      }
      throw new Error(`Unexpected fetch to ${requestUrl}`);
    });
    cleanups.push(() => {
      vi.unstubAllGlobals();
    });

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    await expect(services.comfy.health()).resolves.toMatchObject({
      system: { os: 'default' },
      devices: [],
    });
  });
});
