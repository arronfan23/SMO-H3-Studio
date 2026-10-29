import { Dpapi, isPlatformSupported } from '@primno/dpapi';

export interface SecretCipher {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

const DPAPI_SCOPE = 'CurrentUser';

// Windows DPAPI (CurrentUser scope): ciphertext is bound to the OS user and
// decrypts across processes without storing any plaintext or key material.
const dpapiCipher: SecretCipher = {
  isEncryptionAvailable: () => isPlatformSupported,
  encryptString: (value: string) =>
    Buffer.from(Dpapi.protectData(Buffer.from(value, 'utf8'), null, DPAPI_SCOPE)),
  decryptString: (value: Buffer) =>
    Buffer.from(Dpapi.unprotectData(value, null, DPAPI_SCOPE)).toString('utf8'),
};

export class SecureStorageUnavailableError extends Error {
  readonly code = 'SECURE_STORAGE_UNAVAILABLE';

  constructor() {
    super('Secure storage is unavailable');
    this.name = 'SecureStorageUnavailableError';
  }
}

function assertEncryptionAvailable(cipher: SecretCipher): void {
  let available = false;
  try {
    available = cipher.isEncryptionAvailable();
  } catch {
    throw new SecureStorageUnavailableError();
  }

  if (!available) {
    throw new SecureStorageUnavailableError();
  }
}

export function encryptSecret(
  value: string,
  cipher: SecretCipher = dpapiCipher,
): string {
  assertEncryptionAvailable(cipher);

  try {
    return cipher.encryptString(value).toString('base64');
  } catch {
    throw new Error('Unable to encrypt secret');
  }
}

export function decryptSecret(
  encrypted: string,
  cipher: SecretCipher = dpapiCipher,
): string {
  assertEncryptionAvailable(cipher);

  try {
    if (
      encrypted.length === 0 ||
      encrypted.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encrypted)
    ) {
      throw new Error('Invalid ciphertext');
    }

    const bytes = Buffer.from(encrypted, 'base64');
    if (bytes.toString('base64') !== encrypted) {
      throw new Error('Invalid ciphertext');
    }
    return cipher.decryptString(bytes);
  } catch {
    throw new Error('Unable to decrypt secret');
  }
}
