// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { applyHardwareProfile } from '../../src/main/hardware';
import {
  applyHardwareWorkflow,
  getActiveWorkflow,
  resetHardwareWorkflow,
} from '../../src/main/hardware-workflows';
import type { HardwareProfile, VideoMode } from '../../src/shared/types';

const INT8_UNET = 'minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors';
const WORKFLOW_FILENAMES: Record<VideoMode, string> = {
  text: 'text-ref2va.json',
  audio: 'audio-digital-human.json',
};
const workflowsDirectory = fileURLToPath(
  new URL('../../resources/workflows/', import.meta.url),
);
const temporaryDirectories: string[] = [];

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    preset: 'balanced-16gb',
    modelPolicy: 'int8',
    megapixels: 0.7,
    lowvram: true,
    tiling: 'auto',
    requiresConfirmation: true,
    ...overrides,
  };
}

async function makeHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'smo-h3-hardware-workflows-'));
  temporaryDirectories.push(directory);
  const modelDirectory = join(directory, 'models');
  const profilesDirectory = join(directory, 'workflow-profiles');
  await Promise.all([
    mkdir(modelDirectory, { recursive: true }),
    mkdir(profilesDirectory, { recursive: true }),
  ]);
  await writeFile(join(modelDirectory, INT8_UNET), 'int8');

  return {
    directory,
    modelDirectory,
    profilesDirectory,
    options: { profilesDirectory },
  };
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

afterEach(async () => {
  resetHardwareWorkflow('text');
  resetHardwareWorkflow('audio');
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('hardware workflow copies', () => {
  test.each([
    '../evil',
    '..\\evil',
    'nested/evil',
    'nested\\evil',
    '',
    null,
    undefined,
  ])('rejects an invalid hardware preset: %s', async (preset) => {
    const harness = await makeHarness();
    const activeBefore = getActiveWorkflow('text');

    await expect(
      applyHardwareWorkflow(
        {
          mode: 'text',
          profile: makeProfile({
            preset: preset as HardwareProfile['preset'],
          }),
          confirmed: true,
          modelDirectory: harness.modelDirectory,
        },
        harness.options,
      ),
    ).rejects.toThrow(/invalid hardware preset/i);

    expect(getActiveWorkflow('text')).toBe(activeBefore);
    expect(await readdir(harness.profilesDirectory)).toEqual([]);
  });

  test('rejects an empty modelDirectory', async () => {
    const harness = await makeHarness();
    const activeBefore = getActiveWorkflow('text');

    await expect(
      applyHardwareWorkflow(
        {
          mode: 'text',
          profile: makeProfile(),
          confirmed: true,
          modelDirectory: '',
        },
        harness.options,
      ),
    ).rejects.toThrow(/modelDirectory must not be empty/i);

    expect(getActiveWorkflow('text')).toBe(activeBefore);
    expect(await readdir(harness.profilesDirectory)).toEqual([]);
  });

  test('rejects an unconfirmed replacement without changing files or active state', async () => {
    const harness = await makeHarness();
    const applied = await applyHardwareWorkflow(
      {
        mode: 'text',
        profile: makeProfile(),
        confirmed: true,
        modelDirectory: harness.modelDirectory,
      },
      harness.options,
    );
    const filesBefore = await readdir(harness.profilesDirectory);

    await expect(
      applyHardwareWorkflow(
        {
          mode: 'text',
          profile: makeProfile({ preset: 'conservative' }),
          confirmed: false,
          modelDirectory: harness.modelDirectory,
        },
        harness.options,
      ),
    ).rejects.toThrow(/confirmation/i);

    expect(getActiveWorkflow('text')).toBe(applied.path);
    expect(await readdir(harness.profilesDirectory)).toEqual(filesBefore);
  });

  test.each(['text', 'audio'] as const)(
    'activates a verified %s workflow copy while preserving the frozen graph',
    async (mode) => {
      const harness = await makeHarness();
      const sourcePath = join(workflowsDirectory, WORKFLOW_FILENAMES[mode]);
      const frozenSource = await readFile(sourcePath, 'utf8');
      const frozenHash = await hashFile(sourcePath);
      const profile = makeProfile({
        preset: 'conservative',
        megapixels: 0.4,
        tiling: 4,
      });

      const result = await applyHardwareWorkflow(
        {
          mode,
          profile,
          confirmed: true,
          modelDirectory: harness.modelDirectory,
        },
        harness.options,
      );

      const expectedPath = join(
        harness.profilesDirectory,
        `${profile.preset}-${mode}.json`,
      );
      expect(result).toEqual({ path: expectedPath, profile });
      expect(result.path).not.toBe(sourcePath);
      expect(getActiveWorkflow(mode)).toBe(expectedPath);
      expect(
        JSON.parse(
          await readFile(join(harness.profilesDirectory, "active-workflows.json"), "utf8"),
        ),
      ).toEqual({ [mode]: expectedPath });
      const expectedCopy = applyHardwareProfile(
        JSON.parse(frozenSource),
        profile,
        true,
        harness.modelDirectory,
      );
      expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual(expectedCopy);
      expect(await hashFile(sourcePath)).toBe(frozenHash);
    },
  );

  test('reset restores the frozen default for only the selected mode', async () => {
    const harness = await makeHarness();
    const textCopy = await applyHardwareWorkflow(
      {
        mode: 'text',
        profile: makeProfile(),
        confirmed: true,
        modelDirectory: harness.modelDirectory,
      },
      harness.options,
    );
    const audioCopy = await applyHardwareWorkflow(
      {
        mode: 'audio',
        profile: makeProfile(),
        confirmed: true,
        modelDirectory: harness.modelDirectory,
      },
      harness.options,
    );

    const defaultPath = resetHardwareWorkflow('text');

    expect(defaultPath).toBe(join(workflowsDirectory, WORKFLOW_FILENAMES.text));
    expect(getActiveWorkflow('text')).toBe(defaultPath);
    expect(getActiveWorkflow('audio')).toBe(audioCopy.path);
    await expect(readFile(textCopy.path, 'utf8')).resolves.toBeTruthy();
  });

  test('missing models preserve the previous active workflow and leave no partial files', async () => {
    const harness = await makeHarness();
    const applied = await applyHardwareWorkflow(
      {
        mode: 'text',
        profile: makeProfile(),
        confirmed: true,
        modelDirectory: harness.modelDirectory,
      },
      harness.options,
    );
    const emptyModelDirectory = join(harness.directory, 'empty-models');
    await mkdir(emptyModelDirectory);
    const filesBefore = await readdir(harness.profilesDirectory);

    await expect(
      applyHardwareWorkflow(
        {
          mode: 'text',
          profile: makeProfile({
            preset: 'high-memory-candidate',
            modelPolicy: 'bf16-if-present',
          }),
          confirmed: true,
          modelDirectory: emptyModelDirectory,
        },
        harness.options,
      ),
    ).rejects.toThrow(/missing/i);

    expect(getActiveWorkflow('text')).toBe(applied.path);
    const filesAfter = await readdir(harness.profilesDirectory);
    expect(filesAfter).toEqual(filesBefore);
    expect(filesAfter.filter((path) => path.endsWith('.tmp'))).toEqual([]);
  });

  test('reapplying the same preset overwrites the previous copy idempotently', async () => {
    const harness = await makeHarness();
    const first = await applyHardwareWorkflow(
      {
        mode: 'text',
        profile: makeProfile({ preset: 'conservative' }),
        confirmed: true,
        modelDirectory: harness.modelDirectory,
      },
      harness.options,
    );

    const second = await applyHardwareWorkflow(
      {
        mode: 'text',
        profile: makeProfile({ preset: 'conservative', megapixels: 0.4 }),
        confirmed: true,
        modelDirectory: harness.modelDirectory,
      },
      harness.options,
    );

    expect(second.path).toBe(first.path);
    expect(getActiveWorkflow('text')).toBe(second.path);
    expect(await readdir(harness.profilesDirectory)).toEqual([
      'active-workflows.json',
      'conservative-text.json',
    ]);
    const copy = JSON.parse(await readFile(second.path, 'utf8'));
    expect(copy).toEqual(
      applyHardwareProfile(
        JSON.parse(
          await readFile(join(workflowsDirectory, WORKFLOW_FILENAMES.text), 'utf8'),
        ),
        makeProfile({ preset: 'conservative', megapixels: 0.4 }),
        true,
        harness.modelDirectory,
      ),
    );
  });

  test("serializes same-mode applies so active state and persistence match the last call", async () => {
    const harness = await makeHarness();
    const firstProfile = makeProfile({ preset: "conservative", megapixels: 0.4 });
    const secondProfile = makeProfile({ preset: "balanced-16gb", megapixels: 0.7 });

    const [, second] = await Promise.all([
      applyHardwareWorkflow(
        {
          mode: "text",
          profile: firstProfile,
          confirmed: true,
          modelDirectory: harness.modelDirectory,
        },
        harness.options,
      ),
      applyHardwareWorkflow(
        {
          mode: "text",
          profile: secondProfile,
          confirmed: true,
          modelDirectory: harness.modelDirectory,
        },
        harness.options,
      ),
    ]);

    expect(getActiveWorkflow("text")).toBe(second.path);
    expect(
      JSON.parse(
        await readFile(join(harness.profilesDirectory, "active-workflows.json"), "utf8"),
      ),
    ).toEqual({ text: second.path });
    expect(JSON.parse(await readFile(second.path, "utf8"))["115"].inputs.megapixels).toBe(0.7);
  });

  test('uses a custom profilesDirectory when provided', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'smo-h3-hardware-workflows-custom-'),
    );
    temporaryDirectories.push(directory);
    const modelDirectory = join(directory, 'models');
    const customProfilesDirectory = join(directory, 'custom-profiles');
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, INT8_UNET), 'int8');

    const result = await applyHardwareWorkflow(
      {
        mode: 'text',
        profile: makeProfile({ preset: 'high-memory-candidate' }),
        confirmed: true,
        modelDirectory,
      },
      { profilesDirectory: customProfilesDirectory },
    );

    expect(result.path).toBe(
      join(customProfilesDirectory, 'high-memory-candidate-text.json'),
    );
    expect(getActiveWorkflow('text')).toBe(result.path);
    expect(await readdir(customProfilesDirectory)).toEqual([
      'active-workflows.json',
      'high-memory-candidate-text.json',
    ]);
  });
});
