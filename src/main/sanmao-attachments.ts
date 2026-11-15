import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import type { SanmaoAttachmentMetadata } from '../shared/sanmao';
import type { SanmaoDraftAttachmentInput } from './sanmao-conversations';
import type { FileDialog } from './files';

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);
const TEXT_TYPES = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.log', 'text/plain'],
]);
const IMAGE_LIMIT = 5 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
const KIND_LIMIT = 4;

export type SanmaoContentBlock =
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | { type: 'text'; text: string };

function metadataOf(input: SanmaoDraftAttachmentInput): SanmaoAttachmentMetadata {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    mimeType: input.mimeType,
    size: input.size,
  };
}

export class SanmaoAttachmentService {
  private readonly authorized = new Map<string, SanmaoDraftAttachmentInput>();

  constructor(private readonly options: { dialog: FileDialog }) {}

  async selectAttachments(existingIds: string[]): Promise<SanmaoAttachmentMetadata[]> {
    const result = await this.options.dialog.showOpenDialog({
      title: '添加图片或文本附件',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: '支持的附件',
        extensions: [...IMAGE_TYPES.keys(), ...TEXT_TYPES.keys()].map((extension) => extension.slice(1)),
      }],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return this.authorizeDroppedAttachments(result.filePaths, existingIds);
  }

  async authorizeDroppedAttachments(
    paths: string[],
    existingIds: string[],
  ): Promise<SanmaoAttachmentMetadata[]> {
    const existing = this.resolve(existingIds);
    const candidates: SanmaoDraftAttachmentInput[] = [];
    for (const path of paths) candidates.push(await this.validate(path));
    const counts = { image: 0, text: 0 };
    for (const attachment of [...existing, ...candidates]) counts[attachment.kind] += 1;
    if (counts.image > KIND_LIMIT || counts.text > KIND_LIMIT) {
      throw new Error('图片和文本附件分别最多 4 个');
    }
    for (const attachment of candidates) this.authorized.set(attachment.id, attachment);
    return candidates.map(metadataOf);
  }

  getAuthorized(id: string): SanmaoDraftAttachmentInput | undefined {
    return this.authorized.get(id);
  }

  resolve(ids: string[]): SanmaoDraftAttachmentInput[] {
    return ids.map((id) => {
      const attachment = this.authorized.get(id);
      if (attachment === undefined) throw new Error('附件未授权或已移除');
      return attachment;
    });
  }

  restore(attachments: SanmaoDraftAttachmentInput[]): void {
    for (const attachment of attachments) this.authorized.set(attachment.id, attachment);
  }

  async createContentBlocks(
    attachments: SanmaoAttachmentMetadata[],
  ): Promise<SanmaoContentBlock[]> {
    const resolved = this.resolve(attachments.map((attachment) => attachment.id));
    const blocks: SanmaoContentBlock[] = [];
    for (const attachment of resolved) {
      const stats = await stat(attachment.sourcePath);
      if (!stats.isFile() || stats.size !== attachment.size) {
        throw new Error(`附件已变化，请重新添加：${attachment.name}`);
      }
      const limit = attachment.kind === 'image' ? IMAGE_LIMIT : TEXT_LIMIT;
      if (stats.size > limit) throw new Error(`附件超出大小限制：${attachment.name}`);
      const bytes = await readFile(attachment.sourcePath);
      if (attachment.kind === 'image') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mimeType,
            data: bytes.toString('base64'),
          },
        });
      } else {
        blocks.push({
          type: 'text',
          text: `附件 ${attachment.name}：\n${bytes.toString('utf8')}`,
        });
      }
    }
    return blocks;
  }

  private async validate(path: string): Promise<SanmaoDraftAttachmentInput> {
    if (!isAbsolute(path)) throw new Error('附件路径无效');
    const extension = extname(path).toLowerCase();
    const imageType = IMAGE_TYPES.get(extension);
    const textType = TEXT_TYPES.get(extension);
    if (imageType === undefined && textType === undefined) {
      throw new Error(`不支持的附件格式：${extension || '(无扩展名)'}`);
    }
    let sourcePath: string;
    try {
      sourcePath = await realpath(path);
    } catch {
      throw new Error(`附件不存在：${basename(path)}`);
    }
    const stats = await stat(sourcePath);
    if (!stats.isFile()) throw new Error(`附件不是文件：${basename(path)}`);
    const kind = imageType === undefined ? 'text' : 'image';
    const limit = kind === 'image' ? IMAGE_LIMIT : TEXT_LIMIT;
    if (stats.size > limit) {
      throw new Error(
        `${basename(path)} 超过 ${kind === 'image' ? '5 MiB' : '1 MiB'} 限制`,
      );
    }
    return {
      id: randomUUID(),
      name: basename(sourcePath),
      kind,
      mimeType: imageType ?? textType!,
      size: stats.size,
      sourcePath,
    };
  }
}
