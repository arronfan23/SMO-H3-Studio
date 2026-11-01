import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  downloadFile as defaultDownloadFile,
  downloadParts as defaultDownloadParts,
} from './download';
import { selectEnvironmentProfile } from './environment-manifest';
import type { EnvironmentStore } from './environment-store';
import type {
  EnvironmentConfig,
  EnvironmentManifest,
  EnvironmentModelFile,
  EnvironmentProfile,
  EnvironmentProfileSelection,
  EnvironmentRuntime,
  EnvironmentStage,
  EnvironmentStartInput,
  EnvironmentState,
} from '../shared/environment';
import type { HardwareInfo } from '../shared/types';

export const REQUIRED_COMFY_NODES = [
  'SelfLiftH3Sampler',
  'SelfLiftAvatarH3Sampler',
  'VedaSparseAttention',
  'QwenH3PromptLocal',
  'MiniMaxH3ReferenceToVideo',
] as const;

const REQUIRED_RUNTIME_FILES = [
  'python_embeded/python.exe',
  'tools/launch.py',
  'tools/ffmpeg/ffprobe.exe',
] as const;
const EXTRA_MODEL_PATH_KEYS = [
  'diffusion_models',
  'text_encoders',
  'vae',
  'loras',
  'veda',
  'latent_upscale_models',
  'vae_approx',
] as const;
const PROFILES = new Set<EnvironmentProfile>([
  'conservative',
  'balanced-16gb',
  'high-memory-candidate',
]);
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:CONIN\$|CONOUT\$|CON|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:[ .]|$)/i;
const WINDOWS_ILLEGAL_SEGMENT_PATTERN = /[<>:"|?*\x00-\x1F\x7F]/;

export interface EnvironmentBackendInput {
  runtimeRoot: string;
  modelDirectory: string;
  outputDirectory: string;
  profile: EnvironmentProfile;
  runtime: EnvironmentRuntime;
  pythonPath: string;
  launchScript: string;
  ffprobePath: string;
  signal: AbortSignal;
}

/** On failure or abort, the adapter closes its candidate manager without stopping a healthy existing backend. */
export type EnvironmentStartBackend = (
  input: EnvironmentBackendInput,
) => Promise<unknown>;

/**
 * A verified candidate backend awaiting commitment. The health and node
 * checks have already passed, but the candidate has not replaced the active
 * backend yet: `activate` performs the swap (only after the ready commit
 * succeeds) and `rollback` reclaims the candidate without touching the
 * active backend. Both settle the transaction; a settled transaction ignores
 * further calls.
 */
export interface EnvironmentBackendTransaction {
  systemStats: unknown;
  objectInfo: Record<string, unknown>;
  activate: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Detects the optional transaction shape in a backend start result. Plain
 * `{ systemStats, objectInfo }` results stay supported for adapters that
 * activate internally.
 */
export function readBackendTransaction(
  result: unknown,
): EnvironmentBackendTransaction | undefined {
  if (!isRecord(result)) return undefined;
  if (
    typeof result.activate === 'function' &&
    typeof result.rollback === 'function'
  ) {
    return result as unknown as EnvironmentBackendTransaction;
  }
  return undefined;
}

export interface EnvironmentExtractInput {
  archivePath: string;
  stagingDirectory: string;
  signal?: AbortSignal;
}

export type EnvironmentExtractor = (
  input: EnvironmentExtractInput,
) => Promise<void>;

export interface EnvironmentSetupServiceOptions {
  store: EnvironmentStore;
  manifest: EnvironmentManifest;
  defaultInstallRoot: string;
  outputDirectory: string;
  detectHardware: (installRoot: string) => Promise<HardwareInfo>;
  startBackend: EnvironmentStartBackend;
  downloadParts?: typeof defaultDownloadParts;
  downloadFile?: typeof defaultDownloadFile;
  extract?: EnvironmentExtractor;
  extractor?: EnvironmentExtractor;
}

interface InstallationLayout {
  installRoot: string;
  workDirectory: string;
  downloadDirectory: string;
  archivePath: string;
  stagingDirectory: string;
  runtimeContainer: string;
  runtimeRoot: string;
  stagedRuntimeRoot: string;
  modelRoot: string;
  modelDirectory: string;
  pythonPath: string;
  launchScript: string;
  ffprobePath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertNotReparsePoint(path: string, label: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic link, junction, or reparse point at ${label}: ${path}`,
      );
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function isContainedPath(ancestor: string, candidate: string): boolean {
  const child = win32.relative(win32.resolve(ancestor), win32.resolve(candidate));
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${win32.sep}`) &&
    !win32.isAbsolute(child)
  );
}

function validateInstallRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    !win32.isAbsolute(value)
  ) {
    throw new Error('installRoot must be an absolute Windows path');
  }

  const { root } = win32.parse(value);
  const driveRoot = /^[A-Za-z]:[\\/]$/.test(root);
  const uncRoot = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]$/.test(root);
  if ((!driveRoot && !uncRoot) || /^(?:\\\\[?.]\\|\/\/[?.]\/)/.test(value)) {
    throw new Error('installRoot must use a standard drive or UNC root');
  }

  const remainder = value.slice(root.length);
  const segments = remainder.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) {
    throw new Error('installRoot must not be a disk or UNC share root');
  }
  if ((driveRoot ? value.slice(2) : value).includes(':')) {
    throw new Error('installRoot must not contain an alternate data stream');
  }
  for (const segment of segments) {
    if (
      segment === '.' ||
      segment === '..' ||
      /[. ]$/.test(segment) ||
      WINDOWS_DEVICE_NAME_PATTERN.test(segment) ||
      WINDOWS_ILLEGAL_SEGMENT_PATTERN.test(segment)
    ) {
      throw new Error(`installRoot contains an unsafe path segment: ${segment}`);
    }
  }
  return win32.normalize(value);
}

function installRootKey(value: string): string {
  return win32.normalize(value).toLowerCase();
}

function validateProfile(profile: EnvironmentProfile, hardware: HardwareInfo): void {
  if (!PROFILES.has(profile)) {
    throw new Error(`Unknown environment profile: ${String(profile)}`);
  }
  if (profile === 'balanced-16gb' && hardware.vramGiB < 12) {
    throw new Error('balanced-16gb requires at least 12 GiB VRAM');
  }
  if (profile === 'high-memory-candidate' && hardware.vramGiB < 20) {
    throw new Error('high-memory-candidate requires at least 20 GiB VRAM');
  }
}

function runtimeTopLevel(runtime: EnvironmentRuntime): string {
  const runtimeSegments = runtime.pythonPath.split('/');
  const topLevel = runtimeSegments[0];
  if (
    !topLevel ||
    [runtime.launchScript, runtime.ffprobePath].some(
      (path) => path.split('/')[0] !== topLevel,
    )
  ) {
    throw new Error('Runtime entry points must share one top-level directory');
  }
  return topLevel;
}

function versionedDirName(base: string, manifestVersion: string): string {
  const safeVersion =
    manifestVersion.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/[. ]+$/, '') ||
    'unknown';
  return `${base}.manifest-v${safeVersion}`;
}

function directChildDirName(parent: string, child: string): string | undefined {
  const resolvedParent = win32.resolve(parent);
  const resolvedChild = win32.resolve(child);
  if (win32.dirname(resolvedChild).toLowerCase() !== resolvedParent.toLowerCase()) {
    return undefined;
  }
  return win32.basename(resolvedChild);
}

function recordedModelRootDirName(
  installRoot: string,
  previous: EnvironmentConfig,
): string | undefined {
  if (win32.basename(previous.modelDirectory).toLowerCase() !== 'diffusion_models') {
    return undefined;
  }
  return directChildDirName(installRoot, win32.dirname(previous.modelDirectory));
}

function createLayout(
  installRoot: string,
  runtime: EnvironmentRuntime,
  runtimeDirName?: string,
  modelRootDirName?: string,
): InstallationLayout {
  const topLevel = runtimeTopLevel(runtime);
  const workDirectory = win32.join(installRoot, '.smo-install');
  const downloadDirectory = win32.join(workDirectory, 'downloads');
  const stagingDirectory = win32.join(workDirectory, 'staging');
  const runtimeContainer = win32.join(installRoot, 'runtime');
  const runtimeRoot = win32.join(runtimeContainer, runtimeDirName ?? topLevel);
  const modelRoot = win32.join(installRoot, modelRootDirName ?? 'models');
  const resolveRuntimePath = (path: string) =>
    win32.join(runtimeRoot, ...path.split('/').slice(1));

  return {
    installRoot,
    workDirectory,
    downloadDirectory,
    archivePath: win32.join(downloadDirectory, `${runtime.id}.zip`),
    stagingDirectory,
    runtimeContainer,
    runtimeRoot,
    stagedRuntimeRoot: win32.join(stagingDirectory, topLevel),
    modelRoot,
    modelDirectory: win32.join(modelRoot, 'diffusion_models'),
    pythonPath: resolveRuntimePath(runtime.pythonPath),
    launchScript: resolveRuntimePath(runtime.launchScript),
    ffprobePath: resolveRuntimePath(runtime.ffprobePath),
  };
}

async function verifyFileHash(
  path: string,
  expectedSha256: string,
  expectedSize: number | undefined,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (expectedSize !== undefined && stats.size !== expectedSize) {
    throw new Error(`${label} size mismatch: ${path}`);
  }

  signal?.throwIfAborted();
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  const abort = () => stream.destroy(new Error('Environment setup cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  signal?.throwIfAborted();
  const actual = hash.digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`${label} SHA256 mismatch: ${path}`);
  }
}

async function verifyRuntimeFiles(
  runtimeRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const manifestPath = win32.join(runtimeRoot, 'docs', 'file-manifest.sha256');
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new Error(`Runtime file manifest is missing: ${manifestPath}`);
    throw error;
  }

  const hashes = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!match) continue;
    const path = match[2].replaceAll('\\', '/').replace(/^\.\//, '');
    hashes.set(path, match[1].toLowerCase());
  }

  for (const path of REQUIRED_RUNTIME_FILES) {
    const expected = hashes.get(path);
    if (!expected) throw new Error(`Runtime file manifest has no entry for ${path}`);
    await verifyFileHash(
      win32.join(runtimeRoot, ...path.split('/')),
      expected,
      undefined,
      signal,
      `Runtime file ${path}`,
    );
  }
}

async function verifyModelFiles(
  modelRoot: string,
  models: EnvironmentModelFile[],
  signal?: AbortSignal,
): Promise<void> {
  for (const model of models) {
    await verifyFileHash(
      win32.join(modelRoot, ...model.path.split('/')),
      model.sha256,
      model.size,
      signal,
      `Model ${model.path}`,
    );
  }
}

async function writeExtraModelPaths(
  runtimeRoot: string,
  modelRoot: string,
): Promise<void> {
  const comfyDirectory = win32.join(runtimeRoot, 'ComfyUI');
  await mkdir(comfyDirectory, { recursive: true });
  const quotedRoot = modelRoot.replaceAll("'", "''");
  const lines = [
    'h3_selflift_models:',
    `  base_path: '${quotedRoot}'`,
    ...EXTRA_MODEL_PATH_KEYS.map((key) => `  ${key}: ${key}`),
    '',
  ];
  await writeFile(
    win32.join(comfyDirectory, 'extra_model_paths.yaml'),
    lines.join('\n'),
    'utf8',
  );
}

function readObjectInfo(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) throw new Error('Backend health check returned an invalid result');
  if ('objectInfo' in result) {
    if (!isRecord(result.objectInfo)) {
      throw new Error('Backend health check returned invalid objectInfo');
    }
    return result.objectInfo;
  }
  return result;
}

const POWERSHELL_EXTRACT_SCRIPT = String.raw`
$InputJson = [System.Environment]::GetEnvironmentVariable('SMO_ENVIRONMENT_SETUP_ZIP')
$payload = $InputJson | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression
$staging = [System.IO.Path]::GetFullPath([string]$payload.StagingDirectory)
$rootPrefix = $staging.TrimEnd('\', '/') + '\'
[System.IO.Directory]::CreateDirectory($staging) | Out-Null

function Assert-Contained([string]$Candidate) {
  $full = [System.IO.Path]::GetFullPath($Candidate)
  if (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ZIP entry is not contained in staging: $Candidate"
  }
  return $full
}

function Assert-NoReparsePoint([string]$Path) {
  if ([System.IO.File]::Exists($Path) -or [System.IO.Directory]::Exists($Path)) {
    $item = Get-Item -Force -LiteralPath $Path
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "ZIP extraction refuses a reparse point: $Path"
    }
  }
}

Assert-NoReparsePoint $staging
$stream = [System.IO.File]::OpenRead([string]$payload.ArchivePath)
$archive = [System.IO.Compression.ZipArchive]::new(
  $stream,
  [System.IO.Compression.ZipArchiveMode]::Read
)
try {
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.Length -eq 0) { continue }
    $normalized = $entry.FullName.Replace('\', '/')
    $directoryEntry = $normalized.EndsWith('/')
    $normalized = $normalized.TrimEnd('/')
    if (
      $normalized.Length -eq 0 -or
      $normalized.StartsWith('/') -or
      $normalized.Contains(':') -or
      [System.IO.Path]::IsPathRooted($normalized)
    ) {
      throw "Unsafe absolute or drive-qualified ZIP entry: $($entry.FullName)"
    }
    $segments = $normalized.Split('/')
    foreach ($segment in $segments) {
      if ($segment.Length -eq 0 -or $segment -eq '.' -or $segment -eq '..') {
        throw "Unsafe traversal in ZIP entry: $($entry.FullName)"
      }
    }
    $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixType -eq 0xA000) {
      throw "Symbolic links are not allowed in the runtime ZIP: $($entry.FullName)"
    }

    $relative = [string]::Join('\', $segments)
    $target = Assert-Contained ([System.IO.Path]::Combine($staging, $relative))
    $directoryCount = if ($directoryEntry) { $segments.Length } else { $segments.Length - 1 }
    $current = $staging
    for ($index = 0; $index -lt $directoryCount; $index += 1) {
      $current = [System.IO.Path]::Combine($current, $segments[$index])
      Assert-NoReparsePoint $current
      if (-not [System.IO.Directory]::Exists($current)) {
        [System.IO.Directory]::CreateDirectory($current) | Out-Null
      }
      Assert-NoReparsePoint $current
    }
    if ($directoryEntry) { continue }

    Assert-NoReparsePoint $target
    $source = $entry.Open()
    try {
      $destination = [System.IO.File]::Open(
        $target,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
      )
      try { $source.CopyTo($destination) } finally { $destination.Dispose() }
    } finally {
      $source.Dispose()
    }
  }
} finally {
  $archive.Dispose()
  $stream.Dispose()
}
`;

export async function extractZipArchive(
  input: EnvironmentExtractInput,
): Promise<void> {
  await mkdir(input.stagingDirectory, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        POWERSHELL_EXTRACT_SCRIPT,
      ],
      {
        windowsHide: true,
        signal: input.signal,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          SMO_ENVIRONMENT_SETUP_ZIP: JSON.stringify({
            ArchivePath: input.archivePath,
            StagingDirectory: input.stagingDirectory,
          }),
        },
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        reject(new Error(detail ? `ZIP extraction failed: ${detail}` : error.message));
      },
    );
  });
}

export class EnvironmentSetupService {
  private state: EnvironmentState;
  private readonly loaded: Promise<void>;
  private inFlight: Promise<EnvironmentState> | undefined;
  private inFlightInput: string | undefined;
  private detectFlight:
    | { installRoot: string; promise: Promise<EnvironmentState> }
    | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly options: EnvironmentSetupServiceOptions) {
    this.state = {
      config: null,
      hardware: null,
      selection: null,
      installRoot: win32.normalize(options.defaultInstallRoot),
      stage: 'detect',
      progress: { downloadedBytes: 0, totalBytes: 0 },
      error: null,
      active: false,
      healthy: false,
    };
    this.loaded = this.restore();
  }

  getState(): EnvironmentState {
    return structuredClone(this.state);
  }

  /** State read that waits for the persisted configuration restore. */
  async getRestoredState(): Promise<EnvironmentState> {
    await this.loaded;
    return this.getState();
  }

  /**
   * Marks a restored ready environment healthy. Called by the host only
   * after the recorded backend passed a fresh health and required-node
   * validation and its candidate was activated.
   */
  confirmBackendValidation(): EnvironmentState {
    if (this.state.config?.status !== 'ready') {
      throw new Error('Only a ready environment configuration can be validated');
    }
    this.state = {
      ...this.state,
      stage: 'ready',
      active: false,
      healthy: true,
      error: null,
    };
    return this.getState();
  }

  detect(installRoot = this.options.defaultInstallRoot): Promise<EnvironmentState> {
    if (this.inFlight) {
      return Promise.reject(new Error('Cannot detect hardware while environment setup is active'));
    }
    const key = installRootKey(installRoot);
    if (this.detectFlight) {
      if (this.detectFlight.installRoot !== key) {
        return Promise.reject(
          new Error('Cannot detect a different installRoot while detection is active'),
        );
      }
      return this.detectFlight.promise;
    }

    const operation = this.executeDetect(installRoot);
    const tracked = operation.finally(() => {
      if (this.detectFlight?.promise === tracked) this.detectFlight = undefined;
    });
    this.detectFlight = { installRoot: key, promise: tracked };
    return tracked;
  }

  start(input: EnvironmentStartInput): Promise<EnvironmentState> {
    return this.begin(input);
  }

  retry(input: EnvironmentStartInput): Promise<EnvironmentState> {
    return this.begin(input);
  }

  async cancel(): Promise<EnvironmentState> {
    const pending = this.inFlight;
    if (pending && this.controller) {
      this.controller.abort(new Error('Environment setup cancelled'));
      this.state = {
        ...this.state,
        active: false,
        healthy: false,
        error: 'Environment setup cancellation requested',
      };
      await pending.catch(() => undefined);
    }
    return this.getState();
  }

  private begin(input: EnvironmentStartInput): Promise<EnvironmentState> {
    if (this.detectFlight) {
      return Promise.reject(new Error('Cannot start environment setup while detection is active'));
    }
    const inputKey = `${installRootKey(input.installRoot)}\0${input.profileId}`;
    if (this.inFlight) {
      if (this.inFlightInput === inputKey) return this.inFlight;
      return Promise.reject(
        new Error('A different environment setup input is already active'),
      );
    }
    const operation = this.execute(input);
    const tracked = operation.finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = undefined;
        this.inFlightInput = undefined;
      }
    });
    this.inFlight = tracked;
    this.inFlightInput = inputKey;
    return tracked;
  }

  private async executeDetect(installRoot: string): Promise<EnvironmentState> {
    await this.loaded;
    const normalizedRoot = validateInstallRoot(installRoot);
    const restoredError = this.state.error;
    this.state = {
      ...this.state,
      installRoot: normalizedRoot,
      stage: 'detect',
      active: true,
      healthy: false,
      selection: null,
    };
    try {
      const hardware = await this.options.detectHardware(normalizedRoot);
      this.state = {
        ...this.state,
        hardware,
        stage: 'select',
        active: false,
        error: restoredError,
      };
      return this.getState();
    } catch (error) {
      this.state = { ...this.state, active: false, healthy: false, error: errorMessage(error) };
      throw error;
    }
  }

  private async restore(): Promise<void> {
    try {
      const config = await this.options.store.load();
      let error =
        config && config.status !== 'ready'
          ? 'Previous environment installation was interrupted or failed; retry to resume.'
          : null;
      let installRoot = this.state.installRoot;
      if (config) {
        try {
          installRoot =
            config.installRoot === undefined
              ? // Legacy configs predate the installRoot field: the runtime
                // always lives at <installRoot>/runtime/<topLevel>.
                validateInstallRoot(win32.dirname(win32.dirname(config.runtimeRoot)))
              : validateInstallRoot(config.installRoot);
        } catch (rootError) {
          // Never fall back to the default directory: an empty root makes any
          // reinstall attempt fail validation instead of silently targeting
          // the wrong location.
          installRoot = '';
          error = `Could not restore the recorded installRoot: ${errorMessage(rootError)}`;
        }
      }
      this.state = { ...this.state, config, installRoot, error, healthy: false };
    } catch (error) {
      this.state = {
        ...this.state,
        config: null,
        error: errorMessage(error),
        healthy: false,
        active: false,
      };
    }
  }

  private setStage(stage: EnvironmentStage): void {
    this.state = { ...this.state, stage };
  }

  private setProgress(
    downloadedBytes: number,
    totalBytes: number,
    currentFile?: string,
  ): void {
    this.state = {
      ...this.state,
      progress: { downloadedBytes, totalBytes, ...(currentFile ? { currentFile } : {}) },
    };
  }

  private async removeStaging(layout: InstallationLayout): Promise<void> {
    const workDirectory = win32.resolve(layout.workDirectory);
    const stagingDirectory = win32.resolve(layout.stagingDirectory);
    if (
      !isContainedPath(layout.installRoot, workDirectory) ||
      !isContainedPath(workDirectory, stagingDirectory)
    ) {
      throw new Error('Refusing to clean staging outside the installation work directory');
    }
    await assertNotReparsePoint(workDirectory, 'the installation work directory');
    await assertNotReparsePoint(layout.downloadDirectory, 'the download directory');
    await assertNotReparsePoint(stagingDirectory, 'the staging directory');
    await rm(stagingDirectory, { recursive: true, force: true });
  }

  private async quarantineRuntime(layout: InstallationLayout): Promise<void> {
    const quarantineRoot = win32.join(layout.workDirectory, 'quarantine');
    const destination = win32.join(
      quarantineRoot,
      `${win32.basename(layout.runtimeRoot)}-${randomUUID()}`,
    );
    if (!isContainedPath(layout.workDirectory, destination)) {
      throw new Error('Refusing to quarantine runtime outside the work directory');
    }
    await assertNotReparsePoint(layout.workDirectory, 'the installation work directory');
    await assertNotReparsePoint(layout.downloadDirectory, 'the download directory');
    await assertNotReparsePoint(quarantineRoot, 'the quarantine directory');
    await mkdir(quarantineRoot, { recursive: true });
    await rename(layout.runtimeRoot, destination);
  }

  /**
   * A ready runtime and model set recorded under an older manifest are never
   * moved, reused, or deleted: upgrades install into versioned sibling
   * directories so a failed attempt leaves the working environment untouched.
   * A ready record on the current manifest is reused at its recorded
   * directories (default or versioned); models are shared across runtime ids
   * because their hashes are identical within one manifest.
   */
  private resolveLayout(
    installRoot: string,
    runtime: EnvironmentRuntime,
    previous: EnvironmentConfig | null,
  ): InstallationLayout {
    if (previous?.status !== 'ready') return createLayout(installRoot, runtime);
    const manifestVersion = String(this.options.manifest.version);
    if (previous.manifestVersion !== manifestVersion) {
      return createLayout(
        installRoot,
        runtime,
        previous.runtimeId === runtime.id
          ? versionedDirName(runtimeTopLevel(runtime), manifestVersion)
          : undefined,
        versionedDirName('models', manifestVersion),
      );
    }
    return createLayout(
      installRoot,
      runtime,
      previous.runtimeId === runtime.id
        ? directChildDirName(win32.join(installRoot, 'runtime'), previous.runtimeRoot)
        : undefined,
      recordedModelRootDirName(installRoot, previous),
    );
  }

  private async execute(input: EnvironmentStartInput): Promise<EnvironmentState> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    let layout: InstallationLayout | undefined;
    let candidate: EnvironmentConfig | undefined;
    let candidateSaved = false;
    let preserveReady = false;
    let previousConfig: EnvironmentConfig | null = null;
    let readyCommitted: EnvironmentConfig | undefined;
    let transaction: EnvironmentBackendTransaction | undefined;
    let transactionActivated = false;

    try {
      await this.loaded;
      const installRoot = validateInstallRoot(input.installRoot);
      if (!PROFILES.has(input.profileId)) {
        throw new Error(`Unknown environment profile: ${String(input.profileId)}`);
      }
      signal.throwIfAborted();
      this.state = {
        ...this.state,
        installRoot,
        stage: 'detect',
        progress: { downloadedBytes: 0, totalBytes: 0 },
        selection: null,
        error: null,
        active: true,
        healthy: false,
      };

      const hardware = await this.options.detectHardware(installRoot);
      signal.throwIfAborted();
      this.state = { ...this.state, hardware };
      this.setStage('select');
      const recommended = selectEnvironmentProfile(hardware, this.options.manifest);
      validateProfile(input.profileId, hardware);
      const selection: EnvironmentProfileSelection = {
        ...recommended,
        profile: input.profileId,
      };
      this.state = { ...this.state, selection };
      previousConfig = this.state.config;
      const previous = previousConfig;
      preserveReady = previous?.status === 'ready';
      layout = this.resolveLayout(installRoot, selection.runtime, previous);
      const now = new Date().toISOString();
      candidate = {
        schemaVersion: 1,
        runtimeId: selection.runtime.id,
        runtimeRoot: layout.runtimeRoot,
        modelDirectory: layout.modelDirectory,
        outputDirectory: this.options.outputDirectory,
        installRoot,
        profile: selection.profile,
        hardwareFingerprint: {
          gpu: hardware.gpu,
          vramGiB: hardware.vramGiB,
          ramGiB: hardware.ramGiB,
          cudaComputeCapability: hardware.cudaComputeCapability,
        },
        manifestVersion: String(this.options.manifest.version),
        status: 'installing',
        createdAt: previous?.runtimeRoot === layout.runtimeRoot ? previous.createdAt : now,
        updatedAt: now,
      };
      const matchingReadyPaths =
        previous?.status === 'ready' &&
        previous.runtimeId === candidate.runtimeId &&
        previous.runtimeRoot === candidate.runtimeRoot &&
        previous.modelDirectory === candidate.modelDirectory &&
        previous.outputDirectory === candidate.outputDirectory;
      const matchingReady =
        matchingReadyPaths && previous.manifestVersion === candidate.manifestVersion;

      if (!preserveReady) {
        await this.options.store.save(candidate);
        candidateSaved = true;
        this.state = { ...this.state, config: candidate };
      }

      this.setStage('download-runtime');
      this.setProgress(0, selection.runtime.archiveSize);
      let runtimeValid = false;
      let runtimeError: unknown;
      const runtimeExists = await pathExists(layout.runtimeRoot);
      if (runtimeExists) {
        try {
          await verifyRuntimeFiles(layout.runtimeRoot, signal);
          runtimeValid = true;
        } catch (error) {
          if (signal.aborted) throw error;
          runtimeError = error;
        }
      } else if (matchingReady) {
        runtimeError = new Error(`Ready runtime is missing: ${layout.runtimeRoot}`);
      }
      if (matchingReady && !runtimeValid) throw runtimeError;
      if (!runtimeValid && runtimeExists) await this.quarantineRuntime(layout);

      if (runtimeValid) {
        this.setProgress(selection.runtime.archiveSize, selection.runtime.archiveSize);
      } else {
        await assertNotReparsePoint(layout.workDirectory, 'the installation work directory');
        await assertNotReparsePoint(layout.downloadDirectory, 'the download directory');
        await (this.options.downloadParts ?? defaultDownloadParts)({
          parts: selection.runtime.archiveParts,
          directory: layout.downloadDirectory,
          destination: layout.archivePath,
          expectedSize: selection.runtime.archiveSize,
          expectedSha256: selection.runtime.archiveSha256,
          signal,
          onProgress: (progress) => {
            this.setProgress(
              progress.downloadedBytes,
              progress.totalBytes,
              progress.path,
            );
          },
        });
      }

      this.setStage('extract');
      if (!runtimeValid) {
        await this.removeStaging(layout);
        await mkdir(layout.stagingDirectory, { recursive: true });
        await (this.options.extract ?? this.options.extractor ?? extractZipArchive)({
          archivePath: layout.archivePath,
          stagingDirectory: layout.stagingDirectory,
          signal,
        });
        signal.throwIfAborted();
        const stats = await lstat(layout.stagedRuntimeRoot);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error('Extracted runtime root is not a regular directory');
        }
      }

      this.setStage('download-models');
      const totalModelBytes = selection.modelFiles.reduce(
        (total, model) => total + model.size,
        0,
      );
      this.setProgress(0, totalModelBytes);
      if (matchingReady) {
        await verifyModelFiles(layout.modelRoot, selection.modelFiles, signal);
        this.setProgress(totalModelBytes, totalModelBytes);
      } else {
        let completedBytes = 0;
        for (const model of selection.modelFiles) {
          const destination = win32.join(layout.modelRoot, ...model.path.split('/'));
          this.setProgress(completedBytes, totalModelBytes, model.path);
          await (this.options.downloadFile ?? defaultDownloadFile)({
            url: model.url,
            destination,
            expectedSize: model.size,
            expectedSha256: model.sha256,
            signal,
            onProgress: (progress) => {
              this.setProgress(
                completedBytes + progress.downloadedBytes,
                totalModelBytes,
                model.path,
              );
            },
          });
          completedBytes += model.size;
          this.setProgress(completedBytes, totalModelBytes, model.path);
        }
      }

      this.setStage('verify');
      const verificationRoot = runtimeValid
        ? layout.runtimeRoot
        : layout.stagedRuntimeRoot;
      await verifyRuntimeFiles(verificationRoot, signal);
      await verifyModelFiles(layout.modelRoot, selection.modelFiles, signal);
      await writeExtraModelPaths(verificationRoot, layout.modelRoot);
      if (!runtimeValid) {
        await mkdir(layout.runtimeContainer, { recursive: true });
        if (await pathExists(layout.runtimeRoot)) {
          throw new Error(`Refusing to replace an existing runtime: ${layout.runtimeRoot}`);
        }
        signal.throwIfAborted();
        await rename(layout.stagedRuntimeRoot, layout.runtimeRoot);
      }
      await this.removeStaging(layout);

      signal.throwIfAborted();
      this.setStage('start');
      const result = await this.options.startBackend({
        runtimeRoot: layout.runtimeRoot,
        modelDirectory: layout.modelDirectory,
        outputDirectory: this.options.outputDirectory,
        profile: selection.profile,
        runtime: selection.runtime,
        pythonPath: layout.pythonPath,
        launchScript: layout.launchScript,
        ffprobePath: layout.ffprobePath,
        signal,
      });
      signal.throwIfAborted();
      transaction = readBackendTransaction(result);
      const objectInfo = readObjectInfo(result);
      const missingNodes = REQUIRED_COMFY_NODES.filter(
        (node) => !Object.hasOwn(objectInfo, node),
      );
      if (missingNodes.length > 0) {
        throw new Error(`Backend is missing required nodes: ${missingNodes.join(', ')}`);
      }

      signal.throwIfAborted();
      const ready = await this.options.store.commitReady(candidate);
      readyCommitted = ready;
      signal.throwIfAborted();
      if (transaction !== undefined) {
        // The candidate only replaces the active backend once the ready
        // state is durably committed and no cancellation arrived in between.
        await transaction.activate();
        transactionActivated = true;
      }
      this.state = {
        ...this.state,
        config: ready,
        stage: 'ready',
        error: null,
        active: false,
        healthy: true,
      };
      return this.getState();
    } catch (error) {
      const originalMessage = errorMessage(error);
      this.state = {
        ...this.state,
        error: originalMessage,
        active: false,
        healthy: false,
      };
      if (transaction !== undefined && !transactionActivated) {
        await transaction.rollback().catch(() => undefined);
      }
      if (layout) await this.removeStaging(layout).catch(() => undefined);
      if (readyCommitted && candidate) {
        try {
          if (previousConfig?.status === 'ready') {
            const restored = await this.options.store.commitReady(previousConfig);
            this.state = { ...this.state, config: restored };
          } else {
            const failed: EnvironmentConfig = {
              ...candidate,
              status: 'failed',
              updatedAt: new Date().toISOString(),
            };
            await this.options.store.save(failed);
            this.state = { ...this.state, config: failed };
          }
        } catch (rollbackError) {
          this.state = {
            ...this.state,
            config: readyCommitted,
            error: `${originalMessage}; ready rollback failed: ${errorMessage(rollbackError)}`,
          };
        }
      } else if (candidate && candidateSaved && !preserveReady) {
        const failed: EnvironmentConfig = {
          ...candidate,
          status: 'failed',
          updatedAt: new Date().toISOString(),
        };
        try {
          await this.options.store.save(failed);
          this.state = { ...this.state, config: failed };
        } catch (saveError) {
          this.state = {
            ...this.state,
            error: `${originalMessage}; unable to save failed state: ${errorMessage(saveError)}`,
          };
        }
      }
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
