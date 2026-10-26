// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createAppServices,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_INPUT_DIRECTORY,
} from '../../src/main/app-services';
import { AvatarService } from '../../src/main/avatars';
import { bootstrapApplication } from '../../src/main/bootstrap';
import { ComfyClient } from '../../src/main/comfy';
import { FileService } from '../../src/main/files';
import { applyHardwareProfile, detectHardware } from '../../src/main/hardware';
import type { GenerationHandler } from '../../src/main/ipc';
import { JobCoordinator, type JobEvent } from '../../src/main/jobs';
import { LlmService } from '../../src/main/llm';
import { FileLlmConfigStore } from '../../src/main/llm-config';
import { SkillsService } from '../../src/main/skills';
import { Store } from '../../src/main/store';
import { IPC_CHANNELS } from '../../src/shared/ipc';

const { ipcMainHandle, protocolRegisterFileProtocol } = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  protocolRegisterFileProtocol: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: ipcMainHandle },
  protocol: { registerFileProtocol: protocolRegisterFileProtocol },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

const generationRequest = {
  mode: 'text',
  avatarId: 'avatar-1',
  prompt: 'A quiet studio shot.',
  duration: 8,
  seed: 42,
} as const;

const cleanups: Array<() => void | Promise<void>> = [];

async function useDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-bootstrap-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('production application services', () => {
  beforeEach(() => {
    ipcMainHandle.mockReset();
    protocolRegisterFileProtocol.mockClear();
  });

  test('creates the real services in the selected data directory', async () => {
    const dataDirectory = await useDataDirectory();

    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());

    expect(DEFAULT_DATA_DIRECTORY).toBe('G:\\SMO-H3-Data');
    expect(DEFAULT_INPUT_DIRECTORY).toBe(
      'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\ComfyUI\\input',
    );
    expect(existsSync(join(dataDirectory, 'studio.sqlite'))).toBe(true);
    expect(services.store).toBeInstanceOf(Store);
    expect(services.llmConfig).toBeInstanceOf(FileLlmConfigStore);
    expect(services.llm).toBeInstanceOf(LlmService);
    expect(services.skills).toBeInstanceOf(SkillsService);
    expect(services.comfy).toBeInstanceOf(ComfyClient);
    expect(services.jobCoordinator).toBeInstanceOf(JobCoordinator);
    expect(services.avatars).toBeInstanceOf(AvatarService);
    expect(services.files).toBeInstanceOf(FileService);
    expect(protocolRegisterFileProtocol).toHaveBeenCalledWith(
      'smo-media',
      expect.any(Function),
    );
    expect(services.hardware.detect).toBe(detectHardware);
    expect(services.hardware.apply).toBe(applyHardwareProfile);
  });

  test('accepts an injected generation handler', async () => {
    const dataDirectory = await useDataDirectory();
    const generationHandler: GenerationHandler = async () => ({ id: 'job-1' });

    const services = await createAppServices({ dataDirectory, generationHandler });
    cleanups.push(() => services.close());

    expect(services.startGeneration).toBe(generationHandler);
  });

  test('writes queued, running, completed, and failed job states to the Store', async () => {
    const dataDirectory = await useDataDirectory();
    const services = await createAppServices({
      dataDirectory,
      generationHandler: async () => ({ id: 'unused' }),
    });
    cleanups.push(() => services.close());
    const avatar = services.store.createAvatar({
      name: 'Presenter',
      photoPath: 'avatars/presenter.png',
    });
    const addWork = (id: string) =>
      services.store.addWork({
        id,
        avatarId: avatar.id,
        mode: 'text',
        outputPath: null,
        status: 'pending',
      });
    const firstWork = addWork('first');
    const secondWork = addWork('second');
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const first = services.jobCoordinator.enqueue({
      id: firstWork.id,
      run: () => firstGate,
    });
    const second = services.jobCoordinator.enqueue({
      id: secondWork.id,
      run: async () => undefined,
    });

    expect(services.store.listWorks().find((work) => work.id === firstWork.id)?.status).toBe(
      'running',
    );
    expect(services.store.listWorks().find((work) => work.id === secondWork.id)?.status).toBe(
      'pending',
    );

    finishFirst();
    await Promise.all([first, second]);
    expect(services.store.listWorks().find((work) => work.id === firstWork.id)?.status).toBe(
      'done',
    );
    expect(services.store.listWorks().find((work) => work.id === secondWork.id)?.status).toBe(
      'done',
    );

    const failedWork = addWork('failed');
    const failure = new Error('Generation failed in ComfyUI');
    await expect(
      services.jobCoordinator.enqueue({
        id: failedWork.id,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(services.store.listWorks().find((work) => work.id === failedWork.id)).toMatchObject({
      status: 'failed',
      error: failure.message,
      outputPath: null,
    });
  });

  test('reports Store event write failures while allowing the job to settle', async () => {
    const dataDirectory = await useDataDirectory();
    const reports: Array<{ error: unknown; event: JobEvent }> = [];
    const services = await createAppServices({
      dataDirectory,
      generationHandler: async () => ({ id: 'unused' }),
      errorReporter: (error, event) => reports.push({ error, event }),
    });
    cleanups.push(() => services.close());
    const avatar = services.store.createAvatar({
      name: 'Presenter',
      photoPath: 'avatars/presenter.png',
    });
    const work = services.store.addWork({
      id: 'work-with-write-failures',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'pending',
    });
    const writeFailure = new Error('SQLite is read-only');
    const updateWork = vi
      .spyOn(services.store, 'updateWork')
      .mockImplementation(() => {
        throw writeFailure;
      });

    await services.jobCoordinator.enqueue({
      id: work.id,
      run: async () => undefined,
    });
    updateWork.mockRestore();

    expect(reports).toEqual([
      { error: writeFailure, event: { id: work.id, status: 'pending' } },
      { error: writeFailure, event: { id: work.id, status: 'running' } },
      { error: writeFailure, event: { id: work.id, status: 'done' } },
    ]);
    expect(services.jobCoordinator.completedIds).toEqual([work.id]);
    expect(services.jobCoordinator.activeCount).toBe(0);
  });

  test('registers every channel before creating the first window', async () => {
    const dataDirectory = await useDataDirectory();
    const events: string[] = [];
    ipcMainHandle.mockImplementation((channel: string) => {
      events.push(`register:${channel}`);
    });

    const services = await bootstrapApplication({
      dataDirectory,
      createMainWindow: async () => {
        expect(existsSync(join(dataDirectory, 'studio.sqlite'))).toBe(true);
        events.push('createMainWindow');
      },
    });
    cleanups.push(() => services.close());

    expect(services.store).toBeInstanceOf(Store);
    expect(ipcMainHandle.mock.calls.map(([channel]) => channel)).toEqual(
      IPC_CHANNELS,
    );
    expect(events).toEqual([
      ...IPC_CHANNELS.map((channel) => `register:${channel}`),
      'createMainWindow',
    ]);

    const startHandler = ipcMainHandle.mock.calls.find(
      ([channel]) => channel === 'jobs:start',
    )?.[1] as (event: unknown, payload: unknown) => Promise<unknown>;
    await expect(startHandler({}, generationRequest)).rejects.toThrow(
      /avatar not found/i,
    );
  });
});
