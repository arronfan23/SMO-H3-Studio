import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, protocol, shell } from 'electron';
import type { GenerationHandler, IpcServices } from './ipc';
import { createFfprobeDurationReader, type AudioDurationReader } from './audio-duration';
import { AvatarService } from './avatars';
import { ComfyClient } from './comfy';
import {
  ComfyProcessManager,
  DEFAULT_COMFY_ROOT,
  type ComfyProcessManagerOptions,
} from './comfy-process';
import { parseEnvironmentManifest } from './environment-manifest';
import {
  EnvironmentSetupService,
  REQUIRED_COMFY_NODES,
  type EnvironmentBackendInput,
  type EnvironmentStartBackend,
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
import type { EnvironmentConfig, EnvironmentPaths } from '../shared/environment';
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
 * runs (e.g. terminating the candidate process manager) and is awaited
 * before the wait rejects, so cleanup is finished when the error surfaces.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => void | Promise<void>,
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
    return Promise.resolve()
      .then(onAbort)
      .then(() => {
        throw abortError();
      });
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      void Promise.resolve()
        .then(onAbort)
        .catch(() => undefined)
        .then(() => reject(abortError()));
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

export interface EnvironmentStartBackendAdapterOptions {
  comfy: ComfyClient;
  baseUrl: string;
  logPath: string;
  activePaths: EnvironmentPaths;
  getActiveManager: () => ComfyProcessManager | undefined;
  setActiveManager: (manager: ComfyProcessManager) => void;
  startupEvidenceTimeoutMs?: number;
  killProcessTree?: (pid: number) => Promise<void>;
  createManager?: (
    options: ComfyProcessManagerOptions,
    client: Pick<ComfyClient, 'health'>,
  ) => ComfyProcessManager;
}

function sameRuntimeRoot(a: string, b: string): boolean {
  return win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
}

const STARTUP_EVIDENCE_TIMEOUT_MS = 10_000;
const STARTUP_EVIDENCE_POLL_MS = 50;

function backendPort(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.port.length > 0) {
      return url.port;
    }
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return '';
  }
}

/**
 * A freshly started ComfyUI logs its bind line; the port must match the
 * configured backend so a different process cannot satisfy the check.
 * The GUI address is parsed as a URL so IPv6 hosts ([::1]) compare safely.
 */
export function hasStartupEvidence(logContent: string, port: string): boolean {
  if (
    !logContent.includes('Starting server') ||
    !logContent.includes('To see the GUI go to:')
  ) {
    return false;
  }
  const guiLine = logContent
    .split(/\r?\n/)
    .find((line) => line.includes('To see the GUI go to:'));
  if (guiLine === undefined || port.length === 0) {
    return false;
  }
  const rawUrl = guiLine
    .slice(guiLine.indexOf('To see the GUI go to:') + 'To see the GUI go to:'.length)
    .trim();
  try {
    return new URL(rawUrl).port === port;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the candidate's independent log for proof that THIS ComfyUI bound
 * the expected port. Never surfaces log content in errors.
 */
async function waitForStartupEvidence(input: {
  logPath: string;
  port: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    input.signal.throwIfAborted();
    let content = '';
    try {
      content = await readFile(input.logPath, 'utf8');
    } catch {
      // The launcher creates the log only once ComfyUI starts writing.
    }
    if (hasStartupEvidence(content, input.port)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        'Could not confirm the new ComfyUI runtime started: its log shows ' +
          'no startup evidence for the expected port; refusing to mark the ' +
          'environment ready',
      );
    }
    await delay(Math.min(STARTUP_EVIDENCE_POLL_MS, deadline - Date.now()));
  }
}

/**
 * Builds the environment setup's backend starter. A candidate manager must
 * prove itself (health + required nodes) before it replaces the active one;
 * on any failure or abort it is closed without touching the existing
 * backend. A healthy backend only vouches for the runtime it was started
 * from: when it serves a different runtime root than the candidate, the
 * install must refuse to proceed instead of impersonating the new runtime.
 * Because the old backend can race the pre-check and answer the candidate's
 * first health probe, a new runtime must additionally prove itself through
 * its own startup log before it is accepted.
 */
export function createEnvironmentStartBackend(
  adapter: EnvironmentStartBackendAdapterOptions,
): EnvironmentStartBackend {
  const createManager =
    adapter.createManager ??
    ((
      options: ComfyProcessManagerOptions,
      client: Pick<ComfyClient, 'health'>,
    ) => new ComfyProcessManager(options, client));
  return async (input: EnvironmentBackendInput) => {
    const requiresNewRuntime = !sameRuntimeRoot(
      input.runtimeRoot,
      adapter.activePaths.runtimeRoot,
    );
    let backendHealthy = false;
    try {
      await adapter.comfy.health();
      backendHealthy = true;
    } catch {
      backendHealthy = false;
    }
    if (backendHealthy && requiresNewRuntime) {
      throw new Error(
        'Another ComfyUI backend is already running from ' +
          `${adapter.activePaths.runtimeRoot}; close it before starting the ` +
          `environment at ${input.runtimeRoot}`,
      );
    }

    // A new runtime gets its own log AND its own launch directory (inner
    // launcher, hidden launcher, paths file, pid file) under one UUID: the
    // old backend and any previous candidate must never share a file with
    // this attempt's startup chain.
    const candidateId = randomUUID();
    const candidateLogPath = requiresNewRuntime
      ? join(dirname(adapter.logPath), `environment-${candidateId}.log`)
      : adapter.logPath;
    const candidateLaunchDirectory = requiresNewRuntime
      ? join(dirname(adapter.logPath), `environment-${candidateId}`)
      : undefined;
    const candidate = createManager(
      {
        baseUrl: adapter.baseUrl,
        rootDirectory: input.runtimeRoot,
        pythonPath: input.pythonPath,
        launchScript: input.launchScript,
        outputDirectory: input.outputDirectory,
        lowvram: input.profile !== 'high-memory-candidate',
        logPath: candidateLogPath,
        ...(candidateLaunchDirectory === undefined
          ? {}
          : { launchDirectory: candidateLaunchDirectory }),
        ownedProcess: true,
        ...(adapter.killProcessTree === undefined
          ? {}
          : { killProcessTree: adapter.killProcessTree }),
      },
      adapter.comfy,
    );
    const closeCandidate = () => {
      return candidate.terminate().catch(() => undefined);
    };
    let systemStats: unknown;
    let objectInfo: Record<string, unknown>;
    try {
      systemStats = await raceWithAbort(
        candidate.ensureReady(),
        input.signal,
        closeCandidate,
      );
      if (requiresNewRuntime) {
        // Health alone is not proof for a new runtime: the old backend may
        // have answered the probe. Only this candidate's own startup log
        // closes that window.
        await waitForStartupEvidence({
          logPath: candidateLogPath,
          port: backendPort(adapter.baseUrl),
          signal: input.signal,
          timeoutMs:
            adapter.startupEvidenceTimeoutMs ?? STARTUP_EVIDENCE_TIMEOUT_MS,
        });
      }
      objectInfo = await raceWithAbort(
        adapter.comfy.objectInfo(),
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
      input.signal.throwIfAborted();
    } catch (error) {
      await candidate.terminate().catch(() => undefined);
      throw error;
    }

    const previous = adapter.getActiveManager();
    adapter.setActiveManager(candidate);
    adapter.activePaths.runtimeRoot = input.runtimeRoot;
    adapter.activePaths.modelDirectory = input.modelDirectory;
    adapter.activePaths.outputDirectory = input.outputDirectory;
    await previous?.close();
    return { systemStats, objectInfo };
  };
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
  let environmentSetup: EnvironmentSetupService | undefined;
  const activeEnvironmentPaths: EnvironmentPaths = { ...environmentPaths };

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
        lowvram: environmentConfig?.profile !== 'high-memory-candidate',
        logPath: join(dataDirectory, 'logs', 'comfyui-backend.log'),
      },
      comfy,
    );
    const setup = new EnvironmentSetupService({
      store: environmentStore,
      manifest: environmentManifest,
      defaultInstallRoot: dataDirectory,
      outputDirectory,
      detectHardware: (installRoot) => detectHardware(undefined, installRoot),
      startBackend: createEnvironmentStartBackend({
        comfy,
        baseUrl: comfyBaseUrl,
        logPath: join(dataDirectory, 'logs', 'comfyui-backend.log'),
        activePaths: activeEnvironmentPaths,
        getActiveManager: () => activeComfyProcess,
        setActiveManager: (manager) => {
          activeComfyProcess = manager;
        },
      }),
    });
    environmentSetup = setup;
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
        getState: () => Promise.resolve(setup.getState()),
        detect: (installRoot?: string) => setup.detect(installRoot),
        start: (input) => setup.start(input),
        retry: (input) => setup.retry(input),
        cancel: () => setup.cancel(),
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
        await setup.cancel();
        await jobCoordinator!.close();
        await activeComfyProcess!.close();
        await Promise.allSettled([
          comfy!.close(),
          (async () => store!.close())(),
        ]);
      },
    };
  } catch (error) {
    await environmentSetup?.cancel().catch(() => undefined);
    await jobCoordinator?.close();
    await activeComfyProcess?.close();
    await Promise.allSettled([
      comfy?.close() ?? Promise.resolve(),
      (async () => store?.close())(),
    ]);
    throw error;
  }
}
