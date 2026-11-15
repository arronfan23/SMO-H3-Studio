// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileSanmaoConfigStore } from '../../src/main/sanmao-config';

describe('Sanmao config store', () => {
  let directory: string;
  let configPath: string;
  let store: FileSanmaoConfigStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'smo-sanmao-config-'));
    configPath = join(directory, 'sanmao.json');
    store = new FileSanmaoConfigStore(configPath);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('stores credentials encrypted and never returns the API key in the profile', async () => {
    await store.saveProfile({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-test',
      apiKey: 'secret-sanmao-key',
    });

    expect(await store.getProfile()).toEqual({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-test',
      keyStatus: 'valid',
    });
    expect(await store.getCredentials()).toMatchObject({
      apiKey: 'secret-sanmao-key',
    });
    expect(await readFile(configPath, 'utf8')).not.toContain('secret-sanmao-key');
  });

  test('reuses the existing key when an edit leaves the key blank', async () => {
    await store.saveProfile({
      baseUrl: 'https://api.anthropic.com',
      model: 'old-model',
      apiKey: 'existing-key',
    });

    await store.saveProfile({
      baseUrl: 'https://claude.test',
      model: 'new-model',
      apiKey: '',
    });

    expect(await store.getCredentials()).toMatchObject({
      baseUrl: 'https://claude.test',
      model: 'new-model',
      apiKey: 'existing-key',
    });
  });

  test('requires a key for the first configuration', async () => {
    await expect(store.saveProfile({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      apiKey: '',
    })).rejects.toThrow(/key|required/i);
  });

  test('rejects blank model names', async () => {
    await expect(store.saveProfile({
      baseUrl: 'https://api.anthropic.com',
      model: '  ',
      apiKey: 'key',
    })).rejects.toThrow(/model|required/i);
  });

  test('rejects a damaged configuration file', async () => {
    await writeFile(configPath, '{broken', 'utf8');

    await expect(store.getProfile()).rejects.toThrow(/configuration|read/i);
  });

  test('resolves model discovery from saved values or current overrides', async () => {
    await store.saveProfile({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      apiKey: 'saved-key',
    });

    await expect(store.resolveConnection({})).resolves.toMatchObject({
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'saved-key',
    });
    await expect(store.resolveConnection({
      baseUrl: 'https://claude.test',
      apiKey: 'current-key',
    })).resolves.toMatchObject({
      baseUrl: 'https://claude.test',
      apiKey: 'current-key',
    });
  });
});
