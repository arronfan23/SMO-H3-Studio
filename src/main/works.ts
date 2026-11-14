import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkMode } from '../shared/types';
import type { Store } from './store';

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);

const SPEECH_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a']);

const H3_OUTPUT_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);

const ASSET_EXTENSIONS = new Set([
  ...H3_OUTPUT_EXTENSIONS,
  '.gif',
  ...SPEECH_EXTENSIONS,
  '.ogg',
]);

interface OutputRule {
  extensions: ReadonlySet<string>;
  description: string;
  mediaType: string;
  subdirectory: string;
  untrackedExtensions: ReadonlySet<string>;
}

const OUTPUT_RULES: Record<WorkMode, OutputRule> = {
  text: {
    extensions: VIDEO_EXTENSIONS,
    description: 'an MP4 or WebM video',
    mediaType: 'video',
    subdirectory: 'SMO-H3',
    untrackedExtensions: H3_OUTPUT_EXTENSIONS,
  },
  audio: {
    extensions: VIDEO_EXTENSIONS,
    description: 'an MP4 or WebM video',
    mediaType: 'video',
    subdirectory: 'SMO-H3',
    untrackedExtensions: H3_OUTPUT_EXTENSIONS,
  },
  speech: {
    extensions: SPEECH_EXTENSIONS,
    description: 'a WAV, MP3, FLAC, or M4A audio file',
    mediaType: 'audio',
    subdirectory: 'SMO-Speech',
    untrackedExtensions: SPEECH_EXTENSIONS,
  },
  image: {
    extensions: IMAGE_EXTENSIONS,
    description: 'a PNG, JPG, JPEG, or WebP image',
    mediaType: 'image',
    subdirectory: 'SMO-Image',
    untrackedExtensions: IMAGE_EXTENSIONS,
  },
};

function belongsToWork(name: string, workId: string): boolean {
  return name === workId || name.startsWith(`${workId}.`) || name.startsWith(`${workId}_`);
}

// Deletes files through an open handle so the bytes removed are exactly the
// file that passed validation, closing the check-to-delete TOCTOU window.
// Paths travel through the environment and never appear on the command line.
// The handle is opened with the DELETE access right, delete sharing, and
// FILE_FLAG_OPEN_REPARSE_POINT so a swapped-in final-component link is opened
// rather than followed. Before the disposition is set, the handle's own final
// path is read back with GetFinalPathNameByHandle and must stay inside the
// validated real root, which also catches parent directories swapped for
// junctions after validation. FileDispositionInfo is class 4 of
// FILE_INFO_BY_HANDLE_CLASS and FILE_DISPOSITION_INFO is a single byte.
const POWERSHELL_DELETE_BY_HANDLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class SmoWorkHandleDelete
{
    private const uint DeleteAccess = 0x00010000;
    private const uint FileReadAttributesAccess = 0x00000080;
    private const uint SynchronizeAccess = 0x00100000;
    private const uint ShareReadWriteDelete = 0x00000007;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePointFlag = 0x00200000;
    private const int FileDispositionInfoClass = 4;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        IntPtr fileInformation,
        int bufferLength);

    public static string NormalizePath(string path)
    {
        string normalized = path;
        if (normalized.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
        {
            normalized = "\\\\" + normalized.Substring(8);
        }
        else if (normalized.StartsWith("\\\\?\\", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized.Substring(4);
        }
        return normalized.TrimEnd('\\');
    }

    private static string FinalPath(SafeFileHandle handle)
    {
        int capacity = 512;
        while (true)
        {
            StringBuilder builder = new StringBuilder(capacity);
            uint length = GetFinalPathNameByHandle(handle, builder, (uint)builder.Capacity, 0);
            if (length == 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (length < (uint)builder.Capacity)
            {
                return builder.ToString();
            }
            capacity = (int)length + 1;
        }
    }

    public static void Delete(string path, string root)
    {
        using (SafeFileHandle handle = CreateFile(
            path,
            DeleteAccess | FileReadAttributesAccess | SynchronizeAccess,
            ShareReadWriteDelete,
            IntPtr.Zero,
            OpenExisting,
            OpenReparsePointFlag,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            string finalPath = NormalizePath(FinalPath(handle));
            if (!finalPath.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "Resolved handle path escapes the output directory: " + finalPath);
            }
            IntPtr info = Marshal.AllocHGlobal(1);
            try
            {
                Marshal.WriteByte(info, 1);
                if (!SetFileInformationByHandle(handle, FileDispositionInfoClass, info, 1))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(info);
            }
        }
    }
}
'@

$root = [SmoWorkHandleDelete]::NormalizePath($env:SMO_WORK_DELETE_ROOT)
$paths = $env:SMO_WORK_DELETE_PATHS | ConvertFrom-Json
foreach ($path in $paths) {
    [SmoWorkHandleDelete]::Delete([string]$path, $root)
}
`;

async function deleteFilesByHandle(paths: string[], root: string): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_DELETE_BY_HANDLE_SCRIPT],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        SMO_WORK_DELETE_ROOT: root,
        SMO_WORK_DELETE_PATHS: JSON.stringify(paths),
      },
    },
  );
}

export interface WorkServiceOptions {
  outputDirectory: string;
  store: Pick<Store, 'getWork' | 'deleteWork'>;
  removeFile?: typeof rm;
}

function assertInside(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error('Work output must be inside the output directory');
  }
}

export class WorkService {
  private readonly outputDirectory: string;
  private readonly store: Pick<Store, 'getWork' | 'deleteWork'>;
  private readonly removeFile?: typeof rm;

  constructor(options: WorkServiceOptions) {
    this.outputDirectory = options.outputDirectory;
    this.store = options.store;
    this.removeFile = options.removeFile;
  }

  async deleteWork(id: string): Promise<void> {
    const work = this.store.getWork(id);
    if (work === null) {
      throw new Error(`Work not found: ${id}`);
    }
    if (work.status !== 'done' && work.status !== 'failed') {
      throw new Error('Only completed or failed works can be deleted');
    }
    if (work.outputPath !== null && work.outputPath.trim().length > 0) {
      await this.removeOutput(work.id, work.mode, work.outputPath);
    } else if (work.status === 'failed' && work.outputPath === null) {
      await this.removeUntrackedOutput(work.id, work.mode);
    }
    this.store.deleteWork(id);
  }

  private async removeOutput(workId: string, mode: WorkMode, filePath: string): Promise<void> {
    const root = resolve(this.outputDirectory);
    const candidate = resolve(filePath);
    assertInside(root, candidate);
    const outputRule = OUTPUT_RULES[mode];
    if (!outputRule.extensions.has(extname(candidate).toLowerCase())) {
      throw new Error(`Work output must be ${outputRule.description}`);
    }

    const directory = dirname(candidate);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    const candidates = new Map<string, boolean>([[candidate, true]]);
    for (const name of names) {
      if (!belongsToWork(name, workId) || !ASSET_EXTENSIONS.has(extname(name).toLowerCase())) {
        continue;
      }
      const assetPath = resolve(directory, name);
      if (!candidates.has(assetPath)) {
        candidates.set(assetPath, false);
      }
    }
    await this.removeCandidates(root, candidates, outputRule);
  }

  private async removeUntrackedOutput(workId: string, mode: WorkMode): Promise<void> {
    const root = resolve(this.outputDirectory);
    const outputRule = OUTPUT_RULES[mode];
    const directory = resolve(root, outputRule.subdirectory);
    assertInside(root, directory);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    const candidates = new Map<string, boolean>();
    for (const name of names) {
      if (
        !belongsToWork(name, workId) ||
        !outputRule.untrackedExtensions.has(extname(name).toLowerCase())
      ) {
        continue;
      }
      candidates.set(resolve(directory, name), false);
    }
    await this.removeCandidates(root, candidates, outputRule);
  }

  private async removeCandidates(
    root: string,
    candidates: Map<string, boolean>,
    outputRule: OutputRule,
  ): Promise<void> {
    let realRoot: string | undefined;
    const validated: string[] = [];
    for (const [assetPath, isOutput] of candidates) {
      const stats = await lstat(assetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      });
      if (stats === null) {
        continue;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(
          isOutput
            ? `Work output must be a regular ${outputRule.mediaType} file`
            : 'Work output asset must be a regular file, not a symbolic link or directory',
        );
      }
      realRoot ??= await realpath(root);
      assertInside(realRoot, await realpath(assetPath));
      validated.push(assetPath);
    }

    if (validated.length === 0) {
      return;
    }
    if (this.removeFile !== undefined) {
      for (const assetPath of validated) {
        await this.removeFile(assetPath, { force: true });
      }
      return;
    }
    if (process.platform !== 'win32') {
      throw new Error(`Work output deletion is not supported on ${process.platform}`);
    }
    const deleteRoot = realRoot ?? (await realpath(root));
    await deleteFilesByHandle(validated, deleteRoot);
  }
}
