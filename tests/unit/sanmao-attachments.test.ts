// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core';
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { SanmaoAttachmentService } from '../../src/main/sanmao-attachments';
import type { FileDialog } from '../../src/main/files';
import { SanmaoConversationStore } from '../../src/main/sanmao-conversations';
import { SanmaoService, type SanmaoQueryInput } from '../../src/main/sanmao-service';

const credentials = {
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-test',
  apiKey: 'secret',
};

describe('SanmaoAttachmentService', () => {
  let directory: string;
  let service: SanmaoAttachmentService;
  let showOpenDialog: Mock<FileDialog['showOpenDialog']>;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-sanmao-attachments-'));
    showOpenDialog = vi.fn<FileDialog['showOpenDialog']>();
    service = new SanmaoAttachmentService({ dialog: { showOpenDialog } });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('converts authorized images and text into SDK content blocks without paths', async () => {
    const imagePath = join(directory, 'reference.png');
    const textPath = join(directory, 'brief.md');
    const imageBytes = Buffer.from([0, 1, 2, 255]);
    await writeFile(imagePath, imageBytes);
    await writeFile(textPath, '真实附件内容', 'utf8');

    const attachments = await service.authorizeDroppedAttachments([imagePath, textPath], []);

    expect(attachments.map((attachment) => attachment.kind)).toEqual(['image', 'text']);
    expect(attachments[0]).not.toHaveProperty('sourcePath');
    const blocks = await service.createContentBlocks(attachments);
    expect(blocks).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageBytes.toString('base64'),
        },
      },
      {
        type: 'text',
        text: '附件 brief.md：\n真实附件内容',
      },
    ]);
    expect(JSON.stringify(blocks)).not.toContain(directory);
  });

  test('selects multiple files through the native dialog', async () => {
    const textPath = join(directory, 'notes.txt');
    await writeFile(textPath, 'notes');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [textPath] });

    const selected = await service.selectAttachments([]);

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile', 'multiSelections'],
    }));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ name: 'notes.txt', kind: 'text', size: 5 });
  });

  test('rejects unsupported files, oversized content, and more than four per kind', async () => {
    const unsupported = join(directory, 'animation.gif');
    const largeImage = join(directory, 'large.png');
    const largeText = join(directory, 'large.txt');
    await writeFile(unsupported, 'gif');
    await writeFile(largeImage, Buffer.alloc(5 * 1024 * 1024 + 1));
    await writeFile(largeText, Buffer.alloc(1024 * 1024 + 1));

    await expect(service.authorizeDroppedAttachments([unsupported], [])).rejects.toThrow(/格式/);
    await expect(service.authorizeDroppedAttachments([largeImage], [])).rejects.toThrow(/5\s*MiB/i);
    await expect(service.authorizeDroppedAttachments([largeText], [])).rejects.toThrow(/1\s*MiB/i);

    const textPaths = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const path = join(directory, `note-${index}.txt`);
      await writeFile(path, String(index));
      return path;
    }));
    await expect(service.authorizeDroppedAttachments(textPaths, [])).rejects.toThrow(/最多 4/);
  });

  test('refuses to read attachment IDs that were not authorized', async () => {
    await expect(service.createContentBlocks([{
      id: 'not-authorized',
      name: 'private.txt',
      kind: 'text',
      mimeType: 'text/plain',
      size: 4,
    }])).rejects.toThrow(/授权/);
  });

  test('sends effort and real attachments through an AsyncIterable SDK user message', async () => {
    const imagePath = join(directory, 'sdk.webp');
    await writeFile(imagePath, Buffer.from([9, 8, 7]));
    const attachments = await service.authorizeDroppedAttachments([imagePath], []);
    const conversations = new SanmaoConversationStore(':memory:');
    let captured: SanmaoQueryInput | undefined;
    const sanmao = new SanmaoService({
      store: { getCredentials: async () => credentials },
      conversations,
      attachments: service,
      queryImpl: (input) => {
        captured = input;
        return (async function* () {
          yield { type: 'result', subtype: 'success', is_error: false, result: '完成' };
        })();
      },
      claudeExecutablePath: 'G:\\claude-test\\claude.exe',
    });

    await sanmao.send({
      conversationId: '00000000-0000-4000-8000-000000000401',
      replyId: '00000000-0000-4000-8000-000000000402',
      text: '分析这些材料',
      effort: 'high',
      attachments,
      onText: () => undefined,
    });

    expect(captured?.options.effort).toBe('high');
    expect(captured?.prompt).not.toBeTypeOf('string');
    const prompt = captured?.prompt as AsyncIterable<SDKUserMessage>;
    const messages: SDKUserMessage[] = [];
    for await (const message of prompt) messages.push(message);
    expect(messages).toHaveLength(1);
    expect(messages[0].message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('分析这些材料') }),
      expect.objectContaining({
        type: 'image',
        source: expect.objectContaining({ media_type: 'image/webp' }),
      }),
    ]));
    expect(conversations.getConversation('00000000-0000-4000-8000-000000000401')?.messages[0].attachments)
      .toEqual(attachments);
    sanmao.close();
  });
});
