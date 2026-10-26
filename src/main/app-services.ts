import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerationHandler, IpcServices } from './ipc';
import { ComfyClient } from './comfy';
import { applyHardwareProfile, detectHardware } from './hardware';
import { JobCoordinator } from './jobs';
import { LlmService } from './llm';
import { FileLlmConfigStore } from './llm-config';
import { SkillsService } from './skills';
import { Store } from './store';

export const DEFAULT_DATA_DIRECTORY = 'G:\\SMO-H3-Data';

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
}

async function unconfiguredGenerationHandler(): Promise<never> {
  throw new Error('Generation handler is not configured');
}

export async function createAppServices(
  options: AppServicesOptions = {},
): Promise<AppServices> {
  const dataDirectory = options.dataDirectory ?? DEFAULT_DATA_DIRECTORY;
  await mkdir(dataDirectory, { recursive: true });

  const store = new Store(join(dataDirectory, 'studio.sqlite'));
  const llmConfig = new FileLlmConfigStore(join(dataDirectory, 'llm-config.json'));
  const llm = new LlmService();

  return {
    startGeneration: options.generationHandler ?? unconfiguredGenerationHandler,
    jobCoordinator: new JobCoordinator(),
    llm,
    skills: new SkillsService(llm),
    llmConfig,
    store,
    comfy: new ComfyClient(),
    hardware: {
      detect: detectHardware,
      apply: applyHardwareProfile,
    },
    close: () => store.close(),
  };
}
