// @vitest-environment node

import { describe, expect, test } from 'vitest';
import rawManifest from '../../resources/environment/selflift-spark.json';
import {
  parseEnvironmentManifest,
  selectEnvironmentProfile,
  selectEnvironmentRecommendation,
} from '../../src/main/environment-manifest';
import type { HardwareInfo } from '../../src/shared/types';

const BYTES_PER_GIB = 1024 ** 3;
const VERIFICATION_TEMP_BYTES = 5 * BYTES_PER_GIB;

type EditableManifest = any;
type ManifestMutation = (manifest: EditableManifest, value: string) => void;

function makeManifest(): EditableManifest {
  return structuredClone(rawManifest);
}

function makeHardware(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    gpu: 'NVIDIA GeForce RTX 4090',
    vramGiB: 24,
    ramGiB: 64,
    windowsVersion: 'Windows 11',
    driverVersion: '576.88',
    cudaComputeCapability: '8.9',
    freeDiskGiB: 1024,
    ...overrides,
  };
}

describe('environment manifest', () => {
  test('parses the real manifest with both runtimes and the ten workflow models', () => {
    const manifest = parseEnvironmentManifest(rawManifest);

    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.runtimes).sort()).toEqual(['sm120', 'sm89']);
    expect(manifest.modelFiles.map((model) => model.path.split('/').at(-1))).toEqual([
      'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors',
      'qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors',
      'minimax_h3_video_vae_int8_convrot.safetensors',
      'minimax_h3_audio_vae_fp32.safetensors',
      'dmad_minimax_h3_4step_full_critic_comfy.safetensors',
      'H3_speed_slider_1.1.safetensors',
      'h3_upscaler_lms_v0.1_fp32.safetensors',
      'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',
      'taeh3.safetensors',
      'minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
    ]);

    for (const runtime of Object.values(manifest.runtimes)) {
      expect(
        runtime.archiveParts.reduce((total, part) => total + part.size, 0),
      ).toBe(runtime.archiveSize);
    }
  });

  test.each([
    {
      scenario: 'an empty model URL',
      mutate: (manifest: EditableManifest) => {
        manifest.modelFiles[0].url = '';
      },
    },
    {
      scenario: 'an empty archive-part URL',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm89.archiveParts[0].url = '';
      },
    },
    {
      scenario: 'a non-HTTPS model URL',
      mutate: (manifest: EditableManifest) => {
        manifest.modelFiles[0].url = 'http://huggingface.co/model';
      },
    },
    {
      scenario: 'a non-HTTPS archive-part URL',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm89.archiveParts[0].url = 'http://github.com/runtime';
      },
    },
  ])('rejects $scenario', ({ mutate }) => {
    const manifest = makeManifest();
    mutate(manifest);

    expect(() => parseEnvironmentManifest(manifest)).toThrow();
  });

  test.each([
    {
      scenario: 'a short model SHA256',
      mutate: (manifest: EditableManifest) => {
        manifest.modelFiles[0].sha256 = 'abc123';
      },
    },
    {
      scenario: 'a non-hex archive-part SHA256',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm89.archiveParts[0].sha256 = 'z'.repeat(64);
      },
    },
    {
      scenario: 'an invalid whole-archive SHA256',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm120.archiveSha256 = 'f'.repeat(63);
      },
    },
  ])('rejects $scenario', ({ mutate }) => {
    const manifest = makeManifest();
    mutate(manifest);

    expect(() => parseEnvironmentManifest(manifest)).toThrow();
  });

  test('rejects duplicate model paths', () => {
    const manifest = makeManifest();
    manifest.modelFiles[1].path = manifest.modelFiles[0].path;

    expect(() => parseEnvironmentManifest(manifest)).toThrow(/duplicate/i);
  });

  test('rejects model paths that differ only by Windows path casing', () => {
    const manifest = makeManifest();
    manifest.modelFiles[1].path = manifest.modelFiles[0].path.toUpperCase();

    expect(() => parseEnvironmentManifest(manifest)).toThrow(/duplicate/i);
  });

  test('rejects duplicate runtime archive-part paths', () => {
    const manifest = makeManifest();
    manifest.runtimes.sm89.archiveParts[1].path =
      manifest.runtimes.sm89.archiveParts[0].path;

    expect(() => parseEnvironmentManifest(manifest)).toThrow(/duplicate/i);
  });

  test('rejects archive-part paths that differ only by Windows path casing', () => {
    const manifest = makeManifest();
    manifest.runtimes.sm89.archiveParts[1].path =
      manifest.runtimes.sm89.archiveParts[0].path.toUpperCase();

    expect(() => parseEnvironmentManifest(manifest)).toThrow(/duplicate/i);
  });

  const pathTargets: Array<{ name: string; mutate: ManifestMutation }> = [
    {
      name: 'model path',
      mutate: (manifest, value) => {
        manifest.modelFiles[0].path = value;
      },
    },
    {
      name: 'archive-part path',
      mutate: (manifest, value) => {
        manifest.runtimes.sm89.archiveParts[0].path = value;
      },
    },
    {
      name: 'ZIP python path',
      mutate: (manifest, value) => {
        manifest.runtimes.sm89.pythonPath = value;
      },
    },
    {
      name: 'ZIP launch-script path',
      mutate: (manifest, value) => {
        manifest.runtimes.sm89.launchScript = value;
      },
    },
    {
      name: 'ZIP ffprobe path',
      mutate: (manifest, value) => {
        manifest.runtimes.sm89.ffprobePath = value;
      },
    },
  ];
  const unsafePaths = [
    '/absolute/path',
    'C:/absolute/path',
    'C:\\absolute\\path',
    'C:drive-relative',
    '\\\\server\\share\\file',
    '../escape',
    '..\\escape',
    'models/../../escape',
    'file.txt:stream',
    'models/file.txt:stream',
    'models./file.safetensors',
    'models/file.',
    'models /file.safetensors',
    'models/file ',
    'CON',
    'con',
    'models/PRN.safetensors',
    'models/AUX',
    'models/NUL.txt',
    'models/nul.txt',
    'models/COM1',
    'models/com9.safetensors',
    'models/LPT1',
    'models/lpt9.safetensors',
    'models/NUL .txt',
    'models/NUL..txt',
    'models/CON ./file',
  ];
  const pathCases = pathTargets.flatMap((target) =>
    unsafePaths.map((path) => ({ ...target, path })),
  );

  test.each(pathCases)('rejects unsafe $name: $path', ({ mutate, path }) => {
    const manifest = makeManifest();
    mutate(manifest, path);

    expect(() => parseEnvironmentManifest(manifest)).toThrow();
  });

  const illegalCharacters = [
    ...['<', '>', '"', '|', '?', '*'].map((value) => ({ value, label: value })),
    ...Array.from({ length: 31 }, (_, index) => ({
      value: String.fromCharCode(index + 1),
      label: `U+${(index + 1).toString(16).toUpperCase().padStart(4, '0')}`,
    })),
  ];
  const illegalCharacterCases = pathTargets.flatMap((target) =>
    illegalCharacters.map((character) => ({
      ...target,
      path: `models/before${character.value}after`,
      label: character.label,
    })),
  );

  test.each(illegalCharacterCases)(
    'rejects $name containing illegal character $label',
    ({ mutate, path }) => {
      const manifest = makeManifest();
      mutate(manifest, path);

      expect(() => parseEnvironmentManifest(manifest)).toThrow();
    },
  );

  test.each([
    {
      scenario: 'root',
      mutate: (manifest: EditableManifest) => {
        manifest.unknown = true;
      },
    },
    {
      scenario: 'runtime map',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm100 = manifest.runtimes.sm89;
      },
    },
    {
      scenario: 'runtime',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm89.unknown = true;
      },
    },
    {
      scenario: 'archive part',
      mutate: (manifest: EditableManifest) => {
        manifest.runtimes.sm89.archiveParts[0].unknown = true;
      },
    },
    {
      scenario: 'model',
      mutate: (manifest: EditableManifest) => {
        manifest.modelFiles[0].unknown = true;
      },
    },
  ])('rejects an unknown field at the $scenario level', ({ mutate }) => {
    const manifest = makeManifest();
    mutate(manifest);

    expect(() => parseEnvironmentManifest(manifest)).toThrow();
  });
});

describe('hardware-aware environment selection', () => {
  test('recommends runtime, profile, models, and bytes despite low free disk space', () => {
    const selection = selectEnvironmentRecommendation(
      makeHardware({ freeDiskGiB: 0 }),
      rawManifest,
    );
    const modelBytes = rawManifest.modelFiles.reduce(
      (total, model) => total + model.size,
      0,
    );

    expect(selection.runtime).toEqual(rawManifest.runtimes.sm89);
    expect(selection.profile).toBe('high-memory-candidate');
    expect(selection.modelFiles).toEqual(rawManifest.modelFiles);
    expect(selection.requiredBytes).toBe(
      rawManifest.runtimes.sm89.archiveSize +
        rawManifest.runtimes.sm89.estimatedExtractedBytes +
        modelBytes +
        VERIFICATION_TEMP_BYTES,
    );
  });

  test.each([
    {
      scenario: 'a non-NVIDIA GPU',
      hardware: { gpu: 'AMD Radeon RX 7900' },
      error: /unsupported GPU/i,
    },
    {
      scenario: 'an unsupported CUDA architecture',
      hardware: { cudaComputeCapability: '12.1' },
      error: /unsupported CUDA/i,
    },
    {
      scenario: 'less than 8 GiB VRAM',
      hardware: { vramGiB: 7.99 },
      error: /8 GiB VRAM/i,
    },
    {
      scenario: 'less than 32 GiB RAM',
      hardware: { ramGiB: 31.99 },
      error: /32 GiB RAM/i,
    },
  ])('recommendation still rejects $scenario', ({ hardware, error }) => {
    expect(() =>
      selectEnvironmentRecommendation(makeHardware(hardware), rawManifest),
    ).toThrow(error);
  });

  test('selectEnvironmentProfile retains the download disk-space check', () => {
    expect(() =>
      selectEnvironmentProfile(makeHardware({ freeDiskGiB: 0 }), rawManifest),
    ).toThrow(/disk|空间/i);
  });

  test.each([
    { gpu: 'NVIDIA GeForce RTX 3060', cc: '8.6', runtime: 'sm89' },
    { gpu: 'NVIDIA GeForce RTX 4090', cc: '8.9', runtime: 'sm89' },
    { gpu: 'NVIDIA GeForce RTX 5090', cc: '12.0', runtime: 'sm120' },
  ])('selects $runtime for $gpu with CC $cc', ({ gpu, cc, runtime }) => {
    const selection = selectEnvironmentProfile(
      makeHardware({ gpu, cudaComputeCapability: cc }),
      rawManifest,
    );

    expect(selection.runtime.id).toBe(runtime);
  });

  test.each([
    '7.5',
    '8.0',
    '8.7',
    '8.60',
    '9.0',
    '11.0',
    '12',
    '12.x',
    '12.1',
    '12.8',
    '12.9',
    '13.0',
  ])(
    'rejects unsupported CUDA compute capability %s',
    (cudaComputeCapability) => {
      expect(() =>
        selectEnvironmentProfile(
          makeHardware({ cudaComputeCapability }),
          rawManifest,
        ),
      ).toThrow(/unsupported|架构/i);
    },
  );

  test('rejects non-NVIDIA GPUs', () => {
    expect(() =>
      selectEnvironmentProfile(makeHardware({ gpu: 'AMD Radeon RX 7900' }), rawManifest),
    ).toThrow(/unsupported|架构/i);
  });

  test('rejects less than 8 GiB VRAM and treats the boundary as a candidate', () => {
    expect(() =>
      selectEnvironmentProfile(makeHardware({ vramGiB: 7.99 }), rawManifest),
    ).toThrow('8 GiB');

    const selection = selectEnvironmentProfile(
      makeHardware({ gpu: 'NVIDIA GeForce RTX 3060', vramGiB: 8, ramGiB: 32 }),
      rawManifest,
    );
    expect(selection.profile).toBe('conservative');
  });

  test('rejects less than 32 GiB RAM before selecting a profile', () => {
    expect(() =>
      selectEnvironmentProfile(makeHardware({ ramGiB: 31.99 }), rawManifest),
    ).toThrow('32 GiB');
  });

  test.each([
    { vramGiB: 8, profile: 'conservative' },
    { vramGiB: 11.99, profile: 'conservative' },
    { vramGiB: 12, profile: 'balanced-16gb' },
    { vramGiB: 19.99, profile: 'balanced-16gb' },
    { vramGiB: 20, profile: 'high-memory-candidate' },
  ])('uses the existing $profile threshold at $vramGiB GiB VRAM', ({
    vramGiB,
    profile,
  }) => {
    const selection = selectEnvironmentProfile(
      makeHardware({ vramGiB, ramGiB: 32 }),
      rawManifest,
    );

    expect(selection.profile).toBe(profile);
  });

  test('computes exact download, extraction, model, and verification space', () => {
    const selection = selectEnvironmentProfile(makeHardware(), rawManifest);
    const modelBytes = selection.modelFiles.reduce((total, model) => total + model.size, 0);

    expect(selection.requiredBytes).toBe(
      selection.runtime.archiveSize +
        selection.runtime.estimatedExtractedBytes +
        modelBytes +
        VERIFICATION_TEMP_BYTES,
    );
    expect(selection.requiredBytes).toBeGreaterThanOrEqual(
      selection.runtime.archiveSize +
        selection.runtime.estimatedExtractedBytes +
        modelBytes +
        5 * BYTES_PER_GIB,
    );
  });

  test('rejects an archiveParts byte total above MAX_SAFE_INTEGER', () => {
    const manifest = makeManifest();
    manifest.runtimes.sm89.archiveParts[0].size = Number.MAX_SAFE_INTEGER;
    manifest.runtimes.sm89.archiveParts[1].size = Number.MAX_SAFE_INTEGER;
    manifest.runtimes.sm89.archiveSize = Number.MAX_SAFE_INTEGER;

    expect(() => parseEnvironmentManifest(manifest)).toThrow(
      /archiveParts.*safe integer/i,
    );
  });

  test('rejects a modelBytes total above MAX_SAFE_INTEGER', () => {
    const manifest = makeManifest();
    manifest.modelFiles = manifest.modelFiles.slice(0, 2);
    for (const model of manifest.modelFiles) model.size = Number.MAX_SAFE_INTEGER;

    expect(() => selectEnvironmentProfile(makeHardware(), manifest)).toThrow(
      /modelBytes.*safe integer/i,
    );
  });

  test('rejects requiredBytes above MAX_SAFE_INTEGER when modelBytes is still safe', () => {
    const manifest = makeManifest();
    manifest.modelFiles = manifest.modelFiles.slice(0, 1);
    manifest.modelFiles[0].size = Number.MAX_SAFE_INTEGER;

    expect(() => selectEnvironmentProfile(makeHardware(), manifest)).toThrow(
      /requiredBytes.*safe integer/i,
    );
  });

  test('rejects insufficient disk space before any download can start', () => {
    const requiredBytes = selectEnvironmentProfile(makeHardware(), rawManifest).requiredBytes;

    expect(() =>
      selectEnvironmentProfile(
        makeHardware({ freeDiskGiB: (requiredBytes - 1) / BYTES_PER_GIB }),
        rawManifest,
      ),
    ).toThrow(/disk|空间/i);

    expect(() =>
      selectEnvironmentProfile(
        makeHardware({ freeDiskGiB: requiredBytes / BYTES_PER_GIB }),
        rawManifest,
      ),
    ).not.toThrow();
  });
});
