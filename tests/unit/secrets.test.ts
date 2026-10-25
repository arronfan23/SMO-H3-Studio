// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  type SecretCipher,
} from '../../src/main/secrets';

vi.mock('electron', () => ({ safeStorage: {} }));

const PLAINTEXT = 'sk-test-never-store-in-plaintext';
const CIPHER_PREFIX = Buffer.from('test-cipher-v1\0');

function createCipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => {
      const encrypted = Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a);
      return Buffer.concat([CIPHER_PREFIX, encrypted]);
    },
    decryptString: (value) => {
      if (!value.subarray(0, CIPHER_PREFIX.length).equals(CIPHER_PREFIX)) {
        throw new Error('Invalid test ciphertext');
      }
      const decrypted = value
        .subarray(CIPHER_PREFIX.length)
        .map((byte) => byte ^ 0x5a);
      return Buffer.from(decrypted).toString('utf8');
    },
  };
}

describe('safeStorage secrets', () => {
  test('roundtrips a secret without plaintext in the encoded or decoded ciphertext', () => {
    const cipher = createCipher();

    const encrypted = encryptSecret(PLAINTEXT, cipher);

    expect(encrypted).not.toContain(PLAINTEXT);
    expect(Buffer.from(encrypted, 'base64').toString('utf8')).not.toContain(PLAINTEXT);
    expect(decryptSecret(encrypted, cipher)).toBe(PLAINTEXT);
  });

  test('refuses encryption when secure storage is unavailable', () => {
    expect(() => encryptSecret(PLAINTEXT, createCipher(false))).toThrow(
      /secure storage is unavailable/i,
    );
  });

  test('refuses decryption when secure storage is unavailable', () => {
    expect(() => decryptSecret('Y2lwaGVydGV4dA==', createCipher(false))).toThrow(
      /secure storage is unavailable/i,
    );
  });

  test('does not expose plaintext or backend details when encryption fails', () => {
    const cipher = {
      ...createCipher(),
      encryptString: () => {
        throw new Error(`Backend rejected ${PLAINTEXT}`);
      },
    };

    expect(() => encryptSecret(PLAINTEXT, cipher)).toThrow(/^Unable to encrypt secret$/);
    try {
      encryptSecret(PLAINTEXT, cipher);
    } catch (error) {
      expect((error as Error).message).not.toContain(PLAINTEXT);
      expect((error as Error).message).not.toContain('Backend');
    }
  });

  test.each(['not base64!', '', 'Y2lwaGVydGV4dA=='])(
    'throws a safe error for undecryptable ciphertext %s',
    (ciphertext) => {
      expect(() => decryptSecret(ciphertext, createCipher())).toThrow(
        /^Unable to decrypt secret$/,
      );
    },
  );
});
