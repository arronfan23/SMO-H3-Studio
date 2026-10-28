// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ComfyClient } from '../../src/main/comfy';
import { AvatarService } from '../../src/main/avatars';
import { FileService } from '../../src/main/files';
import { recommendHardware } from "../../src/main/hardware";
import { HardwareWorkflowStore } from '../../src/main/hardware-workflows';
import {
  registerIpc,
  type IpcHandler,
  type IpcHandlerRegistry,
  type IpcServices,
} from '../../src/main/ipc';
import { JobCoordinator } from '../../src/main/jobs';
import { LlmService } from '../../src/main/llm';
import { FileLlmConfigStore } from '../../src/main/llm-config';
import { SkillsService } from '../../src/main/skills';
import { Store } from '../../src/main/store';
import { MediaRegistry } from '../../src/main/media';
import {
  createIpcSchema,
  IPC_CHANNELS,
  type IpcChannel,
  type SmoApi,
} from '../../src/shared/ipc';
import type { Avatar, HardwareInfo, Work } from '../../src/shared/types';
import {
  startLlmUpstream,
  type LocalLlmUpstream,
} from '../fixtures/llm-upstream';

const { cipher, exposeInMainWorld, ipcMainHandle, ipcRendererInvoke } = vi.hoisted(() => {
  const prefix = Buffer.from('ipc-test-cipher\0');
  const transform = (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x5a));

  return {
    exposeInMainWorld: vi.fn(),
    ipcMainHandle: vi.fn(),
    ipcRendererInvoke: vi.fn(),
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) =>
        Buffer.concat([prefix, transform(Buffer.from(value, 'utf8'))]),
      decryptString: (value: Buffer) => {
        if (!value.subarray(0, prefix.length).equals(prefix)) {
          throw new Error('Invalid test ciphertext');
        }
        return transform(value.subarray(prefix.length)).toString('utf8');
      },
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcMain: { handle: ipcMainHandle },
  ipcRenderer: { invoke: ipcRendererInvoke },
  safeStorage: cipher,
}));

const generationRequest = {
  mode: 'text',
  avatarId: 'avatar-1',
  prompt: 'A quiet studio shot.',
  duration: 8,
  seed: 42,
} as const;

const polishRequest = {
  text: 'Animate this presenter photo.',
  duration: 8,
  imageCount: 1,
  videoCount: 0,
  referenceLabels: ['<Picture 1>'],
  skill: 'h3-prompt-writing',
  mode: 'ref2va',
} as const;

const hardwareProfile = {
  preset: 'balanced-16gb',
  modelPolicy: 'int8',
  megapixels: 0.7,
  lowvram: true,
  tiling: 'auto',
  requiresConfirmation: true,
} as const;

const hardwareInfo: HardwareInfo = {
  gpu: 'Test GPU',
  vramGiB: 16,
  ramGiB: 64,
  windowsVersion: 'Windows 11',
  driverVersion: 'test-driver',
  cudaComputeCapability: '12.0',
  freeDiskGiB: 512,
};

class TestIpcRegistry implements IpcHandlerRegistry {
  readonly handlers = new Map<string, IpcHandler>();

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Duplicate test handler: ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, payload: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No test handler registered for ${channel}`);
    }
    return Promise.resolve(handler(payload));
  }
}

const upstreams: LocalLlmUpstream[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function useUpstream(
  handler: Parameters<typeof startLlmUpstream>[0],
): Promise<LocalLlmUpstream> {
  const upstream = await startLlmUpstream(handler);
  upstreams.push(upstream);
  return upstream;
}

async function createHarness(overrides: Partial<IpcServices> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'smo-ipc-handlers-'));
  const store = new Store(':memory:');
  const llmConfig = new FileLlmConfigStore(
    join(directory, 'llm-config.json'),
    cipher,
  );
  const jobCoordinator = new JobCoordinator();
  const registry = new TestIpcRegistry();
  const showOpenDialog = vi.fn();
  const mediaRegistry = new MediaRegistry({
    avatarsDirectory: join(directory, 'avatars'),
    outputDirectory: join(directory, 'output'),
  });
  const hardwareWorkflows = new HardwareWorkflowStore({
    profilesDirectory: join(directory, 'workflow-profiles'),
  });
  const services: IpcServices = {
    startGeneration: async () => ({ id: 'injected-job' }),
    retryWork: async () => ({ id: 'injected-retry' }),
    jobCoordinator,
    llm: {
      listModels: async () => {
        throw new Error('Unexpected listModels call');
      },
      testModel: async () => {
        throw new Error('Unexpected testModel call');
      },
    },
    skills: {
      polish: async () => {
        throw new Error('Unexpected polish call');
      },
    },
    llmConfig,
    store,
    avatars: new AvatarService({
      avatarsDirectory: join(directory, 'avatars'),
      store,
      mediaRegistry,
    }),
    files: new FileService({ mediaRegistry, dialog: { showOpenDialog }, outputDirectory: join(directory, 'output'), dataDirectory: directory }),
    comfy: {
      health: async () => ({ system: {}, devices: [] }),
    },
    startComfy: async () => ({ system: {}, devices: [] }),
    openComfy: async () => undefined,
    hardware: {
      detect: async () => hardwareInfo,
      recommend: async (input) => recommendHardware(input),
      apply: (request) => hardwareWorkflows.apply(request),
      reset: (mode) => hardwareWorkflows.reset(mode),
    },
    ...overrides,
  };

  registerIpc(services, registry);
  cleanups.push(
    () => store.close(),
    () => rm(directory, { recursive: true, force: true }),
  );

  return {
    directory,
    jobCoordinator,
    llmConfig,
    registry,
    showOpenDialog,
    services,
    store,
    invoke: (channel: IpcChannel, payload: unknown = {}) =>
      registry.invoke(channel, payload),
  };
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function validRefPrompt(): string {
  return [
    'subject_definitions:\n<Subject 1> is the presenter identified by <Picture 1>.',
    'summary:\n[reference generation] The target video shows <Subject 1> in a quiet studio.',
    'retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - the supplied identity is retained.',
    'detailed_description:\n[Shot 1] Live-action, <Subject 1> sits still in a quiet studio.',
    'overall_soundscape: Soft room tone continues throughout the video.',
    'non_diegetic_music: N/A',
  ].join('\n\n');
}

afterEach(async () => {
  const pending = [
    ...upstreams.splice(0).map((upstream) => () => upstream.close()),
    ...cleanups.splice(0),
  ];
  await Promise.all(pending.map((cleanup) => cleanup()));
});

describe('IPC input schema', () => {
  test('rejects an unknown channel', () => {
    const schema = createIpcSchema();

    expect(() =>
      schema.parse({ channel: 'shell:exec', payload: { command: 'dir' } }),
    ).toThrow();
  });

  test('rejects audio generation without an audio path', () => {
    const schema = createIpcSchema();

    expect(() =>
      schema.parse({
        channel: 'jobs:start',
        payload: { ...generationRequest, mode: 'audio' },
      }),
    ).toThrow(/audioPath/i);
  });

  test.each([
    { channel: 'files:selectImage', payload: {} },
    { channel: 'files:selectAudio', payload: {} },
    { channel: 'files:mediaUrl', payload: { path: 'G:\\media\\result.mp4' } },
  ])('accepts controlled file request $channel', (request) => {
    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test('rejects a media URL request with an empty path or extra fields', () => {
    expect(() =>
      createIpcSchema().parse({ channel: 'files:mediaUrl', payload: { path: '' } }),
    ).toThrow();
    expect(() =>
      createIpcSchema().parse({
        channel: 'files:mediaUrl',
        payload: { path: 'G:\\media\\result.mp4', shell: true },
      }),
    ).toThrow();
  });

  test('accepts a complete audio generation request', () => {
    const schema = createIpcSchema();
    const request = {
      channel: 'jobs:start',
      payload: {
        ...generationRequest,
        mode: 'audio',
        audioPath: 'G:\\audio\\voice.mp3',
        trimStart: 0.5,
      },
    };

    expect(schema.parse(request)).toEqual(request);
  });

  test.each([
    'jobs:cancel',
    'llm:getProfile',
    'avatars:list',
    'works:list',
    'comfy:health',
    'comfy:start',
    'hardware:detect',
  ])('accepts %s with an empty payload', (channel) => {
    const request = { channel, payload: {} };

    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test('accepts the remaining domain-specific payloads', () => {
    const schema = createIpcSchema();

    expect(
      schema.parse({
        channel: 'llm:saveProfile',
        payload: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'local-model',
          apiKey: 'secret',
        },
      }).channel,
    ).toBe('llm:saveProfile');
    expect(
      schema.parse({
        channel: 'llm:polish',
        payload: polishRequest,
      }).channel,
    ).toBe('llm:polish');
    expect(
      schema.parse({
        channel: 'avatars:create',
        payload: { name: 'Presenter', photoPath: 'G:\\avatars\\presenter.png' },
      }).channel,
    ).toBe('avatars:create');
    expect(
      schema.parse({
        channel: 'avatars:update',
        payload: { id: 'avatar-1', name: 'Renamed' },
      }),
    ).toEqual({
      channel: 'avatars:update',
      payload: { id: 'avatar-1', name: 'Renamed' },
    });
    expect(
      schema.parse({ channel: 'avatars:delete', payload: { id: 'avatar-1' } }),
    ).toEqual({ channel: 'avatars:delete', payload: { id: 'avatar-1' } });

    const hardware = schema.parse({
      channel: 'hardware:apply',
      payload: {
        mode: 'text',
        profile: hardwareProfile,
        confirmed: true,
        modelDirectory: 'G:\\models',
      },
    });
    expect(hardware).toMatchObject({
      payload: { mode: 'text', profile: hardwareProfile },
    });
  });

  test("accepts hardware recommendation and reset requests", () => {
    const recommendation = {
      channel: "hardware:recommend",
      payload: { gpu: "RTX 5080", vramGiB: 16, ramGiB: 64 },
    };
    const reset = { channel: "hardware:reset", payload: { mode: "audio" } };

    expect(createIpcSchema().parse(recommendation)).toEqual(recommendation);
    expect(createIpcSchema().parse(reset)).toEqual(reset);
  });

  test("hardware apply rejects a renderer-supplied graph", () => {
    expect(() =>
      createIpcSchema().parse({
        channel: "hardware:apply",
        payload: {
          mode: "text",
          profile: hardwareProfile,
          confirmed: true,
          modelDirectory: "G:\\models",
          graph: { injected: { class_type: "Anything", inputs: {} } },
        },
      }),
    ).toThrow();
  });

  test.each([
    { channel: 'jobs:retry', payload: { id: '' } },
    { channel: 'files:openFolder', payload: { path: '' } },
    { channel: 'files:openFolder', payload: { path: 'G:\\output', extra: true } },
    { channel: 'comfy:open', payload: { url: 'http://example.com' } },
    { channel: 'avatars:update', payload: { id: '', name: 'Renamed' } },
    { channel: 'avatars:update', payload: { id: 'avatar-1', name: ' ' } },
    { channel: 'avatars:update', payload: { id: 'avatar-1', name: 'Renamed', photoPath: 'x' } },
    { channel: 'avatars:delete', payload: { id: '' } },
    { channel: 'avatars:delete', payload: { id: 'avatar-1', force: true } },
  ])('rejects invalid avatar mutation input: %j', (request) => {
    expect(() => createIpcSchema().parse(request)).toThrow();
  });



  test.each([
    { prompt: '' },
    { prompt: '   ' },
    { duration: 0 },
    { duration: -1 },
    { duration: Number.POSITIVE_INFINITY },
    { duration: Number.NaN },
    { seed: -1 },
    { seed: 1.5 },
    { seed: Number.POSITIVE_INFINITY },
    { trimStart: -0.1 },
    { trimStart: Number.POSITIVE_INFINITY },
  ])('rejects invalid generation values: %j', (override) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...generationRequest, ...override },
      }),
    ).toThrow();
  });

  test.each([
    'not-a-url',
    'ftp://example.com/v1',
    'https://user:secret@example.com/v1',
    'https://example.com/v1?apiKey=secret',
    'https://example.com/v1#fragment',
  ])('rejects an unsafe LLM base URL: %s', (baseUrl) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'llm:saveProfile',
        payload: { baseUrl, model: 'model-a', apiKey: 'secret' },
      }),
    ).toThrow();
  });

  test.each([{ model: ' ' }])(
    'rejects incomplete LLM profile input: %j',
    (override) => {
      expect(() =>
        createIpcSchema().parse({
          channel: 'llm:saveProfile',
          payload: {
            baseUrl: 'https://example.com/v1',
            apiKey: 'secret',
            ...override,
          },
        }),
      ).toThrow();
    },
  );

  test.each([
    { channel: 'llm:saveProfile', payload: { baseUrl: 'https://example.com/v1', model: 'model-a' } },
    { channel: 'llm:listModels', payload: { baseUrl: 'https://example.com/v1', model: 'model-a' } },
    { channel: 'llm:testModel', payload: { baseUrl: 'https://example.com/v1', model: 'model-a' } },
  ])(
    'accepts an optional empty API key in $channel so the saved key can be preserved',
    ({ channel, payload }) => {
      expect(createIpcSchema().parse({ channel, payload }).channel).toBe(channel);
    },
  );

  test('accepts a model discovery request without a model selection', () => {
    const request = {
      channel: 'llm:listModels',
      payload: { baseUrl: 'https://example.com/v1', apiKey: 'renderer-key' },
    };

    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test.each([
    {
      channel: 'llm:listModels',
      payload: { apiKey: 'renderer-key' },
      pattern: /base URL|invalid/i,
    },
    {
      channel: 'llm:listModels',
      payload: { baseUrl: 'https://example.com/v1', model: ' ' },
      pattern: /empty/i,
    },
    {
      channel: 'llm:testModel',
      payload: { baseUrl: 'https://example.com/v1', apiKey: 'renderer-key' },
      pattern: /string|empty/i,
    },
  ])(
    'rejects incomplete model discovery/test input on $channel',
    ({ channel, payload, pattern }) => {
      expect(() =>
        createIpcSchema().parse({ channel, payload }),
      ).toThrow(pattern);
    },
  );

  test.each([
    { channel: 'llm:listModels', payload: { apiKey: 'renderer-key' } },
    { channel: 'llm:testModel', payload: { apiKey: 'renderer-key' } },
    {
      channel: 'llm:polish',
      payload: { ...polishRequest, apiKey: 'renderer-key' },
    },
    {
      channel: 'jobs:start',
      payload: { ...generationRequest, apiKey: 'renderer-key' },
    },
  ])('rejects undeclared renderer fields on $channel', (request) => {
    expect(() => createIpcSchema().parse(request)).toThrow();
  });

  test.each([
    { text: ' ' },
    { duration: 0 },
    { duration: Number.NaN },
    { imageCount: 10 },
    { videoCount: 4 },
    { referenceLabels: ['G:\\private\\avatar.png'] },
    { skill: 'unknown-skill' },
    { mode: 'unknown-mode' },
  ])('rejects invalid polish values: %j', (override) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'llm:polish',
        payload: { ...polishRequest, ...override },
      }),
    ).toThrow();
  });
});

describe('main-process IPC handlers', () => {
  test('registers exactly the whitelisted channels', async () => {
    const harness = await createHarness();

    expect([...harness.registry.handlers.keys()].sort()).toEqual(
      [...IPC_CHANNELS].sort(),
    );
  });

  test('uses ipcMain.handle for the default Electron registration', async () => {
    const harness = await createHarness();
    ipcMainHandle.mockClear();

    registerIpc(harness.services);

    expect(ipcMainHandle.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...IPC_CHANNELS].sort(),
    );
    const getProfile = ipcMainHandle.mock.calls.find(
      ([channel]) => channel === 'llm:getProfile',
    )?.[1];
    await expect(getProfile?.({}, {})).resolves.toBeNull();
  });

  test('validates generation input before calling the injected handler', async () => {
    let calls = 0;
    const harness = await createHarness({
      startGeneration: async () => {
        calls += 1;
        return { id: 'unexpected' };
      },
    });

    await expect(
      harness.invoke('jobs:start', { ...generationRequest, duration: 0 }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('returns the injected generation handler result', async () => {
    let received: unknown;
    const harness = await createHarness({
      startGeneration: async (request) => {
        received = request;
        return { id: 'job-1', status: 'pending' };
      },
    });

    await expect(harness.invoke('jobs:start', generationRequest)).resolves.toEqual({
      id: 'job-1',
      status: 'pending',
    });
    expect(received).toEqual(generationRequest);
  });

  test('cancels only the requested job through the real JobCoordinator', async () => {
    const harness = await createHarness();
    let cancellations = 0;
    let finish = (): void => undefined;

    const completion = harness.jobCoordinator.enqueue({
      id: 'job-1',
      run: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      cancel: () => {
        cancellations += 1;
        finish();
      },
    });

    await harness.invoke('jobs:cancel', { id: 'another-job' });
    expect(cancellations).toBe(0);
    await harness.invoke('jobs:cancel', { id: 'job-1' });
    await completion;
    expect(cancellations).toBe(1);
  });

  test('creates managed avatars and dispatches work queries to the real Store', async () => {
    const harness = await createHarness();
    const source = join(harness.directory, 'presenter.png');
    await writeFile(source, 'image-data');

    await expect(
      harness.invoke('avatars:create', { name: 'Presenter', photoPath: source }),
    ).rejects.toThrow(/selectImage/i);
    harness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    await expect(harness.invoke('files:selectImage')).resolves.toBe(source);
    const avatar = (await harness.invoke('avatars:create', {
      name: 'Presenter',
      photoPath: source,
    })) as Avatar;
    expect(avatar.photoPath).not.toBe(source);
    expect(avatar.photoPath).toContain(join(harness.directory, 'avatars'));
    expect(await readFile(avatar.photoPath, 'utf8')).toBe('image-data');
    await expect(harness.invoke('avatars:list')).resolves.toEqual([avatar]);

    const work = harness.store.addWork({
      id: 'work-1',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: null,
      status: 'pending',
    });
    const works = (await harness.invoke('works:list')) as Work[];
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ id: work.id, avatarId: avatar.id });
  });

  test('handles file selection and controlled media URL requests', async () => {
    const harness = await createHarness();
    const audioPath = join(harness.directory, 'voice.mp3');
    await writeFile(audioPath, 'audio');
    harness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [audioPath] });

    await expect(harness.invoke('files:selectAudio')).resolves.toBe(audioPath);
    const mediaUrl = await harness.invoke('files:mediaUrl', { path: audioPath });
    expect(mediaUrl).toMatch(/^smo-media:\/\/media\//);

    harness.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(harness.invoke('files:selectImage')).resolves.toBeNull();
  });

  test('retries a work through the real retry handler', async () => {
    const harness = await createHarness({
      retryWork: async () => ({ id: 'retried-job' }),
    });

    await expect(harness.invoke('jobs:retry', { id: 'work-1' })).resolves.toEqual({
      id: 'retried-job',
    });
  });

  test('opens an allowed folder through the real file service', async () => {
    const harness = await createHarness();
    const outputDirectory = join(harness.directory, 'output');
    const target = join(outputDirectory, 'nested');
    await mkdir(target, { recursive: true });
    let opened: string | null = null;
    harness.services.files = new FileService({
      mediaRegistry: new MediaRegistry({
        avatarsDirectory: join(harness.directory, 'avatars'),
        outputDirectory,
      }),
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      outputDirectory,
      dataDirectory: harness.directory,
      opener: { openPath: async (path) => { opened = path; return ''; } },
    });

    await expect(harness.invoke('files:openFolder', { path: target })).resolves.toBeUndefined();
    expect(opened).toBe(target);
  });

  test('rejects opening a folder outside allowed roots', async () => {
    const harness = await createHarness();
    const outside = await mkdtemp(join(tmpdir(), 'smo-open-outside-'));

    try {
      await expect(harness.invoke('files:openFolder', { path: outside })).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('opens ComfyUI through the real opener', async () => {
    const harness = await createHarness();
    let opened = false;
    harness.services.openComfy = async () => { opened = true; };

    await expect(harness.invoke('comfy:open')).resolves.toBeUndefined();
    expect(opened).toBe(true);
  });

  test('starts ComfyUI and returns the latest health stats', async () => {
    const harness = await createHarness();
    const stats = {
      system: { os: 'started' },
      devices: [{ name: 'NVIDIA GeForce RTX 5090 Laptop GPU' }],
    };
    let calls = 0;
    harness.services.startComfy = async () => {
      calls += 1;
      return stats;
    };

    await expect(harness.invoke('comfy:start')).resolves.toEqual(stats);
    expect(calls).toBe(1);
  });

  test('renames and deletes avatars through the real service', async () => {
    const harness = await createHarness();
    const source = join(harness.directory, 'presenter.png');
    await writeFile(source, 'image-data');
    harness.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });
    await harness.invoke('files:selectImage');
    const avatar = (await harness.invoke('avatars:create', {
      name: 'Before',
      photoPath: source,
    })) as Avatar;

    await expect(
      harness.invoke('avatars:update', { id: avatar.id, name: 'After' }),
    ).resolves.toEqual({ ...avatar, name: 'After' });
    await expect(harness.invoke('avatars:delete', { id: avatar.id })).resolves.toBeUndefined();

    await expect(harness.invoke('avatars:list')).resolves.toEqual([]);
    await expect(readFile(avatar.photoPath)).rejects.toThrow();
  });

  test('uses saved main-process credentials for all LLM services', async () => {
    const apiKey = 'sk-main-process-only';
    const upstream = await useUpstream((request, response, body) => {
      if (request.method === 'GET') {
        json(response, { data: [{ id: 'model-b' }, { id: 'model-a' }] });
        return;
      }

      const requestBody = JSON.parse(body) as { max_tokens?: number };
      json(response, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: requestBody.max_tokens === 4 ? 'OK' : validRefPrompt(),
            },
          },
        ],
      });
    });
    const llm = new LlmService();
    const harness = await createHarness({
      llm,
      skills: new SkillsService(llm),
    });
    const credentials = {
      baseUrl: `${upstream.baseUrl}/v1`,
      model: 'model-a',
      apiKey,
    };

    await expect(harness.invoke('llm:saveProfile', credentials)).resolves.toBeUndefined();
    await expect(harness.llmConfig.getCredentials()).resolves.toEqual(credentials);
    const profile = await harness.invoke('llm:getProfile');
    const models = await harness.invoke('llm:listModels', {
      baseUrl: credentials.baseUrl,
      model: credentials.model,
    });
    const tested = await harness.invoke('llm:testModel', {
      baseUrl: credentials.baseUrl,
      model: credentials.model,
    });
    const polished = await harness.invoke('llm:polish', polishRequest);

    expect(profile).toEqual({
      baseUrl: credentials.baseUrl,
      model: 'model-a',
      keyStatus: 'valid',
    });
    expect(models).toEqual(['model-a', 'model-b']);
    expect(tested).toMatchObject({ ok: true, summary: 'OK' });
    expect(polished).toMatchObject({
      text: validRefPrompt(),
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    });
    expect(JSON.stringify({ profile, models, tested, polished })).not.toContain(apiKey);
    expect(upstream.requests).toHaveLength(3);
    expect(upstream.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${apiKey}`,
      `Bearer ${apiKey}`,
      `Bearer ${apiKey}`,
    ]);
    expect(
      upstream.requests
        .filter((request) => request.method === 'POST')
        .map((request) => (JSON.parse(request.body) as { model: string }).model),
    ).toEqual(['model-a', 'model-a']);
  });

  test('preserves the existing API key when saving with an empty key', async () => {
    const harness = await createHarness();
    const apiKey = 'sk-existing-secret';

    await harness.invoke('llm:saveProfile', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      apiKey,
    });
    await harness.invoke('llm:saveProfile', {
      baseUrl: 'https://example.com/v1',
      model: 'new-model',
    });

    const credentials = await harness.llmConfig.getCredentials();
    expect(credentials).toEqual({
      baseUrl: 'https://example.com/v1',
      model: 'new-model',
      apiKey,
    });
  });

  test('llm:listModels resolves credentials without modifying the saved profile', async () => {
    const harness = await createHarness({
      llm: { listModels: async () => ['model-a'], testModel: async () => ({ ok: true as const, latencyMs: 10, summary: 'OK' }) },
    });
    const apiKey = 'sk-preserved';

    await harness.invoke('llm:saveProfile', {
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });

    await expect(
      harness.invoke('llm:listModels', {
        baseUrl: 'https://draft.example.com/v1',
        model: 'draft-model',
      }),
    ).resolves.toEqual(['model-a']);

    await expect(harness.llmConfig.getCredentials()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });
  });

  test('llm:listModels discovers models without a model selection', async () => {
    const listModels = vi.fn(async () => ['model-a', 'model-b']);
    const harness = await createHarness({
      llm: { listModels, testModel: async () => ({ ok: true as const, latencyMs: 10, summary: 'OK' }) },
    });
    const apiKey = 'sk-preserved';

    await harness.invoke('llm:saveProfile', {
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });

    await expect(
      harness.invoke('llm:listModels', {
        baseUrl: 'https://draft.example.com/v1',
      }),
    ).resolves.toEqual(['model-a', 'model-b']);

    expect(listModels).toHaveBeenCalledWith({
      baseUrl: 'https://draft.example.com/v1',
      apiKey,
    });
    await expect(harness.llmConfig.getCredentials()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });
  });

  test('llm:testModel resolves credentials without modifying the saved profile', async () => {
    const harness = await createHarness({
      llm: { listModels: async () => ['model-a'], testModel: async () => ({ ok: true as const, latencyMs: 10, summary: 'OK' }) },
    });
    const apiKey = 'sk-preserved';

    await harness.invoke('llm:saveProfile', {
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });

    await expect(
      harness.invoke('llm:testModel', {
        baseUrl: 'https://draft.example.com/v1',
        model: 'draft-model',
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(harness.llmConfig.getCredentials()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });
  });

  test('llm:listModels failure does not modify the saved profile', async () => {
    const harness = await createHarness({
      llm: { listModels: async () => { throw new Error('service unavailable'); }, testModel: async () => ({ ok: true as const, latencyMs: 10, summary: 'OK' }) },
    });
    const apiKey = 'sk-preserved';

    await harness.invoke('llm:saveProfile', {
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });

    await expect(
      harness.invoke('llm:listModels', {
        baseUrl: 'https://draft.example.com/v1',
        model: 'draft-model',
      }),
    ).rejects.toThrow(/service unavailable/i);

    await expect(harness.llmConfig.getCredentials()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });
  });

  test('llm:testModel failure does not modify the saved profile', async () => {
    const harness = await createHarness({
      llm: { listModels: async () => ['model-a'], testModel: async () => { throw new Error('test failed'); } },
    });
    const apiKey = 'sk-preserved';

    await harness.invoke('llm:saveProfile', {
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });

    await expect(
      harness.invoke('llm:testModel', {
        baseUrl: 'https://draft.example.com/v1',
        model: 'draft-model',
      }),
    ).rejects.toThrow(/test failed/i);

    await expect(harness.llmConfig.getCredentials()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey,
    });
  });

  test('rejects LLM list/test calls without an API key when no profile is configured', async () => {
    const harness = await createHarness();

    await expect(
      harness.invoke('llm:listModels', { baseUrl: 'https://example.com/v1', model: 'model-a' }),
    ).rejects.toThrow(/api key is required/i);
    await expect(
      harness.invoke('llm:testModel', { baseUrl: 'https://example.com/v1', model: 'model-a' }),
    ).rejects.toThrow(/api key is required/i);
  });

  test('checks health through the real ComfyClient against a local service', async () => {
    const upstream = await useUpstream((_request, response) => {
      json(response, { system: { os: 'test' }, devices: [{ name: 'Test GPU' }] });
    });
    const harness = await createHarness({
      comfy: new ComfyClient(upstream.baseUrl),
    });

    await expect(harness.invoke('comfy:health')).resolves.toEqual({
      system: { os: 'test' },
      devices: [{ name: 'Test GPU' }],
    });
    expect(upstream.requests[0]).toMatchObject({ url: '/system_stats' });
  });

  test('returns the injected hardware detection result', async () => {
    const harness = await createHarness();

    await expect(harness.invoke('hardware:detect')).resolves.toEqual(hardwareInfo);
  });

  test('applies a confirmed hardware profile through the real workflow function', async () => {
    const harness = await createHarness();
    const modelDirectory = join(harness.directory, 'models');
    const profilesDirectory = join(harness.directory, 'workflow-profiles');
    const unetName = 'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors';
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, unetName), '');

    const result = (await harness.invoke('hardware:apply', {
      mode: 'text',
      profile: hardwareProfile,
      confirmed: true,
      modelDirectory,
    })) as { path: string; profile: typeof hardwareProfile };

    const expectedPath = join(profilesDirectory, 'balanced-16gb-text.json');
    expect(result).toEqual({ path: expectedPath, profile: hardwareProfile });
    const patched = JSON.parse(await readFile(result.path, 'utf8'));
    expect(patched['127'].inputs.unet_name).toBe(unetName);
    expect(patched['115'].inputs.megapixels).toBe(0.7);
  });


  test("recommends a hardware profile through the real recommender", async () => {
    const harness = await createHarness();
    const input = { gpu: "RTX 5080", vramGiB: 16, ramGiB: 64 };

    await expect(harness.invoke("hardware:recommend", input)).resolves.toEqual(
      recommendHardware(input),
    );
  });

  test("resets only the requested hardware mode", async () => {
    const harness = await createHarness();

    await expect(harness.invoke("hardware:reset", { mode: "audio" })).resolves.toMatch(
      /audio-digital-human\.json$/,
    );
  });

  test('rejects hardware apply without confirmation', async () => {
    const harness = await createHarness();

    await expect(
      harness.invoke('hardware:apply', {
        mode: 'text',
        profile: hardwareProfile,
        confirmed: false,
        modelDirectory: 'G:\\models',
      }),
    ).rejects.toThrow(/requires confirmation/i);
  });
});

describe('LLM configuration privacy', () => {
  test('never returns the API key from a saved profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-ipc-'));
    const path = join(directory, 'llm-config.json');
    const apiKey = 'sk-ipc-test-secret';

    try {
      const store = new FileLlmConfigStore(path, cipher);
      const saveResult = await store.save({
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'local-model',
        apiKey,
      });
      const profile = await store.getProfile();

      expect(saveResult).toBeUndefined();
      expect(profile).toEqual({
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'local-model',
        keyStatus: 'valid',
      });
      expect(JSON.stringify(profile)).not.toContain(apiKey);
      expect(await readFile(path, 'utf8')).not.toContain(apiKey);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('preload API', () => {
  let api: SmoApi;

  beforeAll(async () => {
    await import('../../src/preload/index');
    const exposure = exposeInMainWorld.mock.calls[0];
    expect(exposure?.[0]).toBe('smo');
    api = exposure?.[1] as SmoApi;
  });

  beforeEach(() => {
    ipcRendererInvoke.mockReset();
    ipcRendererInvoke.mockImplementation(async () => undefined);
  });

  test('exposes only the fixed domain methods', () => {
    expect(Object.keys(api).sort()).toEqual([
      'avatars',
      'comfy',
      'files',
      'hardware',
      'jobs',
      'llm',
      'works',
    ]);
    expect(Object.keys(api.avatars).sort()).toEqual(['create', 'delete', 'list', 'update']);
    expect(Object.keys(api.jobs).sort()).toEqual(['cancel', 'retry', 'start']);
    expect(Object.keys(api.llm).sort()).toEqual([
      'getProfile',
      'listModels',
      'polish',
      'saveProfile',
      'testModel',
    ]);
    expect(Object.keys(api.comfy)).toEqual(['health', 'start', 'open']);
    expect(Object.keys(api.hardware).sort()).toEqual(['apply', 'detect', 'recommend', 'reset']);
    expect(Object.keys(api.works)).toEqual(['list']);
    expect(Object.keys(api.files).sort()).toEqual([
      'mediaUrl',
      'openFolder',
      'selectAudio',
      'selectImage',
    ]);

    const exposedMethods = Object.values(api).flatMap((domain) => Object.keys(domain));
    for (const forbidden of ['invoke', 'shell', 'process', 'require', 'ipcRenderer']) {
      expect(exposedMethods).not.toContain(forbidden);
    }
  });

  test.each([
    {
      channel: 'avatars:list',
      payload: {},
      call: (smo: SmoApi) => smo.avatars.list(),
    },
    {
      channel: 'avatars:create',
      payload: { name: 'Presenter', photoPath: 'G:\\avatar.png' },
      call: (smo: SmoApi) =>
        smo.avatars.create({ name: 'Presenter', photoPath: 'G:\\avatar.png' }),
    },
    {
      channel: 'avatars:update',
      payload: { id: 'avatar-1', name: 'Renamed' },
      call: (smo: SmoApi) => smo.avatars.update({ id: 'avatar-1', name: 'Renamed' }),
    },
    {
      channel: 'avatars:delete',
      payload: { id: 'avatar-1' },
      call: (smo: SmoApi) => smo.avatars.delete('avatar-1'),
    },
    {
      channel: 'jobs:start',
      payload: generationRequest,
      call: (smo: SmoApi) => smo.jobs.start(generationRequest),
    },
    {
      channel: 'jobs:cancel',
      payload: {},
      call: (smo: SmoApi) => smo.jobs.cancel(),
    },
    {
      channel: 'jobs:cancel',
      payload: { id: 'job-1' },
      call: (smo: SmoApi) => smo.jobs.cancel('job-1'),
    },
    {
      channel: 'files:selectImage',
      payload: {},
      call: (smo: SmoApi) => smo.files.selectImage(),
    },
    {
      channel: 'files:selectAudio',
      payload: {},
      call: (smo: SmoApi) => smo.files.selectAudio(),
    },
    {
      channel: 'files:mediaUrl',
      payload: { path: 'G:\\media\\result.mp4' },
      call: (smo: SmoApi) => smo.files.mediaUrl('G:\\media\\result.mp4'),
    },
    {
      channel: 'llm:saveProfile',
      payload: { baseUrl: 'https://example.com/v1', model: 'model-a', apiKey: 'secret' },
      call: (smo: SmoApi) =>
        smo.llm.saveProfile({
          baseUrl: 'https://example.com/v1',
          model: 'model-a',
          apiKey: 'secret',
        }),
    },
    {
      channel: 'llm:getProfile',
      payload: {},
      call: (smo: SmoApi) => smo.llm.getProfile(),
    },
    {
      channel: 'llm:listModels',
      payload: { baseUrl: 'https://example.com/v1', model: 'model-a', apiKey: 'secret' },
      call: (smo: SmoApi) =>
        smo.llm.listModels({
          baseUrl: 'https://example.com/v1',
          model: 'model-a',
          apiKey: 'secret',
        }),
    },
    {
      channel: 'llm:testModel',
      payload: { baseUrl: 'https://example.com/v1', model: 'model-a', apiKey: 'secret' },
      call: (smo: SmoApi) =>
        smo.llm.testModel({
          baseUrl: 'https://example.com/v1',
          model: 'model-a',
          apiKey: 'secret',
        }),
    },
    {
      channel: 'llm:polish',
      payload: polishRequest,
      call: (smo: SmoApi) => smo.llm.polish(polishRequest),
    },
    {
      channel: 'comfy:health',
      payload: {},
      call: (smo: SmoApi) => smo.comfy.health(),
    },
    {
      channel: 'comfy:start',
      payload: {},
      call: (smo: SmoApi) => smo.comfy.start(),
    },
    {
      channel: 'hardware:detect',
      payload: {},
      call: (smo: SmoApi) => smo.hardware.detect(),
    },
    {
      channel: 'hardware:apply',
      payload: {
        mode: 'text',
        profile: hardwareProfile,
        confirmed: true,
        modelDirectory: 'G:\\models',
      },
      call: (smo: SmoApi) =>
        smo.hardware.apply({
          mode: 'text',
          profile: hardwareProfile,
          confirmed: true,
          modelDirectory: 'G:\\models',
        }),
    },
    {
      channel: "hardware:recommend",
      payload: { gpu: "RTX 5080", vramGiB: 16, ramGiB: 64 },
      call: (smo: SmoApi) =>
        smo.hardware.recommend({ gpu: "RTX 5080", vramGiB: 16, ramGiB: 64 }),
    },
    {
      channel: "hardware:reset",
      payload: { mode: "audio" },
      call: (smo: SmoApi) => smo.hardware.reset("audio"),
    },
    {
      channel: 'jobs:retry',
      payload: { id: 'work-1' },
      call: (smo: SmoApi) => smo.jobs.retry('work-1'),
    },
    {
      channel: 'files:openFolder',
      payload: { path: 'G:\\output' },
      call: (smo: SmoApi) => smo.files.openFolder('G:\\output'),
    },
    {
      channel: 'comfy:open',
      payload: {},
      call: (smo: SmoApi) => smo.comfy.open(),
    },
    {
      channel: 'works:list',
      payload: {},
      call: (smo: SmoApi) => smo.works.list(),
    },
  ])('maps $channel without exposing a generic invoke method', async ({ channel, payload, call }) => {
    await call(api);

    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(channel, payload);
  });
});
