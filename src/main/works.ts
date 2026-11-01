import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Store } from './store';

const execFileAsync = promisify(execFile);

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp4',
  '.webm',
  '.gif',
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.m4a',
]);

// Deletes files through an open handle so the bytes removed are exactly the
// file that passed validation, closing the check-to-delete TOCTOU window.
// Paths travel through the environment and never appear on the command line.
// The handle is opened with the DELETE access right and delete sharing so the
// disposition can be set on it; FileDispositionInfo is class 4 of
// FILE_INFO_BY_HANDLE_CLASS and FILE_DISPOSITION_INFO is a single byte.
const POWERSHELL_DELETE_BY_HANDLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class SmoWorkHandleDelete
{
    private const uint DeleteAccess = 0x00010000;
    private const uint FileReadAttributesAccess = 0x00000080;
    private const uint SynchronizeAccess = 0x00100000;
    private const uint ShareReadWriteDelete = 0x00000007;
    private const uint OpenExisting = 3;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        IntPtr fileInformation,
        int bufferLength);

    public static void Delete(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path,
            DeleteAccess | FileReadAttributesAccess | SynchronizeAccess,
            ShareReadWriteDelete,
            IntPtr.Zero,
            OpenExisting,
            0,
            IntPtr.Zero))
        {
            if (handle.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
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

$paths = $env:SMO_WORK_DELETE_PATHS | ConvertFrom-Json
foreach ($path in $paths) {
    [SmoWorkHandleDelete]::Delete([string]$path)
}
`;

async function deleteFilesByHandle(paths: string[]): Promise<void> {
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
      await this.removeOutput(work.id, work.outputPath);
    }
    this.store.deleteWork(id);
  }

  private async removeOutput(workId: string, filePath: string): Promise<void> {
    const root = resolve(this.outputDirectory);
    const candidate = resolve(filePath);
    assertInside(root, candidate);
    if (!['.mp4', '.webm'].includes(extname(candidate).toLowerCase())) {
      throw new Error('Work output must be an MP4 or WebM video');
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
      const belongsToWork =
        name === workId || name.startsWith(`${workId}.`) || name.startsWith(`${workId}_`);
      if (!belongsToWork || !ASSET_EXTENSIONS.has(extname(name).toLowerCase())) {
        continue;
      }
      const assetPath = resolve(directory, name);
      if (!candidates.has(assetPath)) {
        candidates.set(assetPath, false);
      }
    }

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
            ? 'Work output must be a regular video file'
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
    if (process.platform === 'win32') {
      await deleteFilesByHandle(validated);
      return;
    }
    for (const assetPath of validated) {
      await rm(assetPath, { force: true });
    }
  }
}
