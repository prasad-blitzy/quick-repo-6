/**
 * tests/unit/utils/crypto.test.ts — AES-GCM Encryption/Decryption Unit Tests
 *
 * Comprehensive test suite for src/utils/crypto.ts covering all AAP requirements:
 *
 * 1. Round-trip encrypt → decrypt returns original plaintext (CRITICAL)
 * 2. Ciphertext uniqueness — different plaintexts produce different outputs
 * 3. Random IV — same plaintext produces different ciphertexts each time
 * 4. Base64 output format validation and minimum byte-length checks
 * 5. Decryption failure handling — wrong key, corrupted data, invalid inputs
 * 6. Per-installation encryption key generation, storage, and cross-session persistence
 * 7. Edge cases — Unicode, special characters, CJK, very long strings, null bytes
 *
 * Per AAP Sections 0.2.3 (test requirements), 0.5.1 Group 12 (crypto utility),
 * and 0.7.2 (AES-GCM mandatory, per-installation key, random IV per encryption).
 *
 * Testing framework: Vitest 4.1.0 with happy-dom environment.
 * Module under test: src/utils/crypto.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt } from '@/utils/crypto';

// ---------------------------------------------------------------------------
// Mock Storage and Chrome Mock Setup
// ---------------------------------------------------------------------------

/**
 * Module-level mock storage that simulates chrome.storage.local's persistent
 * key-value store. Reassigned in beforeEach to provide a fresh, empty storage
 * for each test. Mock functions reference this variable via closure, so
 * reassignment automatically updates what the mocks see on subsequent calls.
 */
let mockStorage: Record<string, unknown> = {};

/**
 * Creates a callback-compatible chrome.storage.local mock on globalThis.
 *
 * CRITICAL DESIGN NOTE: The crypto module's internal helpers (chromeStorageGet
 * and chromeStorageSet) use the callback-based Chrome API pattern:
 *   chrome.storage.local.get([key], (result) => { ... })
 *   chrome.storage.local.set({ key: value }, () => { ... })
 *
 * The default mock from tests/setup.ts only supports the Promise-based pattern
 * (no callback parameter) and would cause the crypto module to hang forever
 * waiting for a callback that is never invoked. This function creates a mock
 * that detects a trailing callback argument and invokes it synchronously,
 * while still supporting the Promise-based pattern as a fallback.
 */
function setupChromeMock(): void {
  const chromeMock = {
    storage: {
      local: {
        /**
         * Mock chrome.storage.local.get — supports both:
         *   get(keys): Promise<Record>  (Promise-based)
         *   get(keys, callback): void   (Callback-based — used by crypto module)
         */
        get: vi.fn((...args: unknown[]) => {
          const keys = args[0];
          const callback = typeof args[1] === 'function'
            ? (args[1] as (result: Record<string, unknown>) => void)
            : undefined;

          const result: Record<string, unknown> = {};
          if (typeof keys === 'string') {
            if (keys in mockStorage) {
              result[keys] = mockStorage[keys];
            }
          } else if (Array.isArray(keys)) {
            for (const k of keys as string[]) {
              if (k in mockStorage) {
                result[k] = mockStorage[k];
              }
            }
          }

          if (callback) {
            callback(result);
            return undefined;
          }
          return Promise.resolve(result);
        }),

        /**
         * Mock chrome.storage.local.set — supports both:
         *   set(items): Promise<void>           (Promise-based)
         *   set(items, callback): void          (Callback-based — used by crypto module)
         */
        set: vi.fn((...args: unknown[]) => {
          const items = args[0] as Record<string, unknown>;
          const callback = typeof args[1] === 'function'
            ? (args[1] as () => void)
            : undefined;

          Object.assign(mockStorage, items);

          if (callback) {
            callback();
            return undefined;
          }
          return Promise.resolve();
        }),

        /**
         * Mock chrome.storage.local.remove — supports both API styles.
         */
        remove: vi.fn((...args: unknown[]) => {
          const keys = args[0];
          const callback = typeof args[1] === 'function'
            ? (args[1] as () => void)
            : undefined;

          const keysArr: string[] = Array.isArray(keys)
            ? (keys as string[])
            : [keys as string];
          for (const k of keysArr) {
            delete mockStorage[k];
          }

          if (callback) {
            callback();
            return undefined;
          }
          return Promise.resolve();
        }),

        /**
         * Mock chrome.storage.local.clear — supports both API styles.
         */
        clear: vi.fn((...args: unknown[]) => {
          const callback = typeof args[0] === 'function'
            ? (args[0] as () => void)
            : undefined;

          const allKeys = Object.keys(mockStorage);
          for (const k of allKeys) {
            delete mockStorage[k];
          }

          if (callback) {
            callback();
            return undefined;
          }
          return Promise.resolve();
        }),
      },
    },
    runtime: {
      /**
       * chrome.runtime.lastError must be undefined when no error occurred.
       * The crypto module checks this inside storage callbacks:
       *   if (chrome.runtime.lastError) { reject(...) }
       */
      lastError: undefined as { message?: string } | undefined,
      id: 'test-extension-id',
    },
  };

  Object.defineProperty(globalThis, 'chrome', {
    value: chromeMock,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('src/utils/crypto — AES-GCM Encryption/Decryption', () => {
  beforeEach(() => {
    mockStorage = {};
    setupChromeMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Web Crypto API Availability
  // -----------------------------------------------------------------------

  describe('Web Crypto API availability', () => {
    it('should have the crypto global object available in test environment', () => {
      expect(typeof crypto).toBe('object');
      expect(crypto).not.toBeNull();
    });

    it('should have crypto.subtle available for AES-GCM operations', () => {
      expect(typeof crypto.subtle).toBe('object');
      expect(crypto.subtle).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Round-Trip Encryption (CRITICAL — AAP requirement #1)
  // -----------------------------------------------------------------------

  describe('Round-trip encryption', () => {
    it('should round-trip encrypt and decrypt to return original plaintext', async () => {
      const plaintext = 'sk-birdeye-api-key-12345abcdef';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should round-trip with a short API key', async () => {
      const plaintext = 'abc123';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should round-trip with a long API key containing special characters', async () => {
      const plaintext = 'sk-very-long-api-key-with-special-characters-!@#$%^&*()';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should round-trip with a UUID-style key', async () => {
      const plaintext = '550e8400-e29b-41d4-a716-446655440000';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should round-trip with a Base64-encoded key value', async () => {
      const plaintext = 'dGhpcyBpcyBhIHRlc3Qga2V5';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should round-trip with an empty string', async () => {
      const plaintext = '';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should round-trip multiple different API keys sequentially', async () => {
      const apiKeys = [
        'BIRDEYE_API_KEY_VALUE',
        'HELIUS_API_KEY_VALUE',
        'GROQ_API_KEY_VALUE',
        'RUGCHECK_API_KEY_VALUE',
        'ANTHROPIC_API_KEY_VALUE',
      ];

      for (const key of apiKeys) {
        const encrypted = await encrypt(key);
        const decrypted = await decrypt(encrypted);
        expect(decrypted).toBe(key);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Ciphertext Uniqueness (AAP requirement #2 and #3)
  // -----------------------------------------------------------------------

  describe('Ciphertext uniqueness', () => {
    it('should produce different ciphertexts for different plaintexts', async () => {
      const encrypted1 = await encrypt('api-key-1');
      const encrypted2 = await encrypt('api-key-2');
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should produce different ciphertexts for the same plaintext due to random IV', async () => {
      const plaintext = 'same-api-key';
      const encrypted1 = await encrypt(plaintext);
      const encrypted2 = await encrypt(plaintext);

      // Ciphertexts MUST differ — each encrypt() generates a fresh random 12-byte IV.
      // IV reuse with the same key catastrophically breaks AES-GCM confidentiality
      // and authenticity. This is a CRITICAL security property.
      expect(encrypted1).not.toBe(encrypted2);

      // But both must correctly decrypt to the original plaintext
      expect(await decrypt(encrypted1)).toBe(plaintext);
      expect(await decrypt(encrypted2)).toBe(plaintext);
    });

    it('should produce multiple unique ciphertexts for repeated encryption', async () => {
      const plaintext = 'repeated-key';
      const results = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const encrypted = await encrypt(plaintext);
        results.add(encrypted);
      }

      // All 10 encryptions should produce unique ciphertexts
      expect(results.size).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // Encrypted Output Format
  // -----------------------------------------------------------------------

  describe('Encrypted output format', () => {
    it('should return a non-empty string', async () => {
      const encrypted = await encrypt('test-key');
      expect(typeof encrypted).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
    });

    it('should return a valid Base64 encoded string', async () => {
      const encrypted = await encrypt('test-key');
      // atob() throws on invalid Base64 input
      expect(() => atob(encrypted)).not.toThrow();
    });

    it('should produce output decodable from Base64 to bytes', async () => {
      const encrypted = await encrypt('test-key');
      const decoded = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded.length).toBeGreaterThan(0);
    });

    it('should contain at least IV (12 bytes) + plaintext + auth tag (16 bytes) in output', async () => {
      const encrypted = await encrypt('x');
      const decoded = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
      // Minimum: 12 (IV) + 1 byte ('x' encoded as UTF-8) + 16 (GCM auth tag) = 29 bytes
      expect(decoded.length).toBeGreaterThanOrEqual(29);
    });

    it('should have at least 28 bytes decoded for empty plaintext', async () => {
      const encrypted = await encrypt('');
      const decoded = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
      // Minimum: 12 (IV) + 0 (empty plaintext) + 16 (GCM auth tag) = 28 bytes
      expect(decoded.length).toBeGreaterThanOrEqual(28);
    });

    it('should have larger output for longer plaintext', async () => {
      const shortEncrypted = await encrypt('a');
      const longEncrypted = await encrypt('a'.repeat(1000));
      const shortDecoded = Uint8Array.from(atob(shortEncrypted), (c) => c.charCodeAt(0));
      const longDecoded = Uint8Array.from(atob(longEncrypted), (c) => c.charCodeAt(0));
      expect(longDecoded.length).toBeGreaterThan(shortDecoded.length);
    });
  });

  // -----------------------------------------------------------------------
  // Decryption Failure Handling (AAP requirement #4 — MANDATORY)
  // -----------------------------------------------------------------------

  describe('Decryption failure handling', () => {
    it('should fail gracefully when decrypting with a wrong key', async () => {
      // Encrypt with installation key A
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const crypto1 = await import('@/utils/crypto');
      const encrypted = await crypto1.encrypt('my-secret');

      // Clear stored key to force generation of a completely new key B
      mockStorage = {};
      vi.resetModules();
      setupChromeMock();
      const crypto2 = await import('@/utils/crypto');

      // Decrypting key A's ciphertext with key B must throw — never silently
      // return an empty string or garbage data
      await expect(crypto2.decrypt(encrypted)).rejects.toThrow();
    });

    it('should throw a descriptive error message on wrong-key decryption', async () => {
      // Encrypt with key A
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const crypto1 = await import('@/utils/crypto');
      const encrypted = await crypto1.encrypt('my-secret-key');

      // Force generation of key B by clearing storage
      mockStorage = {};
      vi.resetModules();
      setupChromeMock();
      const crypto2 = await import('@/utils/crypto');

      // Error message should mention key change or data corruption per crypto module spec:
      // "Failed to decrypt data — the encryption key may have changed or the data is corrupted."
      await expect(crypto2.decrypt(encrypted)).rejects.toThrow(
        /decrypt|key|corrupt/i
      );
    });

    it('should throw on corrupted ciphertext', async () => {
      // Valid Base64 but NOT valid AES-GCM ciphertext
      const corrupted = btoa('this-is-not-encrypted-data-at-all');
      await expect(decrypt(corrupted)).rejects.toThrow();
    });

    it('should throw on tampered ciphertext', async () => {
      const encrypted = await encrypt('sensitive-data');
      // Decode, flip a byte in the ciphertext portion, re-encode
      const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
      // Tamper with a byte after the IV (byte index 15, well into ciphertext)
      if (bytes.length > 15) {
        bytes[15] = bytes[15] ^ 0xff;
      }
      let binaryString = '';
      for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
      }
      const tampered = btoa(binaryString);
      // AES-GCM authentication should detect tampering and reject
      await expect(decrypt(tampered)).rejects.toThrow();
    });

    it('should throw on empty ciphertext input', async () => {
      await expect(decrypt('')).rejects.toThrow();
    });

    it('should throw a descriptive error on empty ciphertext', async () => {
      // The crypto module validates: "decrypt() requires a non-empty Base64-encoded string argument."
      await expect(decrypt('')).rejects.toThrow(/non-empty|empty|argument/i);
    });

    it('should throw on invalid Base64 input', async () => {
      await expect(decrypt('not-valid-base64!!!')).rejects.toThrow();
    });

    it('should throw on Base64 string that decodes to fewer bytes than the IV length', async () => {
      // 10 bytes is less than the required 12-byte IV
      const shortBytes = new Array(10).fill(65);
      const tooShort = btoa(String.fromCharCode(...shortBytes));
      await expect(decrypt(tooShort)).rejects.toThrow();
    });

    it('should throw on Base64 string exactly equal to IV length (no ciphertext)', async () => {
      // Exactly 12 bytes — IV only, no ciphertext data
      const exactIV = new Array(12).fill(66);
      const ivOnly = btoa(String.fromCharCode(...exactIV));
      await expect(decrypt(ivOnly)).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Per-Installation Encryption Key (AAP requirement #5)
  // -----------------------------------------------------------------------

  describe('Per-installation encryption key generation', () => {
    it('should generate a new encryption key and store it on first call', async () => {
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const cryptoModule = await import('@/utils/crypto');

      await cryptoModule.encrypt('test');

      // Verify the encryption key was persisted to chrome.storage.local
      const storedKey = mockStorage['__crypto_encryption_key'];
      expect(storedKey).toBeDefined();

      // Verify it is a valid JWK (JSON Web Key) object for AES-GCM 256-bit
      expect(typeof storedKey).toBe('object');
      const jwk = storedKey as JsonWebKey;
      expect(jwk.kty).toBe('oct');        // Octet sequence (symmetric key)
      expect(jwk.alg).toBe('A256GCM');    // AES-GCM 256-bit algorithm
      expect(typeof jwk.k).toBe('string'); // Base64url-encoded key material
      expect((jwk.k as string).length).toBeGreaterThan(0);
    });

    it('should store key with extractable and encrypt/decrypt usages', async () => {
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const cryptoModule = await import('@/utils/crypto');

      await cryptoModule.encrypt('test');

      const jwk = mockStorage['__crypto_encryption_key'] as JsonWebKey;
      expect(jwk.ext).toBe(true); // Extractable
      expect(jwk.key_ops).toEqual(expect.arrayContaining(['encrypt', 'decrypt']));
    });

    it('should reuse the cached key on subsequent encrypt calls without additional storage writes', async () => {
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const cryptoModule = await import('@/utils/crypto');

      // First encrypt — generates and stores key (one storage.set call)
      await cryptoModule.encrypt('test1');
      // Access the mock through `any` to avoid TypeScript conflict between
      // @types/chrome's chrome.storage.local.set and vitest's Mock types
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setMock = (globalThis as any).chrome.storage.local.set as ReturnType<typeof vi.fn>;
      const setCallCountAfterFirst = setMock.mock.calls.length;

      // Second encrypt — should reuse cached key (NO additional storage.set call)
      const encrypted2 = await cryptoModule.encrypt('test2');
      const setCallCountAfterSecond = setMock.mock.calls.length;

      // chrome.storage.local.set should have been called exactly once
      expect(setCallCountAfterFirst).toBe(1);
      expect(setCallCountAfterSecond).toBe(1);

      // Both values should decrypt correctly using the same cached key
      const encrypted1 = await cryptoModule.encrypt('test1');
      expect(await cryptoModule.decrypt(encrypted1)).toBe('test1');
      expect(await cryptoModule.decrypt(encrypted2)).toBe('test2');
    });

    it('should not call storage.get on second operation (uses module-level cache)', async () => {
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const cryptoModule = await import('@/utils/crypto');

      // First encrypt — calls storage.get to check for existing key
      await cryptoModule.encrypt('test1');
      // Access the mock through `any` to avoid TypeScript conflict between
      // @types/chrome's chrome.storage.local.get and vitest's Mock types
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getMock = (globalThis as any).chrome.storage.local.get as ReturnType<typeof vi.fn>;
      const getCallCountAfterFirst = getMock.mock.calls.length;

      // Second encrypt — should use module-level cachedKey, no storage.get call
      await cryptoModule.encrypt('test2');
      const getCallCountAfterSecond = getMock.mock.calls.length;

      // storage.get was called once during first encrypt (to check for existing key)
      expect(getCallCountAfterFirst).toBe(1);
      // No additional storage.get call on second encrypt
      expect(getCallCountAfterSecond).toBe(1);
    });

    it('should retrieve stored key from chrome.storage.local on module reload', async () => {
      // --- Session 1: Generate key and encrypt ---
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const crypto1 = await import('@/utils/crypto');

      const encrypted = await crypto1.encrypt('persistent-test');

      // Verify the key was stored in mockStorage
      expect(mockStorage['__crypto_encryption_key']).toBeDefined();

      // --- Session 2: Simulate service worker restart (module cache cleared) ---
      // Reset module cache to clear the module-level cachedKey variable,
      // but keep mockStorage intact so the persisted JWK is still available.
      vi.resetModules();
      setupChromeMock(); // New mock functions still reference the same mockStorage
      const crypto2 = await import('@/utils/crypto');

      // Should successfully decrypt by loading the key from storage
      const decrypted = await crypto2.decrypt(encrypted);
      expect(decrypted).toBe('persistent-test');
    });

    it('should work correctly across multiple module reloads with the same storage', async () => {
      // Session 1: Generate key and encrypt
      vi.resetModules();
      mockStorage = {};
      setupChromeMock();
      const crypto1 = await import('@/utils/crypto');
      const encrypted1 = await crypto1.encrypt('session1-data');

      // Session 2: Reload, encrypt new data, decrypt old data
      vi.resetModules();
      setupChromeMock();
      const crypto2 = await import('@/utils/crypto');
      const encrypted2 = await crypto2.encrypt('session2-data');
      expect(await crypto2.decrypt(encrypted1)).toBe('session1-data');

      // Session 3: Reload again, decrypt both previous encryptions
      vi.resetModules();
      setupChromeMock();
      const crypto3 = await import('@/utils/crypto');
      expect(await crypto3.decrypt(encrypted1)).toBe('session1-data');
      expect(await crypto3.decrypt(encrypted2)).toBe('session2-data');
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases and Special Characters
  // -----------------------------------------------------------------------

  describe('Edge cases and special characters', () => {
    it('should handle Unicode emoji characters', async () => {
      const plaintext = '🚀 memecoin API key 🌙✨';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle all common special characters', async () => {
      const plaintext = 'key!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle CJK (Chinese, Japanese, Korean) characters', async () => {
      const plaintext = '日本語テスト中文测试한국어테스트';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle very long strings (10,000+ characters)', async () => {
      const plaintext = 'A'.repeat(10000);
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle strings with newlines, carriage returns, and tabs', async () => {
      const plaintext = 'line1\nline2\r\nline3\ttab';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle strings containing null bytes', async () => {
      const plaintext = 'before\0after';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle mixed ASCII and multi-byte Unicode correctly', async () => {
      const plaintext = 'API-Key-αβγδ-日本-🔑-End';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle strings with only whitespace', async () => {
      const plaintext = '   \t\n  ';
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });
});
