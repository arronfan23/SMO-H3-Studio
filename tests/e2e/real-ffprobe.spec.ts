import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createFfprobeDurationReader } from '../../src/main/audio-duration';

const REAL_RUN_ENABLED = process.env.SMO_REAL_H3 === '1';
const FFMPEG_PATH =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\tools\\ffmpeg\\ffmpeg.exe';
const EXECUTION_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

test.describe('real bundled ffprobe', () => {
  test.skip(!REAL_RUN_ENABLED, 'Set SMO_REAL_H3=1 to run the real ffprobe suite.');

  test('reads the duration of a generated WAV without path overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'smo-real-ffprobe-'));
    const audioPath = join(root, 'two-second-tone.wav');
    const previousFfprobePath = process.env.SMO_FFPROBE_PATH;
    const previousFfmpegPath = process.env.SMO_FFMPEG_PATH;

    try {
      await execFileAsync(
        FFMPEG_PATH,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=1000:duration=2',
          '-c:a',
          'pcm_s16le',
          audioPath,
        ],
        { timeout: EXECUTION_TIMEOUT_MS, windowsHide: true },
      );

      delete process.env.SMO_FFPROBE_PATH;
      delete process.env.SMO_FFMPEG_PATH;
      const reader = createFfprobeDurationReader();
      await expect(reader(audioPath)).resolves.toBeCloseTo(2, 1);
    } finally {
      if (previousFfprobePath === undefined) {
        delete process.env.SMO_FFPROBE_PATH;
      } else {
        process.env.SMO_FFPROBE_PATH = previousFfprobePath;
      }
      if (previousFfmpegPath === undefined) {
        delete process.env.SMO_FFMPEG_PATH;
      } else {
        process.env.SMO_FFMPEG_PATH = previousFfmpegPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
