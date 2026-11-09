// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import defaultManifest from '../../resources/environment/media-components.json';
import {
  SpeechRuntime,
  type SpeechExecFile,
} from '../../src/main/speech-runtime';
import type { MediaComponentManifest } from '../../src/shared/media-components';

const UV_SOURCE = 'astral-sh/uv';
const UV_VERSION = '0.11.13';
const UV_REVISION = '4512a39319dbd9ad96e0b0a22223eb263dbf5d16';
const UV_PATH = `runtime/uv-${UV_VERSION}-x86_64-pc-windows-msvc.zip`;

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('SpeechRuntime', () => {
  let directory: string;
  let modelDirectory: string;
  let runtimeDirectory: string;
  let projectDirectory: string;
  let archive: Buffer;
  let manifest: MediaComponentManifest;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-speech-runtime-'));
    modelDirectory = join(directory, 'models');
    runtimeDirectory = join(directory, 'speech runtime & isolated');
    projectDirectory = join(directory, 'speech project');
    archive = Buffer.from('fake uv zip fixture');
    const archivePath = join(modelDirectory, ...UV_PATH.split('/'));
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, archive);
    await mkdir(projectDirectory, { recursive: true });
    manifest = {
      version: 1,
      components: {
        speech: {
          id: 'speech',
          revisions: { [UV_SOURCE]: UV_REVISION },
          files: [
            {
              url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
              path: UV_PATH,
              size: archive.length,
              sha256: sha256(archive),
              source: UV_SOURCE,
            },
          ],
          totalBytes: archive.length,
        },
      },
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createRuntime(
    harness: { invalidInitialVersion?: 'mismatch' | 'error' } = {},
  ) {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }> = [];
    let versionChecks = 0;
    const execFile: SpeechExecFile = vi.fn(async (command, args, options) => {
      calls.push({ command, args, options: { ...options } });
      if (command === 'tar') {
        const outputDirectory = args[args.indexOf('-C') + 1];
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, 'uv.exe'), 'uv fixture');
      }
      if (command.endsWith('uv.exe') && args.length === 1 && args[0] === '--version') {
        versionChecks += 1;
        if (versionChecks === 1 && harness.invalidInitialVersion === 'error') {
          throw new Error('injected broken uv executable');
        }
        if (versionChecks === 1 && harness.invalidInitialVersion === 'mismatch') {
          return { stdout: 'uv 0.0.1 (broken)', stderr: '' };
        }
        return {
          stdout: `uv ${UV_VERSION} (${UV_REVISION.slice(0, 9)} x86_64-pc-windows-msvc)`,
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const runtime = new SpeechRuntime({
      modelDirectory,
      runtimeDirectory,
      projectDirectory,
      manifest,
      execFile,
    });
    return { runtime, execFile, calls, versionChecks: () => versionChecks };
  }

  test('verifies uv and runs Python 3.12, venv, and locked sync without a shell', async () => {
    const { runtime, calls } = createRuntime();

    const result = await runtime.prepare();

    const venvDirectory = join(runtimeDirectory, 'venv');
    const uvCalls = calls.filter(({ command }) => command.endsWith('uv.exe'));
    expect(uvCalls).toHaveLength(4);
    expect(uvCalls[0]?.args).toEqual(['--version']);
    expect(uvCalls[1]?.args).toEqual(['python', 'install', '3.12']);
    expect(uvCalls[2]?.args).toEqual([
      'venv',
      '--python',
      '3.12',
      venvDirectory,
    ]);
    expect(uvCalls[3]?.args).toEqual([
      'sync',
      '--locked',
      '--project',
      projectDirectory,
    ]);
    for (const call of calls) {
      expect(call.options).toMatchObject({ shell: false, windowsHide: true });
    }
    expect(uvCalls[3]?.options.env).toMatchObject({
      UV_PROJECT_ENVIRONMENT: venvDirectory,
      UV_PYTHON_INSTALL_DIR: join(runtimeDirectory, 'python'),
    });
    expect(result).toEqual({
      pythonPath: join(venvDirectory, 'Scripts', 'python.exe'),
      environment: expect.objectContaining({
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        UV_PROJECT_ENVIRONMENT: venvDirectory,
      }),
    });
    expect(result.environment.PYTHONHOME).toBeUndefined();
  });

  test('rejects a modified uv archive before executing any command', async () => {
    await writeFile(join(modelDirectory, ...UV_PATH.split('/')), 'tampered');
    const { runtime, execFile } = createRuntime();

    await expect(runtime.prepare()).rejects.toThrow(/sha256|size|hash/i);

    expect(execFile).not.toHaveBeenCalled();
  });

  test.each(['mismatch', 'error'] as const)(
    're-extracts and repairs an existing uv after a version %s',
    async (invalidInitialVersion) => {
      const toolDirectory = join(runtimeDirectory, 'tools', `uv-${UV_VERSION}`);
      const uvPath = join(toolDirectory, 'uv.exe');
      await mkdir(toolDirectory, { recursive: true });
      await writeFile(uvPath, 'broken uv fixture');
      const { runtime, calls, versionChecks } = createRuntime({
        invalidInitialVersion,
      });

      await runtime.prepare();

      expect(versionChecks()).toBe(2);
      expect(calls.filter(({ command }) => command === 'tar')).toHaveLength(1);
      expect(await readFile(uvPath, 'utf8')).toBe('uv fixture');
      const uvCalls = calls.filter(({ command }) => command.endsWith('uv.exe'));
      expect(uvCalls[0]?.args).toEqual(['--version']);
      expect(uvCalls[1]?.args).toEqual(['--version']);
      expect(uvCalls[2]?.args).toEqual(['python', 'install', '3.12']);
    },
  );

  test('pins the official Windows x64 uv release commit, version, and SHA256', () => {
    const speech = defaultManifest.components.speech;
    const uv = speech?.files.find((file) => file.source === UV_SOURCE);

    expect(speech?.revisions[UV_SOURCE]).toBe(UV_REVISION);
    expect(uv).toMatchObject({
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
      path: UV_PATH,
      size: 23_354_520,
      sha256: '0953ac2ef4fbe47ad469bfa80b658a577a02c4d73a2fb9c4c7c70dda432efded',
      source: UV_SOURCE,
    });
  });
});
