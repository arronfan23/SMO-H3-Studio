import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const DEFAULT_FFPROBE_PATH =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\ComfyUI\\tools\\ffmpeg\\ffprobe.exe';

function resolveFfprobePath(): string {
  const envPath = process.env.SMO_FFPROBE_PATH;
  if (envPath && envPath.length > 0) {
    return envPath;
  }
  const ffmpegPath = process.env.SMO_FFMPEG_PATH;
  if (ffmpegPath && ffmpegPath.length > 0) {
    const ffprobePath = ffmpegPath.replace(/ffmpeg\.exe$/i, 'ffprobe.exe');
    if (ffprobePath !== ffmpegPath) {
      return ffprobePath;
    }
  }
  return DEFAULT_FFPROBE_PATH;
}

const FFPROBE_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

export type AudioDurationReader = (filePath: string) => Promise<number>;

export interface FfprobeExecutor {
  (
    filePath: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean },
  ): Promise<{ stdout: string }>;
}

export interface FfprobeDurationReaderOptions {
  ffprobePath?: string;
  timeoutMs?: number;
  execute?: FfprobeExecutor;
}

const defaultExecute: FfprobeExecutor = async (filePath, args, options) =>
  execFileAsync(filePath, args, options) as Promise<{ stdout: string }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFfprobeDurationReader(
  options: FfprobeDurationReaderOptions = {},
): AudioDurationReader {
  const execute = options.execute ?? defaultExecute;
  const ffprobePath = options.ffprobePath ?? resolveFfprobePath();
  const timeout = options.timeoutMs ?? FFPROBE_TIMEOUT_MS;

  return async (filePath) => {
    let stdout: string;
    try {
      const result = await execute(
        ffprobePath,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          filePath,
        ],
        { timeout, windowsHide: true },
      );
      stdout = result.stdout;
    } catch (error) {
      throw new Error(`ffprobe could not read audio duration: ${errorMessage(error)}`);
    }

    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('ffprobe returned invalid audio duration');
    }
    return duration;
  };
}
