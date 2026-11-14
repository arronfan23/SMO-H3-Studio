import type {
  SanmaoCredentials,
  SanmaoConnection,
  SanmaoProfile,
  SanmaoProfileView,
} from '../shared/sanmao';
import { FileLlmConfigStore } from './llm-config';
import type { SecretCipher } from './secrets';

export class FileSanmaoConfigStore {
  private readonly store: FileLlmConfigStore;

  constructor(path: string, cipher?: SecretCipher) {
    this.store = new FileLlmConfigStore(path, cipher);
  }

  saveProfile(
    input: SanmaoProfile & { apiKey?: string },
  ): Promise<SanmaoCredentials> {
    return this.store.saveProfile(input);
  }

  getProfile(): Promise<SanmaoProfileView | null> {
    return this.store.getProfile();
  }

  getCredentials(): Promise<SanmaoCredentials | null> {
    return this.store.getCredentials();
  }

  resolveCredentials(
    input: SanmaoProfile & { apiKey?: string },
  ): Promise<SanmaoCredentials> {
    return this.store.resolveCredentials(input);
  }

  async resolveConnection(input: {
    baseUrl?: string;
    apiKey?: string;
  }): Promise<SanmaoConnection> {
    const existing = await this.getCredentials();
    const baseUrl = input.baseUrl?.trim() || existing?.baseUrl || '';
    const apiKey = input.apiKey?.trim() || existing?.apiKey || '';
    if (!baseUrl || !apiKey) {
      throw new Error('三脚猫请求地址和 API Key 是必需的');
    }
    return { baseUrl, apiKey };
  }
}
