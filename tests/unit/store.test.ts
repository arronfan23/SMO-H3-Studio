// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../../src/main/store';
import type { NewWork, VideoMode } from '../../src/shared/types';

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
});

describe('file persistence', () => {
  test('retains avatars and works after closing and reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smo-h3-store-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'library.db');

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
