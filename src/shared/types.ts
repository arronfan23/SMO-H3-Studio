export type VideoMode = 'text' | 'audio';

export interface GenerationRequest {
  mode: VideoMode;
  avatarId: string;
  prompt: string;
  duration: number;
  seed: number;
  audioPath?: string;
  trimStart?: number;
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

export interface Work {
  id: string;
  avatarId: string;
  mode: VideoMode;
  outputPath: string | null;
  status: WorkStatus;
  createdAt: string;
}

export type NewWork = Omit<Work, 'createdAt'>;

export interface LlmProfile {
  baseUrl: string;
  model: string;
}

export interface LlmCredentials extends LlmProfile {
  apiKey: string;
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
