import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  EnvironmentConfig,
  EnvironmentProfile,
} from '../../src/shared/environment';

const REQUIRED_RUNTIME_FILES = [
  'python_embeded/python.exe',
  'tools/launch.py',
  'tools/ffmpeg/ffmpeg.exe',
  'tools/ffmpeg/ffprobe.exe',
] as const;
const EMPTY_FILE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
    mkdir(join(runtimeRoot, 'python_embeded'), { recursive: true }),
    mkdir(join(runtimeRoot, 'tools', 'ffmpeg'), { recursive: true }),
    mkdir(join(runtimeRoot, 'docs'), { recursive: true }),
    mkdir(modelDirectory, { recursive: true }),
    mkdir(options.outputDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(options.dataDirectory, 'environment.json'),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    ),
    ...REQUIRED_RUNTIME_FILES.map((path) =>
      writeFile(join(runtimeRoot, ...path.split('/')), '', 'utf8'),
    ),
    writeFile(
      join(runtimeRoot, 'docs', 'file-manifest.sha256'),
      `${REQUIRED_RUNTIME_FILES.map(
        (path) => `${EMPTY_FILE_SHA256} *${path}`,
      ).join('\n')}\n`,
      'utf8',
    ),
  ]);
  return config;
}
