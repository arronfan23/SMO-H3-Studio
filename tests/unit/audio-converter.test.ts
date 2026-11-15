// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import {
  convertAudio,
  type AudioConversionFormat,
  type AudioConvertInput,
  type AudioExecutor,
} from '../../src/main/audio-converter';

const sourcePath = 'G:\\audio input\\voice & take.webm';
const destinationPath = 'D:\\audio output\\voice & take.wav';

function input(
  format: AudioConversionFormat,
  signal?: AbortSignal,
): AudioConvertInput {
  return {
    ffmpegPath: 'G:\\runtime\\tools\\ffmpeg\\ffmpeg.exe',
    sourcePath,
    destinationPath,
    format,
    ...(signal === undefined ? {} : { signal }),
  };
}

describe('audio converter recording', () => {
  test.each([
    {
      format: 'wav' as const,
      codecArgs: ['-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le'],
    },
    { format: 'mp3' as const, codecArgs: ['-c:a', 'libmp3lame'] },
    { format: 'flac' as const, codecArgs: ['-c:a', 'flac'] },
    { format: 'm4a' as const, codecArgs: ['-c:a', 'aac'] },
  ])(
    'uses execFile arguments for $format without a shell',
    async ({ format, codecArgs }) => {
      const execute = vi.fn<AudioExecutor>().mockResolvedValue({
        stdout: '',
        stderr: '',
      });
      const signal = new AbortController().signal;

      await convertAudio(input(format, signal), {
        execute,
        timeoutMs: 12_345,
      });

      expect(execute).toHaveBeenCalledWith(
        'G:\\runtime\\tools\\ffmpeg\\ffmpeg.exe',
        ['-nostdin', '-y', '-i', sourcePath, ...codecArgs, destinationPath],
        { timeout: 12_345, windowsHide: true, signal },
      );
      const options = execute.mock.calls[0]?.[2];
      expect(options).not.toHaveProperty('shell');
    },
  );

  test('does not start FFmpeg when the recording signal is already aborted', async () => {
    const execute = vi.fn<AudioExecutor>();
    const controller = new AbortController();
    controller.abort(new Error('recording cancelled'));

    await expect(
      convertAudio(input('wav', controller.signal), { execute }),
    ).rejects.toThrow('recording cancelled');
    expect(execute).not.toHaveBeenCalled();
  });

  test('surfaces FFmpeg execution errors', async () => {
    const execute = vi
      .fn<AudioExecutor>()
      .mockRejectedValue(new Error('process exited with code 1'));

    await expect(convertAudio(input('wav'), { execute })).rejects.toThrow(
      /FFmpeg conversion failed.*process exited with code 1/i,
    );
  });
});
