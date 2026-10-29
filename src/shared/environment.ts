export type EnvironmentRuntimeId = 'sm89' | 'sm120';

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
  profile: 'conservative' | 'balanced-16gb' | 'high-memory-candidate';
  modelFiles: EnvironmentModelFile[];
  requiredBytes: number;
}
