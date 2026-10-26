import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialog, protocol, shell } from 'electron';
import type { GenerationHandler, IpcServices } from './ipc';
import { AvatarService } from './avatars';
import { ComfyClient } from './comfy';
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
  close(): void;
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

export async function createAppServices(
  options: AppServicesOptions = {},
): Promise<AppServices> {
  const dataDirectory =
    options.dataDirectory ?? process.env.SMO_DATA_DIRECTORY ?? DEFAULT_DATA_DIRECTORY;
  const outputDirectory =
    options.outputDirectory ?? process.env.SMO_OUTPUT_DIRECTORY ?? DEFAULT_OUTPUT_DIRECTORY;
  const comfyBaseUrl =
    options.comfyBaseUrl ?? process.env.SMO_COMFYUI_BASE_URL ?? DEFAULT_COMFYUI_BASE_URL;

  await mkdir(dataDirectory, { recursive: true });
  const profilesDirectory = join(dataDirectory, "workflow-profiles");
  const hardwareWorkflows = new HardwareWorkflowStore({ profilesDirectory });
  await hardwareWorkflows.load();

  const mediaRegistry = new MediaRegistry({
    avatarsDirectory: join(dataDirectory, 'avatars'),
    outputDirectory,
  });
  registerMediaProtocol(mediaRegistry, options.mediaProtocol ?? protocol);

  const store = new Store(join(dataDirectory, 'studio.sqlite'));
  const avatars = new AvatarService({
    avatarsDirectory: join(dataDirectory, 'avatars'),
    store,
    mediaRegistry,
  });
  const files = new FileService({
    mediaRegistry,
    dialog: options.fileDialog ?? dialog,
    outputDirectory,
    dataDirectory,
  });
  const llmConfig = new FileLlmConfigStore(join(dataDirectory, 'llm-config.json'));
  const llm = new LlmService();
  const comfy = new ComfyClient(comfyBaseUrl);
  const jobCoordinator = new JobCoordinator({
    onEvent: (event) => {
      store.updateWork(event.id, {
        status: event.status,
        ...(event.status === 'failed'
          ? { error: jobErrorMessage(event.error) }
          : {}),
      });
    },
    onEventError: options.errorReporter ?? defaultErrorReporter,
  });
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
    });

  const retryWork = createRetryHandler({
    store,
    mediaRegistry,
    startGeneration,
  });
  const openComfy = async (): Promise<void> => {
    await shell.openExternal(comfyBaseUrl);
  };

  return {
    startGeneration,
    retryWork,
    jobCoordinator,
    llm,
    skills: new SkillsService(llm),
    llmConfig,
    avatars,
    files,
    store,
    comfy,
    openComfy,
    hardware: {
      detect: () => detectHardware(undefined, outputDirectory),
      recommend: async (input) => recommendHardware(input),
      apply: (request) =>
        hardwareWorkflows.apply(request),
      reset: (mode) =>
        hardwareWorkflows.reset(mode),
    },
    close: () => store.close(),
  };
}
