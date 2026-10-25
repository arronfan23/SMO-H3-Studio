import { safeStorage } from 'electron';

export interface SecretCipher {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

function assertEncryptionAvailable(cipher: SecretCipher): void {
  let available = false;
  try {
    available = cipher.isEncryptionAvailable();
  } catch {
    throw new Error('Secure storage is unavailable');
  }

  if (!available) {
    throw new Error('Secure storage is unavailable');
  }
}

export function encryptSecret(
  value: string,
  cipher: SecretCipher = safeStorage,
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
  cipher: SecretCipher = safeStorage,
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
