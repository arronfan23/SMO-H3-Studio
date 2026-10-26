import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HardwareInfo,
  HardwareModelPolicy,
  HardwareProfile,
  HardwareRecommendationInput,
} from '../shared/types';

const INT8_UNET = 'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors';
const BF16_UNET = 'minimax_h3_fl2va_bf16.safetensors';
const DETECTION_TIMEOUT_MS = 5000;
const BYTES_PER_GIB = 1024 ** 3;
const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,memory.total,driver_version,compute_cap',
  '--format=csv,noheader',
] as const;
const POWERSHELL_HARDWARE_SCRIPT = [
  '$os = Get-CimInstance Win32_OperatingSystem;',
  '$computer = Get-CimInstance Win32_ComputerSystem;',
  '$driveName = (Get-Location).Drive.Name;',
  '$drive = Get-PSDrive -Name $driveName;',
  '[pscustomobject]@{',
  'WindowsVersion = "$($os.Caption) $($os.Version)";',
  'TotalMemoryBytes = [uint64]$computer.TotalPhysicalMemory;',
  'FreeDiskBytes = [uint64]$drive.Free',
  '} | ConvertTo-Json -Compress',
].join(' ');

type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export interface HardwareCommandRequest {
  command: string;
  args: readonly string[];
  timeoutMs: number;
}

export type HardwareRunner = (request: HardwareCommandRequest) => Promise<string>;

export function recommendHardware(
  input: HardwareRecommendationInput,
): HardwareProfile {
  if (input.vramGiB < 12 || input.ramGiB < 32) {
    return {
      preset: 'conservative',
      modelPolicy: 'int8',
      megapixels: 0.4,
      lowvram: true,
      tiling: 4,
      requiresConfirmation: true,
    };
  }

  if (input.vramGiB < 20) {
    return {
      preset: 'balanced-16gb',
      modelPolicy: 'int8',
      megapixels: 0.7,
      lowvram: true,
      tiling: 'auto',
      requiresConfirmation: true,
    };
  }

  return {
    preset: 'high-memory-candidate',
    modelPolicy: 'bf16-if-present',
    megapixels: 1,
    lowvram: false,
    tiling: 'auto',
    requiresConfirmation: true,
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function selectUnetModel(
  policy: HardwareModelPolicy,
  modelDirectory: string,
): string {
  const candidates = policy === 'bf16-if-present' ? [BF16_UNET, INT8_UNET] : [INT8_UNET];
  const selected = candidates.find((filename) => isFile(join(modelDirectory, filename)));

  if (selected) return selected;

  throw new Error(
    `Required UNET model files are missing in "${modelDirectory}": ${candidates.join(
      ', ',
    )}. Automatic download is disabled.`,
  );
}

export function applyHardwareProfile<T extends Record<string, ComfyNode>>(
  graph: T,
  profile: HardwareProfile,
  confirmed: boolean,
  modelDirectory?: string,
): T {
  if (!confirmed) throw new Error('Hardware profile requires confirmation');

  const unetName = modelDirectory
    ? selectUnetModel(profile.modelPolicy, modelDirectory)
    : undefined;
  const copy = structuredClone(graph);

  for (const node of Object.values(copy)) {
    if (node.class_type === 'ResolutionSelector') {
      node.inputs.megapixels = profile.megapixels;
    }

    if (node.class_type === 'SelfLiftAvatarH3Sampler') {
      node.inputs.highres_tiling = true;
      node.inputs.tiling_mode = profile.tiling === 'auto' ? 'auto' : 'manual';
      if (profile.tiling !== 'auto') node.inputs.tiling_tiles = profile.tiling;
    }

    if (node.class_type === 'UNETLoader' && unetName) {
      node.inputs.unet_name = unetName;
    }
  }

  return copy;
}

export function getComfyLaunchArgs(
  profile: Pick<HardwareProfile, 'lowvram'>,
): string[] {
  return profile.lowvram ? ['--lowvram'] : [];
}

function executeProcess(request: HardwareCommandRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      request.command,
      [...request.args],
      {
        encoding: 'utf8',
        timeout: request.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }

        const detail = stderr.trim();
        if (detail && !error.message.includes(detail)) {
          error.message = `${error.message}: ${detail}`;
        }
        reject(error);
      },
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; killed?: unknown };
  return candidate.code === 'ETIMEDOUT' || candidate.killed === true;
}

async function runDetectionCommand(
  label: string,
  command: string,
  args: readonly string[],
  runner: HardwareRunner,
): Promise<string> {
  try {
    return await runner({ command, args, timeoutMs: DETECTION_TIMEOUT_MS });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`${label} timed out after ${DETECTION_TIMEOUT_MS} ms`);
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed: ${detail}`);
  }
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('Unclosed CSV quote');
  fields.push(field.trim());
  return fields;
}

function parseGpuOutput(stdout: string) {
  try {
    const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
    if (!line) throw new Error('Empty GPU output');

    const [gpu, memory, driverVersion, cudaComputeCapability, ...extra] =
      parseCsvLine(line);
    const memoryMatch = /^(\d+(?:\.\d+)?)\s*MiB$/i.exec(memory);

    if (
      !gpu ||
      !memoryMatch ||
      !driverVersion ||
      !cudaComputeCapability ||
      extra.length > 0
    ) {
      throw new Error('Invalid GPU fields');
    }

    const memoryMiB = Number(memoryMatch[1]);
    if (!Number.isFinite(memoryMiB) || memoryMiB <= 0) {
      throw new Error('Invalid GPU memory');
    }

    return {
      gpu,
      vramGiB: memoryMiB / 1024,
      driverVersion,
      cudaComputeCapability,
    };
  } catch {
    throw new Error('Unable to parse GPU detection output');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWindowsHardwareOutput(stdout: string) {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value)) throw new Error('Invalid Windows hardware payload');

    const windowsVersion = value.WindowsVersion;
    const totalMemoryBytes = value.TotalMemoryBytes;
    const freeDiskBytes = value.FreeDiskBytes;

    if (typeof windowsVersion !== 'string' || windowsVersion.trim().length === 0) {
      throw new Error('Invalid Windows version');
    }
    if (
      typeof totalMemoryBytes !== 'number' ||
      !Number.isFinite(totalMemoryBytes) ||
      totalMemoryBytes <= 0
    ) {
      throw new Error('Invalid physical memory');
    }
    if (
      typeof freeDiskBytes !== 'number' ||
      !Number.isFinite(freeDiskBytes) ||
      freeDiskBytes < 0
    ) {
      throw new Error('Invalid free disk space');
    }

    return {
      windowsVersion: windowsVersion.trim(),
      ramGiB: totalMemoryBytes / BYTES_PER_GIB,
      freeDiskGiB: freeDiskBytes / BYTES_PER_GIB,
    };
  } catch {
    throw new Error('Unable to parse Windows hardware detection output');
  }
}

export async function detectHardware(
  runner: HardwareRunner = executeProcess,
): Promise<HardwareInfo> {
  const gpuOutput = await runDetectionCommand(
    'GPU detection',
    'nvidia-smi',
    NVIDIA_SMI_ARGS,
    runner,
  );
  const gpu = parseGpuOutput(gpuOutput);
  const windowsOutput = await runDetectionCommand(
    'Windows hardware detection',
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_HARDWARE_SCRIPT],
    runner,
  );

  return { ...gpu, ...parseWindowsHardwareOutput(windowsOutput) };
}
