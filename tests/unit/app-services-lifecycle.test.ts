// @vitest-environment node

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ComfyProcessManager } from '../../src/main/comfy-process';
import { createAppServices } from '../../src/main/app-services';
import { MediaComponentService } from '../../src/main/media-components';
import { SpeechProcessManager } from '../../src/main/speech-process';

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

class FakeSpeechChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  killed = false;

  readonly kill = vi.fn(() => {
    if (this.exitCode !== null) return false;
    this.killed = true;
    queueMicrotask(() => this.emitExit(null));
    return true;
  });

  emitExit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

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
  test('startComfy delegates to the ComfyUI process manager', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });
    const stats = { system: { os: 'test' }, devices: [] };
    const ensureReady = vi
      .spyOn(ComfyProcessManager.prototype, 'ensureReady')
      .mockResolvedValue(stats);

    try {
      await expect(services.startComfy()).resolves.toEqual(stats);
      expect(ensureReady).toHaveBeenCalledTimes(1);
    } finally {
      ensureReady.mockRestore();
      await services.close();
    }
  });

  test('close stops the ComfyUI process manager after the coordinator and before ComfyClient', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });

    const order: string[] = [];
    vi.spyOn(services.jobCoordinator, 'close').mockImplementation(async () => {
      order.push('coordinator');
    });
    const managerClose = vi
      .spyOn(ComfyProcessManager.prototype, 'close')
      .mockImplementation(async () => {
        order.push('manager');
      });
    vi.spyOn(services.comfy, 'close').mockImplementation(async () => {
      order.push('comfy');
    });
    const storeClose = vi.spyOn(services.store, 'close');

    try {
      await services.close();

      expect(order).toEqual(['coordinator', 'manager', 'comfy']);
      expect(managerClose).toHaveBeenCalledTimes(1);
      expect(storeClose).toHaveBeenCalledTimes(1);
    } finally {
      managerClose.mockRestore();
    }
  });

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

    let rejectRun!: (reason: Error) => void;
    let releaseCleanup!: () => void;
    let cancelRequested = false;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const run = services.jobCoordinator.enqueue({
      id: 'active-work',
      run: async () => {
        try {
          await new Promise<void>((_resolve, reject) => {
            rejectRun = reject;
          });
        } finally {
          await cleanup;
        }
      },
      cancel: async () => {
        cancelRequested = true;
        rejectRun(new Error('Generation cancelled'));
      },
    });
    const runRejection = expect(run).rejects.toThrow(/cancelled/i);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(services.jobCoordinator.activeCount).toBe(1);

    let failedWorkBeforeStoreClose = false;
    const realClose = services.store.close.bind(services.store);
    const storeClose = vi.spyOn(services.store, 'close').mockImplementation(() => {
      failedWorkBeforeStoreClose =
        services.store.listWorks().some((work) => work.status === 'failed');
      return realClose();
    });

    const closePromise = services.close();
    await vi.waitFor(() => expect(cancelRequested).toBe(true));
    const storeCloseCallsBeforeCleanup = storeClose.mock.calls.length;
    releaseCleanup();
    await runRejection;
    await closePromise;

    expect(storeCloseCallsBeforeCleanup).toBe(0);
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

  test('close retries the full shutdown chain after JobCoordinator close fails', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({ dataDirectory });
    let storeClosed = false;
    cleanups.push(() => {
      if (!storeClosed) services.store.close();
    });
    const order: string[] = [];
    const closeFailure = new Error('injected coordinator close timeout');
    const originalCoordinatorClose = services.jobCoordinator.close.bind(
      services.jobCoordinator,
    );
    const coordinatorClose = vi.spyOn(services.jobCoordinator, 'close');
    coordinatorClose
      .mockImplementationOnce(async () => {
        order.push('coordinator-failed');
        throw closeFailure;
      })
      .mockImplementation(async () => {
        order.push('coordinator');
        await originalCoordinatorClose();
      });
    const speechClose = vi
      .spyOn(SpeechProcessManager.prototype, 'close')
      .mockImplementation(async () => {
        order.push('speech-process');
      });
    const componentCancel = vi
      .spyOn(MediaComponentService.prototype, 'cancel')
      .mockImplementation((id) => {
        order.push(`cancel-${id}`);
      });
    const managerClose = vi
      .spyOn(ComfyProcessManager.prototype, 'close')
      .mockImplementation(async () => {
        order.push('comfy-process');
      });
    const comfyClose = vi.spyOn(services.comfy, 'close').mockImplementation(async () => {
      order.push('comfy-client');
    });
    const realStoreClose = services.store.close.bind(services.store);
    const storeClose = vi.spyOn(services.store, 'close').mockImplementation(() => {
      order.push('store');
      storeClosed = true;
      realStoreClose();
    });

    try {
      const firstClose = services.close();
      const concurrentClose = services.close();
      const concurrentCloseShared = concurrentClose === firstClose;
      void concurrentClose.catch(() => undefined);
      await expect(firstClose).rejects.toBe(closeFailure);
      expect(speechClose).not.toHaveBeenCalled();
      expect(managerClose).not.toHaveBeenCalled();
      expect(storeClose).not.toHaveBeenCalled();

      await expect(services.close()).resolves.toBeUndefined();
      const successfulClose = services.close();
      expect(services.close()).toBe(successfulClose);
      await successfulClose;

      expect(concurrentCloseShared).toBe(true);
      expect(coordinatorClose).toHaveBeenCalledTimes(2);
      expect(speechClose).toHaveBeenCalledTimes(1);
      expect(componentCancel).toHaveBeenCalledTimes(2);
      expect(managerClose).toHaveBeenCalledTimes(1);
      expect(comfyClose).toHaveBeenCalledTimes(1);
      expect(storeClose).toHaveBeenCalledTimes(1);
      expect(order).toEqual([
        'coordinator-failed',
        'coordinator',
        'speech-process',
        'cancel-speech',
        'cancel-image',
        'comfy-process',
        'comfy-client',
        'store',
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('close retains the same speech process for a real second kill before closing Store', async () => {
    const dataDirectory = await useDataDirectory();
    const child = new FakeSpeechChild();
    const manager = new SpeechProcessManager({
      pythonPath: 'fake-python.exe',
      serviceScript: 'fake-service.py',
      modelDirectory: dataDirectory,
      startupTimeoutMs: 100,
      healthTimeoutMs: 50,
      shutdownTimeoutMs: 5,
      pollIntervalMs: 1,
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.write('SMO_SPEECH_URL=http://127.0.0.1:43127\n');
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
      fetchImpl: async (input) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (url.pathname === '/health') return Response.json({ ok: true });
        return new Response(null, { status: 503 });
      },
    });
    const speechProcessFactory = vi.fn(() => manager);
    const services = await createAppServices({
      dataDirectory,
      speechProcessFactory,
    });
    let storeClosed = false;
    cleanups.push(() => {
      if (!storeClosed) services.store.close();
    });
    const managerClose = vi.spyOn(manager, 'close');
    vi.spyOn(ComfyProcessManager.prototype, 'close').mockResolvedValue(undefined);
    const realStoreClose = services.store.close.bind(services.store);
    const storeClose = vi.spyOn(services.store, 'close').mockImplementation(() => {
      storeClosed = true;
      realStoreClose();
    });
    await manager.start();
    child.kill
      .mockImplementationOnce(() => {
        child.killed = true;
        child.emit('error', new Error('injected first kill error'));
        return true;
      })
      .mockImplementationOnce(() => {
        child.killed = true;
        child.emitExit(0);
        return true;
      });

    try {
      await expect(services.close()).rejects.toThrow(/process.*error|kill/i);
      expect(storeClose).not.toHaveBeenCalled();

      await expect(services.close()).resolves.toBeUndefined();

      expect(speechProcessFactory).toHaveBeenCalledTimes(1);
      expect(managerClose).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.exitCode).toBe(0);
      expect(storeClose).toHaveBeenCalledTimes(1);
      await services.close();
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(managerClose).toHaveBeenCalledTimes(2);
      expect(storeClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('reopening services fails interrupted works and reserves completed ones', async () => {
    const dataDirectory = await useDataDirectory();

    const first = await createAppServices({ dataDirectory });
    const avatar = first.store.createAvatar({
      name: 'Presenter',
      photoPath: 'avatars/presenter.png',
    });
    first.store.addWork({
      id: 'running-work',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'running',
    });
    first.store.addWork({
      id: 'pending-work',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'pending',
    });
    first.store.addWork({
      id: 'done-work',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: 'output/done-work.mp4',
      status: 'done',
    });
    await first.close();

    const second = await createAppServices({ dataDirectory });
    try {
      const works = new Map(second.store.listWorks().map((work) => [work.id, work]));

      const running = works.get('running-work');
      expect(running?.status).toBe('failed');
      expect(running?.error).toMatch(/interrupted.*restart/i);

      const pending = works.get('pending-work');
      expect(pending?.status).toBe('failed');
      expect(pending?.error).toMatch(/interrupted.*restart/i);

      expect(works.get('done-work')?.status).toBe('done');
      expect(second.jobCoordinator.completedIds).toEqual(['done-work']);
      expect(second.jobCoordinator.activeCount).toBe(0);

      expect(() =>
        second.jobCoordinator.enqueue({
          id: 'done-work',
          run: async () => undefined,
        }),
      ).toThrow(/duplicate job id/i);
    } finally {
      await second.close();
    }
  });
});
