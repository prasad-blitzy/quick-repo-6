/**
 * TTL-Based Cache Backed by chrome.storage.local
 *
 * Provides a namespaced, expiration-aware caching layer over Chrome Extension
 * storage for persisting API responses, LLM analysis results, and safety check
 * data across service worker restarts.
 *
 * Key behaviors:
 * - Automatic expiration checking on read (lazy eviction)
 * - Batch cleanup of expired entries (periodic eviction via chrome.alarms)
 * - Graceful error handling for quota exceeded, corrupted data, and storage failures
 * - JSON-serializable values only (no functions, Symbols, or circular references)
 *
 * Storage constraints:
 * - chrome.storage.local default limit: 5 MB (10 MB with unlimitedStorage permission)
 * - All entries are namespaced with CACHE_PREFIX to avoid collisions with
 *   Zustand persistence, encrypted API keys, and other extension storage
 *
 * Consumed by:
 * - src/api/base-client.ts — API response caching
 * - src/ai/router.ts — LLM response caching (5-minute TTL)
 * - src/api/groq.ts — Groq LLM response caching
 *
 * @module src/utils/cache
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Storage key prefix applied to all cache entries to isolate them from other
 * data in chrome.storage.local (Zustand state, encrypted keys, etc.).
 */
export const CACHE_PREFIX = '__cache:' as const;

/**
 * TTL for cached LLM/AI analysis responses — 5 minutes (300 000 ms).
 * Per AAP Section 0.7.4: "All Groq/Claude LLM responses must be cached in
 * chrome.storage.local with a 5-minute TTL keyed by token mint address +
 * analysis tier; duplicate analyses within the TTL window must return
 * cached results."
 */
export const LLM_CACHE_TTL = 5 * 60 * 1000; // 300 000 ms

/**
 * TTL for cached external API responses — 30 seconds (30 000 ms).
 * Suitable for Birdeye price data, DexScreener token pairs, and other
 * rapidly-updating market data where moderate staleness is acceptable.
 */
export const API_CACHE_TTL = 30 * 1000; // 30 000 ms

/**
 * TTL for cached safety check results — 5 minutes (300 000 ms).
 * RugCheck reports, GoPlus security checks, and honeypot simulation results
 * change infrequently; a 5-minute TTL prevents redundant API calls while
 * ensuring safety data remains reasonably fresh.
 */
export const SAFETY_CACHE_TTL = 5 * 60 * 1000; // 300 000 ms

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal structure stored in chrome.storage.local for each cached value.
 * The generic parameter `T` must be JSON-serializable.
 */
export interface CacheEntry<T> {
  /** The cached value — must be JSON-serializable */
  value: T;
  /** Unix timestamp (ms) at which this entry expires */
  expiresAt: number;
  /** Unix timestamp (ms) at which this entry was created */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the namespaced storage key for a given user-facing cache key.
 *
 * @param key - The logical cache key supplied by the caller
 * @returns The prefixed key used to read/write chrome.storage.local
 */
function prefixKey(key: string): string {
  return `${CACHE_PREFIX}${key}`;
}

/**
 * Type-guard that validates a value retrieved from storage looks like a
 * well-formed `CacheEntry`. This protects against corrupted or manually-
 * edited storage data.
 *
 * @param raw - The raw value read from chrome.storage.local
 * @returns `true` when `raw` has the expected CacheEntry shape
 */
function isCacheEntry(raw: unknown): raw is CacheEntry<unknown> {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  return (
    'value' in obj &&
    typeof obj.expiresAt === 'number' &&
    typeof obj.createdAt === 'number'
  );
}

// ---------------------------------------------------------------------------
// Public API — exported as individual named functions AND as a `cache` object
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached value by key. Returns `null` on cache miss, expiration,
 * or corrupted data. Expired entries are lazily removed from storage.
 *
 * @typeParam T - Expected type of the cached value (must be JSON-serializable)
 * @param key - Logical cache key (without prefix)
 * @returns The cached value cast to `T`, or `null` if absent / expired / corrupted
 *
 * @example
 * ```ts
 * const data = await get<BirdeyeTokenData>('birdeye:SOL123');
 * if (data) {
 *   // Use cached Birdeye response
 * }
 * ```
 */
export async function get<T>(key: string): Promise<T | null> {
  const storageKey = prefixKey(key);

  try {
    const result = await chrome.storage.local.get(storageKey);
    const raw: unknown = result[storageKey];

    // Key does not exist in storage → cache miss
    if (raw === undefined || raw === null) {
      return null;
    }

    // Validate structural integrity of the cached entry
    if (!isCacheEntry(raw)) {
      // Corrupted or manually-written data — silently remove and return miss
      try {
        await chrome.storage.local.remove(storageKey);
      } catch {
        // Best-effort cleanup; swallow removal errors
      }
      return null;
    }

    // Automatic expiration checking on read (per AAP)
    if (Date.now() >= raw.expiresAt) {
      // Entry has expired — remove from storage and return miss
      try {
        await chrome.storage.local.remove(storageKey);
      } catch {
        // Best-effort cleanup; swallow removal errors
      }
      return null;
    }

    // Valid, non-expired entry — return the value typed as T
    return raw.value as T;
  } catch {
    // Storage read failed (e.g. extension context invalidated, quota issues).
    // Return a cache miss rather than propagating the error.
    return null;
  }
}

/**
 * Store a value in the cache with an explicit time-to-live.
 *
 * @typeParam T - Type of the value being cached (must be JSON-serializable)
 * @param key    - Logical cache key (without prefix)
 * @param value  - The data to cache
 * @param ttlMs  - Time-to-live in milliseconds before the entry expires
 *
 * @example
 * ```ts
 * await set('llm:SOL123:fast', analysisResult, LLM_CACHE_TTL);
 * ```
 */
export async function set<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const storageKey = prefixKey(key);
  const now = Date.now();

  const entry: CacheEntry<T> = {
    value,
    expiresAt: now + ttlMs,
    createdAt: now,
  };

  try {
    await chrome.storage.local.set({ [storageKey]: entry });
  } catch (err: unknown) {
    // Log quota-exceeded or other storage errors without throwing.
    // Callers should not crash because a cache write failed.
    const message =
      err instanceof Error ? err.message : 'Unknown cache set error';
    console.warn(`[cache] Failed to set key "${key}": ${message}`);
  }
}

/**
 * Immediately remove a single cache entry. No-op if the key does not exist.
 *
 * @param key - Logical cache key (without prefix)
 *
 * @example
 * ```ts
 * await invalidate('birdeye:SOL123');
 * ```
 */
export async function invalidate(key: string): Promise<void> {
  const storageKey = prefixKey(key);

  try {
    await chrome.storage.local.remove(storageKey);
  } catch {
    // Removal of a non-existent key is a no-op in chrome.storage.
    // Swallow any unexpected errors to honour the "never throw" contract.
  }
}

/**
 * Scan all entries in chrome.storage.local that belong to the cache namespace
 * and batch-remove every entry whose TTL has elapsed.
 *
 * Designed to be called periodically from a `chrome.alarms` handler in the
 * service worker (e.g. every 60 seconds) to prevent storage bloat.
 *
 * @example
 * ```ts
 * // In entrypoints/background.ts:
 * chrome.alarms.onAlarm.addListener(async (alarm) => {
 *   if (alarm.name === 'cache-cleanup') {
 *     await cleanup();
 *   }
 * });
 * chrome.alarms.create('cache-cleanup', { periodInMinutes: 1 });
 * ```
 */
export async function cleanup(): Promise<void> {
  try {
    // Retrieve ALL storage entries (pass null for unfiltered access)
    const allItems = await chrome.storage.local.get(null);
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [storageKey, raw] of Object.entries(allItems)) {
      // Only inspect entries that belong to the cache namespace
      if (!storageKey.startsWith(CACHE_PREFIX)) {
        continue;
      }

      // Skip entries that are not well-formed CacheEntry objects
      if (!isCacheEntry(raw)) {
        // Treat malformed cache entries as expired — remove them
        expiredKeys.push(storageKey);
        continue;
      }

      // Check expiration
      if (now >= raw.expiresAt) {
        expiredKeys.push(storageKey);
      }
    }

    // Batch-remove all expired / corrupted entries in a single call
    if (expiredKeys.length > 0) {
      await chrome.storage.local.remove(expiredKeys);
      console.debug(
        `[cache] cleanup: removed ${expiredKeys.length} expired/corrupted entries`,
      );
    }
  } catch (err: unknown) {
    // Log but do not throw — cleanup failures should never crash the service worker.
    const message =
      err instanceof Error ? err.message : 'Unknown cache cleanup error';
    console.warn(`[cache] cleanup failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Convenience namespace export
// ---------------------------------------------------------------------------

/**
 * Bundled cache API for consumers that prefer namespaced access:
 *
 * ```ts
 * import { cache } from '@/utils/cache';
 * const data = await cache.get<SomeType>('key');
 * await cache.set('key', data, API_CACHE_TTL);
 * await cache.invalidate('key');
 * await cache.cleanup();
 * ```
 */
export const cache = {
  get,
  set,
  invalidate,
  cleanup,
} as const;
