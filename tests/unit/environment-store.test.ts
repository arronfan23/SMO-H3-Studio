// @vitest-environment node

import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  EnvironmentStore,
  resolveEnvironmentPaths,
} from '../../src/main/environment-store';
import type {
  EnvironmentConfig,
  EnvironmentPaths,
} from '../../src/shared/environment';

const directories: string[] = [];

interface AtomicWriter {
  writeAtomically(config: EnvironmentConfig): Promise<void>;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  return {
    schemaVersion: 1,
    runtimeId: 'sm89',
    runtimeRoot: 'G:\\SMO\\runtime',
    modelDirectory: 'G:\\SMO\\models',
    outputDirectory: 'G:\\SMO\\output',
    profile: 'balanced-16gb',
    hardwareFingerprint: {
      gpu: 'NVIDIA GeForce RTX 4090',
      vramGiB: 24,
      ramGiB: 64,
      cudaComputeCapability: '8.9',
    },
    manifestVersion: '2026.10.29',
    status: 'installing',
    createdAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:05:00.000Z',
    ...overrides,
  };
}

async function useStore(): Promise<{
  store: EnvironmentStore;
  path: string;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-environment-store-'));
  directories.push(directory);
  const path = join(directory, 'environment.json');
  return { store: new EnvironmentStore(path), path, directory };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('EnvironmentStore persistence', () => {
  test('returns null when the configuration does not exist', async () => {
    const { store } = await useStore();

    await expect(store.load()).resolves.toBeNull();
  });

  test.each(['installing', 'failed'] as const)(
    'roundtrips a valid %s configuration without changing its fields',
    async (status) => {
      const { store } = await useStore();
      const config = makeConfig({ status });
      const snapshot = structuredClone(config);

      await store.save(config);

      await expect(store.load()).resolves.toEqual(config);
      expect(config).toEqual(snapshot);
    },
  );

  test('loads a valid ready configuration from disk', async () => {
    const { store, path } = await useStore();
    const config = makeConfig({ status: 'ready' });
    await writeJson(path, config);

    await expect(store.load()).resolves.toEqual(config);
  });

  test('rejects malformed JSON instead of treating it as a missing configuration', async () => {
    const { store, path } = await useStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{not valid JSON', 'utf8');

    await expect(store.load()).rejects.toThrow(/environment configuration.*JSON/i);
  });

  test.each([0, 2, '1'])('rejects schemaVersion %s', async (schemaVersion) => {
    const { store, path } = await useStore();
    const config = { ...makeConfig(), schemaVersion };
    await writeJson(path, config);

    await expect(store.load()).rejects.toThrow(/schemaVersion/i);
  });

  test('rejects a missing required field', async () => {
    const { store, path } = await useStore();
    const config = structuredClone(makeConfig()) as any;
    delete config.outputDirectory;
    await writeJson(path, config);

    await expect(store.load()).rejects.toThrow(/outputDirectory/i);
  });

  test.each([
    {
      scenario: 'root',
      mutate: (config: any) => {
        config.unknown = true;
      },
    },
    {
      scenario: 'hardware fingerprint',
      mutate: (config: any) => {
        config.hardwareFingerprint.unknown = true;
      },
    },
  ])('rejects an unknown field at the $scenario level', async ({ mutate }) => {
    const { store, path } = await useStore();
    const config = structuredClone(makeConfig()) as any;
    mutate(config);
    await writeJson(path, config);

    await expect(store.load()).rejects.toThrow(/unrecognized|unknown/i);
  });

  test.each(['createdAt', 'updatedAt'] as const)(
    'rejects an invalid ISO timestamp in %s',
    async (field) => {
      const { store, path } = await useStore();
      const config = structuredClone(makeConfig()) as any;
      config[field] = '2026-02-30T08:00:00.000Z';
      await writeJson(path, config);

      await expect(store.load()).rejects.toThrow(new RegExp(`${field}|ISO`, 'i'));
    },
  );

  test.each([
    { field: 'vramGiB', value: 0 },
    { field: 'vramGiB', value: -1 },
    { field: 'vramGiB', value: Number.POSITIVE_INFINITY },
    { field: 'ramGiB', value: Number.NaN },
    { field: 'ramGiB', value: '64' },
  ])('rejects invalid hardware value $field: $value', async ({ field, value }) => {
    const { store } = await useStore();
    const config = structuredClone(makeConfig()) as any;
    config.hardwareFingerprint[field] = value;

    await expect(store.save(config)).rejects.toThrow(
      /environment configuration/i,
    );
  });

  test.each(['', '   '])('rejects a blank GPU name: %j', async (gpu) => {
    const { store } = await useStore();
    const config = structuredClone(makeConfig()) as any;
    config.hardwareFingerprint.gpu = gpu;

    await expect(store.save(config)).rejects.toThrow(/gpu/i);
  });

  test.each([
    { field: 'runtimeId', value: 'sm100' },
    { field: 'profile', value: 'maximum' },
    { field: 'status', value: 'unknown' },
  ])('rejects invalid enum value $field: $value', async ({ field, value }) => {
    const { store } = await useStore();
    const config = structuredClone(makeConfig()) as any;
    config[field] = value;

    await expect(store.save(config)).rejects.toThrow(
      new RegExp(`${field}|environment configuration`, 'i'),
    );
  });
});

describe('EnvironmentStore Windows path validation', () => {
  const pathFields = ['runtimeRoot', 'modelDirectory', 'outputDirectory'] as const;
  const unsafePaths = [
    { label: 'empty', value: '' },
    { label: 'relative', value: 'SMO\\runtime' },
    { label: 'relative with forward slashes', value: 'SMO/runtime' },
    { label: 'drive-relative', value: 'C:SMO\\runtime' },
    { label: 'root-relative', value: '\\SMO\\runtime' },
    { label: 'root-relative with a forward slash', value: '/SMO/runtime' },
    { label: 'parent traversal', value: 'G:\\SMO\\..\\runtime' },
    { label: 'parent traversal with forward slashes', value: 'G:/SMO/../runtime' },
    { label: 'UNC parent traversal', value: '\\\\server\\share\\..\\runtime' },
    { label: 'alternate data stream', value: 'G:\\SMO\\runtime:stream' },
    { label: 'NUL', value: 'G:\\SMO\\bad\0name' },
    { label: 'control character', value: 'G:\\SMO\\bad\x1Fname' },
    { label: 'CON device', value: 'G:\\SMO\\CON' },
    { label: 'device with extension', value: 'G:\\SMO\\prn.txt' },
    { label: 'COM device segment', value: 'G:\\SMO\\COM1\\runtime' },
    { label: 'LPT device', value: 'G:\\SMO\\LPT9' },
    { label: 'CONIN$ device', value: 'G:\\SMO\\CONIN$' },
    { label: 'lowercase CONOUT$ device', value: 'G:\\SMO\\conout$' },
    { label: 'CONIN$ device with extension', value: 'G:\\SMO\\CONIN$.txt' },
    { label: 'CONOUT$ device with extension', value: 'G:\\SMO\\conout$.log' },
    { label: 'superscript COM1 device', value: 'G:\\SMO\\COM¹' },
    { label: 'superscript COM2 device', value: 'G:\\SMO\\com²' },
    { label: 'superscript COM3 device', value: 'G:\\SMO\\Com³' },
    { label: 'superscript COM1 device with extension', value: 'G:\\SMO\\COM¹.txt' },
    { label: 'superscript COM2 device with extension', value: 'G:\\SMO\\com².log' },
    { label: 'superscript COM3 device with extension', value: 'G:\\SMO\\Com³.json' },
    { label: 'superscript LPT1 device', value: 'G:\\SMO\\LPT¹' },
    { label: 'superscript LPT2 device', value: 'G:\\SMO\\lpt²' },
    { label: 'superscript LPT3 device', value: 'G:\\SMO\\Lpt³' },
    { label: 'superscript LPT1 device with extension', value: 'G:\\SMO\\LPT¹.txt' },
    { label: 'superscript LPT2 device with extension', value: 'G:\\SMO\\lpt².log' },
    { label: 'superscript LPT3 device with extension', value: 'G:\\SMO\\Lpt³.json' },
    { label: 'trailing dot', value: 'G:\\SMO\\runtime.' },
    { label: 'trailing space', value: 'G:\\SMO\\runtime ' },
    { label: 'extended namespace', value: '\\\\?\\G:\\SMO\\runtime' },
    { label: 'device namespace', value: '\\\\.\\G:\\SMO\\runtime' },
    ...['<', '>', '"', '|', '?', '*'].map((character) => ({
      label: `illegal character ${character}`,
      value: `G:\\SMO\\bad${character}name`,
    })),
  ];
  const pathCases = pathFields.flatMap((field) =>
    unsafePaths.map((path) => ({ field, ...path })),
  );

  test.each(pathCases)('rejects unsafe $field: $label', async ({ field, value }) => {
    const { store, path } = await useStore();
    const config = structuredClone(makeConfig()) as any;
    config[field] = value;
    await writeJson(path, config);

    await expect(store.load()).rejects.toThrow(/path/i);
  });

  test('accepts Chinese paths and directory names containing spaces', async () => {
    const { store } = await useStore();
    const config = makeConfig({
      runtimeRoot: 'G:\\SMO H3 Studio\\运行时',
      modelDirectory: 'D:\\模型 文件\\H3 模型',
      outputDirectory: 'E:\\输出 视频\\成片',
    });

    await store.save(config);

    await expect(store.load()).resolves.toEqual(config);
  });

  test.each([
    '\\\\server\\share',
    '\\\\server\\share\\',
    '//server/share',
    '//server/share/',
    '\\\\server\\share\\models\\H3',
    '\\\\server\\share\\models\\H3\\',
    '//server/share/models/H3',
    '//server/share/models/H3/',
  ])('accepts a valid UNC path: %s', async (uncPath) => {
    const { store } = await useStore();
    const config = makeConfig({
      runtimeRoot: uncPath,
      modelDirectory: uncPath,
      outputDirectory: uncPath,
    });

    await store.save(config);

    await expect(store.load()).resolves.toEqual(config);
  });
});

describe('EnvironmentStore atomic writes and readiness', () => {
  test('cleans its temporary file when the atomic rename fails', async () => {
    const { store, path, directory } = await useStore();
    await mkdir(path);

    await expect(store.save(makeConfig())).rejects.toThrow();

    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  test('rejects public saves that claim ready status', async () => {
    const { store } = await useStore();

    await expect(store.save(makeConfig({ status: 'ready' }))).rejects.toThrow(
      /ready/i,
    );
    await expect(store.load()).resolves.toBeNull();
  });

  test('commitReady writes the supplied healthy configuration in one transition', async () => {
    const { store } = await useStore();
    const candidate = makeConfig({
      status: 'installing',
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
    });
    const snapshot = structuredClone(candidate);

    const ready = await store.commitReady(candidate);

    expect(ready.status).toBe('ready');
    expect(ready.createdAt).toBe(candidate.createdAt);
    expect(Date.parse(ready.updatedAt)).toBeGreaterThan(
      Date.parse(candidate.updatedAt),
    );
    await expect(store.load()).resolves.toEqual(ready);
    expect(candidate).toEqual(snapshot);
  });

  test('commitReady failure leaves the previous ready file untouched', async () => {
    const { store } = await useStore();
    await store.save(makeConfig({ manifestVersion: 'old-ready' }));
    const oldReady = await store.markReady();
    const writer = store as unknown as AtomicWriter;
    vi.spyOn(writer, 'writeAtomically').mockRejectedValueOnce(
      new Error('simulated atomic commit failure'),
    );

    await expect(
      store.commitReady(
        makeConfig({ manifestVersion: 'new-ready', status: 'installing' }),
      ),
    ).rejects.toThrow('simulated atomic commit failure');

    await expect(store.load()).resolves.toEqual(oldReady);
  });

  test.each(['installing', 'failed'] as const)(
    'marks an existing %s configuration ready',
    async (status) => {
      const { store } = await useStore();
      const original = makeConfig({
        status,
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z',
      });
      const snapshot = structuredClone(original);
      await store.save(original);

      const ready = await store.markReady();

      expect(ready.status).toBe('ready');
      expect(ready.createdAt).toBe(original.createdAt);
      expect(Date.parse(ready.updatedAt)).toBeGreaterThan(
        Date.parse(original.updatedAt),
      );
      await expect(store.load()).resolves.toEqual(ready);
      expect(original).toEqual(snapshot);
    },
  );

  test('markReady is idempotent for an already ready configuration', async () => {
    const { store } = await useStore();
    await store.save(makeConfig());
    const ready = await store.markReady();

    await expect(store.markReady()).resolves.toEqual(ready);
  });

  test('markReady rejects when no configuration exists', async () => {
    const { store } = await useStore();

    await expect(store.markReady()).rejects.toThrow(
      /no environment configuration/i,
    );
  });

  test('markReady does not replace an invalid configuration', async () => {
    const { store, path } = await useStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{broken', 'utf8');

    await expect(store.markReady()).rejects.toThrow(/environment configuration/i);
    await expect(readFile(path, 'utf8')).resolves.toBe('{broken');
  });

  test('serializes the whole markReady read-modify-write before a later save', async () => {
    const { store, path } = await useStore();
    const otherStore = new EnvironmentStore(path);
    await store.save(makeConfig({ manifestVersion: 'old-installing' }));

    const markReadyHasRead = createDeferred();
    const finishMarkReadyRead = createDeferred();
    const originalLoad = store.load.bind(store);
    let pauseNextLoad = true;
    vi.spyOn(store, 'load').mockImplementation(async () => {
      const config = await originalLoad();
      if (pauseNextLoad) {
        pauseNextLoad = false;
        markReadyHasRead.resolve();
        await finishMarkReadyRead.promise;
      }
      return config;
    });

    // Make the later save's write synchronous so the old implementation's
    // final write order is deterministic; the public operations stay real.
    const otherWriter = otherStore as unknown as AtomicWriter;
    vi.spyOn(otherWriter, 'writeAtomically').mockImplementation(async (config) => {
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    });

    const readyPromise = store.markReady();
    await markReadyHasRead.promise;

    const latest = makeConfig({
      manifestVersion: 'new-failed',
      status: 'failed',
      updatedAt: '2026-10-30T08:00:00.000Z',
    });
    const savePromise = otherStore.save(latest);
    finishMarkReadyRead.resolve();

    await Promise.all([readyPromise, savePromise]);

    await expect(store.load()).resolves.toEqual(latest);
  });

  test('runs a later same-path mutation after an earlier mutation fails', async () => {
    const { store, path } = await useStore();
    const otherStore = new EnvironmentStore(path);
    const firstWriteStarted = createDeferred();
    const failFirstWrite = createDeferred();
    const firstWriter = store as unknown as AtomicWriter;
    vi.spyOn(firstWriter, 'writeAtomically').mockImplementation(async () => {
      firstWriteStarted.resolve();
      await failFirstWrite.promise;
      throw new Error('simulated write failure');
    });

    const failedSave = store.save(makeConfig());
    await firstWriteStarted.promise;
    const latest = makeConfig({ status: 'failed' });
    const latestSave = otherStore.save(latest);
    failFirstWrite.resolve();

    await expect(failedSave).rejects.toThrow('simulated write failure');
    await latestSave;
    await expect(store.load()).resolves.toEqual(latest);
  });
});

describe('resolveEnvironmentPaths', () => {
  const fallback: EnvironmentPaths = {
    runtimeRoot: 'G:\\Legacy\\runtime',
    modelDirectory: 'G:\\Legacy\\models',
    outputDirectory: 'G:\\Legacy\\output',
  };

  test('returns a copy of the legacy fallback when config is null', () => {
    const resolved = resolveEnvironmentPaths(null, fallback);

    expect(resolved).toEqual(fallback);
    expect(resolved).not.toBe(fallback);
    resolved.runtimeRoot = 'C:\\Changed\\runtime';
    expect(fallback.runtimeRoot).toBe('G:\\Legacy\\runtime');
  });

  test('uses only paths from an existing configuration', () => {
    const config = makeConfig({
      runtimeRoot: 'D:\\Configured\\runtime',
      modelDirectory: 'E:\\Configured\\models',
      outputDirectory: 'F:\\Configured\\output',
    });

    expect(resolveEnvironmentPaths(config, fallback)).toEqual({
      runtimeRoot: 'D:\\Configured\\runtime',
      modelDirectory: 'E:\\Configured\\models',
      outputDirectory: 'F:\\Configured\\output',
    });
  });

  test('does not mutate config or fallback inputs', () => {
    const config = makeConfig();
    const originalConfig = structuredClone(config);
    const originalFallback = structuredClone(fallback);

    const resolved = resolveEnvironmentPaths(config, fallback);
    resolved.outputDirectory = 'C:\\Changed\\output';

    expect(config).toEqual(originalConfig);
    expect(fallback).toEqual(originalFallback);
  });

  test('validates configured paths with the same rules as the store', () => {
    const config = makeConfig({ runtimeRoot: '..\\escape' });

    expect(() => resolveEnvironmentPaths(config, fallback)).toThrow(/path/i);
  });
});
