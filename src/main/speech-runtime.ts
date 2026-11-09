import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import defaultManifest from '../../resources/environment/media-components.json';
import type { MediaComponentManifest } from '../shared/media-components';

const UV_SOURCE = 'astral-sh/uv';
const UV_VERSION = '0.11.13';
const UV_REVISION = '4512a39319dbd9ad96e0b0a22223eb263dbf5d16';
const UV_ARCHIVE_PATH = `runtime/uv-${UV_VERSION}-x86_64-pc-windows-msvc.zip`;
const UV_DOWNLOAD_URL =
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/` +
  'uv-x86_64-pc-windows-msvc.zip';

export interface SpeechExecFileOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
}

export type SpeechExecFile = (
  command: string,
  args: readonly string[],
  options: SpeechExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface SpeechRuntimeOptions {
  modelDirectory: string;
  runtimeDirectory: string;
  projectDirectory: string;
  manifest?: MediaComponentManifest;
  execFile?: SpeechExecFile;
}

export interface PreparedSpeechRuntime {
  pythonPath: string;
  environment: Record<string, string>;
}

function defaultExecFile(
  command: string,
  args: readonly string[],
  options: SpeechExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { ...options, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class SpeechRuntime {
  private readonly execFile: SpeechExecFile;
  private preparePromise: Promise<PreparedSpeechRuntime> | null = null;

  constructor(private readonly options: SpeechRuntimeOptions) {
    this.execFile = options.execFile ?? defaultExecFile;
  }

  prepare(): Promise<PreparedSpeechRuntime> {
    this.preparePromise ??= this.runPrepare().catch((error: unknown) => {
      this.preparePromise = null;
      throw error;
    });
    return this.preparePromise;
  }

  private async hasExpectedUvVersion(
    uvPath: string,
    commandOptions: SpeechExecFileOptions,
  ): Promise<boolean> {
    try {
      const { stdout } = await this.execFile(uvPath, ['--version'], commandOptions);
      const match = /^uv\s+(\S+)/.exec(stdout.trim());
      return match?.[1] === UV_VERSION;
    } catch {
      return false;
    }
  }

  private async reinstallUv(
    archivePath: string,
    toolsRoot: string,
    toolDirectory: string,
    commandOptions: SpeechExecFileOptions,
  ): Promise<void> {
    await mkdir(toolsRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(toolsRoot, '.uv-'));
    try {
      await this.execFile('tar', ['-xf', archivePath, '-C', temporaryDirectory], {
        cwd: this.options.runtimeDirectory,
        env: commandOptions.env,
        shell: false,
        windowsHide: true,
      });
      const temporaryUvPath = join(temporaryDirectory, 'uv.exe');
      if (!(await fileExists(temporaryUvPath))) {
        throw new Error('The verified uv archive did not contain uv.exe');
      }
      if (!(await this.hasExpectedUvVersion(temporaryUvPath, commandOptions))) {
        throw new Error(`The extracted uv.exe does not report version ${UV_VERSION}`);
      }
      await rm(toolDirectory, { recursive: true, force: true });
      await rename(temporaryDirectory, toolDirectory);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async runPrepare(): Promise<PreparedSpeechRuntime> {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('The isolated speech runtime requires Windows x64');
    }
    const manifest = this.options.manifest ?? defaultManifest;
    const speech = manifest.components.speech;
    if (speech?.revisions[UV_SOURCE] !== UV_REVISION) {
      throw new Error('The speech manifest does not pin the expected uv release commit');
    }
    const asset = speech.files.find(
      (file) =>
        file.source === UV_SOURCE &&
        file.path === UV_ARCHIVE_PATH &&
        file.url === UV_DOWNLOAD_URL,
    );
    if (!asset) throw new Error('The speech manifest has no Windows x64 uv archive');

    const archivePath = join(this.options.modelDirectory, ...UV_ARCHIVE_PATH.split('/'));
    const archive = await readFile(archivePath);
    const actualSha256 = createHash('sha256').update(archive).digest('hex');
    if (archive.length !== asset.size || actualSha256 !== asset.sha256) {
      throw new Error('The uv archive size or SHA256 does not match the speech manifest');
    }

    const toolsRoot = join(this.options.runtimeDirectory, 'tools');
    const toolDirectory = join(toolsRoot, `uv-${UV_VERSION}`);
    const uvPath = join(toolDirectory, 'uv.exe');
    const venvDirectory = join(this.options.runtimeDirectory, 'venv');
    const pythonInstallDirectory = join(this.options.runtimeDirectory, 'python');
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: join(this.options.runtimeDirectory, 'uv-cache'),
      UV_NO_CONFIG: '1',
      UV_NO_PROGRESS: '1',
      UV_PROJECT_ENVIRONMENT: venvDirectory,
      UV_PYTHON_INSTALL_DIR: pythonInstallDirectory,
    };
    await mkdir(this.options.runtimeDirectory, { recursive: true });

    const commandOptions: SpeechExecFileOptions = {
      cwd: this.options.projectDirectory,
      env: environment,
      shell: false,
      windowsHide: true,
    };
    if (
      !(await fileExists(uvPath)) ||
      !(await this.hasExpectedUvVersion(uvPath, commandOptions))
    ) {
      await this.reinstallUv(archivePath, toolsRoot, toolDirectory, commandOptions);
    }

    await this.execFile(uvPath, ['python', 'install', '3.12'], commandOptions);
    await this.execFile(
      uvPath,
      ['venv', '--python', '3.12', venvDirectory],
      commandOptions,
    );
    await this.execFile(
      uvPath,
      ['sync', '--locked', '--project', this.options.projectDirectory],
      commandOptions,
    );

    return {
      pythonPath: join(venvDirectory, 'Scripts', 'python.exe'),
      environment: {
        UV_PROJECT_ENVIRONMENT: venvDirectory,
        VIRTUAL_ENV: venvDirectory,
        HF_HUB_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        TRANSFORMERS_OFFLINE: '1',
      },
    };
  }
}
