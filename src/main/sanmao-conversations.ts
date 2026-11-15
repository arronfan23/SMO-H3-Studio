import { DatabaseSync } from 'node:sqlite';
import type {
  SanmaoAttachmentMetadata,
  SanmaoConversation,
  SanmaoConversationSummary,
  SanmaoEffort,
  SanmaoMessage,
} from '../shared/sanmao';

export interface SanmaoDraftAttachmentInput extends SanmaoAttachmentMetadata {
  sourcePath: string;
}

interface ConversationInput {
  id: string;
  title?: string;
  model: string;
  effort?: SanmaoEffort;
}

interface AppendMessageInput {
  conversationId: string;
  model: string;
  effort?: SanmaoEffort;
  message: SanmaoMessage;
}

interface DraftInput {
  conversationId: string;
  model: string;
  effort?: SanmaoEffort;
  draft: string;
  attachments: SanmaoDraftAttachmentInput[];
}

function now(): string {
  return new Date().toISOString();
}

function conversationTitle(text: string): string {
  return text.trim().slice(0, 40) || '新会话';
}

export class SanmaoConversationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sanmao_conversations (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
        draft TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sanmao_messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        attachments TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES sanmao_conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sanmao_draft_attachments (
        id TEXT PRIMARY KEY NOT NULL,
        conversationId TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'text')),
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        sourcePath TEXT NOT NULL,
        sortOrder INTEGER NOT NULL,
        FOREIGN KEY (conversationId) REFERENCES sanmao_conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS sanmao_messages_conversation
        ON sanmao_messages(conversationId, createdAt);
      CREATE INDEX IF NOT EXISTS sanmao_drafts_conversation
        ON sanmao_draft_attachments(conversationId, sortOrder);
    `);
  }

  createConversation(input: ConversationInput): SanmaoConversation {
    const timestamp = now();
    this.db.prepare(
      `INSERT INTO sanmao_conversations
       (id, title, model, effort, draft, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
    ).run(
      input.id,
      input.title?.trim() || '新会话',
      input.model,
      input.effort ?? 'medium',
      timestamp,
      timestamp,
    );
    return this.getConversation(input.id)!;
  }

  appendMessage(input: AppendMessageInput): SanmaoMessage {
    return this.inTransaction(() => {
      this.ensureConversation({
        id: input.conversationId,
        title: input.message.role === 'user' ? conversationTitle(input.message.text) : '新会话',
        model: input.model,
        effort: input.effort,
      });
      const timestamp = now();
      const message: SanmaoMessage = {
        ...input.message,
        createdAt: timestamp,
      };
      this.db.prepare(
        `INSERT INTO sanmao_messages (id, conversationId, role, text, attachments, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        message.id,
        input.conversationId,
        message.role,
        message.text,
        message.attachments === undefined ? null : JSON.stringify(message.attachments),
        timestamp,
      );
      this.db.prepare(
        `UPDATE sanmao_conversations
         SET model = ?, effort = ?, updatedAt = ?
         WHERE id = ?`,
      ).run(input.model, input.effort ?? 'medium', timestamp, input.conversationId);
      if (message.role === 'user') {
        this.db.prepare(
          'UPDATE sanmao_conversations SET draft = \'\' WHERE id = ?',
        ).run(input.conversationId);
        this.db.prepare(
          'DELETE FROM sanmao_draft_attachments WHERE conversationId = ?',
        ).run(input.conversationId);
      }
      return message;
    });
  }

  listConversations(): SanmaoConversationSummary[] {
    return this.db.prepare(
      `SELECT id, title, model, effort, draft, createdAt, updatedAt
       FROM sanmao_conversations
       ORDER BY updatedAt DESC, rowid DESC`,
    ).all().map((row) => this.toSummary(row));
  }

  getConversation(id: string): SanmaoConversation | null {
    const row = this.db.prepare(
      `SELECT id, title, model, effort, draft, createdAt, updatedAt
       FROM sanmao_conversations WHERE id = ?`,
    ).get(id);
    if (row === undefined) return null;
    const messages = this.db.prepare(
      `SELECT id, role, text, attachments, createdAt
       FROM sanmao_messages WHERE conversationId = ?
       ORDER BY createdAt, rowid`,
    ).all(id).map((message) => ({
      id: message.id as string,
      role: message.role as SanmaoMessage['role'],
      text: message.text as string,
      createdAt: message.createdAt as string,
      ...(message.attachments === null
        ? {}
        : { attachments: JSON.parse(message.attachments as string) as SanmaoAttachmentMetadata[] }),
    }));
    const draftAttachments = this.db.prepare(
      `SELECT id, name, kind, mimeType, size
       FROM sanmao_draft_attachments WHERE conversationId = ?
       ORDER BY sortOrder, rowid`,
    ).all(id).map((attachment) => ({
      id: attachment.id as string,
      name: attachment.name as string,
      kind: attachment.kind as SanmaoAttachmentMetadata['kind'],
      mimeType: attachment.mimeType as string,
      size: attachment.size as number,
    }));
    return {
      ...this.toSummary(row),
      messages,
      draftAttachments,
    };
  }

  getDraftAttachmentInputs(conversationId: string): SanmaoDraftAttachmentInput[] {
    return this.db.prepare(
      `SELECT id, name, kind, mimeType, size, sourcePath
       FROM sanmao_draft_attachments WHERE conversationId = ?
       ORDER BY sortOrder, rowid`,
    ).all(conversationId).map((attachment) => ({
      id: attachment.id as string,
      name: attachment.name as string,
      kind: attachment.kind as SanmaoAttachmentMetadata['kind'],
      mimeType: attachment.mimeType as string,
      size: attachment.size as number,
      sourcePath: attachment.sourcePath as string,
    }));
  }

  updateDraft(input: DraftInput): SanmaoConversation {
    return this.inTransaction(() => {
      this.ensureConversation({
        id: input.conversationId,
        model: input.model,
        effort: input.effort,
      });
      this.db.prepare(
        `UPDATE sanmao_conversations
         SET model = ?, effort = ?, draft = ?, updatedAt = ?
         WHERE id = ?`,
      ).run(
        input.model,
        input.effort ?? 'medium',
        input.draft,
        now(),
        input.conversationId,
      );
      this.db.prepare(
        'DELETE FROM sanmao_draft_attachments WHERE conversationId = ?',
      ).run(input.conversationId);
      const insert = this.db.prepare(
        `INSERT INTO sanmao_draft_attachments
         (id, conversationId, name, kind, mimeType, size, sourcePath, sortOrder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.attachments.forEach((attachment, index) => {
        insert.run(
          attachment.id,
          input.conversationId,
          attachment.name,
          attachment.kind,
          attachment.mimeType,
          attachment.size,
          attachment.sourcePath,
          index,
        );
      });
      return this.getConversation(input.conversationId)!;
    });
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM sanmao_conversations WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }

  private ensureConversation(input: ConversationInput): void {
    const exists = this.db.prepare(
      'SELECT 1 AS present FROM sanmao_conversations WHERE id = ?',
    ).get(input.id);
    if (exists === undefined) this.createConversation(input);
  }

  private toSummary(row: Record<string, unknown>): SanmaoConversationSummary {
    return {
      id: row.id as string,
      title: row.title as string,
      model: row.model as string,
      effort: row.effort as SanmaoEffort,
      draft: row.draft as string,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
    };
  }

  private inTransaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
