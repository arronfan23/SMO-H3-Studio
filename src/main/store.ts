import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  Avatar,
  NewWork,
  VideoMode,
  Work,
  WorkStatus,
} from '../shared/types';

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
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
        FOREIGN KEY (avatarId) REFERENCES avatars(id) ON DELETE RESTRICT
      );
    `);
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

  addWork(input: NewWork): Work {
    if (input.mode !== 'text' && input.mode !== 'audio') {
      throw new Error(`Invalid video mode: ${String(input.mode)}`);
    }

    const work: Work = { ...input, createdAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO works (id, avatarId, mode, outputPath, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        work.id,
        work.avatarId,
        work.mode,
        work.outputPath,
        work.status,
        work.createdAt,
      );

    return work;
  }

  listWorks(): Work[] {
    return this.db
      .prepare(
        `SELECT id, avatarId, mode, outputPath, status, createdAt
         FROM works
         ORDER BY createdAt DESC, rowid DESC`,
      )
      .all()
      .map((row) => ({
        id: row.id as string,
        avatarId: row.avatarId as string,
        mode: row.mode as VideoMode,
        outputPath: row.outputPath as string | null,
        status: row.status as WorkStatus,
        createdAt: row.createdAt as string,
      }));
  }

  close(): void {
    this.db.close();
  }
}
