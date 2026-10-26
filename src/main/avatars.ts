import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Avatar } from '../shared/types';
import type { Store } from './store';
import type { MediaRegistry } from './media';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface AvatarServiceOptions {
  avatarsDirectory: string;
  store: Pick<Store, 'createAvatar' | 'listAvatars' | 'updateAvatar' | 'deleteAvatar'>;
  mediaRegistry: Pick<MediaRegistry, 'isSelectedImage'>;
}

export class AvatarService {
  private readonly avatarsDirectory: string;
  private readonly store: AvatarServiceOptions['store'];
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

  async updateAvatar(id: string, input: { name: string }): Promise<Avatar> {
    return this.store.updateAvatar(id, { name: input.name.trim() });
  }

  async deleteAvatar(id: string): Promise<void> {
    const avatar = this.store.listAvatars().find((candidate) => candidate.id === id);
    if (avatar === undefined) {
      throw new Error(`Avatar not found: ${id}`);
    }

    await this.validateRemovablePhoto(avatar.photoPath);
    this.store.deleteAvatar(id);
    await rm(avatar.photoPath, { force: true });
  }

  private async validateRemovablePhoto(photoPath: string): Promise<void> {
    const root = resolve(this.avatarsDirectory);
    const candidate = resolve(photoPath);
    const relativePath = relative(root, candidate);
    if (relativePath.length === 0) {
      throw new Error('Avatar photo is not a file');
    }
    if (
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error('Avatar photo must be inside the managed avatars directory');
    }

    try {
      const photoStats = await lstat(candidate);
      if (!photoStats.isFile()) {
        throw new Error('Avatar photo is not a file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}
