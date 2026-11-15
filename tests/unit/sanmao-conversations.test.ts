// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SanmaoConversationStore } from '../../src/main/sanmao-conversations';

const firstId = '00000000-0000-4000-8000-000000000101';
const secondId = '00000000-0000-4000-8000-000000000102';

describe('SanmaoConversationStore', () => {
  let directory: string;
  let databasePath: string;
  let store: SanmaoConversationStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-sanmao-conversations-'));
    databasePath = join(directory, 'studio.sqlite');
    store = new SanmaoConversationStore(databasePath);
  });

  afterEach(async () => {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('creates a conversation from the first user message and keeps ordered history', () => {
    const text = '  请帮我整理这一段口播文案，保留产品参数并压缩到四十个字以内。  ';
    store.appendMessage({
      conversationId: firstId,
      model: 'claude-a',
      effort: 'low',
      message: { id: 'message-user', role: 'user', text },
    });
    store.appendMessage({
      conversationId: firstId,
      model: 'claude-a',
      effort: 'low',
      message: { id: 'message-assistant', role: 'assistant', text: '整理后的文案' },
    });

    const conversation = store.getConversation(firstId);
    expect(conversation).toMatchObject({
      id: firstId,
      title: text.trim().slice(0, 40),
      model: 'claude-a',
      effort: 'low',
      draft: '',
    });
    expect(conversation?.messages.map((message) => message.id)).toEqual([
      'message-user',
      'message-assistant',
    ]);
    expect(store.listConversations()).toHaveLength(1);
    expect(store.listConversations()[0]).not.toHaveProperty('messages');
  });

  test('persists model, effort, draft and safe attachment metadata after reopening', () => {
    store.updateDraft({
      conversationId: firstId,
      model: 'claude-b',
      effort: 'high',
      draft: '尚未发送的草稿',
      attachments: [{
        id: 'attachment-1',
        name: 'brief.txt',
        kind: 'text',
        mimeType: 'text/plain',
        size: 128,
        sourcePath: 'G:\\private\\brief.txt',
      }],
    });

    const before = store.getConversation(firstId);
    expect(before).toMatchObject({
      title: '新会话',
      model: 'claude-b',
      effort: 'high',
      draft: '尚未发送的草稿',
    });
    expect(before?.draftAttachments).toEqual([{
      id: 'attachment-1',
      name: 'brief.txt',
      kind: 'text',
      mimeType: 'text/plain',
      size: 128,
    }]);
    expect(before?.draftAttachments[0]).not.toHaveProperty('sourcePath');
    store.close();

    store = new SanmaoConversationStore(databasePath);
    expect(store.getConversation(firstId)).toEqual(before);
  });

  test('names a draft-created conversation from its first user message', () => {
    store.updateDraft({
      conversationId: firstId,
      model: 'claude-a',
      draft: '先保存的草稿',
      attachments: [],
    });
    expect(store.getConversation(firstId)?.title).toBe('新会话');

    store.appendMessage({
      conversationId: firstId,
      model: 'claude-a',
      message: { id: 'first-user', role: 'user', text: '首条消息应该成为标题' },
    });

    expect(store.getConversation(firstId)?.title).toBe('首条消息应该成为标题');
  });

  test('deletes only the selected conversation and cascades its messages and drafts', () => {
    store.createConversation({ id: firstId, model: 'claude-a' });
    store.createConversation({ id: secondId, model: 'claude-a' });
    store.appendMessage({
      conversationId: firstId,
      model: 'claude-a',
      message: { id: 'first-message', role: 'user', text: '删除这个会话' },
    });
    store.updateDraft({
      conversationId: firstId,
      model: 'claude-a',
      draft: '草稿',
      attachments: [],
    });
    store.appendMessage({
      conversationId: secondId,
      model: 'claude-a',
      message: { id: 'second-message', role: 'user', text: '保留这个会话' },
    });

    store.deleteConversation(firstId);

    expect(store.getConversation(firstId)).toBeNull();
    expect(store.getConversation(secondId)?.messages.map((message) => message.id))
      .toEqual(['second-message']);
    expect(store.listConversations().map((conversation) => conversation.id))
      .toEqual([secondId]);
    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM sanmao_messages').get())
        .toEqual({ count: 1 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM sanmao_draft_attachments').get())
        .toEqual({ count: 0 });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
