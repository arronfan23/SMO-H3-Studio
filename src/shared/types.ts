export type VideoMode = 'text' | 'audio';

export interface GenerationRequest {
  mode: VideoMode;
  avatarId: string;
  prompt: string;
  duration: number;
  seed: number;
  audioPath?: string;
  trimStart?: number;
  subtitles?: boolean;
  retryOf?: string;
}

export interface GenerationStartResult {
  /** Identifies a queued job; generation may still be running. */
  id: string;
}

export interface Avatar {
  id: string;
  name: string;
  photoPath: string;
  createdAt: string;
}

export type WorkStatus = 'pending' | 'running' | 'done' | 'failed';

/** Real frame progress reported by ComfyUI (e.g. value 12 of max 24 frames). */
export interface WorkProgress {
  value: number;
  max: number;
}

export interface WorkMetadata {
  [key: string]: unknown;
  /** Sanitized request snapshot kept for retry; written when the work is queued. */
  request?: GenerationRequest;
  /** Workflow identifier (frozen filename or explicit path) used for retry. */
  workflowVersion?: string;
  /** Id of the failed work this one retries, when applicable. */
  retryOf?: string;
  /** Last frame progress reported by ComfyUI while running. */
  progress?: WorkProgress;
}

export interface Work {
  id: string;
  avatarId: string;
  mode: VideoMode;
  outputPath: string | null;
  status: WorkStatus;
  createdAt: string;
  promptId: string | null;
  metadata: WorkMetadata | null;
  error: string | null;
}

export type NewWork = Omit<Work, 'createdAt' | 'promptId' | 'metadata' | 'error'> &
  Partial<Pick<Work, 'promptId' | 'metadata' | 'error'>>;

export type WorkUpdate = Partial<
  Pick<Work, 'status' | 'outputPath' | 'promptId' | 'error' | 'metadata'>
>;

export interface LlmProfile {
  baseUrl: string;
  model: string;
}

export type LlmKeyStatus = 'valid' | 'reenter-required';

export interface LlmProfileView extends LlmProfile {
  keyStatus: LlmKeyStatus;
}

export interface LlmCredentials extends LlmProfile {
  apiKey: string;
}

export interface LlmDiscoveryInput {
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

export interface LlmConnection {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export type HardwarePreset =
  | 'conservative'
  | 'balanced-16gb'
  | 'high-memory-candidate';

export type HardwareModelPolicy = 'int8' | 'bf16-if-present';

export interface HardwareRecommendationInput {
  gpu: string;
  vramGiB: number;
  ramGiB: number;
}

export interface HardwareProfile {
  preset: HardwarePreset;
  modelPolicy: HardwareModelPolicy;
  megapixels: number;
  /** Raw H3 ResolutionSelector aspect ratio; omitted to keep the frozen workflow value. */
  aspectRatio?: string;
  lowvram: boolean;
  tiling: number | 'auto';
  requiresConfirmation: boolean;
}

export interface HardwareInfo extends HardwareRecommendationInput {
  windowsVersion: string;
  driverVersion: string;
  cudaComputeCapability: string;
  freeDiskGiB: number;
}
