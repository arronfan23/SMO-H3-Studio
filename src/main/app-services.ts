import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GenerationHandler, IpcServices } from './ipc';
import { ComfyClient } from './comfy';
import { createGenerationHandler } from './generation';
import { applyHardwareProfile, detectHardware } from './hardware';
import { JobCoordinator, type JobEventErrorHandler } from './jobs';
import { LlmService } from './llm';
import { FileLlmConfigStore } from './llm-config';
import { SkillsService } from './skills';
import { Store } from './store';

export const DEFAULT_DATA_DIRECTORY = 'G:\\SMO-H3-Data';
export const DEFAULT_OUTPUT_DIRECTORY =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\ComfyUI\\output';

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
  generationHandler?: GenerationHandler;
  errorReporter?: JobEventErrorHandler;
}

function defaultWorkflowsDirectory(): string {
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  if (resourcesPath) {
    const packagedRoot = join(resourcesPath, 'resources/workflows');
    if (existsSync(packagedRoot)) {
      return packagedRoot;
    }
  }
  return fileURLToPath(new URL('../../resources/workflows/', import.meta.url));
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
  const dataDirectory = options.dataDirectory ?? DEFAULT_DATA_DIRECTORY;
  await mkdir(dataDirectory, { recursive: true });

  const store = new Store(join(dataDirectory, 'studio.sqlite'));
  const llmConfig = new FileLlmConfigStore(join(dataDirectory, 'llm-config.json'));
  const llm = new LlmService();
  const comfy = new ComfyClient();
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
      outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    });

  return {
    startGeneration,
    jobCoordinator,
    llm,
    skills: new SkillsService(llm),
    llmConfig,
    store,
    comfy,
    hardware: {
      detect: detectHardware,
      apply: applyHardwareProfile,
    },
    close: () => store.close(),
  };
}
