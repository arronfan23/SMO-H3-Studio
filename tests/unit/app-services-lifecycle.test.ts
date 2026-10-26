// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppServices } from '../../src/main/app-services';

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

const cleanups: Array<() => void | Promise<void>> = [];

async function useDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-lifecycle-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('AppServices lifecycle', () => {
  test('close releases ComfyClient, JobCoordinator, and Store', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });

    const comfyClose = vi.spyOn(services.comfy, 'close');
    const coordinatorClose = vi.spyOn(services.jobCoordinator, 'close');
    const storeClose = vi.spyOn(services.store, 'close');

    await services.close();

    expect(comfyClose).toHaveBeenCalledTimes(1);
    expect(coordinatorClose).toHaveBeenCalledTimes(1);
    expect(storeClose).toHaveBeenCalledTimes(1);
  });

  test('close is idempotent', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });

    await services.close();
    await services.close();

    expect(services.store).toBeDefined();
  });
});
