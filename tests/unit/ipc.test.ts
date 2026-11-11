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
import {
  HardwareWorkflowStore,
  profileWorkflowFilename,
} from '../../src/main/hardware-workflows';
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
import { ASPECT_RATIO_OPTIONS } from '../../src/shared/generation-options';
import type {
  Avatar,
  HardwareInfo,
  ImageGenerationRequest,
  SpeechGenerationRequest,
  Work,
} from '../../src/shared/types';
import {
  startLlmUpstream,
  type LocalLlmUpstream,
} from '../fixtures/llm-upstream';

const { appGetVersion, cipher, exposeInMainWorld, ipcMainHandle, ipcRendererInvoke, webUtilsGetPathForFile } = vi.hoisted(() => {
  const prefix = Buffer.from('ipc-test-cipher\0');
  const transform = (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x5a));

  return {
    appGetVersion: vi.fn(() => '0.3.15-test'),
    exposeInMainWorld: vi.fn(),
    ipcMainHandle: vi.fn(),
    ipcRendererInvoke: vi.fn(),
    webUtilsGetPathForFile: vi.fn(),
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
  app: { getVersion: appGetVersion },
  contextBridge: { exposeInMainWorld },
  ipcMain: { handle: ipcMainHandle },
  ipcRenderer: { invoke: ipcRendererInvoke },
  safeStorage: cipher,
  webUtils: { getPathForFile: webUtilsGetPathForFile },
}));

const generationRequest = {
  mode: 'text',
  avatarId: 'avatar-1',
  prompt: 'A quiet studio shot.',
  duration: 8,
  seed: 42,
  steps: 12,
  referenceImagePaths: [] as string[],
} as const;

const speechGenerationRequest: SpeechGenerationRequest = {
  mode: 'speech',
  speechMode: 'custom',
  prompt: '本地语音 IPC 测试',
  language: 'Chinese',
  outputFormat: 'mp3',
  speaker: 'Vivian',
  instruct: '自然地说',
};

const imageGenerationRequest: ImageGenerationRequest = {
  mode: 'image',
  prompt: '玻璃温室里的晨光',
  width: 1344,
  height: 768,
  seed: 99,
  steps: 30,
  referenceImagePaths: [],
};

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

const environmentState = {
  config: null,
  hardware: null,
  selection: null,
  installRoot: 'D:\\SMO-Environment',
  stage: 'detect',
  progress: { downloadedBytes: 0, totalBytes: 0 },
  error: null,
  active: false,
  healthy: false,
} as const;

const speechComponentState = {
  id: 'speech',
  status: 'ready',
  downloadedBytes: 100,
  totalBytes: 100,
  currentFile: null,
  error: null,
  active: false,
} as const;

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
    speech: {
      getCapabilities: async () => ({
        speakers: ['Vivian'],
        languages: ['Auto', 'Chinese'],
      }),
    },
    components: {
      getState: () => ({ ...speechComponentState }),
      install: async () => ({ ...speechComponentState }),
      cancel: () => undefined,
    },
    retryWork: async () => ({ id: 'injected-retry' }),
    deleteWork: async () => {
      throw new Error('Unexpected deleteWork call');
    },
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
    recordings: {
      save: async () => join(directory, 'recordings', 'recorded.wav'),
      discard: async () => undefined,
    },
    comfy: {
      health: async () => ({ system: {}, devices: [] }),
    },
    startComfy: async () => ({ system: {}, devices: [] }),
    openComfy: async () => undefined,
    environment: {
      getState: async () => ({ ...environmentState }),
      detect: async () => ({ ...environmentState }),
      selectExistingRoot: vi.fn(async () => null),
      importExisting: vi.fn(async () => ({ ...environmentState })),
      start: async () => ({ ...environmentState }),
      retry: async () => ({ ...environmentState }),
      cancel: async () => ({ ...environmentState }),
      validate: async () => ({ ...environmentState }),
    },
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

  test('accepts no reference text generation with a null avatarId', () => {
    const request = {
      channel: 'jobs:start',
      payload: {
        ...generationRequest,
        avatarId: null,
        referenceImagePaths: [],
      },
    };

    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test('defaults no reference paths for a legacy avatar request', () => {
    const { referenceImagePaths: _referenceImagePaths, ...payload } =
      generationRequest;

    expect(
      createIpcSchema().parse({ channel: 'jobs:start', payload }),
    ).toEqual({
      channel: 'jobs:start',
      payload: { ...payload, avatarId: 'avatar-1', referenceImagePaths: [] },
    });
  });

  test('accepts nine ordered reference paths at the IPC boundary', () => {
    const referenceImagePaths = Array.from(
      { length: 9 },
      (_, index) => `G:\\refs\\${9 - index}.png`,
    );
    const request = {
      channel: 'jobs:start',
      payload: { ...generationRequest, avatarId: null, referenceImagePaths },
    };

    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test.each([
    Array.from({ length: 10 }, (_, index) => `G:\\refs\\${index}.png`),
    [''],
    ['   '],
    ['G:\\refs\\valid.png', 42],
    null,
    'G:\\refs\\not-an-array.png',
  ])('rejects invalid video reference paths: %j', (referenceImagePaths) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...generationRequest, avatarId: null, referenceImagePaths },
      }),
    ).toThrow();
  });

  test.each([
    { avatarId: '' },
    { avatarId: '   ' },
    { unknown: true },
  ])('keeps no reference video input strict: %j', (override) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...generationRequest, avatarId: null, ...override },
      }),
    ).toThrow();
  });

  test.each([
    { avatarId: null, referenceImagePaths: [] },
    { avatarId: 'avatar-1', referenceImagePaths: ['G:\\refs\\one.png'] },
  ])('keeps audio avatar and no reference constraints: %j', (override) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: {
          ...generationRequest,
          mode: 'audio',
          audioPath: 'G:\\audio\\voice.mp3',
          ...override,
        },
      }),
    ).toThrow();
  });

  test('rejects subtitle preferences in new generation requests', () => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...generationRequest, subtitles: true },
      }),
    ).toThrow();
  });

  test.each([
    { channel: 'files:selectImage', payload: {} },
    { channel: 'files:selectAudio', payload: {} },
    { channel: 'files:mediaUrl', payload: { path: 'G:\\media\\result.mp4' } },
    { channel: 'files:authorizeDroppedImage', payload: { path: 'G:\\photos\\dropped.png' } },
    { channel: 'files:authorizeDroppedAudio', payload: { path: 'G:\\audio\\voice.mp3' } },
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

  test.each(['wav', 'mp3', 'flac', 'm4a'] as const)(
    'speech accepts the %s output format with a strict custom request',
    (outputFormat) => {
      const request = {
        channel: 'jobs:start',
        payload: { ...speechGenerationRequest, outputFormat },
      };

      expect(createIpcSchema().parse(request)).toEqual(request);
    },
  );

  test('speech accepts clone requests with blank reference text', () => {
    const request = {
      channel: 'jobs:start',
      payload: {
        mode: 'speech',
        speechMode: 'clone',
        prompt: '克隆语音',
        language: 'Auto',
        outputFormat: 'wav',
        referenceAudioPath: 'G:\\audio\\reference.wav',
        referenceText: '  ',
      },
    };

    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test('image accepts a strict generation request', () => {
    const request = {
      channel: 'jobs:start',
      payload: imageGenerationRequest,
    };

    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test('image defaults omitted reference image paths to an empty array', () => {
    const { referenceImagePaths: _referenceImagePaths, ...payload } =
      imageGenerationRequest;

    expect(
      createIpcSchema().parse({ channel: 'jobs:start', payload }),
    ).toEqual({
      channel: 'jobs:start',
      payload: { ...payload, referenceImagePaths: [] },
    });
  });

  test.each([1, 2, 3, 4])(
    'image accepts %i authorized reference image paths',
    (count) => {
      const referenceImagePaths = Array.from(
        { length: count },
        (_, index) => `G:\\refs\\${index + 1}.png`,
      );
      const request = {
        channel: 'jobs:start',
        payload: { ...imageGenerationRequest, referenceImagePaths },
      };

      expect(createIpcSchema().parse(request)).toEqual(request);
    },
  );

  test.each([
    Array.from({ length: 5 }, (_, index) => `G:\\refs\\${index + 1}.png`),
    [''],
    ['   '],
    ['G:\\refs\\valid.png', 42],
    [null],
    'G:\\refs\\not-an-array.png',
  ])('image rejects invalid reference image paths: %j', (referenceImagePaths) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...imageGenerationRequest, referenceImagePaths },
      }),
    ).toThrow();
  });

  test.each([
    { prompt: ' ' },
    { width: 1000 },
    { height: 1023 },
    { seed: -1 },
    { steps: 0 },
    { steps: 101 },
    { avatarId: 'avatar-must-not-be-accepted' },
    { unknown: true },
  ])('image rejects invalid or undeclared request fields: %j', (override) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...imageGenerationRequest, ...override },
      }),
    ).toThrow();
  });

  test.each([
    { speaker: undefined },
    { speaker: '' },
    { language: '' },
    { prompt: '  ' },
    { outputFormat: 'ogg' },
    { avatarId: 'must-not-be-accepted' },
  ])('speech rejects an invalid custom request: %j', (override) => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: { ...speechGenerationRequest, ...override },
      }),
    ).toThrow();
  });

  test('speech rejects clone requests without an authorized-audio path field', () => {
    expect(() =>
      createIpcSchema().parse({
        channel: 'jobs:start',
        payload: {
          mode: 'speech',
          speechMode: 'clone',
          prompt: '克隆语音',
          language: 'Auto',
          outputFormat: 'wav',
        },
      }),
    ).toThrow(/referenceAudioPath/i);
  });

  test.each([
    { channel: 'speech:getCapabilities', payload: {} },
    { channel: 'speech:getCapabilities', payload: { speechMode: 'other' } },
    { channel: 'speech:getCapabilities', payload: { speechMode: 'custom', extra: true } },
    { channel: 'components:getState', payload: {} },
    { channel: 'components:getState', payload: { id: 'other' } },
    { channel: 'components:install', payload: { id: 'speech', extra: true } },
    { channel: 'components:cancel', payload: { id: 'image', force: true } },
  ])('speech component IPC rejects a non-strict payload: %j', (request) => {
    expect(() => createIpcSchema().parse(request)).toThrow();
  });

  test.each([
    { channel: 'speech:getCapabilities', payload: { speechMode: 'custom' } },
    { channel: 'components:getState', payload: { id: 'speech' } },
    { channel: 'components:install', payload: { id: 'image' } },
    { channel: 'components:cancel', payload: { id: 'speech' } },
  ])('speech component IPC accepts a controlled payload: %j', (request) => {
    expect(createIpcSchema().parse(request)).toEqual(request);
  });

  test.each([
    'jobs:cancel',
    'jobs:getState',
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

  test.each([
    'environment:getState',
    'environment:selectExistingRoot',
    'environment:cancel',
    'environment:validate',
  ])(
    'accepts %s with an empty payload',
    (channel) => {
      const request = { channel, payload: {} };

      expect(createIpcSchema().parse(request)).toEqual(request);
    },
  );

  test('accepts environment detect with an optional install root', () => {
    const schema = createIpcSchema();

    expect(
      schema.parse({ channel: 'environment:detect', payload: {} }),
    ).toEqual({ channel: 'environment:detect', payload: {} });
    expect(
      schema.parse({
        channel: 'environment:detect',
        payload: { installRoot: 'D:\\SMO-Environment' },
      }),
    ).toEqual({
      channel: 'environment:detect',
      payload: { installRoot: 'D:\\SMO-Environment' },
    });
  });

  test.each(['environment:start', 'environment:retry'])(
    'accepts %s with a profile and install root',
    (channel) => {
      const request = {
        channel,
        payload: {
          profileId: 'balanced-16gb',
          installRoot: 'D:\\SMO-Environment',
        },
      };

      expect(createIpcSchema().parse(request)).toEqual(request);
    },
  );

  test('validates environment import with a strict payload', () => {
    const request = {
      channel: 'environment:import',
      payload: {
        runtimeRoot: 'D:\\Existing\\Runtime',
        profileId: 'balanced-16gb',
      },
    } as const;

    expect(createIpcSchema().parse(request)).toEqual(request);
    for (const payload of [
      { ...request.payload, extra: true },
      { ...request.payload, runtimeRoot: '' },
      { ...request.payload, runtimeRoot: '   ' },
      { ...request.payload, profileId: 'turbo' },
      { runtimeRoot: request.payload.runtimeRoot },
    ]) {
      expect(() =>
        createIpcSchema().parse({ channel: 'environment:import', payload }),
      ).toThrow();
    }
  });

  test.each([
    { channel: 'environment:getState', payload: { verbose: true } },
    { channel: 'environment:selectExistingRoot', payload: { verbose: true } },
    { channel: 'environment:cancel', payload: { force: true } },
    { channel: 'environment:validate', payload: { verbose: true } },
    { channel: 'environment:detect', payload: { installRoot: '' } },
    { channel: 'environment:detect', payload: { installRoot: '   ' } },
    {
      channel: 'environment:detect',
      payload: { installRoot: 'D:\\env', runtimeRoot: 'D:\\rt' },
    },
    {
      channel: 'environment:start',
      payload: { profileId: 'turbo', installRoot: 'D:\\env' },
    },
    {
      channel: 'environment:start',
      payload: { profileId: 'balanced-16gb' },
    },
    {
      channel: 'environment:start',
      payload: { profileId: 'balanced-16gb', installRoot: '' },
    },
    {
      channel: 'environment:retry',
      payload: {
        profileId: 'conservative',
        installRoot: 'D:\\env',
        baseUrl: 'http://127.0.0.1:8188',
      },
    },
    {
      channel: 'environment:retry',
      payload: {
        profileId: 'high-memory-candidate',
        installRoot: 'D:\\env',
        outputDirectory: 'D:\\out',
      },
    },
  ])('rejects invalid environment input: %j', (request) => {
    expect(() => createIpcSchema().parse(request)).toThrow();
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
    expect(
      schema.parse({ channel: 'works:delete', payload: { id: 'work-1' } }),
    ).toEqual({ channel: 'works:delete', payload: { id: 'work-1' } });
    expect(
      schema.parse({
        channel: 'works:rename',
        payload: { id: 'work-1', title: '新标题' },
      }),
    ).toEqual({
      channel: 'works:rename',
      payload: { id: 'work-1', title: '新标题' },
    });
    expect(
      schema.parse({
        channel: 'works:rename',
        payload: { id: 'work-1', title: '题'.repeat(120) },
      }),
    ).toEqual({
      channel: 'works:rename',
      payload: { id: 'work-1', title: '题'.repeat(120) },
    });

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

  test("accepts only the eight H3 aspect ratios on hardware profiles", () => {
    const schema = createIpcSchema();
    const base = {
      channel: "hardware:apply",
      payload: { mode: "text", confirmed: true, modelDirectory: "G:\\models" },
    };

    for (const option of ASPECT_RATIO_OPTIONS) {
      expect(
        schema.parse({
          ...base,
          payload: {
            ...base.payload,
            profile: { ...hardwareProfile, aspectRatio: option.value },
          },
        }),
      ).toMatchObject({
        payload: { profile: { aspectRatio: option.value } },
      });
    }

    for (const aspectRatio of ["foo;bar", "16:9", ""]) {
      expect(() =>
        schema.parse({
          ...base,
          payload: {
            ...base.payload,
            profile: { ...hardwareProfile, aspectRatio },
          },
        }),
      ).toThrow();
    }
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
    { channel: 'files:authorizeDroppedImage', payload: {} },
    { channel: 'files:authorizeDroppedImage', payload: { path: '' } },
    { channel: 'files:authorizeDroppedImage', payload: { path: '   ' } },
    {
      channel: 'files:authorizeDroppedImage',
      payload: { path: 'G:\\photos\\dropped.png', shell: true },
    },
    { channel: 'files:authorizeDroppedAudio', payload: {} },
    { channel: 'files:authorizeDroppedAudio', payload: { path: '' } },
    { channel: 'files:authorizeDroppedAudio', payload: { path: '   ' } },
    {
      channel: 'files:authorizeDroppedAudio',
      payload: { path: 'G:\\audio\\voice.mp3', shell: true },
    },
    { channel: 'comfy:open', payload: { url: 'http://example.com' } },
    { channel: 'avatars:update', payload: { id: '', name: 'Renamed' } },
    { channel: 'avatars:update', payload: { id: 'avatar-1', name: ' ' } },
    { channel: 'avatars:update', payload: { id: 'avatar-1', name: 'Renamed', photoPath: 'x' } },
    { channel: 'avatars:delete', payload: { id: '' } },
    { channel: 'avatars:delete', payload: { id: 'avatar-1', force: true } },
    { channel: 'works:delete', payload: { id: '' } },
    { channel: 'works:delete', payload: { id: 'work-1', force: true } },
    { channel: 'works:rename', payload: { id: '', title: '新标题' } },
    { channel: 'works:rename', payload: { id: 'work-1' } },
    { channel: 'works:rename', payload: { id: 'work-1', title: '' } },
    { channel: 'works:rename', payload: { id: 'work-1', title: '   ' } },
    { channel: 'works:rename', payload: { id: 'work-1', title: '题'.repeat(121) } },
    { channel: 'works:rename', payload: { id: 'work-1', title: '新标题', outputPath: 'x' } },
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

  test('forwards a speech generation request through jobs:start', async () => {
    const startGeneration = vi.fn(async () => ({ id: 'speech-job' }));
    const harness = await createHarness({ startGeneration });

    await expect(
      harness.invoke('jobs:start', speechGenerationRequest),
    ).resolves.toEqual({ id: 'speech-job' });
    expect(startGeneration).toHaveBeenCalledWith(speechGenerationRequest);
  });

  test('forwards an image generation request through jobs:start', async () => {
    const startGeneration = vi.fn(async () => ({ id: 'image-job' }));
    const harness = await createHarness({ startGeneration });

    await expect(
      harness.invoke('jobs:start', imageGenerationRequest),
    ).resolves.toEqual({ id: 'image-job' });
    expect(startGeneration).toHaveBeenCalledWith(imageGenerationRequest);
  });

  test('dispatches speech capabilities and component state, install, and cancel', async () => {
    const getCapabilities = vi.fn(async () => ({
      speakers: ['Vivian'],
      languages: ['Chinese'],
    }));
    const getState = vi.fn(() => ({ ...speechComponentState }));
    const install = vi.fn(async () => ({ ...speechComponentState }));
    const cancel = vi.fn(() => undefined);
    const harness = await createHarness({
      speech: { getCapabilities },
      components: { getState, install, cancel },
    });

    await expect(
      harness.invoke('speech:getCapabilities', { speechMode: 'custom' }),
    ).resolves.toEqual({ speakers: ['Vivian'], languages: ['Chinese'] });
    expect(getCapabilities).toHaveBeenCalledWith('custom');
    await expect(
      harness.invoke('components:getState', { id: 'speech' }),
    ).resolves.toEqual(speechComponentState);
    expect(getState).toHaveBeenCalledWith('speech');
    await expect(
      harness.invoke('components:install', { id: 'image' }),
    ).resolves.toEqual(speechComponentState);
    expect(install).toHaveBeenCalledWith('image');
    await harness.invoke('components:cancel', { id: 'speech' });
    expect(cancel).toHaveBeenCalledWith('speech');
  });

  test('speech refuses a new component runtime install while any generation is active', async () => {
    const install = vi.fn(async () => ({ ...speechComponentState }));
    const harness = await createHarness({
      components: {
        getState: () => ({ ...speechComponentState }),
        install,
        cancel: () => undefined,
      },
    });
    let finish = (): void => undefined;
    const active = harness.jobCoordinator.enqueue({
      id: 'active-video',
      run: () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });

    await expect(
      harness.invoke('components:install', { id: 'speech' }),
    ).rejects.toThrow(/generation.*running|active generation/i);
    expect(install).not.toHaveBeenCalled();
    finish();
    await active;
  });

  test('accepts video steps and forwards the request unchanged', async () => {
    const startGeneration = vi.fn(async () => ({ id: 'job-steps' }));
    const harness = await createHarness({ startGeneration });
    const video = { ...generationRequest, steps: 12 };

    await expect(harness.invoke('jobs:start', video)).resolves.toEqual({
      id: 'job-steps',
    });
    expect(startGeneration).toHaveBeenCalledWith(video);

    for (const steps of [0, 101, 1.5]) {
      await expect(
        harness.invoke('jobs:start', { ...video, steps }),
      ).rejects.toThrow();
    }
    await expect(
      harness.invoke('jobs:start', { ...video, unknown: true }),
    ).rejects.toThrow();
    expect(startGeneration).toHaveBeenCalledTimes(1);
  });

  test('requires steps in new generation requests', async () => {
    const harness = await createHarness();
    const { steps: _steps, ...requestWithoutSteps } = generationRequest;

    await expect(
      harness.invoke('jobs:start', requestWithoutSteps),
    ).rejects.toThrow();
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

  test('returns idle and active job states through jobs:getState', async () => {
    const harness = await createHarness();
    let finish!: () => void;

    await expect(harness.invoke('jobs:getState')).resolves.toEqual({ activeId: null });
    const completion = harness.jobCoordinator.enqueue({
      id: 'one',
      run: () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    await expect(harness.invoke('jobs:getState')).resolves.toEqual({ activeId: 'one' });

    finish();
    await completion;
    await expect(harness.invoke('jobs:getState')).resolves.toEqual({ activeId: null });
    await expect(
      harness.invoke('jobs:getState', { verbose: true }),
    ).rejects.toThrow();
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

  test('authorizes a dropped image so it can be used as an avatar photo', async () => {
    const harness = await createHarness();
    const source = join(harness.directory, 'dropped.png');
    await writeFile(source, 'image-data');

    await expect(
      harness.invoke('avatars:create', { name: 'Dropped', photoPath: source }),
    ).rejects.toThrow(/selectImage/i);

    await expect(
      harness.invoke('files:authorizeDroppedImage', { path: source }),
    ).resolves.toBe(source);

    const avatar = (await harness.invoke('avatars:create', {
      name: 'Dropped',
      photoPath: source,
    })) as Avatar;
    expect(avatar.photoPath).toContain(join(harness.directory, 'avatars'));
    expect(await readFile(avatar.photoPath, 'utf8')).toBe('image-data');

    const mediaUrl = await harness.invoke('files:mediaUrl', { path: source });
    expect(mediaUrl).toMatch(/^smo-media:\/\/media\//);
  });

  test('rejects dropped non-image files without authorizing them', async () => {
    const harness = await createHarness();
    const audioPath = join(harness.directory, 'voice.mp3');
    await writeFile(audioPath, 'audio');

    await expect(
      harness.invoke('files:authorizeDroppedImage', { path: audioPath }),
    ).rejects.toThrow(/extension/i);
    await expect(
      harness.invoke('files:mediaUrl', { path: audioPath }),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      harness.invoke('avatars:create', { name: 'Nope', photoPath: audioPath }),
    ).rejects.toThrow();
  });

  test('audio drop authorizes the file for controlled media access', async () => {
    const harness = await createHarness();
    const source = join(harness.directory, 'dropped.mp3');
    await writeFile(source, 'audio-data');

    await expect(
      harness.invoke('files:mediaUrl', { path: source }),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      harness.invoke('files:authorizeDroppedAudio', { path: source }),
    ).resolves.toBe(source);
    await expect(
      harness.invoke('files:mediaUrl', { path: source }),
    ).resolves.toMatch(/^smo-media:\/\/media\//);
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

  test('deletes works through the deleteWork service', async () => {
    const deleted: string[] = [];
    const harness = await createHarness({
      deleteWork: async (id) => {
        deleted.push(id);
      },
    });

    await expect(
      harness.invoke('works:delete', { id: 'work-1' }),
    ).resolves.toBeUndefined();
    expect(deleted).toEqual(['work-1']);
  });

  test('renames a work through the real Store without touching the output path', async () => {
    const harness = await createHarness();
    const avatar = harness.store.createAvatar({
      name: 'Presenter',
      photoPath: 'avatars/presenter.png',
    });
    const work = harness.store.addWork({
      id: 'work-1',
      avatarId: avatar.id,
      mode: 'text',
      outputPath: 'output/work-1.mp4',
      status: 'done',
    });

    const renamed = (await harness.invoke('works:rename', {
      id: work.id,
      title: '  发布会成片  ',
    })) as Work;

    expect(renamed).toMatchObject({
      id: work.id,
      title: '发布会成片',
      outputPath: 'output/work-1.mp4',
    });
    expect(harness.store.getWork(work.id)).toMatchObject({
      title: '发布会成片',
      outputPath: 'output/work-1.mp4',
    });

    await expect(
      harness.invoke('works:rename', { id: work.id, title: '   ' }),
    ).rejects.toThrow();
    await expect(
      harness.invoke('works:rename', { id: work.id, title: '题'.repeat(121) }),
    ).rejects.toThrow();
    expect(harness.store.getWork(work.id)?.title).toBe('发布会成片');
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

    const expectedPath = join(
      profilesDirectory,
      profileWorkflowFilename('text', hardwareProfile),
    );
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

  test('returns the environment state through the environment domain', async () => {
    const harness = await createHarness();

    await expect(harness.invoke('environment:getState')).resolves.toEqual(
      environmentState,
    );
  });

  test('dispatches existing-root selection and returns cancellation', async () => {
    const harness = await createHarness();
    const selectExistingRoot = vi.mocked(
      harness.services.environment.selectExistingRoot,
    );
    selectExistingRoot.mockResolvedValueOnce('D:\\Existing\\ComfyUI');

    await expect(
      harness.invoke('environment:selectExistingRoot'),
    ).resolves.toBe('D:\\Existing\\ComfyUI');

    selectExistingRoot.mockResolvedValueOnce(null);
    await expect(
      harness.invoke('environment:selectExistingRoot'),
    ).resolves.toBeNull();
    expect(selectExistingRoot).toHaveBeenCalledTimes(2);

    await expect(
      harness.invoke('environment:selectExistingRoot', { verbose: true }),
    ).rejects.toThrow();
    expect(selectExistingRoot).toHaveBeenCalledTimes(2);
  });

  test('dispatches environment import only after strict validation', async () => {
    const harness = await createHarness();
    const importExisting = vi.mocked(
      harness.services.environment.importExisting,
    );
    const input = {
      runtimeRoot: 'D:\\Existing\\Runtime',
      profileId: 'conservative' as const,
    };
    const ready = {
      ...environmentState,
      stage: 'ready' as const,
      healthy: true,
    };
    importExisting.mockResolvedValueOnce(ready);

    await expect(
      harness.invoke('environment:import', input),
    ).resolves.toEqual(ready);
    expect(importExisting).toHaveBeenCalledWith(input);

    await expect(
      harness.invoke('environment:import', { ...input, extra: true }),
    ).rejects.toThrow();
    expect(importExisting).toHaveBeenCalledTimes(1);
  });

  test('dispatches environment validate with an empty payload', async () => {
    const validate = vi.fn(async () => ({
      ...environmentState,
      stage: 'ready' as const,
      healthy: true,
    }));
    const harness = await createHarness({
      environment: {
        getState: async () => ({ ...environmentState }),
        detect: async () => ({ ...environmentState }),
        selectExistingRoot: async () => null,
        importExisting: async () => ({ ...environmentState }),
        start: async () => ({ ...environmentState }),
        retry: async () => ({ ...environmentState }),
        cancel: async () => ({ ...environmentState }),
        validate,
      },
    });

    await expect(harness.invoke('environment:validate')).resolves.toEqual({
      ...environmentState,
      stage: 'ready',
      healthy: true,
    });
    expect(validate).toHaveBeenCalledTimes(1);

    await expect(
      harness.invoke('environment:validate', { verbose: true }),
    ).rejects.toThrow();
    expect(validate).toHaveBeenCalledTimes(1);
  });

  test('dispatches environment detect with the optional install root', async () => {
    const detect = vi.fn(async (_installRoot?: string) => ({
      ...environmentState,
    }));
    const harness = await createHarness({
      environment: {
        getState: async () => ({ ...environmentState }),
        detect,
        selectExistingRoot: async () => null,
        importExisting: async () => ({ ...environmentState }),
        start: async () => ({ ...environmentState }),
        retry: async () => ({ ...environmentState }),
        cancel: async () => ({ ...environmentState }),
        validate: async () => ({ ...environmentState }),
      },
    });

    await harness.invoke('environment:detect', {
      installRoot: 'D:\\SMO-Environment',
    });
    expect(detect).toHaveBeenCalledWith('D:\\SMO-Environment');

    await harness.invoke('environment:detect', {});
    expect(detect).toHaveBeenLastCalledWith(undefined);
  });

  test.each(['environment:start', 'environment:retry'] as const)(
    'validates %s input before calling the service',
    async (channel) => {
      let calls = 0;
      const run = async () => {
        calls += 1;
        return { ...environmentState };
      };
      const harness = await createHarness({
        environment: {
          getState: async () => ({ ...environmentState }),
          detect: async () => ({ ...environmentState }),
          selectExistingRoot: async () => null,
          importExisting: async () => ({ ...environmentState }),
          start: run,
          retry: run,
          cancel: async () => ({ ...environmentState }),
          validate: async () => ({ ...environmentState }),
        },
      });

      await expect(
        harness.invoke(channel, { profileId: 'turbo', installRoot: 'D:\\env' }),
      ).rejects.toThrow();
      expect(calls).toBe(0);

      await expect(
        harness.invoke(channel, {
          profileId: 'high-memory-candidate',
          installRoot: 'D:\\env',
        }),
      ).resolves.toEqual(environmentState);
      expect(calls).toBe(1);
    },
  );

  test('dispatches environment cancel to the service', async () => {
    const cancel = vi.fn(async () => ({ ...environmentState }));
    const harness = await createHarness({
      environment: {
        getState: async () => ({ ...environmentState }),
        detect: async () => ({ ...environmentState }),
        selectExistingRoot: async () => null,
        importExisting: async () => ({ ...environmentState }),
        start: async () => ({ ...environmentState }),
        retry: async () => ({ ...environmentState }),
        cancel,
        validate: async () => ({ ...environmentState }),
      },
    });

    await expect(harness.invoke('environment:cancel')).resolves.toEqual(
      environmentState,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
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

describe('app version IPC', () => {
  test('returns the Electron package version through the fixed channel', async () => {
    const harness = await createHarness();

    expect(IPC_CHANNELS).toContain('app:getVersion');
    await expect(harness.invoke('app:getVersion', {})).resolves.toBe('0.3.15-test');
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
    webUtilsGetPathForFile.mockReset();
  });

  test('authorizes dropped images by resolving the File through webUtils, never a raw path', async () => {
    webUtilsGetPathForFile.mockReturnValue('G:\\photos\\dropped.png');
    const file = { name: 'dropped.png' };

    await api.files.authorizeDroppedImage(file);

    expect(webUtilsGetPathForFile).toHaveBeenCalledWith(file);
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenCalledWith('files:authorizeDroppedImage', {
      path: 'G:\\photos\\dropped.png',
    });
  });

  test('cannot authorize an arbitrary string path from the renderer', async () => {
    webUtilsGetPathForFile.mockImplementation(() => {
      throw new Error('getPathForFile expects a File object');
    });

    // webUtils.getPathForFile rejects non-File input synchronously, before
    // any IPC round-trip can happen.
    expect(() => api.files.authorizeDroppedImage('G:\\private\\hacked.png')).toThrow(
      /File object/,
    );
    expect(ipcRendererInvoke).not.toHaveBeenCalled();
  });

  test('audio drop resolves the File through webUtils instead of accepting a raw path', async () => {
    webUtilsGetPathForFile.mockReturnValue('G:\\audio\\dropped.mp3');
    const file = { name: 'dropped.mp3' };

    await api.files.authorizeDroppedAudio(file);

    expect(webUtilsGetPathForFile).toHaveBeenCalledWith(file);
    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenCalledWith('files:authorizeDroppedAudio', {
      path: 'G:\\audio\\dropped.mp3',
    });
  });

  test('audio drop cannot authorize an arbitrary renderer path string', async () => {
    webUtilsGetPathForFile.mockImplementation(() => {
      throw new Error('getPathForFile expects a File object');
    });

    expect(() => api.files.authorizeDroppedAudio('G:\\private\\hacked.mp3')).toThrow(
      /File object/,
    );
    expect(ipcRendererInvoke).not.toHaveBeenCalled();
  });

  test('exposes only the fixed domain methods', () => {
    expect(Object.keys(api).sort()).toEqual([
      'app',
      'avatars',
      'comfy',
      'components',
      'environment',
      'files',
      'hardware',
      'jobs',
      'llm',
      'recordings',
      'speech',
      'window',
      'works',
    ]);
    expect(Object.keys(api.avatars).sort()).toEqual(['create', 'delete', 'list', 'update']);
    expect(Object.keys(api.jobs).sort()).toEqual(['cancel', 'getState', 'retry', 'start']);
    expect(Object.keys(api.llm).sort()).toEqual([
      'getProfile',
      'listModels',
      'polish',
      'saveProfile',
      'testModel',
    ]);
    expect(Object.keys(api.comfy)).toEqual(['health', 'start', 'open']);
    expect(Object.keys(api.speech)).toEqual(['getCapabilities']);
    expect(Object.keys(api.components).sort()).toEqual([
      'cancel',
      'getState',
      'install',
    ]);
    expect(Object.keys(api.environment).sort()).toEqual([
      'cancel',
      'detect',
      'getState',
      'importExisting',
      'retry',
      'selectExistingRoot',
      'start',
      'validate',
    ]);
    expect(Object.keys(api.hardware).sort()).toEqual(['apply', 'detect', 'recommend', 'reset']);
    expect(Object.keys(api.works)).toEqual(['delete', 'list', 'rename']);
    expect(Object.keys(api.files).sort()).toEqual([
      'authorizeDroppedAudio',
      'authorizeDroppedImage',
      'mediaUrl',
      'openFolder',
      'selectAudio',
      'selectImage',
    ]);
    expect(Object.keys(api.recordings).sort()).toEqual(['discard', 'save']);
    expect(Object.keys(api.window).sort()).toEqual([
      'beginResize',
      'close',
      'endResize',
      'isMaximized',
      'minimize',
      'resize',
      'toggleMaximize',
    ]);
    expect(Object.keys(api.app)).toEqual(['getVersion']);

    const exposedMethods = Object.values(api).flatMap((domain) => Object.keys(domain));
    for (const forbidden of ['invoke', 'shell', 'process', 'require', 'ipcRenderer']) {
      expect(exposedMethods).not.toContain(forbidden);
    }
  });

  test.each([
    {
      channel: 'app:getVersion',
      payload: {},
      call: (smo: SmoApi) => smo.app.getVersion(),
    },
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
      channel: 'jobs:start',
      payload: speechGenerationRequest,
      call: (smo: SmoApi) => smo.jobs.start(speechGenerationRequest),
    },
    {
      channel: 'jobs:start',
      payload: imageGenerationRequest,
      call: (smo: SmoApi) => smo.jobs.start(imageGenerationRequest),
    },
    {
      channel: 'speech:getCapabilities',
      payload: { speechMode: 'custom' },
      call: (smo: SmoApi) => smo.speech.getCapabilities('custom'),
    },
    {
      channel: 'components:getState',
      payload: { id: 'speech' },
      call: (smo: SmoApi) => smo.components.getState('speech'),
    },
    {
      channel: 'components:install',
      payload: { id: 'image' },
      call: (smo: SmoApi) => smo.components.install('image'),
    },
    {
      channel: 'components:cancel',
      payload: { id: 'speech' },
      call: (smo: SmoApi) => smo.components.cancel('speech'),
    },
    {
      channel: 'jobs:getState',
      payload: {},
      call: (smo: SmoApi) => smo.jobs.getState(),
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
      channel: 'files:authorizeDroppedImage',
      payload: { path: 'G:\\photos\\dropped.png' },
      call: (smo: SmoApi) => {
        webUtilsGetPathForFile.mockReturnValueOnce('G:\\photos\\dropped.png');
        return smo.files.authorizeDroppedImage({ name: 'dropped.png' });
      },
    },
    {
      channel: 'files:authorizeDroppedAudio',
      payload: { path: 'G:\\audio\\dropped.mp3' },
      call: (smo: SmoApi) => {
        webUtilsGetPathForFile.mockReturnValueOnce('G:\\audio\\dropped.mp3');
        return smo.files.authorizeDroppedAudio({ name: 'dropped.mp3' });
      },
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
      channel: 'environment:getState',
      payload: {},
      call: (smo: SmoApi) => smo.environment.getState(),
    },
    {
      channel: 'environment:selectExistingRoot',
      payload: {},
      call: (smo: SmoApi) => smo.environment.selectExistingRoot(),
    },
    {
      channel: 'environment:import',
      payload: { runtimeRoot: 'D:\\Existing\\ComfyUI', profileId: 'balanced-16gb' },
      call: (smo: SmoApi) =>
        smo.environment.importExisting({
          runtimeRoot: 'D:\\Existing\\ComfyUI',
          profileId: 'balanced-16gb',
        }),
    },
    {
      channel: 'environment:detect',
      payload: {},
      call: (smo: SmoApi) => smo.environment.detect(),
    },
    {
      channel: 'environment:detect',
      payload: { installRoot: 'D:\\SMO-Environment' },
      call: (smo: SmoApi) => smo.environment.detect('D:\\SMO-Environment'),
    },
    {
      channel: 'environment:start',
      payload: { profileId: 'balanced-16gb', installRoot: 'D:\\SMO-Environment' },
      call: (smo: SmoApi) =>
        smo.environment.start({
          profileId: 'balanced-16gb',
          installRoot: 'D:\\SMO-Environment',
        }),
    },
    {
      channel: 'environment:retry',
      payload: { profileId: 'conservative', installRoot: 'D:\\SMO-Environment' },
      call: (smo: SmoApi) =>
        smo.environment.retry({
          profileId: 'conservative',
          installRoot: 'D:\\SMO-Environment',
        }),
    },
    {
      channel: 'environment:cancel',
      payload: {},
      call: (smo: SmoApi) => smo.environment.cancel(),
    },
    {
      channel: 'works:list',
      payload: {},
      call: (smo: SmoApi) => smo.works.list(),
    },
    {
      channel: 'works:delete',
      payload: { id: 'work-1' },
      call: (smo: SmoApi) => smo.works.delete('work-1'),
    },
    {
      channel: 'works:rename',
      payload: { id: 'work-1', title: '新标题' },
      call: (smo: SmoApi) => smo.works.rename({ id: 'work-1', title: '新标题' }),
    },
    {
      channel: 'window:minimize',
      payload: {},
      call: (smo: SmoApi) => smo.window.minimize(),
    },
    {
      channel: 'window:toggle-maximize',
      payload: {},
      call: (smo: SmoApi) => smo.window.toggleMaximize(),
    },
    {
      channel: 'window:close',
      payload: {},
      call: (smo: SmoApi) => smo.window.close(),
    },
    {
      channel: 'window:is-maximized',
      payload: {},
      call: (smo: SmoApi) => smo.window.isMaximized(),
    },
    {
      channel: 'window:begin-resize',
      payload: { direction: 'se' },
      call: (smo: SmoApi) => smo.window.beginResize('se'),
    },
    {
      channel: 'window:resize',
      payload: { direction: 'n' },
      call: (smo: SmoApi) => smo.window.resize('n'),
    },
    {
      channel: 'window:end-resize',
      payload: {},
      call: (smo: SmoApi) => smo.window.endResize(),
    },
  ])('maps $channel without exposing a generic invoke method', async ({ channel, payload, call }) => {
    await call(api);

    expect(ipcRendererInvoke).toHaveBeenCalledTimes(1);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(channel, payload);
  });
});
