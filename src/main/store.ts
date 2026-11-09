import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Avatar,
  NewWork,
  Work,
  WorkMode,
  WorkStatus,
  WorkUpdate,
} from '../shared/types';

const WORK_COLUMN_NAMES = [
  'id',
  'avatarId',
  'mode',
  'outputPath',
  'status',
  'createdAt',
  'title',
  'completedAt',
  'promptId',
  'metadata',
  'error',
] as const;
const WORK_COLUMNS = WORK_COLUMN_NAMES.join(', ');
const WORK_MODES = new Set<WorkMode>(['text', 'audio', 'speech', 'image']);
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
    avatarId: row.avatarId as string | null,
    mode: row.mode as WorkMode,
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

function createWorksTable(db: DatabaseSync, tableName: 'works' | 'works_media'): void {
  db.exec(`
    CREATE TABLE ${tableName} (
      id TEXT PRIMARY KEY NOT NULL,
      avatarId TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('text', 'audio', 'speech', 'image')),
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
}

function assertForeignKeysValid(db: DatabaseSync): void {
  if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('Work migration failed the foreign key check');
  }
}

function migrateWorks(db: DatabaseSync, workColumns: Set<string>): void {
  assertForeignKeysValid(db);

  const sourceColumns = WORK_COLUMN_NAMES.map((column) =>
    workColumns.has(column) ? column : `NULL AS ${column}`,
  ).join(', ');

  // SQLite ignores foreign_keys changes inside a transaction, so both switches
  // deliberately remain outside BEGIN/COMMIT.
  db.exec('PRAGMA foreign_keys = OFF');
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    createWorksTable(db, 'works_media');
    db.exec(`
      INSERT INTO works_media (${WORK_COLUMNS})
      SELECT ${sourceColumns} FROM works;
      DROP TABLE works;
      ALTER TABLE works_media RENAME TO works;
    `);
    assertForeignKeysValid(db);
    db.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Work migration and rollback failed');
      }
    }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  assertForeignKeysValid(db);
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
      `);

      const worksTable = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'works'")
        .get();
      if (worksTable === undefined) {
        createWorksTable(db, 'works');
      } else {
        const workColumnRows = db.prepare('PRAGMA table_info(works)').all();
        const workColumns = new Set(workColumnRows.map((row) => row.name as string));
        const avatarId = workColumnRows.find((row) => row.name === 'avatarId');
        const worksSchema = worksTable.sql as string;
        if (
          avatarId?.notnull !== 0 ||
          !worksSchema.includes("'speech'") ||
          !worksSchema.includes("'image'")
        ) {
          migrateWorks(db, workColumns);
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
    if (!WORK_MODES.has(input.mode)) {
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
    if (trimmed.length > 120) {
      throw new Error('Work title must not exceed 120 characters');
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
