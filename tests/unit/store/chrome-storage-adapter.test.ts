/**
 * tests/unit/store/chrome-storage-adapter.test.ts
 *
 * Comprehensive unit tests for the Zustand-to-chrome.storage persistence
 * middleware. Covers serialization/deserialization, read/write operations,
 * middleware lifecycle, cross-context sync, hydration, manual persistence,
 * and state clearing.
 *
 * Per AAP Section 0.4.4 and 0.7.1:
 * - State must survive service worker termination via chrome.storage
 * - Cross-context sync via chrome.storage.onChanged between SW and content script
 * - Zustand stores mix state + actions; only data fields are serialized
 *
 * @module tests/unit/store/chrome-storage-adapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from 'zustand/vanilla';
import {
  createChromeStorageMiddleware,
  hydrateStore,
  persistStore,
  clearStoredState,
  serializeState,
  deserializeState,
  readFromStorage,
  writeToStorage,
  type ChromeStorageArea,
  type ChromeStorageConfig,
} from '../../../src/store/chrome-storage-adapter';

// ---------------------------------------------------------------------------
// Test Store Type Definitions
// ---------------------------------------------------------------------------

/** Plain state fields for the test store */
interface TestStoreState {
  count: number;
  name: string;
  items: string[];
}

/** Action methods for the test store */
interface TestStoreActions {
  increment: () => void;
  setName: (name: string) => void;
  addItem: (item: string) => void;
}

/** Combined Zustand store type (state + actions, as Zustand does) */
type TestStore = TestStoreState & TestStoreActions;

// ---------------------------------------------------------------------------
// Chrome Storage Mock Infrastructure
// ---------------------------------------------------------------------------

/** Backing stores for each chrome.storage area */
let mockLocalStorage: Record<string, unknown>;
let mockSyncStorage: Record<string, unknown>;
let mockSessionStorage: Record<string, unknown>;

/** Registered onChanged listeners for simulating cross-context sync */
let onChangedListeners: Array<
  (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => void
>;

/**
 * Creates a mock chrome.storage.StorageArea backed by an in-memory
 * Record object, with vi.fn() wrappers for call tracking.
 */
function createMockStorageArea(backingStore: Record<string, unknown>) {
  return {
    get: vi.fn(
      (keys?: string | string[] | Record<string, unknown> | null) => {
        if (keys === null || keys === undefined) {
          return Promise.resolve({ ...backingStore });
        }
        if (typeof keys === 'string') {
          return Promise.resolve(
            keys in backingStore ? { [keys]: backingStore[keys] } : {},
          );
        }
        if (Array.isArray(keys)) {
          const result: Record<string, unknown> = {};
          keys.forEach((k) => {
            if (k in backingStore) result[k] = backingStore[k];
          });
          return Promise.resolve(result);
        }
        return Promise.resolve({});
      },
    ),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(backingStore, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const keysArr = Array.isArray(keys) ? keys : [keys];
      keysArr.forEach((k) => delete backingStore[k]);
      return Promise.resolve();
    }),
  };
}

/**
 * Simulates a chrome.storage.onChanged event by invoking all registered
 * listeners with the provided change data. This replicates the behavior
 * of Chrome firing onChanged when another context writes to storage.
 */
function simulateStorageChange(
  storageKey: string,
  newValue: unknown,
  areaName: string,
  oldValue?: unknown,
): void {
  const changes = {
    [storageKey]: {
      newValue,
      ...(oldValue !== undefined ? { oldValue } : {}),
    },
  };
  for (const listener of onChangedListeners) {
    listener(changes, areaName);
  }
}

// ---------------------------------------------------------------------------
// Main Test Suite
// ---------------------------------------------------------------------------

describe('chrome-storage-adapter', () => {
  // -----------------------------------------------------------------------
  // Setup and Teardown
  // -----------------------------------------------------------------------

  beforeEach(() => {
    // Enable fake timers for debounce testing (default 300ms write debounce)
    vi.useFakeTimers();

    // Reset backing stores
    mockLocalStorage = {};
    mockSyncStorage = {};
    mockSessionStorage = {};
    onChangedListeners = [];

    // Override the global chrome mock with fine-grained test controls
    globalThis.chrome = {
      storage: {
        local: createMockStorageArea(mockLocalStorage),
        sync: createMockStorageArea(mockSyncStorage),
        session: createMockStorageArea(mockSessionStorage),
        onChanged: {
          addListener: vi.fn(
            (listener: (...args: unknown[]) => void) => {
              onChangedListeners.push(
                listener as (typeof onChangedListeners)[number],
              );
            },
          ),
          removeListener: vi.fn(
            (listener: (...args: unknown[]) => void) => {
              onChangedListeners = onChangedListeners.filter(
                (l) => l !== listener,
              );
            },
          ),
          hasListener: vi.fn(() => false),
        },
      },
    } as unknown as typeof chrome;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    onChangedListeners = [];
  });

  // -----------------------------------------------------------------------
  // Test Helpers
  // -----------------------------------------------------------------------

  /**
   * Creates a TestStore wrapped with the chrome.storage persistence
   * middleware. Configurable storage key, area, and middleware options.
   */
  function createTestStore(
    key: string = 'test-store',
    area: ChromeStorageArea = 'local',
    config?: Partial<ChromeStorageConfig>,
  ) {
    return createStore<TestStore>(
      createChromeStorageMiddleware<TestStore>(
        key,
        area,
        (set) => ({
          count: 0,
          name: '',
          items: [],
          increment: () => set((s) => ({ count: s.count + 1 })),
          setName: (n: string) => set({ name: n }),
          addItem: (item: string) =>
            set((s) => ({ items: [...s.items, item] })),
        }),
        config,
      ),
    );
  }

  /**
   * Creates a plain vanilla Zustand store without persistence middleware.
   * Used to test hydrateStore and persistStore as standalone functions.
   */
  function createVanillaStore(initialState?: Partial<TestStoreState>) {
    return createStore<TestStore>((set) => ({
      count: initialState?.count ?? 0,
      name: initialState?.name ?? '',
      items: initialState?.items ?? [],
      increment: () => set((s) => ({ count: s.count + 1 })),
      setName: (n: string) => set({ name: n }),
      addItem: (item: string) =>
        set((s) => ({ items: [...s.items, item] })),
    }));
  }

  // =========================================================================
  // serializeState
  // =========================================================================

  describe('serializeState', () => {
    it('serializes plain state fields correctly', () => {
      const state = { count: 5, name: 'test', items: ['a', 'b'] };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      expect(parsed.count).toBe(5);
      expect(parsed.name).toBe('test');
      expect(parsed.items).toEqual(['a', 'b']);
    });

    it('excludes function properties (Zustand actions)', () => {
      const state = {
        count: 5,
        name: 'test',
        increment: () => {},
        setName: (_n: string) => {},
      };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      expect(parsed.count).toBe(5);
      expect(parsed.name).toBe('test');
      expect(parsed.increment).toBeUndefined();
      expect(parsed.setName).toBeUndefined();
    });

    it('excludes explicitly excluded fields', () => {
      const state = { count: 1, name: 'test', computed: 'derived-value' };
      const result = serializeState(state, ['computed']);
      const parsed = JSON.parse(result);

      expect(parsed.count).toBe(1);
      expect(parsed.name).toBe('test');
      expect(parsed.computed).toBeUndefined();
    });

    it('handles empty state object', () => {
      const result = serializeState({});
      expect(result).toBe('{}');
    });

    it('handles state with nested objects', () => {
      const state = {
        settings: { theme: 'dark', mode: 'conservative' },
        count: 1,
      };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      expect(parsed.settings).toEqual({ theme: 'dark', mode: 'conservative' });
      expect(parsed.count).toBe(1);
    });

    it('handles state with arrays', () => {
      const state = { items: ['token1', 'token2', 'token3'] };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      expect(parsed.items).toEqual(['token1', 'token2', 'token3']);
    });

    it('handles state with null and undefined values', () => {
      const state = { value: null, other: undefined as unknown };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      // null is preserved by JSON.stringify
      expect(parsed.value).toBeNull();
      // undefined is omitted by JSON.stringify
      expect(parsed.other).toBeUndefined();
    });

    it('converts Map instances to serializable format', () => {
      const state = {
        data: new Map<string, string>([
          ['key1', 'val1'],
          ['key2', 'val2'],
        ]),
      };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      expect(parsed.data.__type).toBe('Map');
      expect(parsed.data.entries).toEqual([
        ['key1', 'val1'],
        ['key2', 'val2'],
      ]);
    });

    it('converts Set instances to serializable format', () => {
      const state = { tags: new Set(['tag1', 'tag2']) };
      const result = serializeState(state);
      const parsed = JSON.parse(result);

      expect(parsed.tags.__type).toBe('Set');
      expect(parsed.tags.values).toEqual(['tag1', 'tag2']);
    });
  });

  // =========================================================================
  // deserializeState
  // =========================================================================

  describe('deserializeState', () => {
    it('parses valid JSON into state object', () => {
      const result = deserializeState<TestStoreState>(
        '{"count":5,"name":"test","items":["a"]}',
      );

      expect(result.count).toBe(5);
      expect(result.name).toBe('test');
      expect(result.items).toEqual(['a']);
    });

    it('returns empty object for invalid JSON (graceful error handling)', () => {
      const result = deserializeState('not-valid-json');
      expect(result).toEqual({});
    });

    it('returns empty object for empty string', () => {
      const result = deserializeState('');
      expect(result).toEqual({});
    });

    it('handles JSON with extra/unknown fields', () => {
      const result = deserializeState<{ count: number }>(
        '{"count":10,"extra":"field","unknown":true}',
      );

      expect(result.count).toBe(10);
      expect((result as Record<string, unknown>).extra).toBe('field');
    });

    it('preserves nested objects and arrays', () => {
      const result = deserializeState<Record<string, unknown>>(
        '{"settings":{"theme":"dark"},"items":["a","b"]}',
      );

      expect(result.settings).toEqual({ theme: 'dark' });
      expect(result.items).toEqual(['a', 'b']);
    });

    it('handles JSON with numeric, boolean, null values', () => {
      const result = deserializeState<{
        count: number;
        active: boolean;
        data: null;
      }>('{"count":0,"active":false,"data":null}');

      expect(result.count).toBe(0);
      expect(result.active).toBe(false);
      expect(result.data).toBeNull();
    });

    it('restores Map instances from serialized __type marker', () => {
      const json = JSON.stringify({
        data: {
          __type: 'Map',
          entries: [
            ['key1', 'val1'],
            ['key2', 'val2'],
          ],
        },
      });
      const result = deserializeState<{ data: Map<string, string> }>(json);

      expect(result.data).toBeInstanceOf(Map);
      expect(result.data!.get('key1')).toBe('val1');
      expect(result.data!.get('key2')).toBe('val2');
    });

    it('restores Set instances from serialized __type marker', () => {
      const json = JSON.stringify({
        tags: { __type: 'Set', values: ['tag1', 'tag2'] },
      });
      const result = deserializeState<{ tags: Set<string> }>(json);

      expect(result.tags).toBeInstanceOf(Set);
      expect(result.tags!.has('tag1')).toBe(true);
      expect(result.tags!.has('tag2')).toBe(true);
    });
  });

  // =========================================================================
  // readFromStorage
  // =========================================================================

  describe('readFromStorage', () => {
    it('reads and deserializes from chrome.storage.local', async () => {
      mockLocalStorage['test-key'] = '{"count":10}';

      const result = await readFromStorage<TestStoreState>('test-key', 'local');

      expect(result).not.toBeNull();
      expect(result!.count).toBe(10);
      expect(chrome.storage.local.get).toHaveBeenCalledWith('test-key');
    });

    it('reads from chrome.storage.sync', async () => {
      mockSyncStorage['settings-key'] = '{"mode":"conservative"}';

      const result = await readFromStorage<{ mode: string }>(
        'settings-key',
        'sync',
      );

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('conservative');
      expect(chrome.storage.sync.get).toHaveBeenCalledWith('settings-key');
    });

    it('reads from chrome.storage.session', async () => {
      mockSessionStorage['session-key'] = '{"temp":true}';

      const result = await readFromStorage<{ temp: boolean }>(
        'session-key',
        'session',
      );

      expect(result).not.toBeNull();
      expect(result!.temp).toBe(true);
      expect(chrome.storage.session.get).toHaveBeenCalledWith('session-key');
    });

    it('returns null when key does not exist', async () => {
      const result = await readFromStorage<TestStoreState>(
        'nonexistent',
        'local',
      );
      expect(result).toBeNull();
    });

    it('returns null on chrome.storage error (graceful degradation)', async () => {
      (
        chrome.storage.local.get as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('Storage error'));

      const result = await readFromStorage<TestStoreState>('key', 'local');
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // writeToStorage
  // =========================================================================

  describe('writeToStorage', () => {
    it('serializes state and writes to chrome.storage.local', async () => {
      await writeToStorage('test-key', { count: 5, name: 'test' }, 'local');

      expect(chrome.storage.local.set).toHaveBeenCalled();
      const callArgs = (chrome.storage.local.set as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      expect(typeof callArgs['test-key']).toBe('string');

      const parsed = JSON.parse(callArgs['test-key'] as string);
      expect(parsed.count).toBe(5);
      expect(parsed.name).toBe('test');
    });

    it('writes to chrome.storage.sync', async () => {
      await writeToStorage(
        'settings-key',
        { mode: 'conservative' },
        'sync',
      );
      expect(chrome.storage.sync.set).toHaveBeenCalled();
    });

    it('writes to chrome.storage.session', async () => {
      await writeToStorage('session-key', { temp: true }, 'session');
      expect(chrome.storage.session.set).toHaveBeenCalled();
    });

    it('excludes specified fields from serialization', async () => {
      await writeToStorage(
        'key',
        { count: 1, computed: 'skip' },
        'local',
        ['computed'],
      );

      const callArgs = (chrome.storage.local.set as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      const parsed = JSON.parse(callArgs['key'] as string);

      expect(parsed.count).toBe(1);
      expect(parsed.computed).toBeUndefined();
    });

    it('does not throw on write errors (graceful degradation)', async () => {
      (
        chrome.storage.local.set as ReturnType<typeof vi.fn>
      ).mockRejectedValueOnce(new Error('Write error'));

      // Should resolve without throwing
      await expect(
        writeToStorage('key', { data: true }, 'local'),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // createChromeStorageMiddleware — Core Middleware
  // =========================================================================

  describe('createChromeStorageMiddleware', () => {
    it('returns a valid Zustand store with correct initial state', () => {
      const store = createTestStore();

      expect(store.getState().count).toBe(0);
      expect(store.getState().name).toBe('');
      expect(store.getState().items).toEqual([]);
    });

    it('state changes trigger debounced writes to chrome.storage.local', async () => {
      const store = createTestStore('debounce-store', 'local');

      store.getState().increment();

      // Debounced — should NOT have written yet
      expect(chrome.storage.local.set).not.toHaveBeenCalled();

      // Advance past the default 300ms debounce
      await vi.advanceTimersByTimeAsync(300);

      // Now it should have written
      expect(chrome.storage.local.set).toHaveBeenCalled();

      const callArgs = (chrome.storage.local.set as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      const parsed = JSON.parse(callArgs['debounce-store'] as string);
      expect(parsed.count).toBe(1);
    });

    it('rapid state changes are coalesced into a single debounced write', async () => {
      const store = createTestStore('coalesce-store', 'local');

      // Rapidly increment 5 times
      store.getState().increment();
      store.getState().increment();
      store.getState().increment();
      store.getState().increment();
      store.getState().increment();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(300);

      // Should have been called only ONCE (coalesced)
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);

      const callArgs = (chrome.storage.local.set as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      const parsed = JSON.parse(callArgs['coalesce-store'] as string);
      expect(parsed.count).toBe(5);
    });

    it('respects configurable write debounce delay', async () => {
      const store = createTestStore('custom-debounce', 'local', {
        writeDebounceMs: 500,
      });

      store.getState().increment();

      // After 300ms — should NOT have written yet (custom 500ms debounce)
      await vi.advanceTimersByTimeAsync(300);
      expect(chrome.storage.local.set).not.toHaveBeenCalled();

      // After 200ms more (total 500ms) — should NOW be written
      await vi.advanceTimersByTimeAsync(200);
      expect(chrome.storage.local.set).toHaveBeenCalled();
    });

    it('state changes persist to correct storage area (local vs sync)', async () => {
      const localStore = createTestStore('local-store', 'local');
      const syncStore = createTestStore('sync-store', 'sync');

      localStore.getState().increment();
      syncStore.getState().setName('synced');

      await vi.advanceTimersByTimeAsync(300);

      expect(chrome.storage.local.set).toHaveBeenCalled();
      expect(chrome.storage.sync.set).toHaveBeenCalled();
    });

    it('registers chrome.storage.onChanged listener when enableSync is true (default)', () => {
      createTestStore('sync-default', 'local');

      expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
      expect(onChangedListeners.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT register chrome.storage.onChanged listener when enableSync is false', () => {
      // Clear the mock counter from any previous calls
      (
        chrome.storage.onChanged.addListener as ReturnType<typeof vi.fn>
      ).mockClear();

      createTestStore('no-sync', 'local', { enableSync: false });

      expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();
    });

    it('cross-context sync — onChanged updates the store state', () => {
      const store = createTestStore('sync-test', 'local');
      expect(store.getState().count).toBe(0);

      // Simulate an external storage change (e.g., from service worker context)
      simulateStorageChange(
        'sync-test',
        '{"count":42,"name":"external","items":[]}',
        'local',
      );

      expect(store.getState().count).toBe(42);
      expect(store.getState().name).toBe('external');
    });

    it('cross-context sync ignores changes from different storage areas', () => {
      const store = createTestStore('area-mismatch', 'local');
      store.getState().setName('original');

      // Simulate change from 'sync' area — store is on 'local'
      simulateStorageChange('area-mismatch', '{"name":"wrong-area"}', 'sync');

      expect(store.getState().name).toBe('original');
    });

    it('cross-context sync ignores changes for different storage keys', () => {
      const store = createTestStore('my-store', 'local');
      store.getState().setName('original');

      // Simulate change for a different key
      simulateStorageChange('other-store', '{"name":"wrong-key"}', 'local');

      expect(store.getState().name).toBe('original');
    });

    it('cross-context sync handles malformed newValue gracefully', () => {
      const store = createTestStore('malformed-test', 'local');
      store.getState().setName('safe');

      // Simulate change with invalid JSON — should not crash or alter state
      simulateStorageChange('malformed-test', 'invalid-json-{{', 'local');

      expect(store.getState().name).toBe('safe');
    });

    it('store actions (functions) work normally through the middleware', () => {
      const store = createTestStore();

      store.getState().increment();
      expect(store.getState().count).toBe(1);

      store.getState().setName('hello');
      expect(store.getState().name).toBe('hello');

      store.getState().addItem('token1');
      expect(store.getState().items).toEqual(['token1']);

      // Chained operations
      store.getState().increment();
      store.getState().addItem('token2');
      expect(store.getState().count).toBe(2);
      expect(store.getState().items).toEqual(['token1', 'token2']);
    });

    it('graceful handling when chrome.storage is undefined', () => {
      // Temporarily remove chrome global
      const savedChrome = globalThis.chrome;
      (globalThis as Record<string, unknown>).chrome = undefined;

      // Store should still function for in-memory Zustand state operations
      const store = createStore<TestStore>(
        createChromeStorageMiddleware<TestStore>(
          'no-chrome-store',
          'local',
          (set) => ({
            count: 0,
            name: '',
            items: [],
            increment: () => set((s) => ({ count: s.count + 1 })),
            setName: (n: string) => set({ name: n }),
            addItem: (item: string) =>
              set((s) => ({ items: [...s.items, item] })),
          }),
        ),
      );

      // In-memory state operations should work despite no chrome.storage
      store.getState().increment();
      expect(store.getState().count).toBe(1);

      store.getState().setName('works');
      expect(store.getState().name).toBe('works');

      // Restore chrome global
      globalThis.chrome = savedChrome;
    });
  });

  // =========================================================================
  // hydrateStore
  // =========================================================================

  describe('hydrateStore', () => {
    it('loads persisted state into the store on startup', async () => {
      mockLocalStorage['my-store'] =
        '{"count":100,"name":"hydrated","items":["a","b"]}';
      const store = createVanillaStore();

      await hydrateStore<TestStore>('my-store', store, 'local');

      expect(store.getState().count).toBe(100);
      expect(store.getState().name).toBe('hydrated');
      expect(store.getState().items).toEqual(['a', 'b']);
    });

    it('hydrates from chrome.storage.sync', async () => {
      mockSyncStorage['settings'] = '{"name":"synced-settings","count":77}';
      const store = createVanillaStore();

      await hydrateStore<TestStore>('settings', store, 'sync');

      expect(store.getState().name).toBe('synced-settings');
      expect(store.getState().count).toBe(77);
    });

    it('no-op when no persisted state exists', async () => {
      const store = createVanillaStore({ count: 0, name: 'default' });

      await hydrateStore<TestStore>('nonexistent', store, 'local');

      // Initial state preserved — not overwritten
      expect(store.getState().count).toBe(0);
      expect(store.getState().name).toBe('default');
    });

    it('partial hydration merges with existing state', async () => {
      mockLocalStorage['partial'] = '{"count":50}';
      const store = createVanillaStore({
        count: 0,
        name: 'default',
        items: [],
      });

      await hydrateStore<TestStore>('partial', store, 'local');

      // Hydrated field updated
      expect(store.getState().count).toBe(50);
      // Non-hydrated fields preserved from initial state (Zustand merge)
      expect(store.getState().name).toBe('default');
      expect(store.getState().items).toEqual([]);
    });

    it('handles corrupted persisted state gracefully', async () => {
      mockLocalStorage['corrupted'] = 'not-valid-json';
      const store = createVanillaStore({ count: 7, name: 'safe' });

      await hydrateStore<TestStore>('corrupted', store, 'local');

      // Initial state preserved — corrupted data is discarded
      expect(store.getState().count).toBe(7);
      expect(store.getState().name).toBe('safe');
    });
  });

  // =========================================================================
  // persistStore
  // =========================================================================

  describe('persistStore', () => {
    it('manually persists current store state to chrome.storage', async () => {
      const store = createVanillaStore({ count: 42, name: 'manual' });

      await persistStore<TestStore>('my-store', store, 'local');

      expect(chrome.storage.local.set).toHaveBeenCalled();
      const callArgs = (chrome.storage.local.set as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      const parsed = JSON.parse(callArgs['my-store'] as string);
      expect(parsed.count).toBe(42);
      expect(parsed.name).toBe('manual');
    });

    it('persists to specified storage area (sync)', async () => {
      const store = createVanillaStore({ name: 'sync-test' });

      await persistStore<TestStore>('settings', store, 'sync');

      expect(chrome.storage.sync.set).toHaveBeenCalled();
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('excludes specified fields from persistence', async () => {
      const store = createStore(() => ({
        count: 1,
        computed: 'should-exclude',
      }));

      await persistStore('store', store, 'local', ['computed']);

      const callArgs = (chrome.storage.local.set as ReturnType<typeof vi.fn>)
        .mock.calls[0][0];
      const parsed = JSON.parse(callArgs['store'] as string);
      expect(parsed.count).toBe(1);
      expect(parsed.computed).toBeUndefined();
    });

    it('persists immediately (not debounced) — key difference from middleware', async () => {
      const store = createVanillaStore({ count: 99 });

      // No timer advance needed — persistStore writes synchronously
      await persistStore<TestStore>('immediate', store, 'local');

      // Should have been called exactly once, immediately
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // clearStoredState
  // =========================================================================

  describe('clearStoredState', () => {
    it('removes stored state by key from chrome.storage.local', async () => {
      mockLocalStorage['my-store'] = '{"count":10}';

      await clearStoredState('my-store', 'local');

      expect(chrome.storage.local.remove).toHaveBeenCalledWith('my-store');
      expect(mockLocalStorage['my-store']).toBeUndefined();
    });

    it('removes from chrome.storage.sync', async () => {
      mockSyncStorage['settings'] = '{"mode":"aggressive"}';

      await clearStoredState('settings', 'sync');

      expect(chrome.storage.sync.remove).toHaveBeenCalledWith('settings');
      expect(mockSyncStorage['settings']).toBeUndefined();
    });

    it('no-op for non-existent keys (does not throw)', async () => {
      await expect(
        clearStoredState('does-not-exist', 'local'),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // Integration: Full Persistence Lifecycle
  // =========================================================================

  describe('integration: full persistence lifecycle', () => {
    it('full lifecycle — create store → modify state → persist → hydrate into new store', async () => {
      // Step 1: Create a middleware-wrapped store
      const storeA = createTestStore('lifecycle-store', 'local');

      // Step 2: Modify state
      storeA.getState().increment();
      storeA.getState().setName('lifecycle');
      storeA.getState().addItem('token-abc');

      // Step 3: Let the debounced write complete
      await vi.advanceTimersByTimeAsync(300);

      // Step 4: Verify state was persisted to backing store
      expect(mockLocalStorage['lifecycle-store']).toBeDefined();

      // Step 5: Create a NEW vanilla store with default state
      const storeB = createVanillaStore();
      expect(storeB.getState().count).toBe(0);
      expect(storeB.getState().name).toBe('');
      expect(storeB.getState().items).toEqual([]);

      // Step 6: Hydrate the new store from persisted data
      await hydrateStore<TestStore>('lifecycle-store', storeB, 'local');

      // Step 7: Verify the new store matches the original's modified state
      expect(storeB.getState().count).toBe(1);
      expect(storeB.getState().name).toBe('lifecycle');
      expect(storeB.getState().items).toEqual(['token-abc']);
    });

    it('cross-context sync between two stores (simulating service worker ↔ content script)', async () => {
      // Store A simulates the service worker vanilla store
      const storeA = createTestStore('shared-store', 'local');

      // Store B simulates the content script store — same key and area
      const storeB = createTestStore('shared-store', 'local');

      // Verify both stores start with default state
      expect(storeA.getState().count).toBe(0);
      expect(storeB.getState().count).toBe(0);

      // Modify Store A's state (service worker writes data)
      storeA.getState().increment();
      storeA.getState().increment();
      storeA.getState().setName('from-service-worker');

      // Let Store A's debounced write complete to chrome.storage
      await vi.advanceTimersByTimeAsync(300);

      // Read what Store A persisted
      const persisted = mockLocalStorage['shared-store'] as string;
      expect(persisted).toBeDefined();

      // Simulate chrome.storage.onChanged event (as Chrome would fire it
      // when the service worker writes to storage — content script picks it up)
      simulateStorageChange('shared-store', persisted, 'local');

      // Verify Store B (content script) received the updated state
      expect(storeB.getState().count).toBe(2);
      expect(storeB.getState().name).toBe('from-service-worker');
    });

    it('serialize → deserialize round-trip preserves Map and Set data', () => {
      const original = {
        signals: new Map<string, number>([
          ['SOL123', 85],
          ['SOL456', 62],
        ]),
        tags: new Set(['hot', 'new', 'safe']),
        count: 42,
      };

      const serialized = serializeState(original);
      const restored = deserializeState<typeof original>(serialized);

      expect(restored.count).toBe(42);
      expect(restored.signals).toBeInstanceOf(Map);
      expect((restored.signals as Map<string, number>).get('SOL123')).toBe(85);
      expect((restored.signals as Map<string, number>).get('SOL456')).toBe(62);
      expect(restored.tags).toBeInstanceOf(Set);
      expect((restored.tags as Set<string>).has('hot')).toBe(true);
      expect((restored.tags as Set<string>).has('new')).toBe(true);
      expect((restored.tags as Set<string>).has('safe')).toBe(true);
    });
  });
});
