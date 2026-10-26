// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createAppServices,
  DEFAULT_DATA_DIRECTORY,
} from '../../src/main/app-services';
import { AvatarService } from '../../src/main/avatars';
import { bootstrapApplication } from '../../src/main/bootstrap';
import { ComfyClient } from '../../src/main/comfy';
import { FileService } from '../../src/main/files';
import { getActiveWorkflow, resetHardwareWorkflow } from "../../src/main/hardware-workflows";
import { detectHardware } from '../../src/main/hardware';
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
    expect(typeof services.hardware.apply).toBe('function');
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

  test("restores a persisted active workflow and clears it through reset", async () => {
    const dataDirectory = await useDataDirectory();
    resetHardwareWorkflow("text");
    const frozenPath = getActiveWorkflow("text");
    const modelDirectory = join(dataDirectory, "models");
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(
      join(modelDirectory, "minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors"),
      "int8",
    );
    const profile = {
      preset: "conservative",
      modelPolicy: "int8",
      megapixels: 0.4,
      lowvram: true,
      tiling: 4,
      requiresConfirmation: true,
    } as const;
    let appliedPath = "";
    const first = await createAppServices({ dataDirectory });
    try {
      const applied = await first.hardware.apply({
        mode: "text",
        profile,
        confirmed: true,
        modelDirectory,
      });
      appliedPath = applied.path;
      expect(
        JSON.parse(
          await readFile(join(dataDirectory, "workflow-profiles", "active-workflows.json"), "utf8"),
        ),
      ).toEqual({ text: appliedPath });
    } finally {
      first.close();
    }

    resetHardwareWorkflow("text");
    const second = await createAppServices({ dataDirectory });
    try {
      expect(getActiveWorkflow("text")).toBe(appliedPath);
      await expect(second.hardware.reset("text")).resolves.toBe(frozenPath);
      expect(getActiveWorkflow("text")).toBe(frozenPath);
      expect(
        JSON.parse(
          await readFile(join(dataDirectory, "workflow-profiles", "active-workflows.json"), "utf8"),
        ),
      ).toEqual({});
    } finally {
      second.close();
    }

    const reopened = await createAppServices({ dataDirectory });
    cleanups.push(() => reopened.close());
    expect(getActiveWorkflow("text")).toBe(frozenPath);
  });

  test.each([
    { scenario: "invalid JSON", contents: "{not-json" },
    {
      scenario: "an escaping path",
      contents: JSON.stringify({ text: join(tmpdir(), "outside.json") }),
    },
    {
      scenario: "unsupported fields",
      contents: JSON.stringify({ text: { path: "balanced-16gb-text.json" }, video: "x" }),
    },
  ])("ignores $scenario in active-workflows.json", async ({ contents }) => {
    const dataDirectory = await useDataDirectory();
    const profilesDirectory = join(dataDirectory, "workflow-profiles");
    await mkdir(profilesDirectory, { recursive: true });
    await writeFile(join(profilesDirectory, "active-workflows.json"), contents);
    resetHardwareWorkflow("text");
    const frozenPath = getActiveWorkflow("text");

    const services = await createAppServices({ dataDirectory });
    try {
      expect(getActiveWorkflow("text")).toBe(frozenPath);
    } finally {
      services.close();
    }
  });

  test("rejects the whole persisted mapping when any entry is invalid", async () => {
    const dataDirectory = await useDataDirectory();
    const profilesDirectory = join(dataDirectory, "workflow-profiles");
    await mkdir(profilesDirectory, { recursive: true });
    const validTextPath = join(profilesDirectory, "balanced-16gb-text.json");
    await writeFile(validTextPath, "{}");
    await writeFile(
      join(profilesDirectory, "active-workflows.json"),
      JSON.stringify({ text: validTextPath, audio: join(tmpdir(), "outside.json") }),
    );
    resetHardwareWorkflow("text");
    resetHardwareWorkflow("audio");
    const frozenText = getActiveWorkflow("text");
    const frozenAudio = getActiveWorkflow("audio");

    const services = await createAppServices({ dataDirectory });
    try {
      expect(getActiveWorkflow("text")).toBe(frozenText);
      expect(getActiveWorkflow("audio")).toBe(frozenAudio);
    } finally {
      services.close();
    }
  });

  test("new generation uses the confirmed active copy without contacting ComfyUI", async () => {
    const dataDirectory = await useDataDirectory();
    const modelDirectory = join(dataDirectory, "models");
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(
      join(modelDirectory, "minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors"),
      "int8",
    );
    const photoPath = join(dataDirectory, "avatar.png");
    await writeFile(photoPath, "avatar");
    const services = await createAppServices({ dataDirectory });
    cleanups.push(() => services.close());
    const applied = await services.hardware.apply({
      mode: "text",
      profile: {
        preset: "conservative",
        modelPolicy: "int8",
        megapixels: 0.4,
        lowvram: true,
        tiling: 4,
        requiresConfirmation: true,
      },
      confirmed: true,
      modelDirectory,
    });
    const avatar = services.store.createAvatar({ name: "Presenter", photoPath });
    vi.spyOn(services.comfy, "uploadFile").mockResolvedValue("uploaded/avatar.png");
    const submit = vi.spyOn(services.comfy, "submit").mockResolvedValue({
      prompt_id: "prompt-active",
      number: 1,
      node_errors: {},
    });
    vi.spyOn(services.comfy, "waitForCompletion").mockResolvedValue(undefined);
    vi.spyOn(services.comfy, "history").mockResolvedValue([
      {
        nodeId: "180",
        kind: "gifs",
        filename: "result.mp4",
        subfolder: "SMO-H3",
        type: "output",
      },
    ]);

    const queued = await services.startGeneration({ ...generationRequest, avatarId: avatar.id });
    await vi.waitFor(() => {
      expect(services.store.getWork(queued.id)?.status).toBe("done");
    });

    expect(services.store.getWork(queued.id)?.metadata).toMatchObject({
      workflowVersion: applied.path,
    });
    expect(submit.mock.calls[0][0]).toMatchObject({
      "115": { inputs: { megapixels: 0.4 } },
    });
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
