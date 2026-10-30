import type { HardwarePreset } from './types';

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
