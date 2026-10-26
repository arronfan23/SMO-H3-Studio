// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import {
  createFfprobeDurationReader,
  DEFAULT_FFPROBE_PATH,
} from '../../src/main/audio-duration';

describe('ffprobe audio duration reader', () => {
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
});
