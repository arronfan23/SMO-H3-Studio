// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  type SecretCipher,
} from '../../src/main/secrets';

const { defaultCipher } = vi.hoisted(() => {
  const prefix = Buffer.from('test-cipher-v1\0');
  const transform = (value: Buffer) =>
    Buffer.from(value.map((byte) => byte ^ 0x5a));

  return {
    defaultCipher: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) =>
        Buffer.concat([prefix, transform(Buffer.from(value, 'utf8'))]),
      decryptString: (value: Buffer) => {
        if (!value.subarray(0, prefix.length).equals(prefix)) {
          throw new Error('Invalid test ciphertext');
        }
        return transform(value.subarray(prefix.length)).toString('utf8');
      },
    },
  };
});

vi.mock('electron', () => ({ safeStorage: defaultCipher }));

const PLAINTEXT = 'sk-test-never-store-in-plaintext';

function createCipher(available = true): SecretCipher {
  return {
    ...defaultCipher,
    isEncryptionAvailable: () => available,
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

  test('uses the default Electron safeStorage cipher for roundtrip', () => {
    const encrypted = encryptSecret(PLAINTEXT);

    expect(decryptSecret(encrypted)).toBe(PLAINTEXT);
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
