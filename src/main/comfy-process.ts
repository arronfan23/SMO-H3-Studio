import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ComfyClient, ComfySystemStats } from './comfy';

export const DEFAULT_COMFY_ROOT =
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130';

const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
// A startup with neither a health check success nor an exit record is
// considered dead after this long (e.g. the backend was killed externally
// without writing the status file); the next start attempt then launches a
// fresh backend instead of waiting forever.
const DEFAULT_STALE_STARTUP_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const LOG_TAIL_LENGTH = 2_000;
const INNER_LAUNCHER_FILE_NAME = 'start-comfyui.cmd';
const HIDDEN_LAUNCHER_FILE_NAME = 'start-comfyui-hidden.cmd';
const PATHS_FILE_NAME = 'start-comfyui.paths';
const WORKER_FILE_NAME = 'comfy-worker.py';
const PID_FILE_NAME = 'comfy-worker.pid';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// Paths are passed to the launcher through a generated KEY=VALUE file instead
// of batch arguments or embedded literals: the .cmd reads it with `for /f`
// AFTER switching to UTF-8 (chcp 65001), so non-ASCII paths survive any
// default console codepage, and `set "KEY=VALUE"` stores values verbatim
// (delayed expansion stays disabled, so no % or ! escaping is needed).
const LAUNCHER_ENV = {
  root: 'SMO_COMFY_ROOT_DIR',
  python: 'SMO_COMFY_PYTHON',
  launch: 'SMO_COMFY_LAUNCH',
  port: 'SMO_COMFY_PORT',
  output: 'SMO_COMFY_OUTPUT',
  log: 'SMO_COMFY_LOG',
  status: 'SMO_COMFY_STATUS',
  pid: 'SMO_COMFY_PID',
} as const;

// In owned mode the batch runs this worker instead of launch.py directly:
// the worker spawns launch.py with the same interpreter, records the child
// PID so terminate() can kill exactly that process tree, and forwards the
// exit code. Every path arrives through the UTF-8 paths file as an
// environment variable; nothing user-controlled is embedded in the script.
const WORKER_SCRIPT = `import os
import subprocess
import sys


def main() -> int:
    launch = os.environ["SMO_COMFY_LAUNCH"]
    pid_path = os.environ["SMO_COMFY_PID"]
    process = subprocess.Popen(
        [sys.executable, "-I", "-X", "utf8", launch, *sys.argv[1:]]
    )
    with open(pid_path, "w", encoding="ascii") as handle:
        handle.write(str(process.pid))
    return process.wait()


if __name__ == "__main__":
    sys.exit(main())
`;

async function defaultKillProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

// The backend must never be a handle-inheriting child of the app: on Windows,
// child_process.spawn passes bInheritHandles=TRUE, which leaks every
// inheritable handle (e.g. a test runner's transport pipe) into the detached
// python tree and hangs tools waiting on pipe EOF. Electron's shell.openPath
// goes through ShellExecuteEx instead, so the backend process tree inherits
// nothing. The hidden wrapper detaches the real launcher via `start /min` so
// openPath returns immediately; the inner launcher records the backend exit
// code in a status file before exiting.
async function defaultOpenLauncher(path: string): Promise<string> {
  const { shell } = await import('electron');
  return shell.openPath(path);
}

export interface ComfyProcessManagerOptions {
  baseUrl: string;
  rootDirectory?: string;
  pythonPath?: string;
  launchScript?: string;
  lowvram?: boolean;
  outputDirectory?: string;
  launchDirectory?: string;
  ownedProcess?: boolean;
  killProcessTree?: (pid: number) => Promise<void>;
  logPath: string;
  startupTimeoutMs?: number;
  staleStartupMs?: number;
  pollIntervalMs?: number;
  openLauncher?: (path: string) => Promise<string>;
}

function validateTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ComfyUI ${name} must be a finite positive number`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayUrl(baseUrl: URL): string {
  const url = new URL(baseUrl.href);
  url.username = '';
  url.password = '';
  return url.toString();
}

function validateLaunchPath(value: string, name: string): string {
  if (/[\r\n"]/.test(value)) {
    throw new Error(
      `ComfyUI ${name} must not contain CR, LF, or double quote characters`,
    );
  }
  return value;
}

function buildInnerLauncherScript(input: {
  lowvram: boolean;
  outputDirectory?: string;
  owned: boolean;
}): string {
  const target = input.owned
    ? `"%~dp0${WORKER_FILE_NAME}"`
    : `"%${LAUNCHER_ENV.launch}%"`;
  const launchArguments = [
    `"%${LAUNCHER_ENV.python}%" -I -X utf8 ${target}`,
    ...(input.lowvram ? ['--lowvram'] : []),
    ...(input.outputDirectory === undefined
      ? []
      : [`--output-directory "%${LAUNCHER_ENV.output}%"`]),
    `--port %${LAUNCHER_ENV.port}% >> "%${LAUNCHER_ENV.log}%" 2>&1`,
  ];
  const lines = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'chcp 65001>nul',
    `for /f "usebackq delims=" %%L in ("%~dp0${PATHS_FILE_NAME}") do set "%%L"`,
    `cd /d "%${LAUNCHER_ENV.root}%"`,
    launchArguments.join(' '),
    `set "RESULT=%errorlevel%"`,
    `>"%${LAUNCHER_ENV.status}%" echo %RESULT%`,
    'exit /b %RESULT%',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function buildHiddenLauncherScript(): string {
  const lines = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `start "" /min "%~dp0${INNER_LAUNCHER_FILE_NAME}"`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function buildPathsFile(input: {
  rootDirectory: string;
  pythonPath: string;
  launchScript: string;
  port: string;
  outputDirectory?: string;
  pidPath?: string;
  logPath: string;
  statusPath: string;
}): string {
  const lines = [
    `${LAUNCHER_ENV.root}=${input.rootDirectory}`,
    `${LAUNCHER_ENV.python}=${input.pythonPath}`,
    `${LAUNCHER_ENV.launch}=${input.launchScript}`,
    `${LAUNCHER_ENV.port}=${input.port}`,
    ...(input.outputDirectory === undefined
      ? []
      : [`${LAUNCHER_ENV.output}=${input.outputDirectory}`]),
    ...(input.pidPath === undefined
      ? []
      : [`${LAUNCHER_ENV.pid}=${input.pidPath}`]),
    `${LAUNCHER_ENV.log}=${input.logPath}`,
    `${LAUNCHER_ENV.status}=${input.statusPath}`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

interface ActiveStartup {
  startedAt: number;
}

export class ComfyProcessManager {
  private readonly baseUrl: URL;
  private readonly rootDirectory: string;
  private readonly pythonPath: string;
  private readonly launchScript: string;
  private readonly lowvram: boolean;
  private readonly outputDirectory?: string;
  private readonly launchDirectory: string;
  private readonly ownedProcess: boolean;
  private readonly killProcessTree: (pid: number) => Promise<void>;
  private readonly pidPath: string;
  private readonly logPath: string;
  private readonly statusPath: string;
  private readonly startupTimeoutMs: number;
  private readonly staleStartupMs: number;
  private readonly pollIntervalMs: number;
  private readonly openLauncher: (path: string) => Promise<string>;
  private readonly client: Pick<ComfyClient, 'health'>;
  private startPromise: Promise<ComfySystemStats> | null = null;
  private activeStartup: ActiveStartup | null = null;
  private launchedProcess = false;
  private terminated = false;
  private closed = false;

  constructor(
    options: ComfyProcessManagerOptions,
    client: Pick<ComfyClient, 'health'>,
  ) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new Error('ComfyUI base URL must be a valid HTTP or HTTPS URL');
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error('ComfyUI base URL must be a valid HTTP or HTTPS URL');
    }
    if (typeof options.logPath !== 'string' || options.logPath.trim().length === 0) {
      throw new Error('ComfyUI log path must be non-empty');
    }
    this.baseUrl = baseUrl;
    this.rootDirectory = options.rootDirectory ?? DEFAULT_COMFY_ROOT;
    this.pythonPath =
      options.pythonPath ?? join(this.rootDirectory, 'python_embeded', 'python.exe');
    this.launchScript =
      options.launchScript ?? join(this.rootDirectory, 'tools', 'launch.py');
    this.lowvram = options.lowvram ?? true;
    this.outputDirectory = options.outputDirectory;
    this.launchDirectory = options.launchDirectory ?? dirname(options.logPath);
    this.ownedProcess = options.ownedProcess ?? false;
    this.killProcessTree = options.killProcessTree ?? defaultKillProcessTree;
    this.pidPath = join(this.launchDirectory, PID_FILE_NAME);
    this.logPath = options.logPath;
    this.statusPath = `${options.logPath}.exit`;
    this.startupTimeoutMs = validateTimeout(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      'startupTimeoutMs',
    );
    this.staleStartupMs = validateTimeout(
      options.staleStartupMs ?? DEFAULT_STALE_STARTUP_MS,
      'staleStartupMs',
    );
    this.pollIntervalMs = validateTimeout(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    );
    this.openLauncher = options.openLauncher ?? defaultOpenLauncher;
    this.client = client;
  }

  async ensureReady(): Promise<ComfySystemStats> {
    if (this.closed) {
      throw new Error('ComfyProcessManager is closed');
    }
    try {
      return await this.client.health();
    } catch {
      // Fall through and start the local process when possible.
    }
    if (this.closed) {
      throw new Error('ComfyProcessManager is closed');
    }
    if (!LOCAL_HOSTNAMES.has(this.baseUrl.hostname)) {
      throw new Error(
        `ComfyUI at ${displayUrl(this.baseUrl)} is not reachable and does not ` +
          'point at a local host, so no local ComfyUI process was started',
      );
    }

    let pending = this.startPromise;
    if (pending === null) {
      pending = this.startAndWait();
      this.startPromise = pending;
    }
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) {
        this.startPromise = null;
      }
    }
  }

  async close(): Promise<void> {
    // Never kill the backend: it outlives the app by design.
    this.closed = true;
  }

  /**
   * Owned-mode shutdown for candidates that must not outlive the install
   * attempt. Kills only a backend this manager actually launched (recorded
   * PID, no exit record); a reused healthy instance or an already-exited
   * process is left alone, and non-owned managers are never killed.
   */
  async terminate(): Promise<void> {
    this.closed = true;
    if (!this.ownedProcess || !this.launchedProcess || this.terminated) {
      return;
    }
    // Mark synchronously so concurrent terminate callers cannot both kill.
    this.terminated = true;
    if ((await this.readExitCode()) !== null) {
      return;
    }
    let pid: number | null = null;
    try {
      const content = await readFile(this.pidPath, 'utf8');
      const parsed = Number.parseInt(content.trim(), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      pid = null;
    }
    if (pid === null) {
      return;
    }
    await this.killProcessTree(pid);
  }

  private async startAndWait(): Promise<ComfySystemStats> {
    const exitCode = await this.readExitCode();
    if (
      this.activeStartup !== null &&
      exitCode === null &&
      Date.now() - this.activeStartup.startedAt >= this.staleStartupMs
    ) {
      // Neither healthy nor exited within the stale window: assume the
      // backend died without a trace and allow a fresh launch below.
      this.activeStartup = null;
    }
    // Reuse a startup that is still in flight; only a recorded exit (or the
    // absence of any startup) allows launching a new backend process.
    if (this.activeStartup === null || exitCode !== null) {
      await this.launchBackend();
    }
    try {
      const stats = await this.waitUntilHealthy();
      this.activeStartup = null;
      return stats;
    } catch (error) {
      // A recorded exit means the backend is gone; drop the marker so the
      // next attempt launches a fresh process. A timeout (no exit record)
      // keeps the marker so the retry waits on the same backend.
      if ((await this.readExitCode()) !== null) {
        this.activeStartup = null;
      }
      throw error;
    }
  }

  private async launchBackend(): Promise<void> {
    const port =
      this.baseUrl.port.length > 0
        ? this.baseUrl.port
        : this.baseUrl.protocol === 'https:'
          ? '443'
          : '80';
    validateLaunchPath(this.rootDirectory, 'root directory');
    validateLaunchPath(this.pythonPath, 'python path');
    validateLaunchPath(this.launchScript, 'launch script');
    if (this.outputDirectory !== undefined) {
      validateLaunchPath(this.outputDirectory, 'output directory');
    }
    validateLaunchPath(this.launchDirectory, 'launch directory');
    validateLaunchPath(this.logPath, 'log path');

    const logDirectory = dirname(this.logPath);
    // The log and launch directories (e.g. <data>/logs) may not exist on a
    // fresh data root, and owned candidates get a fresh directory each time.
    await mkdir(logDirectory, { recursive: true });
    await mkdir(this.launchDirectory, { recursive: true });
    if (this.closed) {
      throw new Error('ComfyProcessManager is closed');
    }
    const innerLauncherPath = join(this.launchDirectory, INNER_LAUNCHER_FILE_NAME);
    const hiddenLauncherPath = join(this.launchDirectory, HIDDEN_LAUNCHER_FILE_NAME);
    const pathsPath = join(this.launchDirectory, PATHS_FILE_NAME);
    await writeFile(
      innerLauncherPath,
      buildInnerLauncherScript({
        lowvram: this.lowvram,
        outputDirectory: this.outputDirectory,
        owned: this.ownedProcess,
      }),
      'utf8',
    );
    if (this.ownedProcess) {
      await writeFile(
        join(this.launchDirectory, WORKER_FILE_NAME),
        WORKER_SCRIPT,
        'utf8',
      );
    }
    await writeFile(
      pathsPath,
      buildPathsFile({
        rootDirectory: this.rootDirectory,
        pythonPath: this.pythonPath,
        launchScript: this.launchScript,
        port,
        outputDirectory: this.outputDirectory,
        pidPath: this.ownedProcess ? this.pidPath : undefined,
        logPath: this.logPath,
        statusPath: this.statusPath,
      }),
      'utf8',
    );
    await writeFile(
      hiddenLauncherPath,
      buildHiddenLauncherScript(),
      'utf8',
    );
    // A stale exit marker from a previous backend must not poison this start.
    await rm(this.statusPath, { force: true });
    if (this.closed) {
      throw new Error('ComfyProcessManager is closed');
    }

    const failure = await this.openLauncher(hiddenLauncherPath);
    if (failure.length > 0) {
      throw new Error(`Failed to start the ComfyUI process: ${failure}`);
    }
    this.activeStartup = { startedAt: Date.now() };
    this.launchedProcess = true;
  }

  private async readExitCode(): Promise<number | null> {
    let content: string;
    try {
      content = await readFile(this.statusPath, 'utf8');
    } catch {
      return null;
    }
    const code = Number.parseInt(content.trim(), 10);
    return Number.isInteger(code) ? code : null;
  }

  private async waitUntilHealthy(): Promise<ComfySystemStats> {
    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      if (this.closed) {
        throw new Error('ComfyProcessManager is closed');
      }
      try {
        return await this.client.health();
      } catch {
        // ComfyUI is not up yet; check whether the backend died starting.
      }
      const exitCode = await this.readExitCode();
      if (exitCode !== null) {
        throw await this.startupError(
          `ComfyUI process exited early (code ${exitCode})`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw await this.startupError(
          `ComfyUI startup timed out after ${this.startupTimeoutMs} ms`,
        );
      }
      await delay(Math.min(this.pollIntervalMs, remaining));
    }
  }

  private async startupError(prefix: string): Promise<Error> {
    let tail = '';
    try {
      const content = await readFile(this.logPath, 'utf8');
      tail = content.slice(-LOG_TAIL_LENGTH);
    } catch {
      // The log tail is best-effort context for the error message.
    }
    const trimmed = tail.trim();
    return new Error(
      trimmed.length > 0
        ? `${prefix}. Last log output:\n${trimmed}`
        : prefix,
    );
  }
}
