import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Avatar,
  NewWork,
  VideoMode,
  Work,
  WorkStatus,
  WorkUpdate,
} from '../shared/types';

const WORK_COLUMNS =
  'id, avatarId, mode, outputPath, status, createdAt, title, completedAt, promptId, metadata, error';
const WORK_UPDATE_FIELDS = new Set([
  'status',
  'outputPath',
  'title',
  'completedAt',
  'promptId',
  'error',
  'metadata',
]);

function serializeMetadata(metadata: Work['metadata']): string | null {
  if (metadata === null) {
    return null;
  }
  const serialized = JSON.stringify(metadata);
  if (serialized === undefined) {
    throw new Error('Work metadata must be JSON serializable');
  }
  return serialized;
}

function toWork(row: Record<string, unknown>): Work {
  return {
    id: row.id as string,
    avatarId: row.avatarId as string,
    mode: row.mode as VideoMode,
    outputPath: row.outputPath as string | null,
    status: row.status as WorkStatus,
    createdAt: row.createdAt as string,
    title: row.title as string | null,
    completedAt: row.completedAt as string | null,
    promptId: row.promptId as string | null,
    metadata:
      row.metadata === null
        ? null
        : (JSON.parse(row.metadata as string) as Work['metadata']),
    error: row.error as string | null,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const db = new DatabaseSync(path);

    try {
      db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS avatars (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          photoPath TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS works (
          id TEXT PRIMARY KEY NOT NULL,
          avatarId TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('text', 'audio')),
          outputPath TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
          createdAt TEXT NOT NULL,
          title TEXT,
          completedAt TEXT,
          promptId TEXT,
          metadata TEXT,
          error TEXT,
          FOREIGN KEY (avatarId) REFERENCES avatars(id) ON DELETE RESTRICT
        );
      `);

      const workColumns = new Set(
        db
          .prepare('PRAGMA table_info(works)')
          .all()
          .map((row) => row.name as string),
      );
      for (const column of ['title', 'completedAt', 'promptId', 'metadata', 'error']) {
        if (!workColumns.has(column)) {
          db.exec(`ALTER TABLE works ADD COLUMN ${column} TEXT`);
        }
      }
    } catch (error) {
      db.close();
      throw error;
    }

    this.db = db;
  }

  createAvatar(input: { name: string; photoPath: string }): Avatar {
    if (input.name.trim().length === 0) {
      throw new Error('Avatar name must not be empty');
    }
    if (input.photoPath.trim().length === 0) {
      throw new Error('Avatar photo path must not be empty');
    }

    const avatar: Avatar = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO avatars (id, name, photoPath, createdAt) VALUES (?, ?, ?, ?)')
      .run(avatar.id, avatar.name, avatar.photoPath, avatar.createdAt);

    return avatar;
  }

  listAvatars(): Avatar[] {
    return this.db
      .prepare(
        'SELECT id, name, photoPath, createdAt FROM avatars ORDER BY createdAt DESC, rowid DESC',
      )
      .all()
      .map((row) => ({
        id: row.id as string,
        name: row.name as string,
        photoPath: row.photoPath as string,
        createdAt: row.createdAt as string,
      }));
  }

  updateAvatar(id: string, input: { name: string }): Avatar {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error('Avatar name must not be empty');
    }
    const avatar = this.findAvatar(id);
    if (avatar === null) {
      throw new Error(`Avatar not found: ${id}`);
    }

    this.db.prepare('UPDATE avatars SET name = ? WHERE id = ?').run(name, id);
    return { ...avatar, name };
  }

  deleteAvatar(id: string): Avatar {
    const avatar = this.findAvatar(id);
    if (avatar === null) {
      throw new Error(`Avatar not found: ${id}`);
    }

    const result = this.db
      .prepare(
        `DELETE FROM avatars
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM works WHERE avatarId = ?)`,
      )
      .run(id, id);
    if (result.changes !== 1) {
      throw new Error('Avatar cannot be deleted while works exist');
    }
    return avatar;
  }

  addWork(input: NewWork): Work {
    if (input.id.trim().length === 0) {
      throw new Error('Work id must not be empty');
    }
    if (input.mode !== 'text' && input.mode !== 'audio') {
      throw new Error(`Invalid video mode: ${String(input.mode)}`);
    }

    const work: Work = {
      ...input,
      title: input.title ?? null,
      completedAt: input.completedAt ?? null,
      promptId: input.promptId ?? null,
      metadata: input.metadata ?? null,
      error: input.error ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO works (id, avatarId, mode, outputPath, status, createdAt, title, completedAt, promptId, metadata, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        work.id,
        work.avatarId,
        work.mode,
        work.outputPath,
        work.status,
        work.createdAt,
        work.title,
        work.completedAt,
        work.promptId,
        serializeMetadata(work.metadata),
        work.error,
      );

    return work;
  }

  listWorks(): Work[] {
    return this.db
      .prepare(
        `SELECT ${WORK_COLUMNS}
         FROM works
         ORDER BY createdAt DESC, rowid DESC`,
      )
      .all()
      .map((row) => toWork(row));
  }

  getWork(id: string): Work | null {
    const row = this.db
      .prepare(`SELECT ${WORK_COLUMNS} FROM works WHERE id = ?`)
      .get(id);
    return row === undefined ? null : toWork(row);
  }

  updateWork(id: string, update: WorkUpdate): Work {
    const entries = Object.entries(update);
    for (const [field, value] of entries) {
      if (!WORK_UPDATE_FIELDS.has(field)) {
        throw new Error(`Unknown work update field: ${field}`);
      }
      if (value === undefined) {
        throw new Error(`Work update field must not be undefined: ${field}`);
      }
    }

    const work = this.getWork(id);
    if (work === null) {
      throw new Error(`Work not found: ${id}`);
    }
    if (entries.length === 0) {
      return work;
    }

    const values = entries.map(([field, value]) =>
      field === 'metadata'
        ? serializeMetadata(value as Work['metadata'])
        : (value as string | null),
    );
    this.db
      .prepare(
        `UPDATE works SET ${entries.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`,
      )
      .run(...values, id);

    return this.getWork(id)!;
  }

  /** Renames a work in the database only; the output file is never touched. */
  renameWork(id: string, title: string): Work {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new Error('Work title must not be empty');
    }
    return this.updateWork(id, { title: trimmed });
  }

  deleteWork(id: string): Work {
    const work = this.getWork(id);
    if (work === null) {
      throw new Error(`Work not found: ${id}`);
    }
    if (work.status !== 'done' && work.status !== 'failed') {
      throw new Error('Only completed or failed works can be deleted');
    }
    const result = this.db
      .prepare("DELETE FROM works WHERE id = ? AND status IN ('done', 'failed')")
      .run(id);
    if (result.changes !== 1) {
      throw new Error('Only completed or failed works can be deleted');
    }
    return work;
  }

  close(): void {
    this.db.close();
  }

  private findAvatar(id: string): Avatar | null {
    const row = this.db
      .prepare('SELECT id, name, photoPath, createdAt FROM avatars WHERE id = ?')
      .get(id);
    return row === undefined
      ? null
      : {
          id: row.id as string,
          name: row.name as string,
          photoPath: row.photoPath as string,
          createdAt: row.createdAt as string,
        };
  }
}
