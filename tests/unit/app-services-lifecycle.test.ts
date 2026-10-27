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

  test('close awaits all component releases and does not stop on one failure', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });

    const comfyClose = vi
      .spyOn(services.comfy, 'close')
      .mockRejectedValueOnce(new Error('comfy close failed'));
    const coordinatorClose = vi.spyOn(services.jobCoordinator, 'close');
    const storeClose = vi.spyOn(services.store, 'close');

    await expect(services.close()).resolves.toBeUndefined();

    expect(coordinatorClose).toHaveBeenCalledTimes(1);
    expect(comfyClose).toHaveBeenCalledTimes(1);
    expect(storeClose).toHaveBeenCalledTimes(1);
  });

  test('close waits for jobCoordinator so active job failed events reach Store before Store closes', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });

    const avatar = services.store.createAvatar({
      name: 'Presenter',
      photoPath: 'avatars/presenter.png',
    });
    services.store.addWork({
      id: 'active-work',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'pending',
    });

    const run = services.jobCoordinator.enqueue({
      id: 'active-work',
      run: async () => {
        await new Promise(() => undefined);
      },
      cancel: async () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(services.jobCoordinator.activeCount).toBe(1);

    let failedWorkBeforeStoreClose = false;
    const realClose = services.store.close.bind(services.store);
    vi.spyOn(services.store, 'close').mockImplementation(() => {
      failedWorkBeforeStoreClose =
        services.store.listWorks().some((work) => work.status === 'failed');
      return realClose();
    });

    const closePromise = services.close();
    await expect(run).rejects.toThrow(/cancelled/i);
    await closePromise;

    expect(failedWorkBeforeStoreClose).toBe(true);
  });

  test('close is idempotent and only releases components once', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });

    const comfyClose = vi.spyOn(services.comfy, 'close');
    const coordinatorClose = vi.spyOn(services.jobCoordinator, 'close');
    const storeClose = vi.spyOn(services.store, 'close');

    await services.close();
    await services.close();
    await services.close();

    expect(comfyClose).toHaveBeenCalledTimes(1);
    expect(coordinatorClose).toHaveBeenCalledTimes(1);
    expect(storeClose).toHaveBeenCalledTimes(1);
    expect(services.store).toBeDefined();
  });
});
