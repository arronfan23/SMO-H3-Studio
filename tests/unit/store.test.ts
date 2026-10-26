// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../../src/main/store';
import type { NewWork, VideoMode, WorkStatus } from '../../src/shared/types';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const temporaryDirectories: string[] = [];

function withStore<T>(run: (store: Store) => T, databasePath = ':memory:'): T {
  const store = new Store(databasePath);

  try {
    return run(store);
  } finally {
    store.close();
  }
}

function makeTemporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'smo-h3-store-'));
  temporaryDirectories.push(directory);

  return join(directory, 'library.db');
}

function makeWork(avatarId: string, id = 'work-1'): NewWork {
  return {
    id,
    avatarId,
    mode: 'text',
    outputPath: `works/${id}.mp4`,
    status: 'done',
  };
}

function expectIsoTimestamp(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

afterEach(() => {
  vi.useRealTimers();

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('avatar library', () => {
  test('creates and lists an avatar with a UUID and ISO creation time', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });

      expect(avatar).toMatchObject({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      expect(avatar.id).toMatch(UUID_V4_PATTERN);
      expectIsoTimestamp(avatar.createdAt);
      expect(store.listAvatars()).toEqual([avatar]);
    });
  });

  test('lists avatars by creation time in descending order', () => {
    vi.useFakeTimers();

    withStore((store) => {
      vi.setSystemTime('2026-10-25T08:00:00.000Z');
      const older = store.createAvatar({ name: 'Older', photoPath: 'avatars/older.jpg' });
      vi.setSystemTime('2026-10-25T09:00:00.000Z');
      const newer = store.createAvatar({ name: 'Newer', photoPath: 'avatars/newer.jpg' });

      expect(store.listAvatars()).toEqual([newer, older]);
    });
  });

  test('generates a unique UUID for each avatar', () => {
    withStore((store) => {
      const first = store.createAvatar({ name: 'First', photoPath: 'avatars/first.jpg' });
      const second = store.createAvatar({ name: 'Second', photoPath: 'avatars/second.jpg' });

      expect(first.id).toMatch(UUID_V4_PATTERN);
      expect(second.id).toMatch(UUID_V4_PATTERN);
      expect(second.id).not.toBe(first.id);
    });
  });

  test.each([
    {
      scenario: 'an empty name',
      input: { name: '', photoPath: 'avatars/lin.jpg' },
    },
    {
      scenario: 'a whitespace-only name',
      input: { name: '   ', photoPath: 'avatars/lin.jpg' },
    },
    {
      scenario: 'an empty photo path',
      input: { name: 'Lin', photoPath: '' },
    },
    {
      scenario: 'a whitespace-only photo path',
      input: { name: 'Lin', photoPath: ' \t ' },
    },
  ])('rejects $scenario', ({ input }) => {
    withStore((store) => {
      expect(() => store.createAvatar(input)).toThrow(/must not be empty/i);
      expect(store.listAvatars()).toEqual([]);
    });
  });
});

describe('work library', () => {
  test.each(['text', 'audio'] as const)('adds and lists a %s work', (mode) => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const input = { ...makeWork(avatar.id), mode };
      const work = store.addWork(input);

      expect(work).toMatchObject(input);
      expectIsoTimestamp(work.createdAt);
      expect(store.listWorks()).toEqual([work]);
    });
  });

  test('lists works by creation time in descending order', () => {
    vi.useFakeTimers();

    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      vi.setSystemTime('2026-10-25T08:00:00.000Z');
      const older = store.addWork(makeWork(avatar.id, 'older'));
      vi.setSystemTime('2026-10-25T09:00:00.000Z');
      const newer = store.addWork(makeWork(avatar.id, 'newer'));

      expect(store.listWorks()).toEqual([newer, older]);
    });
  });

  test('rejects an invalid video mode at runtime', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const input = { ...makeWork(avatar.id), mode: 'video' as VideoMode };

      expect(() => store.addWork(input)).toThrow('Invalid video mode');
      expect(store.listWorks()).toEqual([]);
    });
  });

  test('enforces the avatar foreign key without creating an orphan work', () => {
    withStore((store) => {
      expect(() => store.addWork(makeWork('missing-avatar'))).toThrow(
        /FOREIGN KEY constraint failed/i,
      );
      expect(store.listWorks()).toEqual([]);
    });
  });

  test.each([
    { scenario: 'empty', id: '' },
    { scenario: 'whitespace-only', id: ' \t ' },
  ])('rejects an $scenario work id', ({ id }) => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });

      expect(() => store.addWork(makeWork(avatar.id, id))).toThrow('Work id must not be empty');
      expect(store.listWorks()).toEqual([]);
    });
  });

  test('rejects an invalid status through the SQL constraint', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const input = { ...makeWork(avatar.id), status: 'archived' as WorkStatus };

      expect(() => store.addWork(input)).toThrow(/CHECK constraint failed/i);
      expect(store.listWorks()).toEqual([]);
    });
  });

  test('rejects a duplicate work primary key without replacing the original', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const original = store.addWork(makeWork(avatar.id, 'duplicate'));

      expect(() => store.addWork(makeWork(avatar.id, 'duplicate'))).toThrow(
        /UNIQUE constraint failed: works\.id/i,
      );
      expect(store.listWorks()).toEqual([original]);
    });
  });

  test('stores a pending work with a null output path', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const input: NewWork = {
        ...makeWork(avatar.id, 'pending'),
        outputPath: null,
        status: 'pending',
      };
      const work = store.addWork(input);

      expect(work).toMatchObject(input);
      expect(store.listWorks()).toEqual([work]);
    });
  });
});

describe('work updates', () => {
  test('updates and returns every whitelisted work field', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const work = store.addWork({
        ...makeWork(avatar.id),
        outputPath: null,
        status: 'pending',
      });
      const metadata = {
        request: {
          mode: 'text',
          avatarId: avatar.id,
          prompt: 'A quiet studio shot.',
          duration: 8,
          seed: 42,
        },
        workflowVersion: 'text-ref2va.json',
      };

      const updated = store.updateWork(work.id, {
        status: 'running',
        outputPath: 'works/preview.mp4',
        promptId: 'prompt-1',
        error: 'Temporary diagnostic',
        metadata,
      });

      expect(updated).toMatchObject({
        id: work.id,
        status: 'running',
        outputPath: 'works/preview.mp4',
        promptId: 'prompt-1',
        error: 'Temporary diagnostic',
        metadata,
      });
      expect(store.listWorks()).toEqual([updated]);
    });
  });

  test('clears nullable work fields without changing immutable fields', () => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const work = store.addWork({
        ...makeWork(avatar.id),
        promptId: 'prompt-1',
        error: 'Previous error',
        metadata: { workflowVersion: 'text-ref2va.json' },
      });

      const updated = store.updateWork(work.id, {
        outputPath: null,
        promptId: null,
        error: null,
        metadata: null,
      });

      expect(updated).toEqual({
        ...work,
        outputPath: null,
        promptId: null,
        error: null,
        metadata: null,
      });
    });
  });

  test.each([
    { id: 'replacement' },
    { avatarId: 'replacement' },
    { mode: 'audio' },
    { createdAt: '2026-10-26T00:00:00.000Z' },
    { unexpected: true },
  ])('rejects a non-whitelisted work update: %j', (update) => {
    withStore((store) => {
      const avatar = store.createAvatar({ name: 'Lin', photoPath: 'avatars/lin.jpg' });
      const work = store.addWork(makeWork(avatar.id));

      expect(() => store.updateWork(work.id, update as never)).toThrow(
        /unknown work update field/i,
      );
      expect(store.listWorks()).toEqual([work]);
    });
  });

  test('rejects an update for a work that does not exist', () => {
    withStore((store) => {
      expect(() => store.updateWork('missing', { status: 'failed' })).toThrow(
        /work not found/i,
      );
    });
  });
});

describe('schema initialization', () => {
  test('migrates the original works table without losing existing rows', () => {
    const databasePath = makeTemporaryDatabasePath();
    const database = new DatabaseSync(databasePath);
    const createdAt = '2026-10-25T08:00:00.000Z';

    try {
      database.exec(`
        CREATE TABLE avatars (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          photoPath TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE TABLE works (
          id TEXT PRIMARY KEY NOT NULL,
          avatarId TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('text', 'audio')),
          outputPath TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
          createdAt TEXT NOT NULL,
          FOREIGN KEY (avatarId) REFERENCES avatars(id) ON DELETE RESTRICT
        );
      `);
      database
        .prepare('INSERT INTO avatars (id, name, photoPath, createdAt) VALUES (?, ?, ?, ?)')
        .run('avatar-old', 'Old avatar', 'avatars/old.jpg', createdAt);
      database
        .prepare(
          `INSERT INTO works (id, avatarId, mode, outputPath, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('work-old', 'avatar-old', 'audio', 'works/old.mp4', 'done', createdAt);
    } finally {
      database.close();
    }

    withStore((store) => {
      expect(store.listWorks()).toEqual([
        {
          id: 'work-old',
          avatarId: 'avatar-old',
          mode: 'audio',
          outputPath: 'works/old.mp4',
          status: 'done',
          createdAt,
          promptId: null,
          metadata: null,
          error: null,
        },
      ]);

      store.updateWork('work-old', {
        promptId: 'prompt-old',
        metadata: { workflowVersion: 'audio-digital-human.json' },
      });
    }, databasePath);

    const migrated = new DatabaseSync(databasePath);
    try {
      expect(migrated.prepare('SELECT COUNT(*) AS count FROM works').get()?.count).toBe(1);
      expect(migrated.prepare('SELECT promptId FROM works WHERE id = ?').get('work-old')).toEqual({
        promptId: 'prompt-old',
      });
    } finally {
      migrated.close();
    }
  });

  test('closes the database after a failure so the file can be recreated', () => {
    const databasePath = makeTemporaryDatabasePath();
    const database = new DatabaseSync(databasePath);

    try {
      database.exec(`
        CREATE TABLE schema_conflict (id INTEGER);
        CREATE INDEX avatars ON schema_conflict(id);
      `);
     } finally {
       database.close();
     }

    expect(() => new Store(databasePath)).toThrow();
    rmSync(databasePath);

    withStore((store) => {
      expect(store.listAvatars()).toEqual([]);
      expect(store.listWorks()).toEqual([]);
    }, databasePath);
  });
});

describe('file persistence', () => {
  test('retains avatars and works after closing and reopening the database', () => {
    const databasePath = makeTemporaryDatabasePath();

    const { avatar, work } = withStore((store) => {
      const createdAvatar = store.createAvatar({
        name: 'Persistent',
        photoPath: 'avatars/persistent.jpg',
      });
      const createdWork = store.addWork(makeWork(createdAvatar.id, 'persistent'));

      return { avatar: createdAvatar, work: createdWork };
    }, databasePath);

    withStore((store) => {
      expect(store.listAvatars()).toEqual([avatar]);
      expect(store.listWorks()).toEqual([work]);
    }, databasePath);
  });
});
