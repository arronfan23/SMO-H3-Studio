import type { MediaRegistry } from './media';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a'];

export interface FileDialog {
  showOpenDialog(options: {
    title: string;
    properties: ['openFile'];
    filters: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export class FileService {
  constructor(
    private readonly mediaRegistry: MediaRegistry,
    private readonly dialog: FileDialog,
  ) {}

  selectImage(): Promise<string | null> {
    return this.select('选择人物照片', '图片', IMAGE_EXTENSIONS);
  }

  selectAudio(): Promise<string | null> {
    return this.select('选择配音音频', '音频', AUDIO_EXTENSIONS);
  }

  mediaUrl(filePath: string): Promise<string> {
    return this.mediaRegistry.createMediaUrl(filePath);
  }

  private async select(
    title: string,
    name: string,
    extensions: string[],
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
    await this.mediaRegistry.authorizeSelectedFile(filePath);
    return filePath;
  }
}
