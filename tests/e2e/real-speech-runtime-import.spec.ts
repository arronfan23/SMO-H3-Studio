import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_SPEECH_PYTHON =
  'G:\\SMO-H3-Data\\components\\speech\\runtime\\venv\\Scripts\\python.exe';
const pythonPath = resolve(process.env.SMO_SPEECH_PYTHON ?? DEFAULT_SPEECH_PYTHON);
const venvDirectory = dirname(dirname(pythonPath));
const runtimeAvailable =
  existsSync(pythonPath) && existsSync(join(venvDirectory, 'pyvenv.cfg'));

test.describe('real installed speech runtime interpreter', () => {
  test.skip(
    !runtimeAvailable,
    'Requires an existing speech venv with pyvenv.cfg; set SMO_SPEECH_PYTHON to its Scripts/python.exe.',
  );
  test.setTimeout(120_000);

  test('imports qwen_tts using python -I', async () => {
    await expect(
      execFileAsync(pythonPath, ['-I', '-c', 'import qwen_tts'], {
        cwd: venvDirectory,
        env: {
          ...process.env,
          HF_HUB_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
        shell: false,
        windowsHide: true,
      }),
    ).resolves.toMatchObject({
      stdout: expect.any(String),
      stderr: expect.any(String),
    });
    console.log(`Real interpreter import passed: ${pythonPath} -I -c "import qwen_tts"`);
  });
});
