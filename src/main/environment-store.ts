import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, win32 } from 'node:path';
import { z } from 'zod';
import type {
  EnvironmentConfig,
  EnvironmentPaths,
} from '../shared/environment';

const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:CONIN\$|CONOUT\$|CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)/i;
const WINDOWS_ILLEGAL_SEGMENT_CHARACTER_PATTERN = /[<>:"|?*]/;
const WINDOWS_CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]$/;
const WINDOWS_UNC_ROOT_PATTERN = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?$/;

function isSafeWindowsAbsolutePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    WINDOWS_CONTROL_CHARACTER_PATTERN.test(value) ||
    !win32.isAbsolute(value)
  ) {
    return false;
  }

  const { root } = win32.parse(value);
  if (
    !WINDOWS_DRIVE_ROOT_PATTERN.test(root) &&
    !WINDOWS_UNC_ROOT_PATTERN.test(root)
  ) {
    return false;
  }

  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const firstSegmentIndex = WINDOWS_DRIVE_ROOT_PATTERN.test(root) ? 1 : 0;

  return segments.slice(firstSegmentIndex).every(
    (segment) =>
      segment !== '..' &&
      !/[. ]$/.test(segment) &&
      !WINDOWS_DEVICE_NAME_PATTERN.test(segment) &&
      !WINDOWS_ILLEGAL_SEGMENT_CHARACTER_PATTERN.test(segment),
  );
}

const windowsAbsolutePathSchema = z.string().refine(isSafeWindowsAbsolutePath, {
  message:
    'Path must be a fully qualified Windows path without traversal, ADS, device names, or invalid segments',
});

const positiveFiniteNumberSchema = z.number().finite().positive();

const environmentHardwareFingerprintSchema = z
  .object({
    gpu: z.string().refine((value) => value.trim().length > 0, {
      message: 'GPU must not be empty',
    }),
    vramGiB: positiveFiniteNumberSchema,
    ramGiB: positiveFiniteNumberSchema,
    cudaComputeCapability: z.string(),
  })
  .strict();

const environmentConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: z.enum(['sm89', 'sm120']),
    runtimeRoot: windowsAbsolutePathSchema,
    modelDirectory: windowsAbsolutePathSchema,
    outputDirectory: windowsAbsolutePathSchema,
    profile: z.enum(['conservative', 'balanced-16gb', 'high-memory-candidate']),
    hardwareFingerprint: environmentHardwareFingerprintSchema,
    manifestVersion: z.string(),
    status: z.enum(['installing', 'ready', 'failed']),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

function parseEnvironmentConfig(input: unknown): EnvironmentConfig {
  const result = environmentConfigSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export class EnvironmentStore {
  constructor(private readonly path: string) {}

  async load(): Promise<EnvironmentConfig | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new Error(`Unable to read environment configuration at "${this.path}"`);
    }

    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid environment configuration JSON at "${this.path}"`);
    }

    return parseEnvironmentConfig(input);
  }

  async save(config: EnvironmentConfig): Promise<void> {
    const parsed = parseEnvironmentConfig(config);
    if (parsed.status === 'ready') {
      throw new Error(
        'Refusing to save a ready environment configuration without health verification',
      );
    }

    await this.writeAtomically(parsed);
  }

  async markReady(): Promise<EnvironmentConfig> {
    const current = await this.load();
    if (current === null) {
      throw new Error('No environment configuration exists');
    }
    if (current.status === 'ready') return current;

    const ready: EnvironmentConfig = {
      ...current,
      status: 'ready',
      updatedAt: new Date().toISOString(),
    };
    await this.writeAtomically(ready);
    return ready;
  }

  private async writeAtomically(config: EnvironmentConfig): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function resolveEnvironmentPaths(
  config: EnvironmentConfig | null,
  fallback: EnvironmentPaths,
): EnvironmentPaths {
  if (config === null) return { ...fallback };

  const parsed = parseEnvironmentConfig(config);
  return {
    runtimeRoot: parsed.runtimeRoot,
    modelDirectory: parsed.modelDirectory,
    outputDirectory: parsed.outputDirectory,
  };
}
