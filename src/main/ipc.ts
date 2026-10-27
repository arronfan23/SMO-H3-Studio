import { ipcMain } from 'electron';
import type { ComfyClient, ComfySystemStats } from './comfy';
import type { AvatarService } from './avatars';
import type { FileService } from './files';
import type { JobCoordinator } from './jobs';
import type { LlmService } from './llm';
import type { LlmConfigStore } from './llm-config';
import type { SkillsService } from './skills';
import type { Store } from './store';
import {
  createIpcSchema,
  IPC_CHANNELS,
  type HardwareApplyRequest,
  type HardwareWorkflowResult,
  type IpcRequest,
} from '../shared/ipc';
import type { GenerationHandler } from './generation';
import type {
  GenerationRequest,
  GenerationStartResult,
  HardwareInfo,
  HardwareProfile,
  HardwareRecommendationInput,
  VideoMode,
} from '../shared/types';

export type IpcHandler = (payload: unknown) => Promise<unknown>;

export interface IpcHandlerRegistry {
  handle(channel: string, handler: IpcHandler): void;
}

export type { GenerationHandler };

export interface IpcServices {
  startGeneration: GenerationHandler;
  retryWork: (id: string) => Promise<GenerationStartResult>;
  jobCoordinator: Pick<JobCoordinator, 'cancel' | 'cancelActive'>;
  llm: Pick<LlmService, 'listModels' | 'testModel'>;
  skills: Pick<SkillsService, 'polish'>;
  llmConfig: LlmConfigStore;
  store: Pick<Store, 'listAvatars' | 'listWorks'>;
  avatars: Pick<AvatarService, 'createAvatar' | 'updateAvatar' | 'deleteAvatar'>;
  files: Pick<FileService, 'selectImage' | 'selectAudio' | 'mediaUrl' | 'openFolder'>;
  comfy: Pick<ComfyClient, 'health'>;
  startComfy: () => Promise<ComfySystemStats>;
  openComfy: () => Promise<void>;
  hardware: {
    detect: () => Promise<HardwareInfo>;
    recommend: (input: HardwareRecommendationInput) => Promise<HardwareProfile>;
    reset: (mode: VideoMode) => Promise<string>;
    apply: (request: HardwareApplyRequest) => Promise<HardwareWorkflowResult>;
  };
}

const electronIpcRegistry: IpcHandlerRegistry = {
  handle(channel, handler) {
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload));
  },
};

async function dispatch(
  request: IpcRequest,
  services: IpcServices,
): Promise<unknown> {
  switch (request.channel) {
    case 'jobs:start':
      return services.startGeneration(request.payload);
    case 'jobs:retry':
      return services.retryWork(request.payload.id);
    case 'jobs:cancel':
      if (request.payload.id === undefined) {
        await services.jobCoordinator.cancelActive();
      } else {
        await services.jobCoordinator.cancel(request.payload.id);
      }
      return undefined;
    case 'files:selectImage':
      return services.files.selectImage();
    case 'files:selectAudio':
      return services.files.selectAudio();
    case 'files:mediaUrl':
      return services.files.mediaUrl(request.payload.path);
    case 'files:openFolder':
      await services.files.openFolder(request.payload.path);
      return undefined;
    case 'llm:saveProfile':
      await services.llmConfig.saveProfile(request.payload);
      return undefined;
    case 'llm:getProfile': {
      const profile = await services.llmConfig.getProfile();
      return profile === null
        ? null
        : { baseUrl: profile.baseUrl, model: profile.model };
    }
    case 'llm:listModels':
      return services.llm.listModels(
        await services.llmConfig.resolveConnection(request.payload),
      );
    case 'llm:testModel':
      return services.llm.testModel(
        await services.llmConfig.resolveCredentials(request.payload),
      );
    case 'llm:polish': {
      const credentials = await services.llmConfig.getCredentials();
      if (credentials === null) {
        throw new Error('LLM profile is not configured');
      }
      return services.skills.polish(credentials, request.payload);
    }
    case 'avatars:list':
      return services.store.listAvatars();
    case 'avatars:create':
      return services.avatars.createAvatar(request.payload);
    case 'avatars:update':
      return services.avatars.updateAvatar(request.payload.id, {
        name: request.payload.name,
      });
    case 'avatars:delete':
      await services.avatars.deleteAvatar(request.payload.id);
      return undefined;
    case 'works:list':
      return services.store.listWorks();
    case 'comfy:health':
      return services.comfy.health();
    case 'comfy:start':
      return services.startComfy();
    case 'comfy:open':
      await services.openComfy();
      return undefined;
    case 'hardware:detect':
      return services.hardware.detect();
    case 'hardware:recommend':
      return services.hardware.recommend(request.payload);
    case 'hardware:reset':
      return services.hardware.reset(request.payload.mode);
    case 'hardware:apply':
      return services.hardware.apply(request.payload);
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
