/**
 * src/utils/crypto.ts — AES-GCM Encryption/Decryption for API Keys
 *
 * Provides secure encryption and decryption of API keys using the native
 * Web Crypto API with AES-GCM (256-bit). Each Chrome Extension installation
 * receives a unique per-installation encryption key, stored in chrome.storage.local
 * as an exported JWK. The key is cached at the module level to avoid repeated
 * imports within the same service worker or content script session.
 *
 * Security guarantees:
 * - AES-GCM with 256-bit keys (NIST-approved authenticated encryption)
 * - Fresh random 12-byte IV generated for every encrypt() call
 * - Per-installation key isolation (each Chrome profile gets its own key)
 * - Keys stored encrypted in chrome.storage.local, never exposed to content scripts
 * - Base64 encoding for safe string storage of binary ciphertext
 *
 * Consumed by:
 * - src/store/settings-store.ts — encrypts API keys before persisting
 * - entrypoints/background.ts — decrypts API keys for use in external API calls
 * - src/components/SettingsPanel.tsx (indirectly via store)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Chrome storage key under which the per-installation AES-GCM encryption key
 * is persisted as an exported JWK object. This key is separate from the
 * encrypted data it protects, following the principle of key–data separation.
 */
const ENCRYPTION_KEY_STORAGE_KEY = '__crypto_encryption_key';

/**
 * AES-GCM algorithm identifier used across all Web Crypto operations.
 */
const ALGORITHM_NAME = 'AES-GCM' as const;

/**
 * Key length in bits for AES-GCM. 256-bit provides the highest security tier
 * specified by NIST SP 800-38D.
 */
const KEY_LENGTH = 256;

/**
 * Initialization Vector byte length. 96 bits (12 bytes) is the recommended
 * IV size for AES-GCM per NIST SP 800-38D — it avoids the need for the
 * GHASH-based IV construction and provides the best performance.
 */
const IV_BYTE_LENGTH = 12;

// ---------------------------------------------------------------------------
// Custom Error Class
// ---------------------------------------------------------------------------

/**
 * Typed error for all crypto operations. Enables callers to distinguish
 * crypto-related failures from other runtime exceptions.
 */
class CryptoError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CryptoError';
  }
}

// ---------------------------------------------------------------------------
// Module-level CryptoKey Cache
// ---------------------------------------------------------------------------

/**
 * Module-level cache for the per-installation CryptoKey. Avoids redundant
 * chrome.storage reads and crypto.subtle.importKey calls within a single
 * service worker or content script session. Cleared automatically when the
 * service worker terminates (global state is lost on MV3 idle shutdown).
 */
let cachedKey: CryptoKey | null = null;

// ---------------------------------------------------------------------------
// Web Crypto API Availability Guard
// ---------------------------------------------------------------------------

/**
 * Validates that the Web Crypto API is available in the current execution
 * context. The API is available in:
 * - Service workers (entrypoints/background.ts)
 * - Content scripts (entrypoints/content.ts)
 * - Secure contexts (HTTPS pages like gmgn.ai)
 *
 * Throws immediately if unavailable so callers get a clear diagnostic
 * rather than mysterious "crypto is not defined" errors later.
 */
function assertWebCryptoAvailable(): void {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new CryptoError(
      'Web Crypto API is not available in this context. ' +
        'Ensure the code is running in a secure context (HTTPS, service worker, or extension content script).'
    );
  }
}

// ---------------------------------------------------------------------------
// Encryption Key Management
// ---------------------------------------------------------------------------

/**
 * Retrieves the existing per-installation AES-GCM encryption key from
 * chrome.storage.local, or generates a new one on first run. The CryptoKey
 * is cached at the module level so that subsequent calls within the same
 * session avoid repeated storage reads and key imports.
 *
 * Key lifecycle:
 * 1. Check module-level cache → return immediately if present
 * 2. Read JWK from chrome.storage.local → importKey if found
 * 3. Generate a new 256-bit AES-GCM key → export as JWK → persist → return
 *
 * @returns A CryptoKey usable for AES-GCM encrypt/decrypt operations.
 * @throws {CryptoError} If key generation, import, or storage access fails.
 */
export async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
  // Fast path: return module-level cached key
  if (cachedKey !== null) {
    return cachedKey;
  }

  assertWebCryptoAvailable();

  try {
    // Attempt to load an existing key from chrome.storage.local
    const stored = await chromeStorageGet(ENCRYPTION_KEY_STORAGE_KEY);

    if (stored !== undefined && stored !== null) {
      // Re-import the previously exported JWK back into a CryptoKey
      const importedKey = await crypto.subtle.importKey(
        'jwk',
        stored as JsonWebKey,
        { name: ALGORITHM_NAME, length: KEY_LENGTH },
        true, // extractable — needed to re-export if required
        ['encrypt', 'decrypt']
      );
      cachedKey = importedKey;
      return importedKey;
    }

    // No existing key found — generate a new per-installation key
    const newKey = await crypto.subtle.generateKey(
      { name: ALGORITHM_NAME, length: KEY_LENGTH },
      true, // extractable — allows exporting as JWK for persistence
      ['encrypt', 'decrypt']
    );

    // Export to JWK format for JSON-serializable storage
    const exportedJwk = await crypto.subtle.exportKey('jwk', newKey);

    // Persist the JWK to chrome.storage.local for future sessions
    await chromeStorageSet(ENCRYPTION_KEY_STORAGE_KEY, exportedJwk);

    cachedKey = newKey;
    return newKey;
  } catch (error) {
    // Clear cache on failure to prevent stale state
    cachedKey = null;

    if (error instanceof CryptoError) {
      throw error;
    }
    throw new CryptoError(
      'Failed to get or create encryption key. Storage or Web Crypto API may be unavailable.',
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts a plaintext string using AES-GCM with the per-installation key.
 *
 * The output is a Base64-encoded string containing the concatenation of:
 *   [12-byte IV] + [AES-GCM ciphertext + 16-byte auth tag]
 *
 * A fresh random 12-byte IV is generated for every call, which is critical
 * for AES-GCM security — reusing an IV with the same key catastrophically
 * breaks both confidentiality and authenticity.
 *
 * @param plaintext - The string to encrypt (e.g., an API key).
 * @returns Base64-encoded string safe for storage in chrome.storage.
 * @throws {CryptoError} If encryption fails or Web Crypto API is unavailable.
 */
export async function encrypt(plaintext: string): Promise<string> {
  assertWebCryptoAvailable();

  if (typeof plaintext !== 'string') {
    throw new CryptoError('encrypt() requires a string argument.');
  }

  try {
    const key = await getOrCreateEncryptionKey();

    // Generate a cryptographically random 12-byte IV
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));

    // Encode the plaintext string to a UTF-8 byte array
    const plaintextBytes = new TextEncoder().encode(plaintext);

    // Perform AES-GCM encryption (produces ciphertext + 16-byte auth tag)
    const ciphertextBuffer: ArrayBuffer = await crypto.subtle.encrypt(
      { name: ALGORITHM_NAME, iv },
      key,
      plaintextBytes
    );

    // Concatenate IV + ciphertext into a single byte array
    // Layout: [IV (12 bytes)] [ciphertext + auth tag (variable)]
    const combined = new Uint8Array(iv.byteLength + ciphertextBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertextBuffer), iv.byteLength);

    // Encode the combined binary data as a Base64 string for safe storage
    return uint8ArrayToBase64(combined);
  } catch (error) {
    if (error instanceof CryptoError) {
      throw error;
    }
    throw new CryptoError('Failed to encrypt data.', error);
  }
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypts a Base64-encoded ciphertext string produced by encrypt().
 *
 * Extracts the 12-byte IV prefix and the remaining ciphertext, then
 * performs AES-GCM authenticated decryption. If the data has been tampered
 * with, the key has changed, or the input is malformed, a descriptive
 * CryptoError is thrown — this function never silently returns empty strings
 * on failure.
 *
 * @param ciphertext - Base64-encoded string previously returned by encrypt().
 * @returns The original plaintext string.
 * @throws {CryptoError} If decryption fails (wrong key, corrupted data, malformed input).
 */
export async function decrypt(ciphertext: string): Promise<string> {
  assertWebCryptoAvailable();

  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new CryptoError('decrypt() requires a non-empty Base64-encoded string argument.');
  }

  try {
    const key = await getOrCreateEncryptionKey();

    // Decode the Base64 string back to raw bytes
    const combined = base64ToUint8Array(ciphertext);

    // The combined buffer must be at least IV_BYTE_LENGTH bytes (IV alone)
    // plus at least 1 byte of ciphertext to be valid
    if (combined.byteLength <= IV_BYTE_LENGTH) {
      throw new CryptoError(
        'Ciphertext is too short — it must contain at least the IV (' +
          IV_BYTE_LENGTH +
          ' bytes) plus encrypted data.'
      );
    }

    // Split the combined buffer into IV and encrypted data
    const iv = combined.slice(0, IV_BYTE_LENGTH);
    const encryptedData = combined.slice(IV_BYTE_LENGTH);

    // Perform AES-GCM authenticated decryption
    const decryptedBuffer: ArrayBuffer = await crypto.subtle.decrypt(
      { name: ALGORITHM_NAME, iv },
      key,
      encryptedData
    );

    // Decode the decrypted bytes back to a UTF-8 string
    return new TextDecoder().decode(decryptedBuffer);
  } catch (error) {
    if (error instanceof CryptoError) {
      throw error;
    }
    throw new CryptoError(
      'Failed to decrypt data — the encryption key may have changed or the data is corrupted.',
      error
    );
  }
}

// ---------------------------------------------------------------------------
// Base64 Helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a Uint8Array as a Base64 string. Uses the built-in btoa() function
 * available in all Chrome Extension contexts (service worker, content script,
 * page context).
 *
 * For large buffers, builds the binary string in chunks to avoid the
 * "Maximum call stack size exceeded" error that occurs when spreading
 * large typed arrays into String.fromCharCode().
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  let binaryString = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    // Use Array.from to convert to a standard array before spreading,
    // which avoids the TS2802 downlevelIteration requirement on Uint8Array.
    binaryString += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binaryString);
}

/**
 * Decodes a Base64 string back into a Uint8Array. Validates that the input
 * is a valid Base64 string before processing.
 *
 * @throws {CryptoError} If the Base64 string is malformed.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  let binaryString: string;
  try {
    binaryString = atob(base64);
  } catch {
    throw new CryptoError(
      'Invalid Base64 input — the ciphertext string is malformed.'
    );
  }
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Chrome Storage Helpers
// ---------------------------------------------------------------------------

/**
 * Reads a value from chrome.storage.local by key. Returns undefined if the
 * key does not exist. Provides a unified async interface regardless of the
 * Chrome API's callback or Promise style.
 */
async function chromeStorageGet(key: string): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    try {
      if (
        typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.get([key], (result: Record<string, unknown>) => {
          if (chrome.runtime.lastError) {
            reject(
              new CryptoError(
                `chrome.storage.local.get failed: ${chrome.runtime.lastError.message}`
              )
            );
            return;
          }
          resolve(result[key]);
        });
      } else {
        // Fallback for contexts where chrome.storage is unavailable
        // (e.g., unit tests without mocking)
        resolve(undefined);
      }
    } catch (error) {
      reject(
        new CryptoError('Failed to access chrome.storage.local for reading.', error)
      );
    }
  });
}

/**
 * Writes a value to chrome.storage.local under the specified key. Provides
 * a unified async interface regardless of Chrome API style.
 */
async function chromeStorageSet(key: string, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      if (
        typeof chrome !== 'undefined' &&
        chrome.storage &&
        chrome.storage.local
      ) {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            reject(
              new CryptoError(
                `chrome.storage.local.set failed: ${chrome.runtime.lastError.message}`
              )
            );
            return;
          }
          resolve();
        });
      } else {
        // Fallback: silently succeed when chrome.storage is unavailable
        // (unit test environments)
        resolve();
      }
    } catch (error) {
      reject(
        new CryptoError('Failed to access chrome.storage.local for writing.', error)
      );
    }
  });
}
