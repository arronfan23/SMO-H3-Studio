import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { MediaRegistry } from './media';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a'];

export interface FileDialog {
  showOpenDialog(options: {
    title: string;
    properties: ['openFile'] | ['openDirectory'];
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface FolderOpener {
  openPath(path: string): Promise<string>;
}

export interface FileServiceOptions {
  mediaRegistry: MediaRegistry;
  dialog: FileDialog;
  outputDirectory: string;
  dataDirectory: string;
  opener?: FolderOpener;
}

export class FileService {
  private readonly mediaRegistry: MediaRegistry;
  private readonly dialog: FileDialog;
  private readonly outputDirectory: string;
  private readonly dataDirectory: string;
  private readonly opener: FolderOpener;

  constructor(options: FileServiceOptions) {
    this.mediaRegistry = options.mediaRegistry;
    this.dialog = options.dialog;
    this.outputDirectory = resolve(options.outputDirectory);
    this.dataDirectory = resolve(options.dataDirectory);
    this.opener = options.opener ?? {
      openPath: async (path) => {
        const { shell } = await import('electron');
        return shell.openPath(path);
      },
    };
  }

  selectImage(): Promise<string | null> {
    return this.select('选择人物照片', '图片', IMAGE_EXTENSIONS, 'image');
  }

  selectAudio(): Promise<string | null> {
    return this.select('选择配音音频', '音频', AUDIO_EXTENSIONS, 'audio');
  }

  async authorizeDroppedImage(filePath: string): Promise<string> {
    const extension = extname(filePath).toLowerCase().replace(/^\./, '');
    if (!IMAGE_EXTENSIONS.includes(extension)) {
      throw new Error(`Unsupported image extension: ${extension || '(none)'}`);
    }
    await this.mediaRegistry.authorizeSelectedImage(filePath);
    return filePath;
  }

  mediaUrl(filePath: string): Promise<string> {
    return this.mediaRegistry.createMediaUrl(filePath);
  }

  async openFolder(path: string): Promise<void> {
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Folder does not exist');
      }
      throw error;
    }

    const realRoots = await Promise.all(
      [this.outputDirectory, this.dataDirectory].map((root) => realpath(root).catch(() => null)),
    );
    if (!this.isAllowedFolder(resolved, realRoots.filter((root): root is string => root !== null))) {
      throw new Error('Folder path is not allowed');
    }

    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    const errorMessage = await this.opener.openPath(resolved);
    if (errorMessage.length > 0) {
      throw new Error(`Could not open folder: ${errorMessage}`);
    }
  }

  private isAllowedFolder(candidate: string, realRoots: string[]): boolean {
    for (const root of realRoots) {
      const rel = relative(root, candidate);
      if (
        rel.length > 0 &&
        rel !== '..' &&
        !rel.startsWith(`..${sep}`) &&
        !isAbsolute(rel)
      ) {
        return true;
      }
      if (rel === '') {
        return true;
      }
    }
    return false;
  }

  private async select(
    title: string,
    name: string,
    extensions: string[],
    kind: 'image' | 'audio',
  ): Promise<string | null> {
    const result = await this.dialog.showOpenDialog({
      title,
      properties: ['openFile'],
      filters: [{ name, extensions: [...extensions] }],
    });
    const filePath = result.canceled ? undefined : result.filePaths[0];
    if (filePath === undefined) {
      return null;
    }
    if (kind === 'image') {
      await this.mediaRegistry.authorizeSelectedImage(filePath);
    } else {
      await this.mediaRegistry.authorizeSelectedFile(filePath);
    }
    return filePath;
  }
}
