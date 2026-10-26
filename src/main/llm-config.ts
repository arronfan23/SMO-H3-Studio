import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LlmCredentials, LlmProfile } from '../shared/types';
import {
  decryptSecret,
  encryptSecret,
  type SecretCipher,
} from './secrets';

interface StoredLlmConfig {
  version: 1;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
}

export interface LlmConfigStore {
  save(credentials: LlmCredentials): Promise<void>;
  getProfile(): Promise<LlmProfile | null>;
  getCredentials(): Promise<LlmCredentials | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function parseStoredConfig(value: unknown): StoredLlmConfig {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.baseUrl !== 'string' ||
    value.baseUrl.length === 0 ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    typeof value.encryptedApiKey !== 'string' ||
    value.encryptedApiKey.length === 0
  ) {
    throw new Error('Invalid LLM configuration');
  }

  return {
    version: 1,
    baseUrl: value.baseUrl,
    model: value.model,
    encryptedApiKey: value.encryptedApiKey,
  };
}

export class FileLlmConfigStore implements LlmConfigStore {
  constructor(
    private readonly path: string,
    private readonly cipher?: SecretCipher,
  ) {}

  async save(credentials: LlmCredentials): Promise<void> {
    const encryptedApiKey = this.cipher
      ? encryptSecret(credentials.apiKey, this.cipher)
      : encryptSecret(credentials.apiKey);
    const stored: StoredLlmConfig = {
      version: 1,
      baseUrl: credentials.baseUrl,
      model: credentials.model,
      encryptedApiKey,
    };
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async getProfile(): Promise<LlmProfile | null> {
    const stored = await this.read();
    return stored === null
      ? null
      : { baseUrl: stored.baseUrl, model: stored.model };
  }

  async getCredentials(): Promise<LlmCredentials | null> {
    const stored = await this.read();
    if (stored === null) {
      return null;
    }

    const apiKey = this.cipher
      ? decryptSecret(stored.encryptedApiKey, this.cipher)
      : decryptSecret(stored.encryptedApiKey);
    return { baseUrl: stored.baseUrl, model: stored.model, apiKey };
  }

  private async read(): Promise<StoredLlmConfig | null> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw new Error('Unable to read LLM configuration');
    }

    try {
      return parseStoredConfig(JSON.parse(text) as unknown);
    } catch {
      throw new Error('Unable to read LLM configuration');
    }
  }
}
