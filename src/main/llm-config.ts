import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  LlmConnection,
  LlmCredentials,
  LlmDiscoveryInput,
  LlmProfile,
} from '../shared/types';
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
  saveProfile(input: LlmProfile & { apiKey?: string }): Promise<LlmCredentials>;
  resolveConnection(input: LlmDiscoveryInput): Promise<LlmConnection>;
  resolveCredentials(input: LlmProfile & { apiKey?: string }): Promise<LlmCredentials>;
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

  async saveProfile(input: LlmProfile & { apiKey?: string }): Promise<LlmCredentials> {
    const credentials = await this.resolveCredentials(input);
    await this.save(credentials);
    return credentials;
  }

  async resolveCredentials(input: LlmProfile & { apiKey?: string }): Promise<LlmCredentials> {
    const baseUrl = input.baseUrl.trim();
    const model = input.model?.trim() ?? '';
    if (baseUrl.length === 0 || model.length === 0) {
      throw new Error('LLM base URL and model are required');
    }

    const apiKey = await this.resolveApiKey(input.apiKey);
    return { baseUrl, model, apiKey };
  }

  async resolveConnection(input: LlmDiscoveryInput): Promise<LlmConnection> {
    const baseUrl = input.baseUrl.trim();
    if (baseUrl.length === 0) {
      throw new Error('LLM base URL is required');
    }

    const apiKey = await this.resolveApiKey(input.apiKey);
    const model = input.model?.trim() ?? '';
    return model.length > 0 ? { baseUrl, model, apiKey } : { baseUrl, apiKey };
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

  private async resolveApiKey(apiKeyInput: string | undefined): Promise<string> {
    let apiKey = apiKeyInput?.trim() ?? '';
    if (apiKey.length === 0) {
      const existing = await this.getCredentials();
      if (existing === null) {
        throw new Error('API key is required for the first LLM configuration');
      }
      apiKey = existing.apiKey;
    }
    return apiKey;
  }
}
