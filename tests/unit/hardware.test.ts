// @vitest-environment node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { HardwareProfile } from '../../src/shared/types';
import * as hardware from '../../src/main/hardware';

const INT8_UNET = 'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors';
const BF16_UNET = 'minimax_h3_fl2va_bf16.safetensors';
const temporaryDirectories: string[] = [];
const GPU_OUTPUT = '"NVIDIA GeForce RTX 5080", 16384 MiB, 576.88, 12.0\n';
const SYSTEM_OUTPUT = JSON.stringify({
  WindowsVersion: 'Microsoft Windows 10 专业版 10.0.19045',
  TotalMemoryBytes: 64 * 1024 ** 3,
  FreeDiskBytes: 512 * 1024 ** 3,
});

type CommandRequest = {
  command: string;
  args: readonly string[];
  timeoutMs: number;
};

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    ...hardware.recommendHardware({ gpu: 'RTX 5080', vramGiB: 16, ramGiB: 64 }),
    ...overrides,
  };
}

function makeGraph() {
  return {
    resolution: {
      class_type: 'ResolutionSelector',
      inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 0.7, multiple: 32 },
    },
    sampler: {
      class_type: 'SelfLiftAvatarH3Sampler',
      inputs: { highres_tiling: false, tiling_mode: 'auto', tiling_tiles: 2 },
    },
    unet: {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'original.safetensors', weight_dtype: 'default' },
    },
    unrelated: {
      class_type: 'OtherNode',
      inputs: { nested: { value: 1 } },
    },
  };
}

function makeModelDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'smo-h3-hardware-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeInt8ModelDirectory(): string {
  const directory = makeModelDirectory();
  writeFileSync(join(directory, INT8_UNET), 'int8');
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('recommendHardware', () => {
  test.each([
    {
      scenario: 'low VRAM',
      input: { gpu: 'RTX 4060', vramGiB: 11.99, ramGiB: 32 },
      expected: {
        preset: 'conservative',
        modelPolicy: 'int8',
        megapixels: 0.4,
        lowvram: true,
        tiling: 4,
        requiresConfirmation: true,
      },
    },
    {
      scenario: 'low RAM despite high VRAM',
      input: { gpu: 'RTX 4090', vramGiB: 24, ramGiB: 31.99 },
      expected: {
        preset: 'conservative',
        modelPolicy: 'int8',
        megapixels: 0.4,
        lowvram: true,
        tiling: 4,
        requiresConfirmation: true,
      },
    },
    {
      scenario: 'the 12 GiB boundary',
      input: { gpu: 'RTX 5080', vramGiB: 12, ramGiB: 32 },
      expected: {
        preset: 'balanced-16gb',
        modelPolicy: 'int8',
        megapixels: 0.7,
        lowvram: true,
        tiling: 'auto',
        requiresConfirmation: true,
      },
    },
    {
      scenario: 'less than 20 GiB of VRAM',
      input: { gpu: 'RTX 5080', vramGiB: 19.99, ramGiB: 64 },
      expected: {
        preset: 'balanced-16gb',
        modelPolicy: 'int8',
        megapixels: 0.7,
        lowvram: true,
        tiling: 'auto',
        requiresConfirmation: true,
      },
    },
    {
      scenario: 'the 20 GiB boundary',
      input: { gpu: 'RTX 4090', vramGiB: 20, ramGiB: 32 },
      expected: {
        preset: 'high-memory-candidate',
        modelPolicy: 'bf16-if-present',
        megapixels: 1,
        lowvram: false,
        tiling: 'auto',
        requiresConfirmation: true,
      },
    },
  ])('returns the explicit profile for $scenario', ({ input, expected }) => {
    expect(hardware.recommendHardware(input)).toEqual(expected);
  });
});

describe('applyHardwareProfile', () => {
  test('rejects an unconfirmed profile before reading models or changing the graph', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);

    expect(() =>
      hardware.applyHardwareProfile(
        graph,
        makeProfile({ modelPolicy: 'bf16-if-present' }),
        false,
        join('missing', 'models'),
      ),
    ).toThrow(/confirmation/i);
    expect(graph).toEqual(original);
  });

  test('rejects a missing model directory without changing the source graph', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);
    const apply = () => {
      // @ts-expect-error Verify the runtime guard for callers that bypass TypeScript.
      hardware.applyHardwareProfile(graph, makeProfile(), true);
    };

    expect(apply).toThrow('Model directory is required');
    expect(graph).toEqual(original);
  });

  test.each([
    { scenario: 'an empty', modelDirectory: '' },
    { scenario: 'a whitespace-only', modelDirectory: ' \t ' },
  ])(
    'rejects $scenario model directory without changing the source graph',
    ({ modelDirectory }) => {
      const graph = makeGraph();
      const original = structuredClone(graph);
      const apply = () =>
        hardware.applyHardwareProfile(graph, makeProfile(), true, modelDirectory);

      expect(apply).toThrow('Model directory is required');
      expect(graph).toEqual(original);
    },
  );

  test('returns a structured clone with megapixels and automatic tiling', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);

    const copy = hardware.applyHardwareProfile(
      graph,
      makeProfile({ megapixels: 1, tiling: 'auto' }),
      true,
      makeInt8ModelDirectory(),
    );

    expect(copy).not.toBe(graph);
    expect(copy.resolution).not.toBe(graph.resolution);
    expect(copy.unrelated.inputs.nested).not.toBe(graph.unrelated.inputs.nested);
    expect(copy.resolution.inputs.megapixels).toBe(1);
    expect(copy.sampler.inputs).toMatchObject({
      highres_tiling: true,
      tiling_mode: 'auto',
    });
    expect(copy.unet.inputs.unet_name).toBe(INT8_UNET);
    expect(graph).toEqual(original);
  });

  test('uses manual tiling and the requested tile count for numeric tiling', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);

    const copy = hardware.applyHardwareProfile(
      graph,
      makeProfile({ megapixels: 0.4, tiling: 4 }),
      true,
      makeInt8ModelDirectory(),
    );

    expect(copy.sampler.inputs).toMatchObject({
      highres_tiling: true,
      tiling_mode: 'manual',
      tiling_tiles: 4,
    });
    expect(copy.unet.inputs.unet_name).toBe(INT8_UNET);
    expect(graph).toEqual(original);
  });

  test('writes the selected UNET only into the confirmed copy', () => {
    const modelDirectory = makeModelDirectory();
    writeFileSync(join(modelDirectory, INT8_UNET), 'int8');
    writeFileSync(join(modelDirectory, BF16_UNET), 'bf16');
    const graph = makeGraph();
    const original = structuredClone(graph);

    const copy = hardware.applyHardwareProfile(
      graph,
      makeProfile({ modelPolicy: 'bf16-if-present' }),
      true,
      modelDirectory,
    );

    expect(copy.unet.inputs.unet_name).toBe(BF16_UNET);
    expect(copy.unet).not.toBe(graph.unet);
    expect(graph).toEqual(original);
  });

  test('does not change the source graph when required models are missing', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);

    expect(() =>
      hardware.applyHardwareProfile(
        graph,
        makeProfile({ modelPolicy: 'bf16-if-present' }),
        true,
        makeModelDirectory(),
      ),
    ).toThrow(/missing/i);
    expect(graph).toEqual(original);
  });

  test('never writes lowvram as a ComfyUI node field', () => {
    const copy = hardware.applyHardwareProfile(
      makeGraph(),
      makeProfile(),
      true,
      makeInt8ModelDirectory(),
    );

    for (const node of Object.values(copy)) {
      expect(node.inputs).not.toHaveProperty('lowvram');
    }
    expect(copy.unet.inputs.unet_name).toBe(INT8_UNET);
  });
});

describe('applyHardwareProfile aspect ratio', () => {
  test('writes megapixels and aspect ratio only into the ResolutionSelector copy', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);

    const copy = hardware.applyHardwareProfile(
      graph,
      makeProfile({ megapixels: 1, aspectRatio: '9:16 (Portrait Widescreen)' }),
      true,
      makeInt8ModelDirectory(),
    );

    expect(copy).not.toBe(graph);
    expect(copy.resolution.inputs).toMatchObject({
      megapixels: 1,
      aspect_ratio: '9:16 (Portrait Widescreen)',
      multiple: 32,
    });
    expect(copy.sampler.inputs).not.toHaveProperty('aspect_ratio');
    expect(copy.unrelated.inputs.nested).toEqual({ value: 1 });
    expect(graph).toEqual(original);
  });

  test('keeps the frozen aspect ratio when the profile has none', () => {
    const graph = makeGraph();
    const original = structuredClone(graph);

    const copy = hardware.applyHardwareProfile(
      graph,
      makeProfile(),
      true,
      makeInt8ModelDirectory(),
    );

    expect(copy.resolution.inputs.aspect_ratio).toBe('16:9 (Widescreen)');
    expect(graph).toEqual(original);
  });

  test.each(['', '   '])('ignores an empty aspect ratio value %j', (aspectRatio) => {
    const graph = makeGraph();

    const copy = hardware.applyHardwareProfile(
      graph,
      makeProfile({ aspectRatio }),
      true,
      makeInt8ModelDirectory(),
    );

    expect(copy.resolution.inputs.aspect_ratio).toBe('16:9 (Widescreen)');
  });

  test('keeps the UNET selection unchanged when an aspect ratio is set', () => {
    const modelDirectory = makeModelDirectory();
    writeFileSync(join(modelDirectory, INT8_UNET), 'int8');
    writeFileSync(join(modelDirectory, BF16_UNET), 'bf16');

    const copy = hardware.applyHardwareProfile(
      makeGraph(),
      makeProfile({ modelPolicy: 'bf16-if-present', aspectRatio: '1:1 (Square)' }),
      true,
      modelDirectory,
    );

    expect(copy.unet.inputs.unet_name).toBe(BF16_UNET);
    expect(copy.resolution.inputs.aspect_ratio).toBe('1:1 (Square)');
  });
});

describe('getComfyLaunchArgs', () => {
  test('returns an explicit low-VRAM process argument only when recommended', () => {
    expect(hardware.getComfyLaunchArgs(makeProfile({ lowvram: true }))).toEqual([
      '--lowvram',
    ]);
    expect(hardware.getComfyLaunchArgs(makeProfile({ lowvram: false }))).toEqual([]);
  });
});

describe('selectUnetModel', () => {
  test('uses the exact INT8 file for the INT8 policy', () => {
    const modelDirectory = makeModelDirectory();
    writeFileSync(join(modelDirectory, INT8_UNET), 'int8');
    writeFileSync(join(modelDirectory, BF16_UNET), 'bf16');

    expect(hardware.selectUnetModel('int8', modelDirectory)).toBe(INT8_UNET);
  });

  test('falls back from missing BF16 to an existing INT8 file', () => {
    const modelDirectory = makeModelDirectory();
    writeFileSync(join(modelDirectory, INT8_UNET), 'int8');

    expect(hardware.selectUnetModel('bf16-if-present', modelDirectory)).toBe(INT8_UNET);
  });

  test('does not treat a directory named like BF16 as a model file', () => {
    const modelDirectory = makeModelDirectory();
    mkdirSync(join(modelDirectory, BF16_UNET));
    writeFileSync(join(modelDirectory, INT8_UNET), 'int8');

    expect(hardware.selectUnetModel('bf16-if-present', modelDirectory)).toBe(INT8_UNET);
  });

  test('reports both required filenames when every candidate model is missing', () => {
    const modelDirectory = makeModelDirectory();
    const select = () => hardware.selectUnetModel('bf16-if-present', modelDirectory);

    expect(select).toThrow(/missing/i);
    expect(select).toThrow(BF16_UNET);
    expect(select).toThrow(INT8_UNET);
  });
});

describe('detectHardware', () => {
  test('parses GPU, Windows, memory, driver, CUDA, and target-drive disk data', async () => {
    const calls: CommandRequest[] = [];
    const runner = async (request: CommandRequest): Promise<string> => {
      calls.push(request);
      return request.command === 'nvidia-smi' ? GPU_OUTPUT : SYSTEM_OUTPUT;
    };

    const targetDirectory = "G:\\output $notACommand";
    const info = await hardware.detectHardware(runner, targetDirectory);

    expect(info).toEqual({
      windowsVersion: 'Microsoft Windows 10 专业版 10.0.19045',
      gpu: 'NVIDIA GeForce RTX 5080',
      vramGiB: 16,
      ramGiB: 64,
      driverVersion: '576.88',
      cudaComputeCapability: '12.0',
      freeDiskGiB: 512,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      command: 'nvidia-smi',
      args: [
        '--query-gpu=name,memory.total,driver_version,compute_cap',
        '--format=csv,noheader',
      ],
      timeoutMs: 5000,
    });
    expect(calls[1].command).toBe('powershell.exe');
    expect(calls[1].args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    expect(calls[1].args).toHaveLength(5);
    expect(
      Buffer.from(calls[1].args[4], 'base64').toString('utf8'),
    ).toBe(JSON.stringify(targetDirectory));
    expect(calls[1].args[3]).not.toContain(targetDirectory);
    expect(calls[1].args[3]).toContain(
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
    );
    expect(calls[1].args[3]).toContain("ConvertFrom-Json");
    expect(calls[1].args[3]).toContain('FromBase64String');
    expect(calls[1].args[3]).toContain("ErrorActionPreference = 'Stop'");
    expect(calls[1].args[3]).toContain('Get-CimInstance Win32_OperatingSystem');
    expect(calls[1].args[3]).toContain('Get-CimInstance Win32_ComputerSystem');
    expect(calls[1].args[3]).toContain(
      '$targetDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetDirectoryBase64)) | ConvertFrom-Json;',
    );
    expect(calls[1].args[3]).toContain('Get-PSDrive -Name $driveName');
    expect(calls[1].args[3]).toContain('ConvertTo-Json -Compress');
    expect(calls[1].timeoutMs).toBe(5000);
  });

  test('reports a clear GPU process failure', async () => {
    const runner = async (): Promise<string> => {
      throw new Error('nvidia-smi is unavailable');
    };

    await expect(hardware.detectHardware(runner)).rejects.toThrow(
      'GPU detection failed: nvidia-smi is unavailable',
    );
  });

  test('reports a clear Windows hardware process failure', async () => {
    const runner = async (request: CommandRequest): Promise<string> => {
      if (request.command === 'nvidia-smi') return GPU_OUTPUT;
      throw new Error('access denied');
    };

    await expect(hardware.detectHardware(runner)).rejects.toThrow(
      'Windows hardware detection failed: access denied',
    );
  });

  test('distinguishes a process timeout from other failures', async () => {
    const runner = async (): Promise<string> => {
      throw Object.assign(new Error('process killed'), { code: 'ETIMEDOUT' });
    };

    await expect(hardware.detectHardware(runner)).rejects.toThrow(
      'GPU detection timed out after 5000 ms',
    );
  });

  test('rejects malformed GPU output instead of returning partial information', async () => {
    const runner = async (): Promise<string> => 'not-a-gpu-row\n';

    await expect(hardware.detectHardware(runner)).rejects.toThrow(
      /parse GPU detection output/i,
    );
  });

  test('rejects incomplete Windows hardware output', async () => {
    const runner = async (request: CommandRequest): Promise<string> => {
      return request.command === 'nvidia-smi'
        ? GPU_OUTPUT
        : JSON.stringify({ WindowsVersion: 'Windows 11' });
    };

    await expect(hardware.detectHardware(runner)).rejects.toThrow(
      /parse Windows hardware detection output/i,
    );
  });

  test.skipIf(process.platform !== 'win32')(
    'reads a non-zero free disk space on Windows',
    async () => {
      const info = await hardware.detectHardware(undefined, process.cwd());

      expect(info.freeDiskGiB).toBeGreaterThan(0);
    },
  );
});
