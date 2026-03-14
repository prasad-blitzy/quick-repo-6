/**
 * src/store/chrome-storage-adapter.ts — Zustand Persist Middleware for chrome.storage
 *
 * FOUNDATIONAL module used by ALL other Zustand store files in `src/store/`.
 *
 * Provides a middleware factory that wraps any Zustand `StateCreator` with
 * automatic persistence to `chrome.storage.local`, `chrome.storage.sync`, or
 * `chrome.storage.session`. Serializes only data fields (skipping functions
 * that Zustand stores mix into state), debounces writes to prevent excessive
 * I/O, and sets up `chrome.storage.onChanged` listeners for cross-context
 * synchronization between the service worker and content script.
 *
 * Per AAP Section 0.4.4:
 * - Service worker creates Zustand stores using `zustand/vanilla` and persists
 *   to `chrome.storage.local` via this middleware.
 * - Content script reads store snapshots from `chrome.storage.local` and
 *   creates Preact-compatible Zustand hooks for the UI layer.
 * - State changes propagate across contexts via `chrome.storage.onChanged`.
 *
 * Per AAP Section 0.7.1:
 * - State MUST survive service worker termination (~30s idle timeout in MV3).
 * - `chrome.storage.onChanged` listeners MUST be registered synchronously
 *   at the top level of the service worker (handled during store creation).
 *
 * Storage area guidelines:
 * - `local`   — persistent, 5MB default / 10MB with unlimitedStorage, most stores
 * - `sync`    — synced across Chrome devices, 100KB total / 8KB per item, settings only
 * - `session` — in-memory, 10MB limit, survives navigation but not browser restart
 *
 * @module store/chrome-storage-adapter
 */

import type { StateCreator } from 'zustand';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

const logger = createLogger('chrome-storage-adapter');

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * Supported Chrome storage area identifiers.
 *
 * - `'local'`   — Persistent storage, 5MB default (10MB with unlimitedStorage).
 *                  Used by signal-store, token-store, position-store.
 * - `'sync'`    — Synced across user's Chrome devices, 100KB total / 8KB per item.
 *                  Used by settings-store only.
 * - `'session'` — In-memory storage, 10MB limit. Survives page navigation but
 *                  lost on browser restart. Used for transient runtime state.
 */
export type ChromeStorageArea = 'local' | 'sync' | 'session';

/**
 * Configuration for the chrome.storage persistence middleware.
 *
 * Controls how a Zustand store's state is serialized, persisted, and
 * synchronized across Chrome Extension contexts.
 */
export interface ChromeStorageConfig {
  /** Unique key used in chrome.storage to identify this store's persisted state */
  storageKey: string;

  /** Which chrome.storage area to use for persistence */
  storageArea: ChromeStorageArea;

  /**
   * Debounce interval in milliseconds for batching writes to chrome.storage.
   * Prevents excessive I/O from rapid-fire Zustand state updates.
   * @default 300
   */
  writeDebounceMs?: number;

  /**
   * Field names to exclude from serialization (e.g., computed values,
   * transient caches). Functions are always excluded automatically.
   */
  excludeFields?: string[];

  /**
   * Whether to listen to `chrome.storage.onChanged` for incoming state
   * changes from other Extension contexts (content script ↔ service worker).
   * Disable for stores that are only written from a single context.
   * @default true
   */
  enableSync?: boolean;
}

// ---------------------------------------------------------------------------
// Internal Helper — Chrome Storage Area Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves a `ChromeStorageArea` string to the corresponding
 * `chrome.storage.StorageArea` object.
 *
 * Falls back to `chrome.storage.local` for unknown area names.
 * Performs a runtime availability check and returns `null` when the Chrome
 * Extension storage API is not available (e.g., in a test or Node.js
 * environment without mocks).
 *
 * @param area - Target storage area identifier
 * @returns The Chrome StorageArea object, or `null` if chrome.storage is unavailable
 */
function getStorageArea(area: ChromeStorageArea): chrome.storage.StorageArea | null {
  try {
    if (typeof chrome === 'undefined' || !chrome?.storage) {
      return null;
    }
    switch (area) {
      case 'local':
        return chrome.storage.local;
      case 'sync':
        return chrome.storage.sync;
      case 'session':
        return chrome.storage.session;
      default:
        return chrome.storage.local;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serialization — State ↔ JSON
// ---------------------------------------------------------------------------

/**
 * Serializes a Zustand store's state into a JSON string suitable for
 * persistence in `chrome.storage`.
 *
 * Zustand stores mix data fields and action functions into a single state
 * object. This serializer:
 * 1. Skips all fields whose values are `function` — these are Zustand actions
 * 2. Skips fields listed in `excludeFields` — user-specified exclusions
 * 3. Handles `Map` and `Set` by converting to serializable representations
 * 4. Falls back to an empty JSON object on serialization failure
 *
 * @param state      - The full Zustand store state (data + actions)
 * @param excludeFields - Optional field names to exclude from serialization
 * @returns JSON string of the filtered, serializable state
 */
export function serializeState<T>(state: T, excludeFields?: string[]): string {
  try {
    const filtered: Record<string, unknown> = {};
    const entries = Object.entries(state as Record<string, unknown>);

    for (const [key, value] of entries) {
      // Always skip function fields — these are Zustand action methods
      if (typeof value === 'function') {
        continue;
      }

      // Skip user-specified exclusion fields
      if (excludeFields && excludeFields.includes(key)) {
        continue;
      }

      // Convert Map instances to a serializable format
      if (value instanceof Map) {
        filtered[key] = {
          __type: 'Map',
          entries: Array.from(value.entries()),
        };
        continue;
      }

      // Convert Set instances to a serializable format
      if (value instanceof Set) {
        filtered[key] = {
          __type: 'Set',
          values: Array.from(value.values()),
        };
        continue;
      }

      filtered[key] = value;
    }

    return JSON.stringify(filtered);
  } catch (err) {
    logger.error('Failed to serialize state', err);
    return '{}';
  }
}

/**
 * Deserializes a JSON string back into a partial Zustand store state object.
 *
 * Reverses the serialization performed by `serializeState`:
 * - Restores `Map` instances from `{ __type: 'Map', entries: [...] }` markers
 * - Restores `Set` instances from `{ __type: 'Set', values: [...] }` markers
 * - Returns an empty partial on invalid JSON (never throws)
 *
 * @param json - JSON string from chrome.storage
 * @returns Partial state object safe to merge into a Zustand store
 */
export function deserializeState<T>(json: string): Partial<T> {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Restore Map and Set instances from serialized markers
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const obj = value as Record<string, unknown>;
        if (obj.__type === 'Map' && Array.isArray(obj.entries)) {
          parsed[key] = new Map(obj.entries as [unknown, unknown][]);
        } else if (obj.__type === 'Set' && Array.isArray(obj.values)) {
          parsed[key] = new Set(obj.values as unknown[]);
        }
      }
    }

    return parsed as Partial<T>;
  } catch (err) {
    logger.error('Failed to deserialize state from chrome.storage', err);
    return {} as Partial<T>;
  }
}

// ---------------------------------------------------------------------------
// Chrome Storage Read / Write Operations
// ---------------------------------------------------------------------------

/**
 * Reads persisted state from the specified chrome.storage area.
 *
 * Retrieves the stored JSON string for the given key, deserializes it, and
 * returns the resulting partial state object. Returns `null` when:
 * - The key does not exist in storage
 * - chrome.storage is unavailable (test environment)
 * - Deserialization fails (returns `null`, not an empty object)
 *
 * @param key  - The storage key to read
 * @param area - Target chrome.storage area
 * @returns Deserialized partial state, or `null` if not found or unavailable
 */
export async function readFromStorage<T>(
  key: string,
  area: ChromeStorageArea,
): Promise<Partial<T> | null> {
  try {
    const storage = getStorageArea(area);
    if (!storage) {
      logger.warn(`chrome.storage.${area} is not available — skipping read`);
      return null;
    }

    const result = await storage.get(key);
    if (result[key] !== undefined && result[key] !== null) {
      const deserialized = deserializeState<T>(result[key] as string);
      // Only return non-empty deserialized state
      if (Object.keys(deserialized).length > 0) {
        return deserialized;
      }
    }

    return null;
  } catch (err) {
    logger.error(`Failed to read from chrome.storage.${area}`, err);
    return null;
  }
}

/**
 * Writes serialized state to the specified chrome.storage area.
 *
 * Serializes the provided state (excluding functions and excluded fields),
 * then writes the resulting JSON string to chrome.storage under the given key.
 * Errors are caught and logged but never thrown — persistence failures must
 * not crash the application.
 *
 * @param key           - The storage key to write
 * @param state         - The Zustand state object to serialize and persist
 * @param area          - Target chrome.storage area
 * @param excludeFields - Optional field names to exclude from serialization
 */
export async function writeToStorage(
  key: string,
  state: unknown,
  area: ChromeStorageArea,
  excludeFields?: string[],
): Promise<void> {
  try {
    const storage = getStorageArea(area);
    if (!storage) {
      logger.warn(`chrome.storage.${area} is not available — skipping write`);
      return;
    }

    const serialized = serializeState(state, excludeFields);
    await storage.set({ [key]: serialized });
  } catch (err) {
    logger.error(`Failed to write to chrome.storage.${area}`, err);
    // Intentionally not re-thrown — persistence failure must not crash the app
  }
}

// ---------------------------------------------------------------------------
// Write Debounce — Batch Rapid State Changes
// ---------------------------------------------------------------------------

/**
 * Creates a debounced writer that batches rapid calls into a single execution.
 *
 * When multiple Zustand state updates fire in quick succession (common during
 * batch processing or UI interactions), the debounce coalesces them into one
 * chrome.storage write after the specified delay. Only the latest state is
 * persisted — intermediate states are dropped (last-write-wins semantics).
 *
 * @param delay - Debounce delay in milliseconds
 * @returns A function that schedules write operations with debouncing
 */
function createDebouncedWriter(delay: number): (writeFn: () => Promise<void>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingWrite: (() => Promise<void>) | null = null;

  return function scheduleWrite(writeFn: () => Promise<void>): void {
    // Always update the pending write to the latest (last-write-wins)
    pendingWrite = writeFn;

    // Clear any existing scheduled write
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    // Schedule the write after the debounce delay
    timeoutId = setTimeout(async () => {
      timeoutId = null;
      if (pendingWrite) {
        const writeToExecute = pendingWrite;
        pendingWrite = null;
        try {
          await writeToExecute();
        } catch (err) {
          logger.error('Debounced write failed', err);
        }
      }
    }, delay);
  };
}

// ---------------------------------------------------------------------------
// Core Middleware Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Zustand middleware that wraps a store with automatic chrome.storage
 * persistence and cross-context synchronization.
 *
 * This is the primary export and the core integration point for all stores.
 * It wraps the Zustand `set` function so that every state update triggers a
 * debounced write to chrome.storage, and registers a `chrome.storage.onChanged`
 * listener to receive state updates from other Extension contexts.
 *
 * Usage with `zustand/vanilla` (service worker):
 * ```typescript
 * import { createStore } from 'zustand/vanilla';
 * import { createChromeStorageMiddleware } from './chrome-storage-adapter';
 *
 * const signalStore = createStore(
 *   createChromeStorageMiddleware('signal-store', 'local', (set, get) => ({
 *     signals: new Map(),
 *     addSignal: (id, signal) => set(state => {
 *       const next = new Map(state.signals);
 *       next.set(id, signal);
 *       return { signals: next };
 *     }),
 *   }))
 * );
 * ```
 *
 * @param storageKey   - Unique key in chrome.storage for this store
 * @param storageArea  - Target chrome.storage area ('local', 'sync', 'session')
 * @param storeCreator - The original Zustand StateCreator to wrap
 * @param config       - Optional middleware configuration overrides
 * @returns A wrapped StateCreator with persistence behavior
 */
export function createChromeStorageMiddleware<T>(
  storageKey: string,
  storageArea: ChromeStorageArea,
  storeCreator: StateCreator<T, [], []>,
  config?: Partial<ChromeStorageConfig>,
): StateCreator<T, [], []> {
  return (set, get, api) => {
    const writeDebounceMs = config?.writeDebounceMs ?? 300;
    const excludeFields = config?.excludeFields ?? [];
    const enableSync = config?.enableSync ?? true;

    // Create debounced writer for batching rapid state updates
    const debouncedWrite = createDebouncedWriter(writeDebounceMs);

    /**
     * Wrapped `set` function that persists state after every update.
     * Calls the original Zustand `set` to update in-memory state, then
     * schedules a debounced write to chrome.storage.
     *
     * Uses a function wrapper that forwards all arguments to the original
     * `set` while also scheduling persistence. The explicit overloads match
     * Zustand's `SetStateInternal<T>` type to satisfy strict TypeScript checks.
     */
    const persistingSet = ((
      partial: T | Partial<T> | ((state: T) => T | Partial<T>),
      replace?: boolean,
    ): void => {
      // Apply the state update to the in-memory Zustand store
      (set as (partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: boolean) => void)(
        partial,
        replace,
      );

      // Schedule a debounced persistence write
      debouncedWrite(() =>
        writeToStorage(storageKey, get(), storageArea, excludeFields),
      );
    }) as typeof set;

    // Create the store's initial state using the wrapped set function
    const initialState = storeCreator(persistingSet, get, api);

    // Set up cross-context sync via chrome.storage.onChanged
    if (enableSync) {
      setupStorageChangeListener(storageKey, storageArea, set);
    }

    logger.info(`Middleware initialized for store '${storageKey}' on chrome.storage.${storageArea}`);

    return initialState;
  };
}

// ---------------------------------------------------------------------------
// Cross-Context Sync — chrome.storage.onChanged Listener
// ---------------------------------------------------------------------------

/**
 * Registers a `chrome.storage.onChanged` listener that updates the Zustand
 * store when the persisted state is modified by another Extension context.
 *
 * This enables the service worker ↔ content script synchronization pattern:
 * - Service worker updates state → writes to chrome.storage.local
 * - Content script receives the onChanged event → merges into its Zustand store
 * - Preact components re-render via Zustand subscriptions
 *
 * The listener uses the raw `set` (not `persistingSet`) to merge incoming
 * state WITHOUT triggering another write back to chrome.storage, preventing
 * infinite sync loops.
 *
 * @param storageKey  - The storage key to listen for changes on
 * @param storageArea - Which storage area to filter events for
 * @param set         - Zustand's raw set function (no persistence wrapping)
 */
function setupStorageChangeListener<T>(
  storageKey: string,
  storageArea: ChromeStorageArea,
  set: {
    (partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: false): void;
    (state: T | ((state: T) => T), replace: true): void;
  },
): void {
  try {
    if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged) {
      logger.debug('chrome.storage.onChanged not available — cross-context sync disabled');
      return;
    }

    chrome.storage.onChanged.addListener(
      (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string,
      ) => {
        // Only react to changes in our target storage area and key
        if (areaName !== storageArea) {
          return;
        }

        const change = changes[storageKey];
        if (!change || change.newValue === undefined) {
          return;
        }

        try {
          const incomingState = deserializeState<T>(change.newValue as string);

          // Merge incoming state using the raw set to avoid triggering a write-back
          if (Object.keys(incomingState).length > 0) {
            set(incomingState);
            logger.debug(`Store '${storageKey}' synced from chrome.storage.${areaName}`);
          }
        } catch (err) {
          logger.error(`Failed to sync store '${storageKey}' from chrome.storage.${areaName}`, err);
        }
      },
    );

    logger.debug(`Cross-context sync listener registered for store '${storageKey}'`);
  } catch (err) {
    logger.error(`Failed to register chrome.storage.onChanged listener for '${storageKey}'`, err);
  }
}

// ---------------------------------------------------------------------------
// Hydration — Load Persisted State on Startup
// ---------------------------------------------------------------------------

/**
 * Hydrates a Zustand store by loading persisted state from chrome.storage.
 *
 * Called during `initializeStores()` in `src/store/index.ts` at service worker
 * startup and on content script initialization. Reads the stored JSON for the
 * given key, deserializes it, and merges it into the store via `setState`.
 *
 * @param storageKey  - The storage key to read persisted state from
 * @param store       - A Zustand store API object with `setState` and `getState`
 * @param storageArea - Target chrome.storage area (defaults to 'local')
 *
 * @example
 * ```typescript
 * const store = createStore(...);
 * await hydrateStore('signal-store', store, 'local');
 * ```
 */
export async function hydrateStore<T>(
  storageKey: string,
  store: { setState: (state: Partial<T>) => void; getState: () => T },
  storageArea: ChromeStorageArea = 'local',
): Promise<void> {
  try {
    const persisted = await readFromStorage<T>(storageKey, storageArea);
    if (persisted && Object.keys(persisted).length > 0) {
      store.setState(persisted);
      logger.info(`Store '${storageKey}' hydrated from chrome.storage.${storageArea}`);
    } else {
      logger.debug(`No persisted state found for store '${storageKey}' in chrome.storage.${storageArea}`);
    }
  } catch (err) {
    logger.error(`Failed to hydrate store '${storageKey}'`, err);
    // Hydration failure is non-fatal — the store continues with its default state
  }
}

// ---------------------------------------------------------------------------
// Manual Persistence — On-Demand Write
// ---------------------------------------------------------------------------

/**
 * Immediately persists a Zustand store's current state to chrome.storage,
 * bypassing the debounce mechanism.
 *
 * Use this for critical state changes that must survive an immediate service
 * worker termination (e.g., entering a new position, receiving a high-priority
 * exit signal). For routine updates, let the middleware's debounced writes
 * handle persistence.
 *
 * @param storageKey    - The storage key to write to
 * @param store         - A Zustand store API object with `getState`
 * @param storageArea   - Target chrome.storage area (defaults to 'local')
 * @param excludeFields - Optional fields to exclude from persistence
 *
 * @example
 * ```typescript
 * // Immediately persist after a critical operation
 * positionStore.getState().openPosition(tokenMint, entryPrice);
 * await persistStore('position-store', positionStore, 'local');
 * ```
 */
export async function persistStore<T>(
  storageKey: string,
  store: { getState: () => T },
  storageArea: ChromeStorageArea = 'local',
  excludeFields?: string[],
): Promise<void> {
  try {
    await writeToStorage(storageKey, store.getState(), storageArea, excludeFields);
    logger.debug(`Store '${storageKey}' manually persisted to chrome.storage.${storageArea}`);
  } catch (err) {
    logger.error(`Failed to manually persist store '${storageKey}'`, err);
    // Non-fatal — caller should not crash on persistence failure
  }
}

// ---------------------------------------------------------------------------
// Clear Stored State
// ---------------------------------------------------------------------------

/**
 * Removes a store's persisted state from chrome.storage.
 *
 * Use during store reset, user data clearance, or when migrating to a new
 * storage schema. After clearing, the store will initialize with its default
 * state on next hydration.
 *
 * @param storageKey  - The storage key to remove
 * @param storageArea - Target chrome.storage area (defaults to 'local')
 *
 * @example
 * ```typescript
 * await clearStoredState('signal-store', 'local');
 * ```
 */
export async function clearStoredState(
  storageKey: string,
  storageArea: ChromeStorageArea = 'local',
): Promise<void> {
  try {
    const storage = getStorageArea(storageArea);
    if (!storage) {
      logger.warn(`chrome.storage.${storageArea} is not available — skipping clear`);
      return;
    }

    await storage.remove(storageKey);
    logger.info(`Stored state cleared for '${storageKey}' from chrome.storage.${storageArea}`);
  } catch (err) {
    logger.error(`Failed to clear stored state for '${storageKey}'`, err);
    // Non-fatal — caller should handle gracefully
  }
}
