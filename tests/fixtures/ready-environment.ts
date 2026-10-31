import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EnvironmentConfig,
  EnvironmentProfile,
} from '../../src/shared/environment';

export interface ReadyEnvironmentOptions {
  dataDirectory: string;
  installRoot: string;
  outputDirectory: string;
  runtimeRoot?: string;
  modelDirectory?: string;
  profile?: EnvironmentProfile;
}

export async function writeReadyEnvironment(
  options: ReadyEnvironmentOptions,
): Promise<EnvironmentConfig> {
  const runtimeRoot = options.runtimeRoot ?? join(options.installRoot, 'runtime', 'sm120');
  const modelDirectory =
    options.modelDirectory ?? join(options.installRoot, 'models', 'diffusion_models');
  const timestamp = '2026-10-30T08:00:00.000Z';
  const config: EnvironmentConfig = {
    schemaVersion: 1,
    runtimeId: 'sm120',
    runtimeRoot,
    modelDirectory,
    outputDirectory: options.outputDirectory,
    profile: options.profile ?? 'balanced-16gb',
    hardwareFingerprint: {
      gpu: 'NVIDIA GeForce RTX 5080',
      vramGiB: 16,
      ramGiB: 64,
      cudaComputeCapability: '12.0',
    },
    manifestVersion: '1',
    status: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await Promise.all([
    mkdir(options.dataDirectory, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(modelDirectory, { recursive: true }),
    mkdir(options.outputDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(options.dataDirectory, 'environment.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  return config;
}
