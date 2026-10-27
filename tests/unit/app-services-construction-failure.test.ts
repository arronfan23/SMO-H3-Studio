// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { protocolRegisterFileProtocol } = vi.hoisted(() => ({
  protocolRegisterFileProtocol: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  protocol: { registerFileProtocol: protocolRegisterFileProtocol },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

const cleanups: Array<() => void | Promise<void>> = [];

async function useDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-construction-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.resetModules();
});

describe('createAppServices construction failure', () => {
  test('releases ComfyClient, JobCoordinator, and Store when construction fails', async () => {
    const comfyClose = vi.fn().mockResolvedValue(undefined);
    const coordinatorClose = vi.fn().mockResolvedValue(undefined);
    const coordinatorRecover = vi.fn();
    const storeClose = vi.fn();
    const managerState: {
      options: unknown;
      closes: number;
    } = { options: undefined, closes: 0 };

    vi.doMock('../../src/main/comfy', () => ({
      ComfyClient: vi.fn(function () {
        return {
          close: comfyClose,
          health: vi.fn().mockResolvedValue({
            system: { os: 'test' },
            devices: [],
          }),
        };
      }),
    }));

    vi.doMock('../../src/main/jobs', () => ({
      JobCoordinator: vi.fn(function () {
        return {
          close: coordinatorClose,
          recover: coordinatorRecover,
          enqueue: vi.fn(),
          cancel: vi.fn(),
          cancelActive: vi.fn(),
        };
      }),
    }));

    vi.doMock('../../src/main/store', () => ({
      Store: vi.fn(function () {
        return {
          close: storeClose,
          listAvatars: vi.fn().mockReturnValue([]),
          addWork: vi.fn(),
          updateWork: vi.fn(),
          listWorks: vi.fn().mockReturnValue([]),
          getWork: vi.fn().mockReturnValue(null),
        };
      }),
    }));

    vi.doMock('../../src/main/generation', () => ({
      createGenerationHandler: vi.fn(() => {
        throw new Error('construction failed after services created');
      }),
      createRetryHandler: vi.fn(),
    }));

    vi.doMock('../../src/main/comfy-process', () => ({
      DEFAULT_COMFY_ROOT: 'G:\\default-comfy-root',
      ComfyProcessManager: vi.fn(function (options: unknown) {
        managerState.options = options;
        return {
          ensureReady: vi.fn(),
          close: vi.fn().mockImplementation(async () => {
            managerState.closes += 1;
          }),
        };
      }),
    }));

    const { createAppServices } = await import('../../src/main/app-services');
    const dataDirectory = await useDataDirectory();

    await expect(createAppServices({ dataDirectory })).rejects.toThrow(
      'construction failed after services created',
    );

    expect(comfyClose).toHaveBeenCalledTimes(1);
    expect(coordinatorClose).toHaveBeenCalledTimes(1);
    expect(storeClose).toHaveBeenCalledTimes(1);
    expect(managerState.closes).toBe(1);
    expect(managerState.options).toMatchObject({
      rootDirectory: 'G:\\default-comfy-root',
    });
    expect(coordinatorRecover).toHaveBeenCalledWith([]);
  });

  test('uses SMO_COMFYUI_ROOT and the data-directory log for the ComfyUI process manager', async () => {
    const managerOptions: unknown[] = [];
    vi.doMock('../../src/main/generation', () => ({
      createGenerationHandler: vi.fn(() => async () => ({ id: 'job' })),
      createRetryHandler: vi.fn(() => async () => ({ id: 'job' })),
    }));
    vi.doMock('../../src/main/comfy-process', () => ({
      DEFAULT_COMFY_ROOT: 'G:\\default-comfy-root',
      ComfyProcessManager: vi.fn(function (options: unknown) {
        managerOptions.push(options);
        return {
          ensureReady: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }));

    process.env.SMO_COMFYUI_ROOT = 'G:\\custom-comfy-root';
    try {
      const { createAppServices } = await import('../../src/main/app-services');
      const dataDirectory = await useDataDirectory();
      const services = await createAppServices({ dataDirectory });
      cleanups.push(() => services.close());

      expect(managerOptions).toHaveLength(1);
      expect(managerOptions[0]).toMatchObject({
        rootDirectory: 'G:\\custom-comfy-root',
        logPath: join(dataDirectory, 'logs', 'comfyui-backend.log'),
      });
    } finally {
      delete process.env.SMO_COMFYUI_ROOT;
    }
  });

  test.each([
    { name: 'empty string', value: '' },
    { name: 'whitespace', value: '   ' },
  ])('falls back to DEFAULT_COMFY_ROOT when SMO_COMFYUI_ROOT is $name', async ({ value }) => {
    const managerOptions: unknown[] = [];
    vi.doMock('../../src/main/generation', () => ({
      createGenerationHandler: vi.fn(() => async () => ({ id: 'job' })),
      createRetryHandler: vi.fn(() => async () => ({ id: 'job' })),
    }));
    vi.doMock('../../src/main/comfy-process', () => ({
      DEFAULT_COMFY_ROOT: 'G:\\default-comfy-root',
      ComfyProcessManager: vi.fn(function (options: unknown) {
        managerOptions.push(options);
        return {
          ensureReady: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }));

    process.env.SMO_COMFYUI_ROOT = value;
    try {
      const { createAppServices } = await import('../../src/main/app-services');
      const dataDirectory = await useDataDirectory();
      const services = await createAppServices({ dataDirectory });
      cleanups.push(() => services.close());

      expect(managerOptions).toHaveLength(1);
      expect(managerOptions[0]).toMatchObject({
        rootDirectory: 'G:\\default-comfy-root',
      });
    } finally {
      delete process.env.SMO_COMFYUI_ROOT;
    }
  });
});
