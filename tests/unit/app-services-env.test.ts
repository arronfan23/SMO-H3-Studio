// @vitest-environment node

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app, dialog } from 'electron';
import {
  createAppServices,
  resolveStringOption,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_OUTPUT_DIRECTORY,
  DEFAULT_COMFYUI_BASE_URL,
} from '../../src/main/app-services';
import { detectHardware } from '../../src/main/hardware';

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
