// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileLlmConfigStore } from '../../src/main/llm-config';
import type { SecretCipher } from '../../src/main/secrets';

const prefix = Buffer.from('llm-config-test-cipher\0');
const transform = (value: Buffer): Buffer =>
  Buffer.from(value.map((byte) => byte ^ 0x5a));

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.concat([prefix, transform(Buffer.from(value, 'utf8'))]),
  decryptString: (value: Buffer) => {
    if (!value.subarray(0, prefix.length).equals(prefix)) {
      throw new Error('Invalid test ciphertext');
    }
    return transform(value.subarray(prefix.length)).toString('utf8');
  },
};

const directories: string[] = [];

async function useStore(): Promise<FileLlmConfigStore> {
  const directory = await mkdtemp(join(tmpdir(), 'smo-llm-config-'));
  directories.push(directory);
  return new FileLlmConfigStore(join(directory, 'llm-config.json'), cipher);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('FileLlmConfigStore model discovery connection', () => {
  test('resolves a connection without a model and reuses the saved API key', async () => {
    const store = await useStore();
    await store.save({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-saved-secret',
    });

    await expect(
      store.resolveConnection({ baseUrl: 'https://saved.example.com/v1', apiKey: '' }),
    ).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      apiKey: 'sk-saved-secret',
    });
  });

  test('prefers an explicitly supplied API key and keeps an optional model', async () => {
    const store = await useStore();
    await store.save({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-saved-secret',
    });

    await expect(
      store.resolveConnection({
        baseUrl: ' https://draft.example.com/v1 ',
        model: ' draft-model ',
        apiKey: ' sk-draft ',
      }),
    ).resolves.toEqual({
      baseUrl: 'https://draft.example.com/v1',
      model: 'draft-model',
      apiKey: 'sk-draft',
    });
  });

  test('rejects a discovery connection without a base URL', async () => {
    const store = await useStore();

    await expect(store.resolveConnection({ baseUrl: ' ' })).rejects.toThrow(
      /base URL/i,
    );
  });

  test('rejects discovery without any API key when nothing is saved yet', async () => {
    const store = await useStore();

    await expect(
      store.resolveConnection({ baseUrl: 'https://example.com/v1' }),
    ).rejects.toThrow(/API key is required/i);
  });

  test('still requires a model when resolving full credentials', async () => {
    const store = await useStore();
    await store.save({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-saved-secret',
    });

    await expect(
      store.resolveCredentials({
        baseUrl: 'https://saved.example.com/v1',
        model: ' ',
        apiKey: '',
      }),
    ).rejects.toThrow(/model/i);

    const missingModel = { baseUrl: 'https://saved.example.com/v1', apiKey: '' };
    await expect(
      store.resolveCredentials(
        missingModel as Parameters<FileLlmConfigStore['resolveCredentials']>[0],
      ),
    ).rejects.toThrow(/model/i);
  });
});

const brokenCipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.concat([prefix, transform(Buffer.from(value, 'utf8'))]),
  decryptString: () => {
    throw new Error('decryption failed');
  },
};

describe('FileLlmConfigStore credential recovery', () => {
  test('keeps baseUrl/model with reenter-required when the cipher cannot decrypt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-llm-config-'));
    directories.push(directory);
    const path = join(directory, 'llm-config.json');

    const working = new FileLlmConfigStore(path, cipher);
    await working.save({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-saved-secret',
    });

    const broken = new FileLlmConfigStore(path, brokenCipher);

    await expect(broken.getProfile()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      keyStatus: 'reenter-required',
    });
    await expect(broken.getCredentials()).rejects.toThrow(/重新输入 API Key/);
  });

  test('restores a valid status and the fresh key after re-saving', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smo-llm-config-'));
    directories.push(directory);
    const path = join(directory, 'llm-config.json');

    const working = new FileLlmConfigStore(path, cipher);
    await working.save({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-saved-secret',
    });

    const broken = new FileLlmConfigStore(path, brokenCipher);
    await broken.save({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-fresh-secret',
    });

    await expect(working.getProfile()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      keyStatus: 'valid',
    });
    await expect(working.getCredentials()).resolves.toEqual({
      baseUrl: 'https://saved.example.com/v1',
      model: 'saved-model',
      apiKey: 'sk-fresh-secret',
    });
  });
});
