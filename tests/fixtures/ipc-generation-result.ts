import type { GenerationHandler } from '../../src/main/ipc';
import type { SmoApi } from '../../src/shared/ipc';
import type {
  GenerationRequest,
  GenerationStartResult,
} from '../../src/shared/types';

declare const request: GenerationRequest;
declare const handler: GenerationHandler;
declare const api: SmoApi;

export async function checkGenerationStartResult(): Promise<void> {
  const fromMain = await handler(request);
  fromMain satisfies GenerationStartResult;
  fromMain.id satisfies string;

  const fromRenderer = await api.jobs.start(request);
  fromRenderer satisfies GenerationStartResult;
  fromRenderer.id satisfies string;
}

export const queued: GenerationStartResult = { id: 'job-1' };

// @ts-expect-error A queued job must always expose its task ID.
export const missingId: GenerationStartResult = {};
