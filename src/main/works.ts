import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Store } from './store';

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
  private readonly remove: typeof rm;

  constructor(options: WorkServiceOptions) {
    this.outputDirectory = options.outputDirectory;
    this.store = options.store;
    this.remove = options.removeFile ?? rm;
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

    for (const assetPath of validated) {
      await this.remove(assetPath, { force: true });
    }
  }
}
