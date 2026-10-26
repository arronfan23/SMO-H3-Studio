import { ipcMain } from 'electron';
import type { ComfyClient } from './comfy';
import type { JobCoordinator } from './jobs';
import type { LlmService } from './llm';
import type { LlmConfigStore } from './llm-config';
import type { SkillsService } from './skills';
import type { Store } from './store';
import {
  createIpcSchema,
  IPC_CHANNELS,
  type ComfyGraph,
  type IpcRequest,
} from '../shared/ipc';
import type {
  GenerationRequest,
  GenerationStartResult,
  HardwareInfo,
  HardwareProfile,
} from '../shared/types';

export type IpcHandler = (payload: unknown) => Promise<unknown>;

export interface IpcHandlerRegistry {
  handle(channel: string, handler: IpcHandler): void;
}

export type GenerationHandler = (
  request: GenerationRequest,
) => GenerationStartResult | Promise<GenerationStartResult>;

export interface IpcServices {
  startGeneration: GenerationHandler;
  jobCoordinator: Pick<JobCoordinator, 'cancelActive'>;
  llm: Pick<LlmService, 'listModels' | 'testModel'>;
  skills: Pick<SkillsService, 'polish'>;
  llmConfig: LlmConfigStore;
  store: Pick<Store, 'createAvatar' | 'listAvatars' | 'listWorks'>;
  comfy: Pick<ComfyClient, 'health'>;
  hardware: {
    detect: () => Promise<HardwareInfo>;
    apply: (
      graph: ComfyGraph,
      profile: HardwareProfile,
      confirmed: boolean,
      modelDirectory: string,
    ) => ComfyGraph;
  };
}

const electronIpcRegistry: IpcHandlerRegistry = {
  handle(channel, handler) {
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload));
  },
};

async function requireLlmCredentials(store: LlmConfigStore) {
  const credentials = await store.getCredentials();
  if (credentials === null) {
    throw new Error('LLM profile is not configured');
  }
  return credentials;
}

async function dispatch(
  request: IpcRequest,
  services: IpcServices,
): Promise<unknown> {
  switch (request.channel) {
    case 'jobs:start':
      return services.startGeneration(request.payload);
    case 'jobs:cancel':
      await services.jobCoordinator.cancelActive();
      return undefined;
    case 'llm:saveProfile':
      await services.llmConfig.save(request.payload);
      return undefined;
    case 'llm:getProfile': {
      const profile = await services.llmConfig.getProfile();
      return profile === null
        ? null
        : { baseUrl: profile.baseUrl, model: profile.model };
    }
    case 'llm:listModels':
      return services.llm.listModels(
        await requireLlmCredentials(services.llmConfig),
      );
    case 'llm:testModel':
      return services.llm.testModel(
        await requireLlmCredentials(services.llmConfig),
      );
    case 'llm:polish':
      return services.skills.polish(
        await requireLlmCredentials(services.llmConfig),
        request.payload,
      );
    case 'avatars:list':
      return services.store.listAvatars();
    case 'avatars:create':
      return services.store.createAvatar(request.payload);
    case 'works:list':
      return services.store.listWorks();
    case 'comfy:health':
      return services.comfy.health();
    case 'hardware:detect':
      return services.hardware.detect();
    case 'hardware:apply':
      return services.hardware.apply(
        request.payload.graph,
        request.payload.profile,
        request.payload.confirmed,
        request.payload.modelDirectory,
      );
  }
}

export function registerIpc(
  services: IpcServices,
  registry: IpcHandlerRegistry = electronIpcRegistry,
): void {
  const schema = createIpcSchema();

  for (const channel of IPC_CHANNELS) {
    registry.handle(channel, async (payload: unknown) => {
      const request = schema.parse({ channel, payload });
      return dispatch(request, services);
    });
  }
}
