// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createFfprobeDurationReader,
  DEFAULT_FFPROBE_PATH,
} from '../../src/main/audio-duration';

describe('ffprobe audio duration reader', () => {
  afterEach(() => {
    delete process.env.SMO_FFPROBE_PATH;
    delete process.env.SMO_FFMPEG_PATH;
  });

  test('points at the actual H3 tools directory', () => {
    expect(DEFAULT_FFPROBE_PATH).toBe(
      'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\tools\\ffmpeg\\ffprobe.exe',
    );
  });

  test('uses the fixed H3 executable, arguments, and timeout', async () => {
    const execute = vi.fn(async () => ({ stdout: '12.5\n' }));
    const reader = createFfprobeDurationReader({ execute });
    const audioPath = 'G:\\audio files\\voice.mp3';

    await expect(reader(audioPath)).resolves.toBe(12.5);

    expect(execute).toHaveBeenCalledWith(
      DEFAULT_FFPROBE_PATH,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ],
      { timeout: 10_000, windowsHide: true },
    );
  });

  test('rejects an invalid ffprobe duration response', async () => {
    const reader = createFfprobeDurationReader({
      execute: async () => ({ stdout: 'N/A\n' }),
    });

    await expect(reader('voice.mp3')).rejects.toThrow(/invalid audio duration/i);
  });

  test('reports execution and timeout failures', async () => {
    const reader = createFfprobeDurationReader({
      execute: async () => {
        throw new Error('process timed out');
      },
    });

    await expect(reader('voice.mp3')).rejects.toThrow(/ffprobe.*timed out/i);
  });

  test('uses SMO_FFPROBE_PATH env when no explicit ffprobePath option', async () => {
    process.env.SMO_FFPROBE_PATH = 'C:\\custom\\ffprobe.exe';
    const execute = vi.fn(async () => ({ stdout: '5\n' }));
    const reader = createFfprobeDurationReader({ execute });

    await reader('voice.mp3');

    expect(execute).toHaveBeenCalledWith(
      'C:\\custom\\ffprobe.exe',
      expect.any(Array),
      expect.any(Object),
    );
  });

  test('derives ffprobe path from SMO_FFMPEG_PATH env', async () => {
    process.env.SMO_FFMPEG_PATH = 'C:\\tools\\ffmpeg.exe';
    const execute = vi.fn(async () => ({ stdout: '7\n' }));
    const reader = createFfprobeDurationReader({ execute });

    await reader('voice.mp3');

    expect(execute).toHaveBeenCalledWith(
      'C:\\tools\\ffprobe.exe',
      expect.any(Array),
      expect.any(Object),
    );
  });

  test('explicit ffprobePath option takes precedence over env', async () => {
    process.env.SMO_FFPROBE_PATH = 'C:\\env\\ffprobe.exe';
    const execute = vi.fn(async () => ({ stdout: '9\n' }));
    const reader = createFfprobeDurationReader({ execute, ffprobePath: 'C:\\opt\\ffprobe.exe' });

    await reader('voice.mp3');

    expect(execute).toHaveBeenCalledWith(
      'C:\\opt\\ffprobe.exe',
      expect.any(Array),
      expect.any(Object),
    );
  });
});
