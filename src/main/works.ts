import { lstat, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Store } from './store';

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
      await this.removeOutput(work.outputPath);
    }
    this.store.deleteWork(id);
  }

  private async removeOutput(filePath: string): Promise<void> {
    const root = resolve(this.outputDirectory);
    const candidate = resolve(filePath);
    assertInside(root, candidate);
    if (!['.mp4', '.webm'].includes(extname(candidate).toLowerCase())) {
      throw new Error('Work output must be an MP4 or WebM video');
    }
    const stats = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (stats === null) {
      return;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Work output must be a regular video file');
    }
    assertInside(await realpath(root), await realpath(candidate));
    await this.remove(candidate, { force: true });
  }
}
