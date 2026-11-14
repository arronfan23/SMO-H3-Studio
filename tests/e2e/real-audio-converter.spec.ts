import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { convertAudio } from '../../src/main/audio-converter';
import { EnvironmentStore } from '../../src/main/environment-store';

const execFileAsync = promisify(execFile);
const EXECUTION_TIMEOUT_MS = 30_000;
const expectedCodecs = {
  wav: 'pcm_s16le',
  mp3: 'mp3',
  flac: 'flac',
  m4a: 'aac',
} as const;

async function resolveRuntimeTools(): Promise<{
  ffmpegPath: string;
  ffprobePath: string;
}> {
  if (process.env.SMO_FFMPEG_PATH) {
    return {
      ffmpegPath: process.env.SMO_FFMPEG_PATH,
      ffprobePath:
        process.env.SMO_FFPROBE_PATH ??
        process.env.SMO_FFMPEG_PATH.replace(/ffmpeg\.exe$/i, 'ffprobe.exe'),
    };
  }
  const dataDirectory = process.env.SMO_DATA_DIRECTORY ?? 'G:\\SMO-H3-Data';
  const config = await new EnvironmentStore(
    join(dataDirectory, 'environment.json'),
  )
    .load()
    .catch(() => null);
  const runtimeRoot =
    config?.runtimeRoot ??
    'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130';
  return {
    ffmpegPath: join(runtimeRoot, 'tools', 'ffmpeg', 'ffmpeg.exe'),
    ffprobePath: join(runtimeRoot, 'tools', 'ffmpeg', 'ffprobe.exe'),
  };
}

test.describe('real FFmpeg audio converter', () => {
  test.skip(
    process.env.SMO_REAL_FFMPEG !== '1',
    'Set SMO_REAL_FFMPEG=1 to run real audio conversion.',
  );

  test('converts one second of audio to WAV, MP3, FLAC, and M4A', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-real-audio-converter-'));
    const { ffmpegPath, ffprobePath } = await resolveRuntimeTools();
    const sourcePath = join(directory, 'source.wav');
    const results: unknown[] = [];

    try {
      await execFileAsync(
        ffmpegPath,
        [
          '-nostdin',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1:sample_rate=24000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          sourcePath,
        ],
        { timeout: EXECUTION_TIMEOUT_MS, windowsHide: true },
      );

      for (const format of ['wav', 'mp3', 'flac', 'm4a'] as const) {
        const destinationPath = join(directory, `output.${format}`);
        await convertAudio({ ffmpegPath, sourcePath, destinationPath, format });
        const { stdout } = await execFileAsync(
          ffprobePath,
          [
            '-v',
            'error',
            '-show_entries',
            'format=format_name,duration:stream=codec_name,sample_rate,channels',
            '-of',
            'json',
            destinationPath,
          ],
          { timeout: EXECUTION_TIMEOUT_MS, windowsHide: true },
        );
        const probe = JSON.parse(stdout) as {
          streams: Array<{ codec_name: string; sample_rate: string; channels: number }>;
          format: { format_name: string; duration: string };
        };
        const stream = probe.streams[0];
        const duration = Number(probe.format.duration);

        expect(stream.codec_name).toBe(expectedCodecs[format]);
        expect(stream.sample_rate).toBe('24000');
        expect(stream.channels).toBe(1);
        expect(duration).toBeGreaterThan(0);
        expect(probe.format.format_name.split(',')).toContain(format);
        results.push({
          format,
          codec: stream.codec_name,
          sampleRate: stream.sample_rate,
          channels: stream.channels,
          duration,
        });
      }
      console.log('Real audio conversion results:', JSON.stringify(results));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
