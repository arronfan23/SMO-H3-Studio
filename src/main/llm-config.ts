import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  LlmConnection,
  LlmCredentials,
  LlmDiscoveryInput,
  LlmProfile,
  LlmProfileView,
} from '../shared/types';
import {
  SecureStorageUnavailableError,
  decryptSecret,
  encryptSecret,
  type SecretCipher,
} from './secrets';

export const LLM_REENTER_REQUIRED_MESSAGE =
  '密钥无法读取，请在设置页重新输入 API Key';

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
  getProfile(): Promise<LlmProfileView | null>;
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

  async getProfile(): Promise<LlmProfileView | null> {
    const stored = await this.read();
    if (stored === null) {
      return null;
    }

    let keyStatus: LlmProfileView['keyStatus'] = 'valid';
    try {
      this.decryptApiKey(stored.encryptedApiKey);
    } catch (error) {
      if (this.isStorageOutage(error)) {
        throw error;
      }
      keyStatus = 'reenter-required';
    }
    return { baseUrl: stored.baseUrl, model: stored.model, keyStatus };
  }

  async getCredentials(): Promise<LlmCredentials | null> {
    const stored = await this.read();
    if (stored === null) {
      return null;
    }

    let apiKey: string;
    try {
      apiKey = this.decryptApiKey(stored.encryptedApiKey);
    } catch (error) {
      if (this.isStorageOutage(error)) {
        throw error;
      }
      throw new Error(LLM_REENTER_REQUIRED_MESSAGE);
    }
    return { baseUrl: stored.baseUrl, model: stored.model, apiKey };
  }

  private isStorageOutage(error: unknown): boolean {
    // A backend outage must surface as-is: re-entering the key cannot fix it.
    return error instanceof SecureStorageUnavailableError;
  }

  private decryptApiKey(encryptedApiKey: string): string {
    return this.cipher
      ? decryptSecret(encryptedApiKey, this.cipher)
      : decryptSecret(encryptedApiKey);
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
