// @vitest-environment node

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createAppServices,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_OUTPUT_DIRECTORY,
} from '../../src/main/app-services';
import { detectHardware } from '../../src/main/hardware';

const { protocolRegisterFileProtocol } = vi.hoisted(() => ({
  protocolRegisterFileProtocol: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  protocol: { registerFileProtocol: protocolRegisterFileProtocol },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

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
});

describe('createAppServices environment overrides', () => {
  beforeEach(() => {
    protocolRegisterFileProtocol.mockClear();
    vi.mocked(detectHardware).mockClear();
  });

  test('uses default directories and ComfyUI base URL', async () => {
    const dataDirectory = await useDataDirectory();
    const upstream = await startHttpServer();
    cleanups.push(() => upstream.close());

    const services = await createAppServices({ dataDirectory, comfyBaseUrl: upstream.baseUrl });
    cleanups.push(() => services.close());

    await expect(services.comfy.health()).resolves.toMatchObject({
      system: { os: 'test' },
      devices: [],
    });

    expect(DEFAULT_DATA_DIRECTORY).toBe('G:\\SMO-H3-Data');
    expect(DEFAULT_OUTPUT_DIRECTORY).toBe(
      'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\ComfyUI\\output',
    );
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
