import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, protocol, shell } from 'electron';
import type { GenerationHandler, IpcServices } from './ipc';
import { createFfprobeDurationReader, type AudioDurationReader } from './audio-duration';
import { AvatarService } from './avatars';
import { ComfyClient } from './comfy';
import { ComfyProcessManager, DEFAULT_COMFY_ROOT } from './comfy-process';
import { parseEnvironmentManifest } from './environment-manifest';
import {
  EnvironmentSetupService,
  REQUIRED_COMFY_NODES,
  type EnvironmentBackendInput,
} from './environment-setup';
import { EnvironmentStore, resolveEnvironmentPaths } from './environment-store';
import { FileService, type FileDialog } from './files';
import { createGenerationHandler, createRetryHandler } from './generation';
import { detectHardware, recommendHardware } from './hardware';
import { HardwareWorkflowStore } from "./hardware-workflows";
import { defaultWorkflowsDirectory } from './paths';
import { JobCoordinator, type JobEventErrorHandler } from './jobs';
import { LlmService } from './llm';
import { FileLlmConfigStore } from './llm-config';
import { SkillsService } from './skills';
import { Store } from './store';
import { WorkService } from './works';
import type { EnvironmentConfig } from '../shared/environment';
import {
  MediaRegistry,
  registerMediaProtocol,
  type MediaProtocolRegistrar,
} from './media';

export const DEFAULT_DATA_DIRECTORY = 'G:\\SMO-H3-Data';
export const DEFAULT_OUTPUT_DIRECTORY =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\ComfyUI\\output';
export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';

export interface AppServices extends IpcServices {
  store: Store;
  llmConfig: FileLlmConfigStore;
  llm: LlmService;
  skills: SkillsService;
  comfy: ComfyClient;
  jobCoordinator: JobCoordinator;
  close(): Promise<void>;
}

export interface AppServicesOptions {
  dataDirectory?: string;
  outputDirectory?: string;
  comfyBaseUrl?: string;
  generationHandler?: GenerationHandler;
  errorReporter?: JobEventErrorHandler;
  fileDialog?: FileDialog;
  mediaProtocol?: MediaProtocolRegistrar;
}

export function resolveStringOption(
  option: string | undefined,
  env: string | undefined,
  defaultValue: string,
): string {
  const candidate = option ?? env;
  return candidate === undefined || candidate.trim().length === 0 ? defaultValue : candidate;
}

/**
 * On a machine that never ran the G: based setup, data lives under the
 * Electron userData directory instead of requiring a G: drive.
 */
function defaultDataDirectory(): string {
  if (existsSync(DEFAULT_DATA_DIRECTORY)) {
    return DEFAULT_DATA_DIRECTORY;
  }
  const electronApp = app as { getPath?: (name: string) => string };
  if (typeof electronApp.getPath === 'function') {
    return join(electronApp.getPath('userData'), 'data');
  }
  return DEFAULT_DATA_DIRECTORY;
}

function environmentManifestPath(): string {
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  if (resourcesPath) {
    const packaged = join(
      resourcesPath,
      'resources',
      'environment',
      'selflift-spark.json',
    );
    if (existsSync(packaged)) {
      return packaged;
    }
  }
  return fileURLToPath(
    new URL('../../resources/environment/selflift-spark.json', import.meta.url),
  );
}

/**
 * Lets an abort signal cancel a pending wait; on abort the cleanup callback
 * runs (e.g. closing the candidate process manager) and the wait rejects.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void,
): Promise<T> {
  const abortError = () =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error(
          signal.reason === undefined
            ? 'Environment setup cancelled'
            : String(signal.reason),
        );
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort();
      reject(abortError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', handleAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function jobErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return error === undefined ? 'Unknown job error' : String(error);
}

const defaultErrorReporter: JobEventErrorHandler = (error, event) => {
  console.error(
    `[SMO.H3 Studio] Work status update failed for job ${event.id} (${event.status})`,
    error,
  );
};

function createTestFileDialog(): FileDialog | undefined {
  const raw = process.env.SMO_TEST_FILE_DIALOG;
  if (app.isPackaged || !raw) {
    return undefined;
  }
  let paths: string[];
  try {
    paths = JSON.parse(raw) as string[];
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    showOpenDialog: async () => {
      const path = paths.shift();
      return path === undefined
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [path] };
    },
  };
}

export async function createAppServices(
  options: AppServicesOptions = {},
): Promise<AppServices> {
  const legacyEnvironmentExists = existsSync(DEFAULT_DATA_DIRECTORY);
  const dataDirectory = resolveStringOption(
    options.dataDirectory,
    process.env.SMO_DATA_DIRECTORY,
    defaultDataDirectory(),
  );
  const comfyBaseUrl = resolveStringOption(
    options.comfyBaseUrl,
    process.env.SMO_COMFYUI_BASE_URL,
    DEFAULT_COMFYUI_BASE_URL,
  );

  // The recorded environment configuration wins over option/env/default
  // paths; a corrupt store only surfaces as the setup error state.
  const environmentStore = new EnvironmentStore(
    join(dataDirectory, 'environment.json'),
  );
  let environmentConfig: EnvironmentConfig | null = null;
  try {
    environmentConfig = await environmentStore.load();
  } catch {
    environmentConfig = null;
  }
  const environmentPaths = resolveEnvironmentPaths(environmentConfig, {
    runtimeRoot: resolveStringOption(
      undefined,
      process.env.SMO_COMFYUI_ROOT,
      legacyEnvironmentExists ? DEFAULT_COMFY_ROOT : join(dataDirectory, 'runtime'),
    ),
    modelDirectory: join(dataDirectory, 'models'),
    outputDirectory: resolveStringOption(
      options.outputDirectory,
      process.env.SMO_OUTPUT_DIRECTORY,
      legacyEnvironmentExists
        ? DEFAULT_OUTPUT_DIRECTORY
        : join(dataDirectory, 'output'),
    ),
  });
  // Resolved once here so every consumer (setup, media, files, works,
  // generation) shares the same fixed output directory.
  const outputDirectory = environmentPaths.outputDirectory;

  const environmentManifest = parseEnvironmentManifest(
    JSON.parse(await readFile(environmentManifestPath(), 'utf8')),
  );

  await mkdir(dataDirectory, { recursive: true });
  const profilesDirectory = join(dataDirectory, "workflow-profiles");
  const hardwareWorkflows = new HardwareWorkflowStore({ profilesDirectory });

  let store: Store | undefined;
  let comfy: ComfyClient | undefined;
  let activeComfyProcess: ComfyProcessManager | undefined;
  let jobCoordinator: JobCoordinator | undefined;
  const activeEnvironmentPaths = { ...environmentPaths };

  // A candidate manager proves itself (health + required nodes) before it
  // replaces the active one; on any failure it is closed without touching
  // the existing backend.
  const startEnvironmentBackend = async (
    input: EnvironmentBackendInput,
  ): Promise<{ systemStats: unknown; objectInfo: unknown }> => {
    const candidate = new ComfyProcessManager(
      {
        baseUrl: comfyBaseUrl,
        rootDirectory: input.runtimeRoot,
        pythonPath: input.pythonPath,
        launchScript: input.launchScript,
        outputDirectory: input.outputDirectory,
        lowvram: input.profile !== 'high-memory-candidate',
        logPath: join(dataDirectory, 'logs', 'comfyui-backend.log'),
      },
      comfy!,
    );
    const closeCandidate = () => {
      void candidate.close().catch(() => undefined);
    };
    let systemStats: unknown;
    let objectInfo: Record<string, unknown>;
    try {
      systemStats = await raceWithAbort(
        candidate.ensureReady(),
        input.signal,
        closeCandidate,
      );
      objectInfo = await raceWithAbort(
        comfy!.objectInfo(),
        input.signal,
        closeCandidate,
      );
      const missingNodes = REQUIRED_COMFY_NODES.filter(
        (node) => !Object.hasOwn(objectInfo, node),
      );
      if (missingNodes.length > 0) {
        throw new Error(
          `Backend is missing required nodes: ${missingNodes.join(', ')}`,
        );
      }
    } catch (error) {
      await candidate.close().catch(() => undefined);
      throw error;
    }

    const previous = activeComfyProcess;
    activeComfyProcess = candidate;
    activeEnvironmentPaths.runtimeRoot = input.runtimeRoot;
    activeEnvironmentPaths.modelDirectory = input.modelDirectory;
    activeEnvironmentPaths.outputDirectory = input.outputDirectory;
    await previous?.close();
    return { systemStats, objectInfo };
  };

  const environmentSetup = new EnvironmentSetupService({
    store: environmentStore,
    manifest: environmentManifest,
    defaultInstallRoot: dataDirectory,
    outputDirectory,
    detectHardware: (installRoot) => detectHardware(undefined, installRoot),
    startBackend: startEnvironmentBackend,
  });

  try {
    await hardwareWorkflows.load();

    const mediaRegistry = new MediaRegistry({
      avatarsDirectory: join(dataDirectory, 'avatars'),
      outputDirectory,
    });
    registerMediaProtocol(mediaRegistry, options.mediaProtocol ?? protocol);

    store = new Store(join(dataDirectory, 'studio.sqlite'));
    const avatars = new AvatarService({
      avatarsDirectory: join(dataDirectory, 'avatars'),
      store,
      mediaRegistry,
    });
    const files = new FileService({
      mediaRegistry,
      dialog: options.fileDialog ?? createTestFileDialog() ?? dialog,
      outputDirectory,
      dataDirectory,
    });
    const llmConfig = new FileLlmConfigStore(join(dataDirectory, 'llm-config.json'));
    const llm = new LlmService();
    comfy = new ComfyClient(comfyBaseUrl);
    activeComfyProcess = new ComfyProcessManager(
      {
        baseUrl: comfyBaseUrl,
        rootDirectory: environmentPaths.runtimeRoot,
        outputDirectory,
        logPath: join(dataDirectory, 'logs', 'comfyui-backend.log'),
      },
      comfy,
    );
    // The ffprobe binary follows the active runtime; explicit env overrides
    // keep their original precedence.
    const durationReader: AudioDurationReader = (filePath) => {
      if (process.env.SMO_FFPROBE_PATH || process.env.SMO_FFMPEG_PATH) {
        return createFfprobeDurationReader()(filePath);
      }
      return createFfprobeDurationReader({
        ffprobePath: join(
          activeEnvironmentPaths.runtimeRoot,
          'tools',
          'ffmpeg',
          'ffprobe.exe',
        ),
      })(filePath);
    };
    jobCoordinator = new JobCoordinator({
      onEvent: (event) => {
        store!.updateWork(event.id, {
          status: event.status,
          ...(event.status === 'failed'
            ? { error: jobErrorMessage(event.error) }
            : {}),
        });
      },
      onEventError: options.errorReporter ?? defaultErrorReporter,
    });
    jobCoordinator.recover(store.listWorks());
    const startGeneration =
      options.generationHandler ??
      createGenerationHandler({
        store,
        comfy,
        jobCoordinator,
        workflowsDirectory: defaultWorkflowsDirectory(),
        workflowResolver: hardwareWorkflows.getActiveWorkflow,
        outputDirectory,
        mediaRegistry,
        uploadsDirectory: join(dataDirectory, 'uploads'),
        ensureReady: () => activeComfyProcess!.ensureReady(),
        durationReader,
      });

    const retryWork = createRetryHandler({
      store,
      mediaRegistry,
      startGeneration,
    });
    const workService = new WorkService({ outputDirectory, store });
    const openComfy = async (): Promise<void> => {
      await shell.openExternal(comfyBaseUrl);
    };

    let closed = false;
    return {
      startGeneration,
      retryWork,
      deleteWork: (id) => workService.deleteWork(id),
      jobCoordinator,
      llm,
      skills: new SkillsService(llm),
      llmConfig,
      avatars,
      files,
      store,
      comfy,
      openComfy,
      startComfy: () => activeComfyProcess!.ensureReady(),
      environment: {
        getState: () => Promise.resolve(environmentSetup.getState()),
        detect: (installRoot?: string) => environmentSetup.detect(installRoot),
        start: (input) => environmentSetup.start(input),
        retry: (input) => environmentSetup.retry(input),
        cancel: () => environmentSetup.cancel(),
      },
      hardware: {
        detect: () => detectHardware(undefined, outputDirectory),
        recommend: async (input) => recommendHardware(input),
        apply: (request) =>
          hardwareWorkflows.apply(request),
        reset: (mode) =>
          hardwareWorkflows.reset(mode),
      },
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        await environmentSetup.cancel();
        await jobCoordinator!.close();
        await activeComfyProcess!.close();
        await Promise.allSettled([
          comfy!.close(),
          (async () => store!.close())(),
        ]);
      },
    };
  } catch (error) {
    await environmentSetup.cancel().catch(() => undefined);
    await jobCoordinator?.close();
    await activeComfyProcess?.close();
    await Promise.allSettled([
      comfy?.close() ?? Promise.resolve(),
      (async () => store?.close())(),
    ]);
    throw error;
  }
}
