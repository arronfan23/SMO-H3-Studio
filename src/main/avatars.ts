import { constants } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join } from 'node:path';
import type { Avatar } from '../shared/types';
import type { Store } from './store';
import type { MediaRegistry } from './media';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface AvatarServiceOptions {
  avatarsDirectory: string;
  store: Pick<Store, 'createAvatar'>;
  mediaRegistry: Pick<MediaRegistry, 'isSelectedImage'>;
}

export class AvatarService {
  private readonly avatarsDirectory: string;
  private readonly store: Pick<Store, 'createAvatar'>;
  private readonly mediaRegistry: Pick<MediaRegistry, 'isSelectedImage'>;

  constructor(options: AvatarServiceOptions) {
    this.avatarsDirectory = options.avatarsDirectory;
    this.store = options.store;
    this.mediaRegistry = options.mediaRegistry;
  }

  async createAvatar(input: { name: string; photoPath: string }): Promise<Avatar> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error('Avatar name must not be empty');
    }
    if (input.photoPath.trim().length === 0 || !isAbsolute(input.photoPath)) {
      throw new Error('Avatar image path must be absolute');
    }

    const extension = extname(input.photoPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported avatar image extension: ${extension || '(none)'}`);
    }

    let sourceStats;
    try {
      sourceStats = await stat(input.photoPath);
    } catch {
      throw new Error('Avatar image file does not exist or is not a file');
    }
    if (!sourceStats.isFile()) {
      throw new Error('Avatar image file does not exist or is not a file');
    }
    if (!(await this.mediaRegistry.isSelectedImage(input.photoPath))) {
      throw new Error('Avatar image must be explicitly selected through files.selectImage');
    }

    await mkdir(this.avatarsDirectory, { recursive: true });
    const destination = join(
      this.avatarsDirectory,
      `${randomUUID()}${extension}`,
    );
    await copyFile(input.photoPath, destination, constants.COPYFILE_EXCL);
    try {
      return this.store.createAvatar({ name, photoPath: destination });
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  }
}
