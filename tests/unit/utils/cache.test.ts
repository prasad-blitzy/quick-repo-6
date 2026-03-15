/**
 * Unit tests for the TTL-based cache module (src/utils/cache.ts)
 *
 * Validates all four core cache operations — set(), get(), invalidate(),
 * cleanup() — against chrome.storage.local with time-controlled TTL assertions.
 *
 * Coverage includes:
 * - set() stores entries with correct CacheEntry structure (value, expiresAt, createdAt)
 * - get() returns cached data before expiration
 * - get() returns null and lazily evicts expired entries (per AAP)
 * - get() handles corrupted / malformed entries gracefully
 * - invalidate() removes specific entries by prefixed key
 * - cleanup() batch-removes all expired / corrupted cache entries
 * - Constant validation: LLM_CACHE_TTL === 300 000 ms (AAP Section 0.7.4)
 *
 * Chrome storage is mocked globally via tests/setup.ts (setupFiles in vitest.config.ts).
 * Vitest fake timers control Date.now() for deterministic TTL expiration testing.
 *
 * @module tests/unit/utils/cache.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  get,
  set,
  invalidate,
  cleanup,
  CACHE_PREFIX,
  LLM_CACHE_TTL,
  API_CACHE_TTL,
  SAFETY_CACHE_TTL,
} from '@/utils/cache';
import type { CacheEntry } from '@/utils/cache';

describe('TTL Cache (src/utils/cache.ts)', () => {
  /** Fixed base time for deterministic TTL calculations */
  const BASE_TIME = new Date('2025-01-01T00:00:00.000Z').getTime();

  beforeEach(async () => {
    // Enable fake timers — controls Date.now() and setTimeout/setInterval
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    // Reset the internal mock storage state (provided by tests/setup.ts)
    await chrome.storage.local.clear();

    // Clear mock call histories for clean per-test assertions
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Constants Validation (Phase 7 in spec)
  // ---------------------------------------------------------------------------
  describe('Constants', () => {
    it('CACHE_PREFIX equals "__cache:"', () => {
      expect(CACHE_PREFIX).toBe('__cache:');
    });

    it('LLM_CACHE_TTL is 300 000 ms (5 minutes per AAP Section 0.7.4)', () => {
      expect(LLM_CACHE_TTL).toBe(300_000);
    });

    it('API_CACHE_TTL is 30 000 ms (30 seconds)', () => {
      expect(API_CACHE_TTL).toBe(30_000);
    });

    it('SAFETY_CACHE_TTL is 300 000 ms (5 minutes)', () => {
      expect(SAFETY_CACHE_TTL).toBe(300_000);
    });
  });

  // ---------------------------------------------------------------------------
  // set()
  // ---------------------------------------------------------------------------
  describe('set()', () => {
    it('stores data with correct CacheEntry structure in chrome.storage.local', async () => {
      await set('test-key', { data: 123 }, 5000);

      const expectedKey = `${CACHE_PREFIX}test-key`;

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          [expectedKey]: expect.objectContaining({
            value: { data: 123 },
            expiresAt: BASE_TIME + 5000,
            createdAt: BASE_TIME,
          }),
        }),
      );
    });

    it('stored entry conforms to CacheEntry<T> interface', async () => {
      await set('typed-key', { score: 95 }, 10_000);

      const storageKey = `${CACHE_PREFIX}typed-key`;
      const result = await chrome.storage.local.get(storageKey);
      const entry = result[storageKey] as CacheEntry<{ score: number }>;

      expect(entry).toBeDefined();
      expect(entry.value).toEqual({ score: 95 });
      expect(typeof entry.expiresAt).toBe('number');
      expect(typeof entry.createdAt).toBe('number');
      expect(entry.expiresAt).toBe(BASE_TIME + 10_000);
      expect(entry.createdAt).toBe(BASE_TIME);
    });

    it('uses CACHE_PREFIX for the storage key', async () => {
      await set('my-token', 'price-data', 10_000);

      expect(chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({
          [`${CACHE_PREFIX}my-token`]: expect.any(Object),
        }),
      );
    });

    it('overwrites existing entries with new value and TTL', async () => {
      await set('key', 'value1', 5000);
      await set('key', 'value2', 10_000);

      const result = await get<string>('key');
      expect(result).toBe('value2');
    });

    it('handles string values', async () => {
      await set('str', 'hello-world', 5000);
      expect(await get<string>('str')).toBe('hello-world');
    });

    it('handles number values', async () => {
      await set('num', 42.5, 5000);
      expect(await get<number>('num')).toBe(42.5);
    });

    it('handles object values with nested properties', async () => {
      const data = { nested: { deep: { value: true } }, arr: [1, 2] };
      await set('obj', data, 5000);
      expect(await get<typeof data>('obj')).toEqual(data);
    });

    it('handles array values', async () => {
      const arr = [1, 'two', { three: 3 }, [4, 5]];
      await set('arr', arr, 5000);
      expect(await get<typeof arr>('arr')).toEqual(arr);
    });

    it('handles boolean values', async () => {
      await set('bool-true', true, 5000);
      await set('bool-false', false, 5000);

      expect(await get<boolean>('bool-true')).toBe(true);
      expect(await get<boolean>('bool-false')).toBe(false);
    });

    it('handles null values without throwing', async () => {
      // Storing null is valid — CacheEntry wraps it.
      // get() returns null for both "cached null" and "cache miss" (indistinguishable).
      await set('nil', null, 5000);
      const result = await get('nil');
      expect(result).toBeNull();
    });

    it('does not throw on storage write error and warns via console', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
        new Error('QUOTA_BYTES_PER_ITEM quota exceeded'),
      );

      // Should resolve without throwing
      await expect(set('big-key', 'big-value', 5000)).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set key'),
      );

      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // get()
  // ---------------------------------------------------------------------------
  describe('get()', () => {
    it('returns cached data before expiration', async () => {
      await set('key', { data: 'hello' }, 60_000);

      // Advance 30 s — still within 60 s TTL
      vi.advanceTimersByTime(30_000);

      const result = await get<{ data: string }>('key');
      expect(result).toEqual({ data: 'hello' });
    });

    it('returns null after TTL expires and removes the expired entry', async () => {
      await set('key', 'value', 5000);

      // Advance past TTL
      vi.advanceTimersByTime(6000);
      vi.clearAllMocks(); // Clear history before the verification call

      const result = await get('key');
      expect(result).toBeNull();

      // CRITICAL: expired entry must be lazily evicted from storage
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        `${CACHE_PREFIX}key`,
      );
    });

    it('returns null for non-existent keys without throwing', async () => {
      const result = await get('nonexistent-key');
      expect(result).toBeNull();
    });

    it('handles corrupted / malformed entries — returns null and cleans up', async () => {
      // Inject a raw string where a CacheEntry object is expected
      const corruptedKey = `${CACHE_PREFIX}bad`;
      await chrome.storage.local.set({ [corruptedKey]: 'not-a-cache-entry' });
      vi.clearAllMocks();

      const result = await get('bad');
      expect(result).toBeNull();

      // Corrupted entry should be removed from storage
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(corruptedKey);
    });

    it('treats entry missing expiresAt as corrupted', async () => {
      const key = `${CACHE_PREFIX}partial`;
      await chrome.storage.local.set({
        [key]: { value: 'data', createdAt: BASE_TIME },
      });
      vi.clearAllMocks();

      expect(await get('partial')).toBeNull();
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(key);
    });

    it('treats entry missing createdAt as corrupted', async () => {
      const key = `${CACHE_PREFIX}no-created`;
      await chrome.storage.local.set({
        [key]: { value: 'data', expiresAt: BASE_TIME + 10_000 },
      });
      vi.clearAllMocks();

      expect(await get('no-created')).toBeNull();
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(key);
    });

    it('respects generic type parameter for typed retrieval', async () => {
      interface TokenScore {
        score: number;
        mint: string;
      }
      await set<TokenScore>('typed', { score: 85, mint: 'abc123' }, 60_000);

      const result = await get<TokenScore>('typed');
      expect(result).not.toBeNull();
      expect(result!.score).toBe(85);
      expect(result!.mint).toBe('abc123');
    });

    it('returns null at exact expiration boundary (Date.now() === expiresAt)', async () => {
      await set('boundary', 'data', 5000);

      // Advance to exactly the expiration point
      vi.advanceTimersByTime(5000);

      // Date.now() >= expiresAt ⇒ expired
      expect(await get('boundary')).toBeNull();
    });

    it('returns data 1 ms before the expiration boundary', async () => {
      await set('just-before', 'alive', 5000);

      vi.advanceTimersByTime(4999);

      expect(await get<string>('just-before')).toBe('alive');
    });

    it('returns null gracefully when chrome.storage.local.get throws', async () => {
      vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
        new Error('Extension context invalidated'),
      );

      const result = await get('any-key');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // invalidate()
  // ---------------------------------------------------------------------------
  describe('invalidate()', () => {
    it('removes a specific cached entry', async () => {
      await set('key-to-remove', 'value', 60_000);

      // Confirm it exists
      expect(await get<string>('key-to-remove')).toBe('value');

      await invalidate('key-to-remove');

      // Confirm removal
      expect(await get<string>('key-to-remove')).toBeNull();
    });

    it('calls chrome.storage.local.remove with the CACHE_PREFIX-ed key', async () => {
      vi.clearAllMocks();
      await invalidate('test-entry');

      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        `${CACHE_PREFIX}test-entry`,
      );
    });

    it('is a no-op for non-existent keys — does not throw', async () => {
      await expect(invalidate('does-not-exist')).resolves.toBeUndefined();

      // remove() is still called (no-op removal in chrome.storage)
      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        `${CACHE_PREFIX}does-not-exist`,
      );
    });

    it('does not affect other cached entries', async () => {
      await set('key1', 'val1', 60_000);
      await set('key2', 'val2', 60_000);

      await invalidate('key1');

      expect(await get<string>('key1')).toBeNull();
      expect(await get<string>('key2')).toBe('val2');
    });
  });

  // ---------------------------------------------------------------------------
  // cleanup()
  // ---------------------------------------------------------------------------
  describe('cleanup()', () => {
    it('removes all expired entries and preserves fresh ones', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      await set('fresh', 'data1', 60_000);   // survives
      await set('stale1', 'data2', 1000);     // expires
      await set('stale2', 'data3', 2000);     // expires

      // Advance 5 s — stale1 and stale2 expire
      vi.advanceTimersByTime(5000);
      vi.clearAllMocks();

      await cleanup();

      // Verify chrome.storage.local.get(null) was called to scan all entries
      expect(chrome.storage.local.get).toHaveBeenCalledWith(null);

      // Verify batch remove was called exactly once with expired keys
      expect(chrome.storage.local.remove).toHaveBeenCalledTimes(1);
      const removedKeys = vi.mocked(chrome.storage.local.remove).mock
        .calls[0][0] as string[];
      expect(removedKeys).toContain(`${CACHE_PREFIX}stale1`);
      expect(removedKeys).toContain(`${CACHE_PREFIX}stale2`);
      expect(removedKeys).not.toContain(`${CACHE_PREFIX}fresh`);

      // Verify data state
      expect(await get<string>('fresh')).toBe('data1');
      expect(await get<string>('stale1')).toBeNull();
      expect(await get<string>('stale2')).toBeNull();

      debugSpy.mockRestore();
    });

    it('handles empty storage gracefully', async () => {
      await cleanup();

      // get(null) should still be called to scan
      expect(chrome.storage.local.get).toHaveBeenCalledWith(null);

      // Nothing to remove
      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    });

    it('only removes cache-prefixed entries — ignores other storage data', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      // Inject non-cache entries directly
      await chrome.storage.local.set({ 'non-cache-key': 'some-value' });
      await chrome.storage.local.set({ 'zustand-state': { signals: [] } });

      // Store a cache entry that will expire
      await set('cached', 'val', 1000);

      vi.advanceTimersByTime(5000);
      vi.clearAllMocks();

      await cleanup();

      expect(chrome.storage.local.remove).toHaveBeenCalledTimes(1);
      const removedKeys = vi.mocked(chrome.storage.local.remove).mock
        .calls[0][0] as string[];
      expect(removedKeys).toContain(`${CACHE_PREFIX}cached`);
      expect(removedKeys).not.toContain('non-cache-key');
      expect(removedKeys).not.toContain('zustand-state');

      debugSpy.mockRestore();
    });

    it('does nothing when no entries are expired', async () => {
      await set('long-lived-1', 'data', 60_000);
      await set('long-lived-2', 'data', 120_000);
      vi.clearAllMocks();

      await cleanup();

      expect(chrome.storage.local.get).toHaveBeenCalledWith(null);
      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    });

    it('removes malformed cache-prefixed entries during cleanup', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      // Malformed: string instead of CacheEntry
      await chrome.storage.local.set({
        [`${CACHE_PREFIX}malformed`]: 'just-a-string',
      });
      // Valid non-expired entry
      await set('valid', 'data', 60_000);
      vi.clearAllMocks();

      await cleanup();

      expect(chrome.storage.local.remove).toHaveBeenCalledTimes(1);
      const removedKeys = vi.mocked(chrome.storage.local.remove).mock
        .calls[0][0] as string[];
      expect(removedKeys).toContain(`${CACHE_PREFIX}malformed`);
      expect(removedKeys).not.toContain(`${CACHE_PREFIX}valid`);

      debugSpy.mockRestore();
    });

    it('does not throw on storage errors during cleanup', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
        new Error('Storage unavailable'),
      );

      await expect(cleanup()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('cleanup failed'),
      );

      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Integration-Style Lifecycle Tests
  // ---------------------------------------------------------------------------
  describe('Integration', () => {
    it('full lifecycle: set → get → expire → get returns null', async () => {
      await set('lifecycle', 'data', 5000);

      // Before expiration
      expect(await get<string>('lifecycle')).toBe('data');

      // Past TTL
      vi.advanceTimersByTime(6000);

      expect(await get<string>('lifecycle')).toBeNull();
    });

    it('multiple concurrent cache operations', async () => {
      // Store simultaneously
      await Promise.all([
        set('token-a', { price: 1.5 }, 10_000),
        set('token-b', { price: 2.0 }, 5000),
        set('token-c', { price: 3.0 }, 20_000),
      ]);

      // All retrievable
      expect(await get<{ price: number }>('token-a')).toEqual({ price: 1.5 });
      expect(await get<{ price: number }>('token-b')).toEqual({ price: 2.0 });
      expect(await get<{ price: number }>('token-c')).toEqual({ price: 3.0 });

      // Invalidate token-a
      await invalidate('token-a');
      expect(await get('token-a')).toBeNull();

      // Advance 7 s — token-b (5 s TTL) expires, token-c (20 s) survives
      vi.advanceTimersByTime(7000);
      expect(await get('token-b')).toBeNull();
      expect(await get<{ price: number }>('token-c')).toEqual({ price: 3.0 });
    });

    it('set → cleanup → verify only expired entries are removed', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      await set('keep', 'important', 60_000);
      await set('expire-soon', 'temporary', 3000);

      vi.advanceTimersByTime(4000);
      await cleanup();

      expect(await get<string>('keep')).toBe('important');
      expect(await get<string>('expire-soon')).toBeNull();

      debugSpy.mockRestore();
    });

    it('overwrite resets TTL correctly', async () => {
      // Store with 3 s TTL
      await set('refresh', 'v1', 3000);

      // Advance 2 s
      vi.advanceTimersByTime(2000);

      // Overwrite with new 3 s TTL — effectively extends lifetime
      await set('refresh', 'v2', 3000);

      // 2 s after overwrite — still alive (2 < 3)
      vi.advanceTimersByTime(2000);
      expect(await get<string>('refresh')).toBe('v2');

      // 2 more seconds after previous advance — now 4 s since overwrite, past 3 s TTL
      vi.advanceTimersByTime(2000);
      expect(await get<string>('refresh')).toBeNull();
    });
  });
});
