/**
 * src/store/signal-store.ts — Zustand Store for Active Signals
 *
 * Central signal data repository for the GMGN Signal Bot Chrome Extension.
 * Manages the complete lifecycle of trading signals: addition, retrieval,
 * ranking by composite score, staleness pruning, and history tracking.
 *
 * Per AAP Section 0.5.1 Group 10:
 * "Zustand store for active signals; state includes
 * `signals: Map<string, CompositeSignal>`, `signalHistory: CompositeSignal[]`;
 * actions: `addSignal`, `removeSignal`, `getTopSignals(n)`;
 * persisted to `chrome.storage.local` via adapter"
 *
 * Per AAP Section 0.4.4 (Store ↔ Component Bindings):
 * - Writers (Producers): `scoring-engine.ts`, `exit-signals.ts`
 * - Readers (Consumers): `SignalPanel.tsx`, `TokenCard.tsx`, `ScoreGauge.tsx`
 * - Persistence: `chrome.storage.local`
 *
 * Implementation notes:
 * - Uses `Record<string, CompositeSignal>` instead of `Map` because
 *   `chrome.storage` requires JSON-serializable objects and `Map` does not
 *   round-trip through `JSON.stringify`/`JSON.parse` natively.
 * - Signal history is capped at `maxHistorySize` (default 500) to prevent
 *   unbounded growth in `chrome.storage.local` (5 MB default limit).
 * - All state mutations produce new objects via the spread operator to
 *   satisfy Zustand's immutability contract and trigger re-renders.
 * - The `getTopSignals(n)` getter sorts by `composite` descending on every
 *   call; with typical signal counts (<200) this is O(n log n) and adequate.
 * - Persisted to `chrome.storage.local` via `createChromeStorageMiddleware`,
 *   enabling cross-context sync between the service worker and content script
 *   via `chrome.storage.onChanged`.
 * - Uses `zustand/vanilla` `createStore` for the service worker context where
 *   no UI framework hooks are available.
 * - The `createSignalStoreHook` factory returns the same vanilla store
 *   instance, which can be consumed with Zustand's `useStore(store, selector)`
 *   hook in the Preact UI layer via `preact/compat` aliasing.
 *
 * @module store/signal-store
 */

import { createStore } from 'zustand/vanilla';
import { createChromeStorageMiddleware } from './chrome-storage-adapter';
import type { CompositeSignal } from '../signals/types';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger for the signal store module.
 * Uses the `'signal-store'` context tag for easy filtering in DevTools.
 */
const logger = createLogger('signal-store');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default maximum number of entries retained in the signal history array.
 * Capping history prevents unbounded growth that could exhaust the 5 MB
 * `chrome.storage.local` quota.
 */
const DEFAULT_MAX_HISTORY_SIZE = 500;

/**
 * Storage key used for persisting this store in `chrome.storage.local`.
 * Must be unique across all Zustand stores in the extension.
 */
const STORAGE_KEY = 'signal-store';

// ---------------------------------------------------------------------------
// Exported Types — State
// ---------------------------------------------------------------------------

/**
 * Shape of the signal store's data fields (no action methods).
 *
 * Consumers:
 * - `SignalPanel.tsx` reads `signals` for the active signal list
 * - `TokenCard.tsx` reads individual signals via `getSignal()`
 * - `ScoreGauge.tsx` reads `composite` from individual signals
 * - `scoring-engine.ts` writes via `addSignal()`
 * - `exit-signals.ts` writes via `addSignal()` (EXIT decisions)
 */
export interface SignalStoreState {
  /**
   * Active signals keyed by token mint address.
   *
   * Each entry holds the most recent `CompositeSignal` for a token.
   * When a new signal for an existing token arrives, it replaces the
   * previous entry (last-write-wins).
   *
   * Uses `Record<string, CompositeSignal>` instead of `Map` for JSON
   * serialization compatibility with `chrome.storage`.
   */
  signals: Record<string, CompositeSignal>;

  /**
   * Chronological log of all signals (most recent first).
   *
   * Unlike `signals`, history is append-only and retains superseded
   * entries for the same token. This enables retrospective analysis of
   * signal quality over time.
   *
   * Capped at `maxHistorySize` entries — oldest entries are evicted
   * when the cap is reached.
   */
  signalHistory: CompositeSignal[];

  /**
   * Maximum number of entries to retain in `signalHistory`.
   * Configurable at store creation time; default is 500.
   */
  maxHistorySize: number;
}

// ---------------------------------------------------------------------------
// Exported Types — Actions
// ---------------------------------------------------------------------------

/**
 * Action methods available on the signal store.
 *
 * All mutating actions (`addSignal`, `removeSignal`, `clearAll`, `clearStale`)
 * produce new state objects and trigger persistence to `chrome.storage.local`
 * via the middleware. Read-only actions (`getTopSignals`, `getSignal`) access
 * state via `get()` without triggering writes.
 */
export interface SignalStoreActions {
  /**
   * Adds or updates a signal for a token.
   *
   * - Inserts the signal into `signals` keyed by `signal.tokenMint`
   *   (overwrites any existing entry for that mint).
   * - Prepends the signal to `signalHistory` (most-recent-first).
   * - Caps `signalHistory` at `maxHistorySize` by dropping the oldest tail.
   *
   * @param signal - The composite signal produced by the scoring engine
   */
  addSignal: (signal: CompositeSignal) => void;

  /**
   * Removes a signal from the active `signals` map by token mint address.
   *
   * Does NOT remove entries from `signalHistory` — history is a permanent
   * append-only log (subject to the `maxHistorySize` cap).
   *
   * No-op if the token mint is not present in `signals`.
   *
   * @param tokenMint - Solana base58 token mint address to remove
   */
  removeSignal: (tokenMint: string) => void;

  /**
   * Returns the top N active signals sorted by composite score descending.
   *
   * Read-only — does not mutate state or trigger persistence.
   *
   * @param n - Maximum number of signals to return. If fewer active signals
   *            exist, returns all of them.
   * @returns Array of up to `n` CompositeSignal objects, highest scores first
   */
  getTopSignals: (n: number) => CompositeSignal[];

  /**
   * Retrieves a specific signal by its token mint address.
   *
   * Read-only — does not mutate state or trigger persistence.
   *
   * @param tokenMint - Solana base58 token mint address
   * @returns The matching CompositeSignal, or `undefined` if not found
   */
  getSignal: (tokenMint: string) => CompositeSignal | undefined;

  /**
   * Clears all active signals and signal history.
   *
   * Resets `signals` to an empty record and `signalHistory` to an empty
   * array. Triggers persistence to write the empty state.
   */
  clearAll: () => void;

  /**
   * Removes signals from the active `signals` map that are older than
   * the specified maximum age.
   *
   * Compares each signal's `timestamp` against `Date.now() - maxAgeMs`.
   * Signals whose timestamp falls before the cutoff are evicted.
   *
   * Does NOT prune `signalHistory` — only active signals are affected.
   *
   * @param maxAgeMs - Maximum age in milliseconds. Signals older than this
   *                   are removed from the active map.
   */
  clearStale: (maxAgeMs: number) => void;
}

// ---------------------------------------------------------------------------
// Combined Store Type
// ---------------------------------------------------------------------------

/**
 * Full signal store type combining state fields and action methods.
 *
 * Used as the generic type parameter for `createStore<SignalStore>()`.
 */
export type SignalStore = SignalStoreState & SignalStoreActions;

// ---------------------------------------------------------------------------
// Store Factory — Vanilla (Service Worker Context)
// ---------------------------------------------------------------------------

/**
 * Creates a vanilla Zustand store instance for signal management.
 *
 * Intended for the Chrome Extension **service worker** context where no
 * UI framework hooks are available. The store is persisted to
 * `chrome.storage.local` via the `createChromeStorageMiddleware` adapter,
 * which:
 * - Debounces writes at 300 ms to batch rapid state updates
 * - Registers a `chrome.storage.onChanged` listener for cross-context sync
 * - Serializes only data fields (functions are skipped automatically)
 *
 * The returned store API exposes `.getState()`, `.setState()`, and
 * `.subscribe()` methods per the Zustand vanilla store contract.
 *
 * @returns A Zustand `StoreApi<SignalStore>` instance ready for use
 *
 * @example
 * ```typescript
 * // In the service worker (background.ts)
 * import { createSignalStore } from '@/store/signal-store';
 * const signalStore = createSignalStore();
 *
 * // Add a signal
 * signalStore.getState().addSignal(compositeSignal);
 *
 * // Read the top 5 signals
 * const top5 = signalStore.getState().getTopSignals(5);
 * ```
 */
export function createSignalStore() {
  return createStore<SignalStore>()(
    createChromeStorageMiddleware<SignalStore>(
      STORAGE_KEY,
      'local',
      (set, get) => ({
        // -----------------------------------------------------------------
        // Initial State
        // -----------------------------------------------------------------

        /** Active signals map — initially empty */
        signals: {},

        /** Signal history log — initially empty, most-recent-first */
        signalHistory: [],

        /** Default history cap — prevents unbounded chrome.storage growth */
        maxHistorySize: DEFAULT_MAX_HISTORY_SIZE,

        // -----------------------------------------------------------------
        // Actions
        // -----------------------------------------------------------------

        addSignal: (signal: CompositeSignal): void => {
          const tokenMint = signal.tokenMint;

          set((state) => {
            // Upsert into the active signals map (last-write-wins)
            const newSignals: Record<string, CompositeSignal> = {
              ...state.signals,
              [tokenMint]: signal,
            };

            // Prepend to history and enforce the max size cap
            const newHistory = [signal, ...state.signalHistory].slice(
              0,
              state.maxHistorySize,
            );

            return {
              signals: newSignals,
              signalHistory: newHistory,
            };
          });

          logger.debug(
            `Signal added for ${tokenMint}: score=${signal.composite}, decision=${signal.decision}`,
          );
        },

        removeSignal: (tokenMint: string): void => {
          const currentState = get();

          // No-op if the token mint is not in the active map
          if (!(tokenMint in currentState.signals)) {
            logger.debug(
              `removeSignal called for unknown mint ${tokenMint} — no-op`,
            );
            return;
          }

          set((state) => {
            // Immutable removal via destructuring rest spread
            const updatedSignals: Record<string, CompositeSignal> = {};
            for (const [mint, sig] of Object.entries(state.signals)) {
              if (mint !== tokenMint) {
                updatedSignals[mint] = sig;
              }
            }
            return { signals: updatedSignals };
          });

          logger.debug(`Signal removed for ${tokenMint}`);
        },

        getTopSignals: (n: number): CompositeSignal[] => {
          // Guard: clamp n to non-negative integer
          const count = Math.max(0, Math.floor(n));
          if (count === 0) {
            return [];
          }

          const state = get();
          const allSignals = Object.values(state.signals);

          // Sort by composite score descending (highest first)
          return allSignals
            .sort((a, b) => b.composite - a.composite)
            .slice(0, count);
        },

        getSignal: (tokenMint: string): CompositeSignal | undefined => {
          return get().signals[tokenMint];
        },

        clearAll: (): void => {
          set({
            signals: {},
            signalHistory: [],
          });
          logger.info('All signals cleared');
        },

        clearStale: (maxAgeMs: number): void => {
          // Guard: ensure maxAgeMs is a positive number
          if (maxAgeMs <= 0 || !Number.isFinite(maxAgeMs)) {
            logger.debug(
              `clearStale called with invalid maxAgeMs=${maxAgeMs} — no-op`,
            );
            return;
          }

          const now = Date.now();
          const cutoff = now - maxAgeMs;
          let removedCount = 0;

          set((state) => {
            const freshSignals: Record<string, CompositeSignal> = {};

            for (const [mint, signal] of Object.entries(state.signals)) {
              if (signal.timestamp >= cutoff) {
                freshSignals[mint] = signal;
              } else {
                removedCount++;
              }
            }

            return { signals: freshSignals };
          });

          logger.debug(
            `Stale signals cleared: removed=${removedCount}, maxAge=${maxAgeMs}ms`,
          );
        },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Store Factory — Preact Hook Compatible
// ---------------------------------------------------------------------------

/**
 * Creates a signal store instance intended for the Preact UI layer.
 *
 * Returns the same vanilla Zustand `StoreApi<SignalStore>` as
 * `createSignalStore()`. In the UI layer, this store is consumed via
 * Zustand's `useStore(store, selector)` hook, which works through the
 * `preact/compat` aliasing configured in `wxt.config.ts` and
 * `vitest.config.ts`.
 *
 * Typical usage in a Preact component:
 * ```tsx
 * import { useStore } from 'zustand';
 * import { signalStore } from '@/store/index';
 *
 * function SignalPanel() {
 *   const topSignals = useStore(signalStore, (s) => s.getTopSignals(10));
 *   return <div>{topSignals.map(s => <TokenCard key={s.tokenMint} signal={s} />)}</div>;
 * }
 * ```
 *
 * @returns A Zustand `StoreApi<SignalStore>` instance for UI consumption
 */
export function createSignalStoreHook() {
  return createSignalStore();
}

// ---------------------------------------------------------------------------
// Serialization Helper
// ---------------------------------------------------------------------------

/**
 * Extracts only the data fields from a full `SignalStore` state object,
 * stripping out all action methods.
 *
 * The `createChromeStorageMiddleware` adapter already handles this
 * automatically by skipping `typeof value === 'function'` entries during
 * serialization. This helper provides an explicit, type-safe alternative
 * for scenarios where callers need the serializable state subset directly
 * (e.g., manual persistence via `persistStore()`, state snapshot logging,
 * or migration tooling).
 *
 * @param state - The full Zustand store state (data fields + action methods)
 * @returns A `Partial<SignalStoreState>` containing only serializable data
 *
 * @example
 * ```typescript
 * const store = createSignalStore();
 * const snapshot = serializeSignalState(store.getState());
 * // snapshot = { signals: {...}, signalHistory: [...], maxHistorySize: 500 }
 * // No action methods included
 * ```
 */
export function serializeSignalState(
  state: SignalStore,
): Partial<SignalStoreState> {
  return {
    signals: state.signals,
    signalHistory: state.signalHistory,
    maxHistorySize: state.maxHistorySize,
  };
}
