import type { HardwareInfo, HardwarePreset } from './types';

export type EnvironmentRuntimeId = 'sm89' | 'sm120';
export type EnvironmentProfile = HardwarePreset;

export interface EnvironmentHardwareFingerprint {
  gpu: string;
  vramGiB: number;
  ramGiB: number;
  cudaComputeCapability: string;
}

export interface EnvironmentPaths {
  runtimeRoot: string;
  modelDirectory: string;
  outputDirectory: string;
}

export interface EnvironmentConfig extends EnvironmentPaths {
  schemaVersion: 1;
  runtimeId: EnvironmentRuntimeId;
  profile: EnvironmentProfile;
  /** Recorded install root; absent in configs written before it was tracked. */
  installRoot?: string;
  hardwareFingerprint: EnvironmentHardwareFingerprint;
  manifestVersion: string;
  status: 'installing' | 'ready' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentArchivePart {
  url: string;
  path: string;
  size: number;
  sha256: string;
}

export interface EnvironmentModelFile {
  url: string;
  path: string;
  size: number;
  sha256: string;
  source: string;
}

export interface EnvironmentRuntime {
  id: EnvironmentRuntimeId;
  displayName: string;
  archiveParts: EnvironmentArchivePart[];
  archiveSize: number;
  archiveSha256: string;
  estimatedExtractedBytes: number;
  pythonPath: string;
  launchScript: string;
  ffprobePath: string;
}

export interface EnvironmentManifest {
  version: 1;
  runtimes: Record<EnvironmentRuntimeId, EnvironmentRuntime>;
  modelFiles: EnvironmentModelFile[];
}

export interface EnvironmentProfileSelection {
  runtime: EnvironmentRuntime;
  profile: EnvironmentProfile;
  modelFiles: EnvironmentModelFile[];
  requiredBytes: number;
}

export type EnvironmentStage =
  | 'detect'
  | 'select'
  | 'download-runtime'
  | 'extract'
  | 'download-models'
  | 'verify'
  | 'start'
  | 'ready';

export interface EnvironmentStartInput {
  profileId: EnvironmentProfile;
  installRoot: string;
}

export interface EnvironmentProgress {
  downloadedBytes: number;
  totalBytes: number;
  currentFile?: string;
}

export interface EnvironmentState {
  config: EnvironmentConfig | null;
  hardware: HardwareInfo | null;
  selection: EnvironmentProfileSelection | null;
  installRoot: string;
  stage: EnvironmentStage;
  progress: EnvironmentProgress;
  error: string | null;
  active: boolean;
  healthy: boolean;
}
