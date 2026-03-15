/**
 * src/store/index.ts — Barrel Exports and Store Initialization
 *
 * Central export hub for all Zustand state stores used across the GMGN Signal
 * Bot Chrome Extension. Provides unified access to both contexts:
 *
 * - **Vanilla stores** (`vanillaSignalStore`, `vanillaTokenStore`, etc.) for
 *   the service worker context where no React/Preact hooks are available.
 *   These expose `.getState()`, `.setState()`, `.subscribe()`, and
 *   `.getInitialState()` per the Zustand vanilla `StoreApi` contract.
 *
 * - **Hook wrappers** (`useSignalStoreHook`, `useTokenStoreHook`, etc.) for
 *   the Preact UI layer in the content script. These wrap the vanilla store
 *   instances with `useStore()` from Zustand, which works through the
 *   `preact/compat` aliasing configured in `wxt.config.ts` to provide
 *   `useSyncExternalStore` compatibility.
 *
 * Per AAP Section 0.5.1 Group 10:
 * "Barrel exports; creates vanilla stores for service worker context
 *  (`createStore`) and hook-based stores for Preact UI context (using
 *  `preact/compat` for `useSyncExternalStore`)"
 *
 * Per AAP Section 0.4.4 (State Management Integration):
 * - Service worker: uses `zustand/vanilla` (no Preact dependency)
 * - Content script UI: uses Zustand hooks via `preact/compat` aliasing
 * - State sync: `chrome.storage.onChanged` propagates changes across contexts
 *
 * Per AAP Section 0.1.2:
 * "Use Zustand with a chrome.storage sync adapter; leverage `zustand/vanilla`
 *  for the service worker (non-React context) and Zustand hooks via
 *  `preact/compat` in the UI layer"
 *
 * Store persistence:
 * - signal-store  → chrome.storage.local
 * - token-store   → chrome.storage.local
 * - position-store → chrome.storage.local
 * - settings-store → chrome.storage.sync (cross-device)
 *
 * Consumers:
 * - `entrypoints/background.ts` — imports vanilla stores for service worker
 * - `entrypoints/content.ts` — imports hook wrappers for Preact UI
 * - `src/components/*.tsx` — imports hook wrappers for reactive UI updates
 * - `src/signals/scoring-engine.ts` — imports vanilla stores for state reads/writes
 *
 * @module store
 */

// ---------------------------------------------------------------------------
// Re-Export All Individual Store Modules
// ---------------------------------------------------------------------------
// Per AAP: Re-export everything so consumers can import types, factory
// functions, and adapter utilities from a single `@/store` entry point.

export * from './signal-store';
export * from './token-store';
export * from './settings-store';
export * from './position-store';
export * from './chrome-storage-adapter';

// ---------------------------------------------------------------------------
// Internal Imports — Store Factory Functions
// ---------------------------------------------------------------------------

import { createSignalStore } from './signal-store';
import { createTokenStore } from './token-store';
import { createSettingsStore } from './settings-store';
import { createPositionStore } from './position-store';
import { hydrateStore, deserializeState } from './chrome-storage-adapter';

// ---------------------------------------------------------------------------
// External Imports — Zustand Hook API
// ---------------------------------------------------------------------------

import { useStore } from 'zustand';

// ---------------------------------------------------------------------------
// Type Imports — Store State+Actions Combined Types
// ---------------------------------------------------------------------------

import type { SignalStore } from './signal-store';
import type { TokenStore } from './token-store';
import type { SettingsStore } from './settings-store';
import type { PositionStore } from './position-store';

// ---------------------------------------------------------------------------
// Vanilla Store Instances — Service Worker Context
// ---------------------------------------------------------------------------
// Created at module load time using each store's factory function.
// These are zustand/vanilla `StoreApi` instances — they expose
// `.getState()`, `.setState()`, `.subscribe()`, and `.getInitialState()`
// without any React/Preact hook dependency.
//
// Used in `entrypoints/background.ts` (service worker) and any non-UI
// module that needs direct state access (scoring-engine, exit-signals, etc.)

/**
 * Vanilla Zustand store for active signal data.
 *
 * Stores composite scores, factor breakdowns, signal history, and
 * provides `addSignal`, `removeSignal`, `getTopSignals`, `clearStale`
 * actions. Persisted to `chrome.storage.local`.
 *
 * @see {@link SignalStore} for the full state + actions type
 */
export const vanillaSignalStore = createSignalStore();

/**
 * Vanilla Zustand store for token data cache.
 *
 * Aggregates price, safety, metadata, smart money activity, and AI
 * analysis results per token from all data sources (GMGN, Birdeye,
 * PumpPortal, DexScreener). Persisted to `chrome.storage.local`.
 *
 * @see {@link TokenStore} for the full state + actions type
 */
export const vanillaTokenStore = createTokenStore();

/**
 * Vanilla Zustand store for user preferences and configuration.
 *
 * Holds trading mode (conservative/aggressive), scoring weights,
 * TP/SL profiles, encrypted API keys, notification preferences,
 * and LLM tier thresholds. Persisted to `chrome.storage.sync` for
 * cross-device synchronization.
 *
 * @see {@link SettingsStore} for the full state + actions type
 */
export const vanillaSettingsStore = createSettingsStore();

/**
 * Vanilla Zustand store for tracked trading positions.
 *
 * Tracks entry price, current price, TP/SL ladder levels, partial
 * exit history, trailing stop state, and active exit alerts per
 * position. Persisted to `chrome.storage.local`.
 *
 * @see {@link PositionStore} for the full state + actions type
 */
export const vanillaPositionStore = createPositionStore();

// ---------------------------------------------------------------------------
// Hook Wrappers — Preact UI Context
// ---------------------------------------------------------------------------
// These functions wrap the vanilla store instances with Zustand's `useStore`
// hook, creating Preact-compatible reactive selectors. Through the
// `preact/compat` aliasing in `wxt.config.ts`, `useStore` internally uses
// `useSyncExternalStore` from Preact's compat layer.
//
// Usage in Preact components:
// ```tsx
// import { useSignalStoreHook } from '@/store';
//
// function SignalPanel() {
//   const topSignals = useSignalStoreHook((s) => s.getTopSignals(10));
//   return <div>{topSignals.map(s => <TokenCard key={s.tokenMint} signal={s} />)}</div>;
// }
// ```

/**
 * Preact-compatible hook wrapper for the signal store.
 *
 * Accepts a selector function that extracts a slice of the signal store
 * state. Returns the selected value reactively — the Preact component
 * re-renders whenever the selected value changes.
 *
 * @typeParam T - The type of the selected state slice
 * @param selector - Function that extracts a value from the full `SignalStore` state
 * @returns The selected state slice, reactively bound to Preact re-renders
 *
 * @example
 * ```tsx
 * const signals = useSignalStoreHook((s) => s.signals);
 * const topFive = useSignalStoreHook((s) => s.getTopSignals(5));
 * ```
 */
export function useSignalStoreHook<T>(selector: (state: SignalStore) => T): T {
  return useStore(vanillaSignalStore, selector);
}

/**
 * Preact-compatible hook wrapper for the token store.
 *
 * @typeParam T - The type of the selected state slice
 * @param selector - Function that extracts a value from the full `TokenStore` state
 * @returns The selected state slice, reactively bound to Preact re-renders
 *
 * @example
 * ```tsx
 * const token = useTokenStoreHook((s) => s.getToken(mintAddress));
 * const allTokens = useTokenStoreHook((s) => s.getAllTokens());
 * ```
 */
export function useTokenStoreHook<T>(selector: (state: TokenStore) => T): T {
  return useStore(vanillaTokenStore, selector);
}

/**
 * Preact-compatible hook wrapper for the settings store.
 *
 * @typeParam T - The type of the selected state slice
 * @param selector - Function that extracts a value from the full `SettingsStore` state
 * @returns The selected state slice, reactively bound to Preact re-renders
 *
 * @example
 * ```tsx
 * const tradingMode = useSettingsStoreHook((s) => s.tradingMode);
 * const weights = useSettingsStoreHook((s) => s.scoringWeights);
 * const panelVisible = useSettingsStoreHook((s) => s.panelVisible);
 * ```
 */
export function useSettingsStoreHook<T>(selector: (state: SettingsStore) => T): T {
  return useStore(vanillaSettingsStore, selector);
}

/**
 * Preact-compatible hook wrapper for the position store.
 *
 * @typeParam T - The type of the selected state slice
 * @param selector - Function that extracts a value from the full `PositionStore` state
 * @returns The selected state slice, reactively bound to Preact re-renders
 *
 * @example
 * ```tsx
 * const openPositions = usePositionStoreHook((s) => s.getOpenPositions());
 * const position = usePositionStoreHook((s) => s.getPosition(mintAddress));
 * ```
 */
export function usePositionStoreHook<T>(selector: (state: PositionStore) => T): T {
  return useStore(vanillaPositionStore, selector);
}

// ---------------------------------------------------------------------------
// Store Initialization — chrome.storage Hydration
// ---------------------------------------------------------------------------

/**
 * Hydrates all vanilla Zustand stores from persisted chrome.storage state.
 *
 * Called once during service worker startup in `entrypoints/background.ts`.
 * Each store's persisted JSON state is read from its respective chrome.storage
 * area, deserialized, and merged into the in-memory Zustand store via
 * `setState()`. If no persisted state exists for a store, it retains its
 * default initial state.
 *
 * Storage area mapping:
 * - `signal-store`   → `chrome.storage.local`
 * - `token-store`    → `chrome.storage.local`
 * - `position-store` → `chrome.storage.local`
 * - `settings-store` → `chrome.storage.sync` (cross-device)
 *
 * Hydration is fault-tolerant: if one store fails to hydrate (e.g., corrupted
 * data, storage quota exceeded), the others continue independently. Errors
 * are caught and reported but never propagated — the extension starts with
 * default state for any store that fails hydration.
 *
 * @example
 * ```typescript
 * // In entrypoints/background.ts (service worker bootstrap)
 * import { initializeStores } from '@/store';
 * await initializeStores();
 * ```
 */
export async function initializeStores(): Promise<void> {
  const hydrationTasks: Array<{ key: string; promise: Promise<void> }> = [
    {
      key: 'signal-store',
      promise: hydrateStore('signal-store', vanillaSignalStore, 'local'),
    },
    {
      key: 'token-store',
      promise: hydrateStore('token-store', vanillaTokenStore, 'local'),
    },
    {
      key: 'settings-store',
      promise: hydrateStore('settings-store', vanillaSettingsStore, 'sync'),
    },
    {
      key: 'position-store',
      promise: hydrateStore('position-store', vanillaPositionStore, 'local'),
    },
  ];

  const results = await Promise.allSettled(
    hydrationTasks.map((task) => task.promise),
  );

  // Report any hydration failures without crashing
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const taskKey = hydrationTasks[i].key;
    if (result.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error(
        `[store] Failed to hydrate store '${taskKey}':`,
        result.reason,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-Context State Synchronization Listener
// ---------------------------------------------------------------------------

/**
 * Registers a `chrome.storage.onChanged` listener that synchronizes vanilla
 * Zustand store state when chrome.storage is updated by another Extension
 * context (e.g., content script ↔ service worker).
 *
 * When the service worker writes a store's state to `chrome.storage.local`,
 * the content script's `onChanged` handler deserializes the incoming data
 * and merges it into the corresponding vanilla Zustand store, triggering
 * Preact component re-renders via the hook wrappers. The reverse direction
 * also works: content script settings changes flow back to the service worker.
 *
 * CRITICAL per AAP Section 0.7.1: This listener MUST be registered
 * synchronously at the top level of the service worker. All
 * `chrome.runtime.onMessage.addListener`, `chrome.alarms.onAlarm.addListener`,
 * and `chrome.storage.onChanged.addListener` calls must be at the top level —
 * never inside async callbacks, conditionals, or `setTimeout`.
 *
 * Safe to call multiple times (idempotent) — the Chrome API handles
 * duplicate listener registration internally.
 *
 * @example
 * ```typescript
 * // In entrypoints/background.ts — MUST be top-level, synchronous
 * import { setupStorageSyncListener } from '@/store';
 * setupStorageSyncListener();
 * ```
 */
export function setupStorageSyncListener(): void {
  // Guard: chrome.storage API may not be available in test environments
  if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged) {
    return;
  }

  chrome.storage.onChanged.addListener(
    (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      try {
        // ------------------------------------
        // Local storage area — most stores
        // ------------------------------------
        if (areaName === 'local') {
          if (changes['signal-store']?.newValue !== undefined) {
            const incoming = deserializeState<SignalStore>(
              changes['signal-store'].newValue as string,
            );
            if (Object.keys(incoming).length > 0) {
              vanillaSignalStore.setState(incoming);
            }
          }

          if (changes['token-store']?.newValue !== undefined) {
            const incoming = deserializeState<TokenStore>(
              changes['token-store'].newValue as string,
            );
            if (Object.keys(incoming).length > 0) {
              vanillaTokenStore.setState(incoming);
            }
          }

          if (changes['position-store']?.newValue !== undefined) {
            const incoming = deserializeState<PositionStore>(
              changes['position-store'].newValue as string,
            );
            if (Object.keys(incoming).length > 0) {
              vanillaPositionStore.setState(incoming);
            }
          }
        }

        // ------------------------------------
        // Sync storage area — settings only
        // ------------------------------------
        if (areaName === 'sync') {
          if (changes['settings-store']?.newValue !== undefined) {
            const incoming = deserializeState<SettingsStore>(
              changes['settings-store'].newValue as string,
            );
            if (Object.keys(incoming).length > 0) {
              vanillaSettingsStore.setState(incoming);
            }
          }
        }
      } catch (err) {
        // Sync errors are non-fatal — log but never crash the listener
        // eslint-disable-next-line no-console
        console.error('[store] Error in storage sync listener:', err);
      }
    },
  );
}
