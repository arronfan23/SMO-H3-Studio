// @vitest-environment node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  EnvironmentSetupService,
  REQUIRED_COMFY_NODES,
  extractZipArchive,
  resolveExistingModelRoot,
  type EnvironmentSetupServiceOptions,
} from '../../src/main/environment-setup';
import { EnvironmentStore } from '../../src/main/environment-store';
import type {
  DownloadFileOptions,
  DownloadPartsOptions,
  DownloadReceipt,
} from '../../src/main/download';
import type {
  EnvironmentConfig,
  EnvironmentManifest,
} from '../../src/shared/environment';
import type { HardwareInfo } from '../../src/shared/types';

const cleanups: Array<() => void | Promise<void>> = [];
type BackendMock = ReturnType<
  typeof vi.fn<(input: unknown) => Promise<unknown>>
>;
type DownloadPartsMock = ReturnType<
  typeof vi.fn<(options: DownloadPartsOptions) => Promise<DownloadReceipt>>
>;
type DownloadFileMock = ReturnType<
  typeof vi.fn<(options: DownloadFileOptions) => Promise<DownloadReceipt>>
>;
type CommitReady = (config: EnvironmentConfig) => Promise<EnvironmentConfig>;
type CommitCapableStore = EnvironmentStore & { commitReady: CommitReady };
const TOP_LEVEL = 'ComfyUI_SelfLift_Spark_SM120_CUDA130';
const MODEL_PATHS = [
  'diffusion_models/main.safetensors',
  'text_encoders/MiniMax-H3/text.safetensors',
  'vae/video.safetensors',
  'vae/audio.safetensors',
  'loras/detail.safetensors',
  'loras/speed.safetensors',
  'latent_upscale_models/spatial.safetensors',
  'latent_upscale_models/temporal.safetensors',
  'vae_approx/taeh3.safetensors',
  'veda/attention.safetensors',
] as const;

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeManifest(
  contentFn: (path: string) => Buffer = modelContent,
): EnvironmentManifest {
  const archive = Buffer.from('small test archive');
  return {
    version: 1,
    runtimes: {
      sm89: makeRuntime('sm89'),
      sm120: makeRuntime('sm120'),
    },
    modelFiles: MODEL_PATHS.map((path, index) => {
      const content = contentFn(path);
      return {
        url: `https://models.test/${index}.safetensors`,
        path,
        size: content.length,
        sha256: sha256(content),
        source: 'unit-test',
      };
    }),
  };

  function makeRuntime(id: 'sm89' | 'sm120') {
    return {
      id,
      displayName: id,
      archiveParts: [
        {
          url: `https://runtime.test/${id}.zip`,
          path: `${id}.zip.part1`,
          size: archive.length,
          sha256: sha256(archive),
        },
      ],
      archiveSize: archive.length,
      archiveSha256: sha256(archive),
      estimatedExtractedBytes: 1024,
      pythonPath: `${TOP_LEVEL}/python_embeded/python.exe`,
      launchScript: `${TOP_LEVEL}/tools/launch.py`,
      ffprobePath: `${TOP_LEVEL}/tools/ffmpeg/ffprobe.exe`,
    };
  }
}

function modelContent(path: string): Buffer {
  return Buffer.from(`verified model: ${path}`);
}

function makeHardware(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    gpu: 'NVIDIA GeForce RTX 5090',
    vramGiB: 24,
    ramGiB: 64,
    windowsVersion: 'Windows 11',
    driverVersion: 'test-driver',
    cudaComputeCapability: '12.0',
    freeDiskGiB: 1024,
    ...overrides,
  };
}

function makeObjectInfo(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(REQUIRED_COMFY_NODES.map((node) => [node, {}]));
}

async function writeRuntimeFiles(
  runtimeRoot: string,
  options: { corruptLaunch?: boolean; omitManifestEntry?: boolean } = {},
): Promise<void> {
  const files = new Map([
    ['python_embeded/python.exe', Buffer.from('python')],
    ['tools/launch.py', Buffer.from('launch')],
    ['tools/ffmpeg/ffprobe.exe', Buffer.from('ffprobe')],
  ]);
  for (const [path, content] of files) {
    const destination = join(runtimeRoot, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(
      destination,
      options.corruptLaunch && path === 'tools/launch.py'
        ? Buffer.from('corrupt launch')
        : content,
    );
  }
  await mkdir(join(runtimeRoot, 'ComfyUI'), { recursive: true });
  const manifestLines = [...files]
    .filter(([path]) => !(options.omitManifestEntry && path === 'tools/launch.py'))
    .map(([path, content]) => `${sha256(content)}  ${path}`);
  await mkdir(join(runtimeRoot, 'docs'), { recursive: true });
  await writeFile(
    join(runtimeRoot, 'docs', 'file-manifest.sha256'),
    `${manifestLines.join('\n')}\n`,
    'utf8',
  );
}

interface Harness {
  service: EnvironmentSetupService;
  store: EnvironmentStore;
  installRoot: string;
  outputDirectory: string;
  manifest: EnvironmentManifest;
  runtimeRoot: string;
  backend: BackendMock;
  backendInputs: unknown[];
  downloads: {
    parts: DownloadPartsMock;
    file: DownloadFileMock;
  };
  networkDownloads: string[];
  setDownloadProgressHandler(handler: (() => void) | undefined): void;
}

function controlReadyCommit(
  harness: Harness,
  onCommit: (
    config: EnvironmentConfig,
    write: (config: EnvironmentConfig) => Promise<EnvironmentConfig>,
  ) => Promise<EnvironmentConfig>,
  path = join(harness.installRoot, 'environment.json'),
): void {
  const write = async (config: EnvironmentConfig) => {
    const ready: EnvironmentConfig = {
      ...config,
      status: 'ready',
      updatedAt:
        config.status === 'ready' ? config.updatedAt : new Date().toISOString(),
    };
    await writeFile(path, `${JSON.stringify(ready, null, 2)}\n`, 'utf8');
    return ready;
  };
  const commit = vi.fn((config: EnvironmentConfig) => onCommit(config, write));
  (harness.store as CommitCapableStore).commitReady = commit;
  vi.spyOn(harness.store, 'markReady').mockImplementation(async () => {
    const current = await harness.store.load();
    if (!current) throw new Error('No environment configuration exists');
    return commit(current);
  });
}

async function createHarness(
  overrides: {
    hardware?: HardwareInfo;
    manifest?: EnvironmentManifest;
    modelContent?: (path: string) => Buffer;
    installRoot?: string;
    outputDirectory?: string;
    configure?: (context: {
      failNextModel: { value: number };
      corruptLaunch: { value: boolean };
      omitManifestEntry: { value: boolean };
      backend: BackendMock;
      downloadProgress: { current: (() => void) | undefined };
    }) => void;
    service?: Partial<EnvironmentSetupServiceOptions>;
  } = {},
): Promise<Harness> {
  const installRoot = overrides.installRoot ?? (await mkdtemp(join(tmpdir(), 'smo-setup-')));
  const outputDirectory = overrides.outputDirectory ?? join(installRoot, 'fixed-output');
  cleanups.push(() => rm(installRoot, { recursive: true, force: true }));
  const manifest = overrides.manifest ?? makeManifest();
  const contentFn = overrides.modelContent ?? modelContent;
  const store = new EnvironmentStore(join(installRoot, 'environment.json'));
  const failNextModel = { value: -1 };
  const corruptLaunch = { value: false };
  const omitManifestEntry = { value: false };
  const downloadProgress = { current: undefined as (() => void) | undefined };
  const networkDownloads: string[] = [];
  const backendInputs: unknown[] = [];
  const backend = vi.fn<(input: unknown) => Promise<unknown>>(async (input) => {
    backendInputs.push(input);
    return {
      systemStats: { system: { os: 'test' }, devices: [] },
      objectInfo: makeObjectInfo(),
    };
  });
  overrides.configure?.({
    failNextModel,
    corruptLaunch,
    omitManifestEntry,
    backend,
    downloadProgress,
  });

  const parts = vi.fn(async (options: DownloadPartsOptions) => {
    await mkdir(dirname(options.destination), { recursive: true });
    if (!existsSync(options.destination)) {
      networkDownloads.push(options.parts[0].url);
      await writeFile(options.destination, 'archive');
    }
    options.onProgress?.({
      downloadedBytes: options.expectedSize,
      totalBytes: options.expectedSize,
      path: options.destination,
    });
    return {
      resumed: false,
      bytes: options.expectedSize,
      sha256: options.expectedSha256,
    };
  });
  const file = vi.fn(async (options: DownloadFileOptions) => {
    const existing = existsSync(options.destination)
      ? await readFile(options.destination)
      : null;
    if (
      existing === null ||
      existing.length !== options.expectedSize ||
      sha256(existing) !== options.expectedSha256
    ) {
      const model = manifest.modelFiles.find((candidate) => candidate.url === options.url);
      const modelIndex = model ? manifest.modelFiles.indexOf(model) : -1;
      if (modelIndex === failNextModel.value) {
        failNextModel.value = -1;
        throw new Error(`download failed for ${options.url}`);
      }
      networkDownloads.push(options.url);
      await mkdir(dirname(options.destination), { recursive: true });
      await writeFile(options.destination, contentFn(model?.path ?? ''));
    }
    downloadProgress.current?.();
    options.onProgress?.({
      downloadedBytes: options.expectedSize,
      totalBytes: options.expectedSize,
      path: options.destination,
    });
    return {
      resumed: false,
      bytes: options.expectedSize,
      sha256: options.expectedSha256,
    };
  });

  const options: EnvironmentSetupServiceOptions = {
    store,
    manifest,
    defaultInstallRoot: installRoot,
    outputDirectory,
    detectHardware: async () => overrides.hardware ?? makeHardware(),
    downloadParts: parts,
    downloadFile: file,
    extract: async ({ stagingDirectory }) => {
      await writeRuntimeFiles(join(stagingDirectory, TOP_LEVEL), {
        corruptLaunch: corruptLaunch.value,
        omitManifestEntry: omitManifestEntry.value,
      });
    },
    startBackend: backend,
    ...overrides.service,
  };
  const service = new EnvironmentSetupService(options);
  return {
    service,
    store: options.store,
    installRoot,
    outputDirectory,
    manifest,
    runtimeRoot: join(installRoot, 'runtime', TOP_LEVEL),
    backend,
    backendInputs,
    downloads: { parts, file },
    networkDownloads,
    setDownloadProgressHandler(handler) {
      downloadProgress.current = handler;
    },
  };
}

async function seedReadyConfig(
  harness: Harness,
  overrides: Partial<EnvironmentConfig> = {},
): Promise<EnvironmentConfig> {
  const now = new Date().toISOString();
  const config: EnvironmentConfig = {
    schemaVersion: 1,
    runtimeId: 'sm120',
    runtimeRoot: harness.runtimeRoot,
    modelDirectory: join(harness.installRoot, 'models', 'diffusion_models'),
    outputDirectory: harness.outputDirectory,
    profile: 'high-memory-candidate',
    hardwareFingerprint: {
      gpu: 'NVIDIA GeForce RTX 5090',
      vramGiB: 24,
      ramGiB: 64,
      cudaComputeCapability: '12.0',
    },
    manifestVersion: '1',
    status: 'installing',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await harness.store.save(config);
  return harness.store.markReady();
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createExistingModelFixture(): Promise<{
  directory: string;
  runtimeRoot: string;
  configPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-existing-models-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const runtimeRoot = join(directory, 'runtime');
  const comfyDirectory = join(runtimeRoot, 'ComfyUI');
  await mkdir(comfyDirectory, { recursive: true });
  return {
    directory,
    runtimeRoot,
    configPath: join(comfyDirectory, 'extra_model_paths.yaml'),
  };
}

describe('resolveExistingModelRoot', () => {
  test('reads a Chinese external base_path from h3_selflift_models', async () => {
    const { directory, runtimeRoot, configPath } = await createExistingModelFixture();
    const modelRoot = join(directory, '外置模型', '模型部分');
    const yaml = `h3_selflift_models:\n  base_path: '${modelRoot}'\n  diffusion_models: diffusion_models\n`;
    await writeFile(configPath, yaml, 'utf8');

    await expect(resolveExistingModelRoot(runtimeRoot)).resolves.toBe(
      win32.normalize(modelRoot),
    );
    expect(await readFile(configPath, 'utf8')).toBe(yaml);
  });

  test('falls back to ComfyUI/models when the config does not exist', async () => {
    const { runtimeRoot } = await createExistingModelFixture();

    await expect(resolveExistingModelRoot(runtimeRoot)).resolves.toBe(
      join(runtimeRoot, 'ComfyUI', 'models'),
    );
  });

  test('falls back to ComfyUI/models when h3_selflift_models is absent', async () => {
    const { runtimeRoot, configPath } = await createExistingModelFixture();
    await writeFile(configPath, "other_models:\n  base_path: 'D:\\models'\n", 'utf8');

    await expect(resolveExistingModelRoot(runtimeRoot)).resolves.toBe(
      join(runtimeRoot, 'ComfyUI', 'models'),
    );
  });

  test('falls back to ComfyUI/models when base_path is absent', async () => {
    const { runtimeRoot, configPath } = await createExistingModelFixture();
    await writeFile(
      configPath,
      'h3_selflift_models:\n  diffusion_models: diffusion_models\n',
      'utf8',
    );

    await expect(resolveExistingModelRoot(runtimeRoot)).resolves.toBe(
      join(runtimeRoot, 'ComfyUI', 'models'),
    );
  });

  test.each([
    {
      scenario: 'a non-string',
      yamlValue: '42',
      error: /base_path.*string/i,
    },
    {
      scenario: 'a non-absolute path',
      yamlValue: 'models',
      error: /absolute/i,
    },
    {
      scenario: 'an unsafe Windows path',
      yamlValue: "'C:\\models\\CON'",
      error: /unsafe/i,
    },
  ])('rejects $scenario base_path', async ({ yamlValue, error }) => {
    const { runtimeRoot, configPath } = await createExistingModelFixture();
    await writeFile(
      configPath,
      `h3_selflift_models:\n  base_path: ${yamlValue}\n`,
      'utf8',
    );

    await expect(resolveExistingModelRoot(runtimeRoot)).rejects.toThrow(error);
  });

  test('reports malformed YAML instead of silently falling back', async () => {
    const { runtimeRoot, configPath } = await createExistingModelFixture();
    await writeFile(
      configPath,
      'h3_selflift_models:\n  base_path: [unterminated\n',
      'utf8',
    );

    await expect(resolveExistingModelRoot(runtimeRoot)).rejects.toThrow(
      /failed to parse .*extra_model_paths\.yaml/i,
    );
  });

  test('propagates non-ENOENT read failures', async () => {
    const { runtimeRoot, configPath } = await createExistingModelFixture();
    await mkdir(configPath);

    await expect(resolveExistingModelRoot(runtimeRoot)).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});

describe('EnvironmentSetupService installation', () => {
  test('installs, verifies, starts, and marks a complete environment ready', async () => {
    const harness = await createHarness();

    const state = await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(state).toMatchObject({
      stage: 'ready',
      installRoot: win32.normalize(harness.installRoot),
      active: false,
      healthy: true,
      error: null,
      config: {
        status: 'ready',
        runtimeRoot: harness.runtimeRoot,
        modelDirectory: join(harness.installRoot, 'models', 'diffusion_models'),
        outputDirectory: harness.outputDirectory,
      },
    });
    expect(harness.networkDownloads).toHaveLength(11);
    expect(harness.backendInputs[0]).toMatchObject({
      runtimeRoot: harness.runtimeRoot,
      pythonPath: join(harness.installRoot, 'runtime', TOP_LEVEL, 'python_embeded', 'python.exe'),
      launchScript: join(harness.installRoot, 'runtime', TOP_LEVEL, 'tools', 'launch.py'),
      ffprobePath: join(harness.installRoot, 'runtime', TOP_LEVEL, 'tools', 'ffmpeg', 'ffprobe.exe'),
      outputDirectory: harness.outputDirectory,
      profile: 'high-memory-candidate',
      signal: expect.any(AbortSignal),
    });
    expect(harness.backend).toHaveBeenCalledTimes(1);
    expect((await harness.store.load())?.status).toBe('ready');

    const yaml = await readFile(
      join(harness.runtimeRoot, 'ComfyUI', 'extra_model_paths.yaml'),
      'utf8',
    );
    expect(yaml).toContain('h3_selflift_models:');
    expect(yaml).toContain(`base_path: '${join(harness.installRoot, 'models')}'`);
    for (const key of [
      'diffusion_models',
      'text_encoders',
      'vae',
      'loras',
      'veda',
      'latent_upscale_models',
      'vae_approx',
    ]) {
      expect(yaml).toContain(`${key}: ${key}`);
    }
    expect(existsSync(join(harness.installRoot, '.smo-install', 'staging'))).toBe(false);
  });

  test('records the normalized installRoot in the saved environment config', async () => {
    const harness = await createHarness();

    await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect((await harness.store.load())?.installRoot).toBe(
      win32.normalize(harness.installRoot),
    );
  });

  test('escapes apostrophes in the YAML model root', async () => {
    const parent = await mkdtemp(join(tmpdir(), "smo-setup-'quote-"));
    const installRoot = join(parent, 'install');
    await mkdir(installRoot, { recursive: true });
    const harness = await createHarness({ installRoot });
    cleanups.push(() => rm(parent, { recursive: true, force: true }));

    await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot,
    });

    const yaml = await readFile(
      join(harness.runtimeRoot, 'ComfyUI', 'extra_model_paths.yaml'),
      'utf8',
    );
    expect(yaml).toContain(join(harness.installRoot, 'models').replaceAll("'", "''"));
  });

  test('reuses a valid ready installation without downloading or extracting again', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });

    const second = await createHarness({ installRoot: first.installRoot });
    second.networkDownloads.length = 0;
    const state = await second.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });

    expect(state.healthy).toBe(true);
    expect(second.networkDownloads).toEqual([]);
    expect(second.downloads.parts).not.toHaveBeenCalled();
    expect(second.downloads.file).not.toHaveBeenCalled();
    expect(second.backend).toHaveBeenCalledTimes(1);
  });

  test('uses real download progress and keeps getState free of I/O', async () => {
    const harness = await createHarness();
    const stages = new Set<string>();
    let progressSeen = false;
    harness.setDownloadProgressHandler(() => {
      const state = harness.service.getState();
      stages.add(state.stage);
      progressSeen ||= state.progress.downloadedBytes > 0;
    });
    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    for (let index = 0; index < 20; index += 1) {
      expect(harness.service.getState()).toEqual(harness.service.getState());
    }
    await pending;

    expect(progressSeen).toBe(true);
    expect(stages.has('download-models')).toBe(true);
    expect(harness.downloads.parts).toHaveBeenCalledTimes(1);
  });

  test('uses the runtime download callback path as the current file', async () => {
    let service!: EnvironmentSetupService;
    const currentFiles: Array<string | undefined> = [];
    const harness = await createHarness({
      service: {
        downloadParts: async (options) => {
          options.onProgress?.({
            downloadedBytes: options.expectedSize,
            totalBytes: options.expectedSize,
            path: 'callback-runtime.zip',
          });
          currentFiles.push(service.getState().progress.currentFile);
          return {
            resumed: false,
            bytes: options.expectedSize,
            sha256: options.expectedSha256,
          };
        },
      },
    });
    service = harness.service;

    await service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(currentFiles).toEqual(['callback-runtime.zip']);
  });

  test('start and retry share one in-flight operation', async () => {
    const harness = await createHarness();
    const [first, second] = await Promise.all([
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
      harness.service.retry({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot.replaceAll('\\', '/'),
      }),
    ]);

    expect(first).toEqual(second);
    expect(harness.downloads.parts).toHaveBeenCalledTimes(1);
    expect(harness.backend).toHaveBeenCalledTimes(1);
  });

  test('advances through the installation stages in order', async () => {
    const harness = await createHarness();
    const stages: string[] = [];
    let polling = true;
    const poll = async () => {
      while (polling) {
        const stage = harness.service.getState().stage;
        if (stages.at(-1) !== stage) stages.push(stage);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const observer = poll();

    await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    polling = false;
    await observer;
    if (stages.at(-1) !== 'ready') stages.push('ready');

    expect(stages).toEqual([
      'detect',
      'select',
      'download-runtime',
      'extract',
      'download-models',
      'verify',
      'start',
      'ready',
    ]);
  });

  test('returns isolated state snapshots', async () => {
    const harness = await createHarness();
    const snapshot = harness.service.getState();
    snapshot.installRoot = 'C:\\changed';
    snapshot.progress.downloadedBytes = 999;

    expect(harness.service.getState().installRoot).toBe(harness.installRoot);
    expect(harness.service.getState().progress.downloadedBytes).toBe(0);
  });
});

describe('EnvironmentSetupService operation coordination', () => {
  test('successful detection moves to profile selection without starting a download', async () => {
    const harness = await createHarness();

    const state = await harness.service.detect(harness.installRoot);

    expect(state).toMatchObject({
      stage: 'select',
      active: false,
      progress: { downloadedBytes: 0, totalBytes: 0 },
    });
    expect(harness.downloads.parts).not.toHaveBeenCalled();
    expect(harness.downloads.file).not.toHaveBeenCalled();
  });

  test('start rejects while a detect operation is in flight', async () => {
    const detectStarted = createDeferred();
    const finishDetect = createDeferred();
    const detectHardware = vi.fn(async () => {
      detectStarted.resolve();
      await finishDetect.promise;
      return makeHardware();
    });
    const harness = await createHarness({ service: { detectHardware } });

    const detecting = harness.service.detect(harness.installRoot);
    await detectStarted.promise;
    const starting = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    finishDetect.resolve();

    await expect(starting).rejects.toThrow(/detect|busy|active|progress/i);
    await detecting;
  });

  test('detect rejects during setup without clearing the setup active state', async () => {
    const downloadStarted = createDeferred();
    const finishDownload = createDeferred();
    const harness = await createHarness({
      service: {
        downloadParts: async (options) => {
          downloadStarted.resolve();
          await finishDownload.promise;
          return {
            resumed: false,
            bytes: options.expectedSize,
            sha256: options.expectedSha256,
          };
        },
      },
    });
    const starting = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await downloadStarted.promise;

    const detected = harness.service.detect(harness.installRoot);
    const outcome = await detected.then(
      () => null,
      (error: unknown) => error,
    );
    const activeDuringSetup = harness.service.getState().active;
    finishDownload.resolve();
    await starting;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/setup|busy|active|progress/i);
    expect(activeDuringSetup).toBe(true);
  });

  test('same-root concurrent detects share one hardware detection', async () => {
    const detectStarted = createDeferred();
    const finishDetect = createDeferred();
    const detectHardware = vi.fn(async () => {
      detectStarted.resolve();
      await finishDetect.promise;
      return makeHardware();
    });
    const harness = await createHarness({ service: { detectHardware } });

    const first = harness.service.detect(harness.installRoot);
    await detectStarted.promise;
    const second = harness.service.detect(harness.installRoot.replaceAll('\\', '/'));
    finishDetect.resolve();
    await Promise.all([first, second]);

    expect(detectHardware).toHaveBeenCalledTimes(1);
  });

  test('a different-root detect rejects while another detect is running', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'smo-other-detect-'));
    cleanups.push(() => rm(otherRoot, { recursive: true, force: true }));
    const detectStarted = createDeferred();
    const finishDetect = createDeferred();
    const harness = await createHarness({
      service: {
        detectHardware: async (root) => {
          if (win32.normalize(root) === win32.normalize(harness.installRoot)) {
            detectStarted.resolve();
            await finishDetect.promise;
          }
          return makeHardware();
        },
      },
    });

    const first = harness.service.detect(harness.installRoot);
    await detectStarted.promise;
    const second = harness.service.detect(otherRoot);
    finishDetect.resolve();

    await expect(second).rejects.toThrow(/detect|root|busy|active/i);
    await first;
  });

  test('single-flight rejects a different profile or install root', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'smo-other-start-'));
    cleanups.push(() => rm(otherRoot, { recursive: true, force: true }));
    const downloadStarted = createDeferred();
    const finishDownload = createDeferred();
    const harness = await createHarness({
      service: {
        downloadParts: async (options) => {
          downloadStarted.resolve();
          await finishDownload.promise;
          return {
            resumed: false,
            bytes: options.expectedSize,
            sha256: options.expectedSha256,
          };
        },
      },
    });
    const input = {
      profileId: 'high-memory-candidate' as const,
      installRoot: harness.installRoot,
    };
    const first = harness.service.start(input);
    await downloadStarted.promise;

    const differentProfile = harness.service.retry({
      ...input,
      profileId: 'balanced-16gb',
    });
    const differentRoot = harness.service.start({
      ...input,
      installRoot: otherRoot,
    });
    finishDownload.resolve();

    await expect(differentProfile).rejects.toThrow(/input|profile|busy|active/i);
    await expect(differentRoot).rejects.toThrow(/input|root|busy|active/i);
    await first;
  });
});

describe('EnvironmentSetupService failures and recovery', () => {
  test('rejects insufficient disk space before any download', async () => {
    const harness = await createHarness({ hardware: makeHardware({ freeDiskGiB: 0 }) });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/disk/i);
    expect(harness.downloads.parts).not.toHaveBeenCalled();
    expect(harness.service.getState()).toMatchObject({ healthy: false, active: false });
    expect(harness.service.getState().error).toMatch(/disk/i);
  });

  test('retry preserves verified model files and only downloads missing models', async () => {
    const harness = await createHarness({
      configure: ({ failNextModel }) => {
        failNextModel.value = 4;
      },
    });
    const input = {
      profileId: 'high-memory-candidate' as const,
      installRoot: harness.installRoot,
    };

    await expect(harness.service.start(input)).rejects.toThrow(/download failed/i);
    expect((await harness.store.load())?.status).toBe('failed');
    const firstDownloads = [...harness.networkDownloads];
    await expect(harness.service.retry(input)).resolves.toMatchObject({
      stage: 'ready',
      healthy: true,
    });

    const retriedUrls = harness.networkDownloads.slice(firstDownloads.length);
    expect(retriedUrls).toHaveLength(6);
    expect(retriedUrls).not.toContain(harness.manifest.modelFiles[0].url);
    expect(retriedUrls).not.toContain(harness.manifest.modelFiles[3].url);
    expect(retriedUrls).toContain(harness.manifest.modelFiles[4].url);
  });

  test('rejects a missing model even when its downloader reports success', async () => {
    const harness = await createHarness({
      service: {
        downloadFile: async (options) => ({
          resumed: false,
          bytes: options.expectedSize,
          sha256: options.expectedSha256,
        }),
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/model|missing|file/i);
    expect((await harness.store.load())?.status).toBe('failed');
    expect(harness.service.getState().healthy).toBe(false);
  });

  test.each([
    { scenario: 'system stats failure', missingNode: false },
    { scenario: 'a missing required custom node', missingNode: true },
  ])('does not become ready after $scenario', async ({ missingNode }) => {
    const harness = await createHarness({
      configure: ({ backend }) => {
        if (missingNode) {
          backend.mockImplementation(async () => {
            const info = makeObjectInfo();
            delete info[REQUIRED_COMFY_NODES[0]];
            return { systemStats: {}, objectInfo: info };
          });
        } else {
          backend.mockRejectedValue(new Error('backend unhealthy'));
        }
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(missingNode ? /SelfLiftH3Sampler|node/i : /unhealthy/i);
    expect((await harness.store.load())?.status).toBe('failed');
    expect(harness.service.getState()).toMatchObject({ active: false, healthy: false });
    expect(harness.backend).toHaveBeenCalledTimes(1);
  });

  test('rejects critical runtime files whose upstream hash does not match', async () => {
    const harness = await createHarness({
      configure: ({ corruptLaunch }) => {
        corruptLaunch.value = true;
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/launch\.py|sha256|hash/i);
    expect(existsSync(harness.runtimeRoot)).toBe(false);
    expect(harness.backend).not.toHaveBeenCalled();
  });

  test('rejects an incomplete upstream file manifest', async () => {
    const harness = await createHarness({
      configure: ({ omitManifestEntry }) => {
        omitManifestEntry.value = true;
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/manifest|launch\.py/i);
    expect(harness.service.getState().healthy).toBe(false);
  });

  test('cancel aborts the active download and never marks the environment ready', async () => {
    const harness = await createHarness({
      service: {
        downloadParts: async ({ signal }) => {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(new Error('download aborted')),
              { once: true },
            );
          });
          return { resumed: false, bytes: 1, sha256: 'unused' };
        },
      },
    });

    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await vi.waitFor(() => {
      expect(harness.service.getState().stage).toBe('download-runtime');
    });
    harness.service.cancel();

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(harness.service.getState()).toMatchObject({ active: false, healthy: false });
    expect((await harness.store.load())?.status).toBe('failed');
  });

  test('cancel during final staging cleanup prevents backend startup', async () => {
    const harness = await createHarness();
    const cleanupStarted = createDeferred();
    const finishCleanup = createDeferred();
    const cleaner = harness.service as unknown as {
      removeStaging(layout: unknown): Promise<void>;
    };
    const original = cleaner.removeStaging.bind(harness.service);
    let cleanups = 0;
    vi.spyOn(cleaner, 'removeStaging').mockImplementation(async (layout) => {
      cleanups += 1;
      if (cleanups === 2) {
        cleanupStarted.resolve();
        await finishCleanup.promise;
      }
      return original(layout);
    });

    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await cleanupStarted.promise;
    const cancelling = harness.service.cancel();
    finishCleanup.resolve();
    await cancelling;

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(harness.backend).not.toHaveBeenCalled();
    expect((await harness.store.load())?.status).toBe('failed');
  });

  test('cancel during backend startup aborts the adapter signal', async () => {
    const backendStarted = createDeferred();
    const finishBackend = createDeferred();
    let harness!: Harness;
    let observedSignal: AbortSignal | undefined;
    harness = await createHarness({
      service: {
        startBackend: async (input) => {
          observedSignal = input.signal;
          backendStarted.resolve();
          await finishBackend.promise;
          input.signal.throwIfAborted();
          return { systemStats: {}, objectInfo: makeObjectInfo() };
        },
      },
    });

    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await backendStarted.promise;
    const cancelling = harness.service.cancel();
    expect(observedSignal?.aborted).toBe(true);
    finishBackend.resolve();
    await cancelling;

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect((await harness.store.load())?.status).toBe('failed');
  });

  test('cancel before the ready commit cannot publish a ready configuration', async () => {
    let harness!: Harness;
    harness = await createHarness({
      service: {
        startBackend: async () => {
          void harness.service.cancel();
          return { systemStats: {}, objectInfo: makeObjectInfo() };
        },
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/abort|cancel/i);

    expect(harness.service.getState()).toMatchObject({
      active: false,
      healthy: false,
      config: { status: 'failed' },
    });
    expect((await harness.store.load())?.status).toBe('failed');
  });

  test('cancel during an atomic ready commit rolls a new installation back to failed', async () => {
    const harness = await createHarness();
    const commitStarted = createDeferred();
    const finishCommit = createDeferred();
    let commits = 0;
    controlReadyCommit(harness, async (config, write) => {
      commits += 1;
      if (commits === 1) {
        commitStarted.resolve();
        await finishCommit.promise;
      }
      return write(config);
    });

    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await commitStarted.promise;
    const cancelling = harness.service.cancel();
    finishCommit.resolve();
    await cancelling;

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(harness.service.getState()).toMatchObject({
      active: false,
      healthy: false,
      config: { status: 'failed' },
    });
    expect((await harness.store.load())?.status).toBe('failed');
  });

  test.each(['installing', 'failed'] as const)(
    'restores a persisted %s configuration after restart',
    async (status) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      await harness.store.save({
        schemaVersion: 1,
        runtimeId: 'sm120',
        runtimeRoot: harness.runtimeRoot,
        modelDirectory: join(harness.installRoot, 'models', 'diffusion_models'),
        outputDirectory: harness.outputDirectory,
        profile: 'high-memory-candidate',
        hardwareFingerprint: {
          gpu: 'NVIDIA GeForce RTX 5090',
          vramGiB: 24,
          ramGiB: 64,
          cudaComputeCapability: '12.0',
        },
        manifestVersion: '1',
        status,
        createdAt: now,
        updatedAt: now,
      });
      const restarted = new EnvironmentSetupService({
        store: harness.store,
        manifest: harness.manifest,
        defaultInstallRoot: harness.installRoot,
        outputDirectory: harness.outputDirectory,
        detectHardware: async () => makeHardware(),
        startBackend: harness.backend,
      });

      await restarted.detect();
      expect(restarted.getState().config?.status).toBe(status);
      expect(restarted.getState().healthy).toBe(false);
      expect(restarted.getState().error).toMatch(/interrupt|fail|resume|retry/i);
    },
  );

  test('surfaces a corrupt persisted configuration without repeatedly throwing', async () => {
    const harness = await createHarness();
    await writeFile(join(harness.installRoot, 'environment.json'), '{broken', 'utf8');
    const restarted = new EnvironmentSetupService({
      store: harness.store,
      manifest: harness.manifest,
      defaultInstallRoot: harness.installRoot,
      outputDirectory: harness.outputDirectory,
      detectHardware: async () => makeHardware(),
      startBackend: harness.backend,
    });

    await restarted.detect();

    expect(restarted.getState().config).toBeNull();
    expect(restarted.getState().error).toMatch(/configuration|JSON/i);
    expect(() => restarted.getState()).not.toThrow();
    expect(restarted.getState().error).toMatch(/configuration|JSON/i);
  });

  test('keeps an old ready configuration when a different new installation fails', async () => {
    const oldRoot = await mkdtemp(join(tmpdir(), 'smo-old-ready-'));
    cleanups.push(() => rm(oldRoot, { recursive: true, force: true }));
    const old = await createHarness({ installRoot: oldRoot });
    const oldReady = await seedReadyConfig(old);
    const newRoot = await mkdtemp(join(tmpdir(), 'smo-new-failed-'));
    const harness = await createHarness({
      installRoot: newRoot,
      outputDirectory: old.outputDirectory,
      service: {
        store: old.store,
        downloadParts: async () => {
          throw new Error('network offline');
        },
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: newRoot,
      }),
    ).rejects.toThrow(/offline/i);

    expect(await old.store.load()).toEqual(oldReady);
    expect(harness.service.getState().config).toEqual(oldReady);
    expect(harness.service.getState().healthy).toBe(false);
  });

  test('a failed ready commit preserves the old ready file and memory snapshot', async () => {
    const old = await createHarness();
    const oldReady = await seedReadyConfig(old);
    const harness = await createHarness({
      outputDirectory: old.outputDirectory,
      service: { store: old.store },
    });
    controlReadyCommit(
      harness,
      async () => {
        throw new Error('atomic commit failed');
      },
      join(old.installRoot, 'environment.json'),
    );

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/atomic commit failed/i);

    expect(await old.store.load()).toEqual(oldReady);
    expect(harness.service.getState()).toMatchObject({
      config: oldReady,
      healthy: false,
      active: false,
    });
  });

  test('cancel during ready replacement restores the previous ready configuration', async () => {
    const old = await createHarness();
    const oldReady = await seedReadyConfig(old);
    const harness = await createHarness({
      outputDirectory: old.outputDirectory,
      service: { store: old.store },
    });
    const commitStarted = createDeferred();
    const finishCommit = createDeferred();
    let commits = 0;
    controlReadyCommit(
      harness,
      async (config, write) => {
        commits += 1;
        if (commits === 1) {
          commitStarted.resolve();
          await finishCommit.promise;
        }
        return write(config);
      },
      join(old.installRoot, 'environment.json'),
    );

    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await commitStarted.promise;
    const cancelling = harness.service.cancel();
    finishCommit.resolve();
    await cancelling;

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(await old.store.load()).toEqual(oldReady);
    expect(harness.service.getState()).toMatchObject({
      config: oldReady,
      healthy: false,
      active: false,
    });
  });

  test('does not report a previously ready installation healthy when revalidation fails', async () => {
    const harness = await createHarness();
    const ready = await seedReadyConfig(harness);
    await writeRuntimeFiles(harness.runtimeRoot);
    await rm(join(harness.installRoot, 'models', 'diffusion_models', 'main.safetensors'), {
      force: true,
    });
    const restarted = new EnvironmentSetupService({
      store: harness.store,
      manifest: harness.manifest,
      defaultInstallRoot: harness.installRoot,
      outputDirectory: harness.outputDirectory,
      detectHardware: async () => makeHardware(),
      downloadParts: harness.downloads.parts,
      downloadFile: harness.downloads.file,
      startBackend: harness.backend,
    });

    await expect(
      restarted.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/model|missing|file/i);
    expect(await harness.store.load()).toEqual(ready);
    expect(restarted.getState()).toMatchObject({ healthy: false, active: false });
    expect(harness.downloads.file).not.toHaveBeenCalled();
  });

  test('rejects a profile that exceeds the hardware gate', async () => {
    const harness = await createHarness({ hardware: makeHardware({ vramGiB: 16 }) });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/20|high-memory/i);
    await expect(
      harness.service.start({
        profileId: 'balanced-16gb',
        installRoot: harness.installRoot,
      }),
    ).resolves.toMatchObject({ healthy: true });
    expect(harness.backendInputs.at(-1)).toMatchObject({ profile: 'balanced-16gb' });
  });

  test.each([
    'C:\\',
    'relative\\install',
    'C:install',
    'C:\\safe\\..\\escape',
    '\\\\server\\share',
    '\\\\?\\C:\\install',
  ])('rejects unsafe installRoot %s before detection or download', async (installRoot) => {
    const harness = await createHarness();
    const detect = vi.fn(async () => makeHardware());
    const service = new EnvironmentSetupService({
      store: harness.store,
      manifest: harness.manifest,
      defaultInstallRoot: harness.installRoot,
      outputDirectory: harness.outputDirectory,
      detectHardware: detect,
      downloadParts: harness.downloads.parts,
      startBackend: harness.backend,
    });

    await expect(
      service.start({ profileId: 'conservative', installRoot }),
    ).rejects.toThrow(/installRoot|path/i);
    expect(detect).not.toHaveBeenCalled();
  });
});

describe('EnvironmentSetupService installRoot restore', () => {
  function restartService(harness: Harness): EnvironmentSetupService {
    return new EnvironmentSetupService({
      store: harness.store,
      manifest: harness.manifest,
      defaultInstallRoot: harness.installRoot,
      outputDirectory: harness.outputDirectory,
      detectHardware: async () => makeHardware(),
      downloadParts: harness.downloads.parts,
      downloadFile: harness.downloads.file,
      startBackend: harness.backend,
    });
  }

  test('prefers the recorded custom installRoot of a ready config after restart', async () => {
    const harness = await createHarness();
    const customRoot = await mkdtemp(join(tmpdir(), 'smo-custom-root-'));
    cleanups.push(() => rm(customRoot, { recursive: true, force: true }));
    await seedReadyConfig(harness, { installRoot: customRoot });
    const restarted = restartService(harness);

    await vi.waitFor(() => {
      expect(restarted.getState().config).not.toBeNull();
    });

    expect(restarted.getState().installRoot).toBe(win32.normalize(customRoot));
    expect(restarted.getState().healthy).toBe(false);
  });

  test('derives the installRoot from the recorded runtimeRoot for legacy configs', async () => {
    const harness = await createHarness();
    const legacyRoot = await mkdtemp(join(tmpdir(), 'smo-legacy-root-'));
    cleanups.push(() => rm(legacyRoot, { recursive: true, force: true }));
    await seedReadyConfig(harness, {
      runtimeRoot: join(legacyRoot, 'runtime', TOP_LEVEL),
      modelDirectory: join(legacyRoot, 'models', 'diffusion_models'),
    });
    const restarted = restartService(harness);

    await vi.waitFor(() => {
      expect(restarted.getState().config).not.toBeNull();
    });

    expect(restarted.getState().installRoot).toBe(win32.normalize(legacyRoot));
  });

  test('shows an error instead of reinstalling into the default directory when the installRoot cannot be restored', async () => {
    const harness = await createHarness();
    await seedReadyConfig(harness, { runtimeRoot: 'D:\\sm120' });
    const restarted = restartService(harness);

    await vi.waitFor(() => {
      expect(restarted.getState().error).toMatch(/installRoot/i);
    });
    const state = restarted.getState();
    expect(state.installRoot).toBe('');
    expect(state.config?.status).toBe('ready');
    expect(state.healthy).toBe(false);

    await expect(
      restarted.retry({
        profileId: 'high-memory-candidate',
        installRoot: state.installRoot,
      }),
    ).rejects.toThrow(/installRoot/i);
  });

  test('reuses a custom-root ready installation on offline retry after restart', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const offlineParts = vi.fn(async () => {
      throw new Error('network offline');
    });
    const offlineFile = vi.fn(async () => {
      throw new Error('network offline');
    });
    const second = await createHarness({
      installRoot: first.installRoot,
      service: {
        downloadParts: offlineParts,
        downloadFile: offlineFile,
      },
    });
    await vi.waitFor(() => {
      expect(second.service.getState().config?.status).toBe('ready');
    });
    const restoredInstallRoot = second.service.getState().installRoot;

    const state = await second.service.retry({
      profileId: 'high-memory-candidate',
      installRoot: restoredInstallRoot,
    });

    expect(state).toMatchObject({ stage: 'ready', healthy: true });
    expect(restoredInstallRoot).toBe(win32.normalize(first.installRoot));
    expect(state.config?.installRoot).toBe(win32.normalize(first.installRoot));
    expect(offlineParts).not.toHaveBeenCalled();
    expect(offlineFile).not.toHaveBeenCalled();
  });
});

describe('EnvironmentSetupService backend transactions', () => {
  function makeTransaction(activateError?: Error) {
    const calls: string[] = [];
    const activate = vi.fn(async () => {
      calls.push('activate');
      if (activateError) throw activateError;
    });
    const rollback = vi.fn(async () => {
      calls.push('rollback');
    });
    return {
      calls,
      activate,
      rollback,
      result: {
        systemStats: { system: { os: 'test' }, devices: [] },
        objectInfo: makeObjectInfo(),
        activate,
        rollback,
      },
    };
  }

  test('activates the backend transaction only after the ready commit succeeds', async () => {
    const transaction = makeTransaction();
    const harness = await createHarness({
      service: { startBackend: async () => transaction.result },
    });
    controlReadyCommit(harness, async (config, write) => {
      transaction.calls.push('commit');
      return write(config);
    });

    const state = await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(state).toMatchObject({ stage: 'ready', healthy: true });
    expect(transaction.calls).toEqual(['commit', 'activate']);
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  test('rolls back the candidate when cancel lands during a delayed ready commit', async () => {
    const transaction = makeTransaction();
    const harness = await createHarness({
      service: { startBackend: async () => transaction.result },
    });
    const commitStarted = createDeferred();
    const finishCommit = createDeferred();
    let commits = 0;
    controlReadyCommit(harness, async (config, write) => {
      commits += 1;
      if (commits === 1) {
        commitStarted.resolve();
        await finishCommit.promise;
      }
      return write(config);
    });

    const pending = harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });
    await commitStarted.promise;
    const cancelling = harness.service.cancel();
    finishCommit.resolve();
    await cancelling;

    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(transaction.activate).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect((await harness.store.load())?.status).toBe('failed');
    expect(harness.service.getState()).toMatchObject({
      active: false,
      healthy: false,
    });
  });

  test('rolls back the candidate and the ready commit when activation fails', async () => {
    const transaction = makeTransaction(new Error('activate exploded'));
    const harness = await createHarness({
      service: { startBackend: async () => transaction.result },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/activate exploded/i);

    expect(transaction.activate).toHaveBeenCalledTimes(1);
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect((await harness.store.load())?.status).toBe('failed');
    expect(harness.service.getState()).toMatchObject({
      stage: 'start',
      active: false,
      healthy: false,
    });
  });
});

describe('EnvironmentSetupService runtime replacement and reparse safety', () => {
  test('quarantines a corrupt non-ready runtime and reinstalls on retry', async () => {
    const first = await createHarness();
    await writeRuntimeFiles(first.runtimeRoot, { corruptLaunch: true });
    const config = await seedReadyConfig(first);
    await first.store.save({ ...config, status: 'failed' });
    const harness = await createHarness({ installRoot: first.installRoot });

    await expect(
      harness.service.retry({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).resolves.toMatchObject({ stage: 'ready', healthy: true });

    expect(harness.downloads.parts).toHaveBeenCalledTimes(1);
    const quarantineRoot = join(harness.installRoot, '.smo-install', 'quarantine');
    const entries = await readdir(quarantineRoot);
    expect(entries).toHaveLength(1);
    expect(
      await readFile(join(quarantineRoot, entries[0], 'tools', 'launch.py'), 'utf8'),
    ).toBe('corrupt launch');
    expect(
      await readFile(join(harness.runtimeRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
  });

  test('installs a manifest upgrade into a versioned runtime directory', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const ready = await first.store.load();
    if (!ready) throw new Error('Expected a ready config');
    await first.store.save({ ...ready, status: 'installing', manifestVersion: '0' });
    await first.store.markReady();
    const harness = await createHarness({ installRoot: first.installRoot });
    const versionedRoot = join(
      harness.installRoot,
      'runtime',
      `${TOP_LEVEL}.manifest-v1`,
    );

    const state = await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(harness.downloads.parts).toHaveBeenCalledTimes(1);
    expect(state.config?.runtimeRoot).toBe(versionedRoot);
    expect((await harness.store.load())?.runtimeRoot).toBe(versionedRoot);
    expect(harness.backend).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot: versionedRoot,
        pythonPath: join(versionedRoot, 'python_embeded', 'python.exe'),
        launchScript: join(versionedRoot, 'tools', 'launch.py'),
        ffprobePath: join(versionedRoot, 'tools', 'ffmpeg', 'ffprobe.exe'),
      }),
    );
    expect(
      await readFile(join(versionedRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
    expect(
      await readFile(join(first.runtimeRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
    expect(existsSync(join(harness.installRoot, '.smo-install', 'quarantine'))).toBe(false);
  });

  test('reuses the versioned runtime directory on later runs after an upgrade', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const ready = await first.store.load();
    if (!ready) throw new Error('Expected a ready config');
    await first.store.save({ ...ready, status: 'installing', manifestVersion: '0' });
    await first.store.markReady();
    const upgraded = await createHarness({ installRoot: first.installRoot });
    await upgraded.service.start({
      profileId: 'high-memory-candidate',
      installRoot: upgraded.installRoot,
    });
    const versionedRoot = join(
      upgraded.installRoot,
      'runtime',
      `${TOP_LEVEL}.manifest-v1`,
    );
    const harness = await createHarness({ installRoot: first.installRoot });

    const state = await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(state.config?.runtimeRoot).toBe(versionedRoot);
    expect(harness.downloads.parts).not.toHaveBeenCalled();
    expect(harness.networkDownloads).toHaveLength(0);
    expect(harness.backend).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRoot: versionedRoot,
        pythonPath: join(versionedRoot, 'python_embeded', 'python.exe'),
      }),
    );
  });

  test('installs a manifest upgrade into a versioned model root', async () => {
    const upgradedContent = (path: string) => Buffer.from(`upgraded model: ${path}`);
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const ready = await first.store.load();
    if (!ready) throw new Error('Expected a ready config');
    await first.store.save({ ...ready, status: 'installing', manifestVersion: '0' });
    await first.store.markReady();
    const harness = await createHarness({
      installRoot: first.installRoot,
      manifest: makeManifest(upgradedContent),
      modelContent: upgradedContent,
    });
    const versionedModelRoot = join(first.installRoot, 'models.manifest-v1');

    const state = await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(state.config?.modelDirectory).toBe(join(versionedModelRoot, 'diffusion_models'));
    expect((await harness.store.load())?.modelDirectory).toBe(
      join(versionedModelRoot, 'diffusion_models'),
    );
    const versionedRuntimeRoot = join(
      first.installRoot,
      'runtime',
      `${TOP_LEVEL}.manifest-v1`,
    );
    const yaml = await readFile(
      join(versionedRuntimeRoot, 'ComfyUI', 'extra_model_paths.yaml'),
      'utf8',
    );
    expect(yaml).toContain(`base_path: '${versionedModelRoot}'`);
    for (const path of MODEL_PATHS) {
      expect(
        sha256(await readFile(join(versionedModelRoot, ...path.split('/')))),
      ).toBe(sha256(upgradedContent(path)));
      expect(
        sha256(await readFile(join(first.installRoot, 'models', ...path.split('/')))),
      ).toBe(sha256(modelContent(path)));
    }
  });

  test('keeps old ready models and config when a manifest upgrade model download fails', async () => {
    const upgradedContent = (path: string) => Buffer.from(`upgraded model: ${path}`);
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const seeded = await first.store.load();
    if (!seeded) throw new Error('Expected a ready config');
    await first.store.save({ ...seeded, status: 'installing', manifestVersion: '0' });
    const oldReady = await first.store.markReady();
    const oldHashes = new Map<string, string>();
    for (const path of MODEL_PATHS) {
      oldHashes.set(
        path,
        sha256(await readFile(join(first.installRoot, 'models', ...path.split('/')))),
      );
    }
    const harness = await createHarness({
      installRoot: first.installRoot,
      manifest: makeManifest(upgradedContent),
      modelContent: upgradedContent,
      configure: ({ failNextModel }) => {
        failNextModel.value = 1;
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/download failed/);

    expect(await harness.store.load()).toEqual(oldReady);
    for (const [path, hash] of oldHashes) {
      expect(
        sha256(await readFile(join(first.installRoot, 'models', ...path.split('/')))),
      ).toBe(hash);
    }
    const versionedModelRoot = join(first.installRoot, 'models.manifest-v1');
    expect(
      sha256(
        await readFile(join(versionedModelRoot, 'diffusion_models', 'main.safetensors')),
      ),
    ).toBe(sha256(upgradedContent('diffusion_models/main.safetensors')));
  });

  test('reuses versioned runtime and model roots on later runs after an upgrade', async () => {
    const upgradedContent = (path: string) => Buffer.from(`upgraded model: ${path}`);
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const ready = await first.store.load();
    if (!ready) throw new Error('Expected a ready config');
    await first.store.save({ ...ready, status: 'installing', manifestVersion: '0' });
    await first.store.markReady();
    const upgraded = await createHarness({
      installRoot: first.installRoot,
      manifest: makeManifest(upgradedContent),
      modelContent: upgradedContent,
    });
    await upgraded.service.start({
      profileId: 'high-memory-candidate',
      installRoot: upgraded.installRoot,
    });
    const harness = await createHarness({
      installRoot: first.installRoot,
      manifest: makeManifest(upgradedContent),
      modelContent: upgradedContent,
    });

    const state = await harness.service.start({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(state.config?.runtimeRoot).toBe(
      join(first.installRoot, 'runtime', `${TOP_LEVEL}.manifest-v1`),
    );
    expect(state.config?.modelDirectory).toBe(
      join(first.installRoot, 'models.manifest-v1', 'diffusion_models'),
    );
    expect(harness.downloads.parts).not.toHaveBeenCalled();
    expect(harness.networkDownloads).toHaveLength(0);
  });

  test('keeps the old ready runtime and config when a manifest upgrade download fails', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const ready = await first.store.load();
    if (!ready) throw new Error('Expected a ready config');
    await first.store.save({ ...ready, status: 'installing', manifestVersion: '0' });
    const oldReady = await first.store.markReady();
    const harness = await createHarness({
      installRoot: first.installRoot,
      service: {
        downloadParts: async () => {
          throw new Error('network down');
        },
      },
    });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/network down/);

    expect(await harness.store.load()).toEqual(oldReady);
    expect(
      await readFile(join(first.runtimeRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
    expect(existsSync(join(first.runtimeRoot, 'docs', 'file-manifest.sha256'))).toBe(true);
    expect(existsSync(join(harness.installRoot, '.smo-install', 'quarantine'))).toBe(false);
  });

  test('keeps the old ready runtime and config when a manifest upgrade backend start fails', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const ready = await first.store.load();
    if (!ready) throw new Error('Expected a ready config');
    await first.store.save({ ...ready, status: 'installing', manifestVersion: '0' });
    const oldReady = await first.store.markReady();
    const harness = await createHarness({
      installRoot: first.installRoot,
      service: {
        startBackend: async () => {
          throw new Error('backend exploded');
        },
      },
    });
    const versionedRoot = join(
      harness.installRoot,
      'runtime',
      `${TOP_LEVEL}.manifest-v1`,
    );

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/backend exploded/);

    expect(await harness.store.load()).toEqual(oldReady);
    expect(
      await readFile(join(first.runtimeRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
    expect(existsSync(join(harness.installRoot, '.smo-install', 'quarantine'))).toBe(false);
    expect(
      await readFile(join(versionedRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
  });

  test('keeps a matching ready runtime in place when its hash is corrupt', async () => {
    const first = await createHarness();
    await first.service.start({
      profileId: 'high-memory-candidate',
      installRoot: first.installRoot,
    });
    const oldReady = await first.store.load();
    await writeFile(join(first.runtimeRoot, 'tools', 'launch.py'), 'corrupt launch');
    const harness = await createHarness({ installRoot: first.installRoot });

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/launch\.py|sha256|hash/i);

    expect(await harness.store.load()).toEqual(oldReady);
    expect(harness.downloads.parts).not.toHaveBeenCalled();
    expect(existsSync(join(harness.installRoot, '.smo-install', 'quarantine'))).toBe(false);
    expect(existsSync(harness.runtimeRoot)).toBe(true);
  });

  test('quarantining a junction runtime moves the link without deleting its target', async () => {
    const first = await createHarness();
    const outside = await mkdtemp(join(tmpdir(), 'smo-runtime-target-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeRuntimeFiles(outside, { corruptLaunch: true });
    const marker = join(outside, 'keep.txt');
    await writeFile(marker, 'do not delete');
    await mkdir(dirname(first.runtimeRoot), { recursive: true });
    await symlink(outside, first.runtimeRoot, 'junction');
    const config = await seedReadyConfig(first);
    await first.store.save({ ...config, status: 'failed' });
    const harness = await createHarness({ installRoot: first.installRoot });

    await harness.service.retry({
      profileId: 'high-memory-candidate',
      installRoot: harness.installRoot,
    });

    expect(await readFile(marker, 'utf8')).toBe('do not delete');
    const quarantineRoot = join(harness.installRoot, '.smo-install', 'quarantine');
    const entries = await readdir(quarantineRoot);
    expect(entries).toHaveLength(1);
    const quarantined = join(quarantineRoot, entries[0]);
    expect((await lstat(quarantined)).isSymbolicLink()).toBe(true);
    expect(
      await readFile(join(harness.runtimeRoot, 'tools', 'launch.py'), 'utf8'),
    ).toBe('launch');
  });

  test.each([
    { scenario: 'work directory', segments: ['.smo-install'] },
    { scenario: 'download directory', segments: ['.smo-install', 'downloads'] },
    { scenario: 'staging directory', segments: ['.smo-install', 'staging'] },
  ])('rejects a $scenario junction without deleting its target', async ({ segments }) => {
    const harness = await createHarness();
    const outside = await mkdtemp(join(tmpdir(), 'smo-junction-target-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const marker = join(outside, 'keep.txt');
    await writeFile(marker, 'do not delete');
    const junction = join(harness.installRoot, ...segments);
    await mkdir(dirname(junction), { recursive: true });
    await symlink(outside, junction, 'junction');

    await expect(
      harness.service.start({
        profileId: 'high-memory-candidate',
        installRoot: harness.installRoot,
      }),
    ).rejects.toThrow(/junction|reparse|symbolic|unsafe/i);

    expect(await readFile(marker, 'utf8')).toBe('do not delete');
  });
});

describe('production ZIP extraction', () => {
  test('extracts regular entries beneath staging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-zip-valid-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const archivePath = join(directory, 'valid.zip');
    const stagingDirectory = join(directory, 'staging');
    await writeFile(
      archivePath,
      Buffer.from(
        'UEsDBBQAAAAAACNgXl1H3dx5AgAAAAIAAAAMAAAAVG9wL2ZpbGUudHh0b2tQSwECFAAUAAAAAAAjYF5dR93ceQIAAAACAAAADAAAAAAAAAAAAAAAgAEAAAAAVG9wL2ZpbGUudHh0UEsFBgAAAAABAAEAOgAAACwAAAAAAA==',
        'base64',
      ),
    );

    await extractZipArchive({ archivePath, stagingDirectory });

    expect(await readFile(join(stagingDirectory, 'Top', 'file.txt'), 'utf8')).toBe('ok');
  });

  test('rejects a traversal entry without writing outside staging', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-zip-safety-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const archivePath = join(directory, 'malicious.zip');
    const stagingDirectory = join(directory, 'staging');
    await writeFile(
      archivePath,
      Buffer.from(
        'UEsDBBQAAAAAADhfXl1HPvp0CQAAAAkAAAANAAAALi4vZXNjYXBlLnR4dG1hbGljaW91c1BLAQIUABQAAAAAADhfXl1HPvp0CQAAAAkAAAANAAAAAAAAAAAAAACAAQAAAAAuLi9lc2NhcGUudHh0UEsFBgAAAAABAAEAOwAAADQAAAAAAA==',
        'base64',
      ),
    );

    await expect(
      extractZipArchive({ archivePath, stagingDirectory }),
    ).rejects.toThrow(/traversal|unsafe|absolute|contained/i);
    expect(existsSync(join(directory, 'escape.txt'))).toBe(false);
    expect((await lstat(stagingDirectory)).isDirectory()).toBe(true);
  });
});
