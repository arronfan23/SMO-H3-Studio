import { z } from 'zod';
import type {
  EnvironmentManifest,
  EnvironmentProfileSelection,
  EnvironmentRuntimeId,
} from '../shared/environment';
import type { HardwareInfo } from '../shared/types';
import { recommendHardware } from './hardware';

const BYTES_PER_GIB = 1024 ** 3;
const MINIMUM_VRAM_GIB = 8;
const MINIMUM_RAM_GIB = 32;
export const ENVIRONMENT_VERIFICATION_TEMP_BYTES = 5 * BYTES_PER_GIB;

const httpsUrlSchema = z.string().min(1).refine(
  (value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'URL must be a valid HTTPS URL' },
);

const sha256Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'SHA256 must contain exactly 64 hexadecimal characters');

const relativePathSchema = z.string().refine(
  (value) => {
    if (
      value.length === 0 ||
      value.trim() !== value ||
      value.includes('\0') ||
      value.includes('\\') ||
      value.startsWith('/') ||
      /^[a-zA-Z]:/.test(value)
    ) {
      return false;
    }

    return value
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  },
  { message: 'Path must be a safe relative path without traversal' },
);

const byteSizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const archivePartSchema = z
  .object({
    url: httpsUrlSchema,
    path: relativePathSchema,
    size: byteSizeSchema,
    sha256: sha256Schema,
  })
  .strict();

const modelFileSchema = z
  .object({
    url: httpsUrlSchema,
    path: relativePathSchema,
    size: byteSizeSchema,
    sha256: sha256Schema,
    source: z.string().trim().min(1),
  })
  .strict();

const runtimeSchema = z
  .object({
    id: z.enum(['sm89', 'sm120']),
    displayName: z.string().trim().min(1),
    archiveParts: z.array(archivePartSchema).min(1),
    archiveSize: byteSizeSchema,
    archiveSha256: sha256Schema,
    estimatedExtractedBytes: byteSizeSchema,
    pythonPath: relativePathSchema,
    launchScript: relativePathSchema,
    ffprobePath: relativePathSchema,
  })
  .strict()
  .superRefine((runtime, context) => {
    const paths = new Set<string>();
    let archivePartsSize = 0;

    for (const [index, part] of runtime.archiveParts.entries()) {
      archivePartsSize += part.size;
      const normalizedPath = part.path.toLowerCase();
      if (paths.has(normalizedPath)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate archive-part path: ${part.path}`,
          path: ['archiveParts', index, 'path'],
        });
      }
      paths.add(normalizedPath);
    }

    if (archivePartsSize !== runtime.archiveSize) {
      context.addIssue({
        code: 'custom',
        message: 'Archive-part sizes must add up to archiveSize',
        path: ['archiveSize'],
      });
    }
  });

export const environmentManifestSchema = z
  .object({
    version: z.literal(1),
    runtimes: z
      .object({
        sm89: runtimeSchema,
        sm120: runtimeSchema,
      })
      .strict(),
    modelFiles: z.array(modelFileSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const id of ['sm89', 'sm120'] as const) {
      if (manifest.runtimes[id].id !== id) {
        context.addIssue({
          code: 'custom',
          message: `Runtime ${id} must have the matching id`,
          path: ['runtimes', id, 'id'],
        });
      }
    }

    const paths = new Set<string>();
    for (const [index, model] of manifest.modelFiles.entries()) {
      const normalizedPath = model.path.toLowerCase();
      if (paths.has(normalizedPath)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate model path: ${model.path}`,
          path: ['modelFiles', index, 'path'],
        });
      }
      paths.add(normalizedPath);
    }
  });

export function parseEnvironmentManifest(input: unknown): EnvironmentManifest {
  return environmentManifestSchema.parse(input);
}

function selectRuntimeId(hardware: HardwareInfo): EnvironmentRuntimeId {
  if (!/\bnvidia\b/i.test(hardware.gpu)) {
    throw new Error('unsupported GPU: an NVIDIA GPU is required');
  }

  const capability = hardware.cudaComputeCapability;
  if (capability === '8.6' || capability === '8.9') return 'sm89';
  if (/^12\.\d+$/.test(capability)) return 'sm120';

  throw new Error(`unsupported CUDA architecture (compute capability ${capability})`);
}

export function selectEnvironmentProfile(
  manifestInput: unknown,
  hardware: HardwareInfo,
): EnvironmentProfileSelection {
  const manifest = parseEnvironmentManifest(manifestInput);
  const runtimeId = selectRuntimeId(hardware);

  if (!Number.isFinite(hardware.vramGiB) || hardware.vramGiB < MINIMUM_VRAM_GIB) {
    throw new Error(`At least ${MINIMUM_VRAM_GIB} GiB VRAM is required`);
  }
  if (!Number.isFinite(hardware.ramGiB) || hardware.ramGiB < MINIMUM_RAM_GIB) {
    throw new Error(`At least ${MINIMUM_RAM_GIB} GiB RAM is required`);
  }

  const recommendation = recommendHardware(hardware);
  const runtime = manifest.runtimes[runtimeId];
  const modelBytes = manifest.modelFiles.reduce((total, model) => total + model.size, 0);
  const requiredBytes =
    runtime.archiveSize +
    runtime.estimatedExtractedBytes +
    modelBytes +
    ENVIRONMENT_VERIFICATION_TEMP_BYTES;

  if (
    !Number.isFinite(hardware.freeDiskGiB) ||
    hardware.freeDiskGiB < 0 ||
    hardware.freeDiskGiB * BYTES_PER_GIB < requiredBytes
  ) {
    throw new Error(
      `Insufficient disk space before download: ${(requiredBytes / BYTES_PER_GIB).toFixed(
        2,
      )} GiB is required`,
    );
  }

  return {
    runtime,
    profile: recommendation.preset,
    modelFiles: manifest.modelFiles,
    requiredBytes,
  };
}
