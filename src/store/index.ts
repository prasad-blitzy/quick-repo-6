/**
 * src/store/index.ts — Store Barrel Exports and Initialization
 *
 * Central barrel export module for all Zustand state stores used across
 * the Chrome Extension. Provides unified access to both:
 *
 * - **Vanilla stores** for the service worker context (no React/Preact dependency)
 * - **Hook-based stores** for the Preact UI layer (via `preact/compat`)
 *
 * Per AAP Section 0.5.1 Group 10:
 * "Barrel exports; creates vanilla stores for service worker context
 *  (`createStore`) and hook-based stores for Preact UI context (using
 *  `preact/compat` for `useSyncExternalStore`)"
 *
 * Store Architecture:
 * - Service Worker: Uses `zustand/vanilla` stores created by `create*Store()`
 *   functions. These are plain JS objects with `.getState()` and `.setState()`.
 * - Content Script / Preact UI: Uses hook-based stores created by
 *   `create*StoreHook()` functions. These return React-style hooks that
 *   trigger re-renders on state changes.
 *
 * Persistence:
 * - All stores persist to `chrome.storage.local` (or `chrome.storage.sync`
 *   for settings) via the `chrome-storage-adapter.ts` middleware.
 * - Cross-context sync is handled by `chrome.storage.onChanged` listeners.
 *
 * Consumers:
 * - `entrypoints/background.ts` — imports vanilla stores for service worker
 * - `entrypoints/content.ts` — imports hook stores for Preact UI
 * - `src/components/*.tsx` — imports hook stores for reactive UI updates
 * - `src/signals/scoring-engine.ts` — imports vanilla stores for state reads/writes
 *
 * @module store
 */

// ---------------------------------------------------------------------------
// Signal Store
// ---------------------------------------------------------------------------

export {
  createSignalStore,
  createSignalStoreHook,
  serializeSignalState,
} from './signal-store';

export type {
  SignalStoreState,
  SignalStoreActions,
  SignalStore,
} from './signal-store';

// ---------------------------------------------------------------------------
// Token Store
// ---------------------------------------------------------------------------

export {
  createTokenStore,
  createDefaultTokenData,
} from './token-store';

export type {
  TokenData,
  TokenStoreState,
  TokenStoreActions,
  TokenStore,
} from './token-store';

// ---------------------------------------------------------------------------
// Settings Store
// ---------------------------------------------------------------------------

export {
  createSettingsStore,
} from './settings-store';

export type {
  TradingMode,
  ScoringWeights,
  TpSlProfile,
  NotificationPrefs,
  EncryptedApiKeys,
  SettingsStoreState,
  SettingsStoreActions,
  SettingsStore,
} from './settings-store';

// ---------------------------------------------------------------------------
// Position Store
// ---------------------------------------------------------------------------

export {
  createPositionStore,
} from './position-store';

export type {
  ExitReason,
  TpLevel,
  PartialExit,
  ExitAlert,
  Position,
  PositionStoreState,
  PositionStoreActions,
  PositionStore,
} from './position-store';

// ---------------------------------------------------------------------------
// Chrome Storage Adapter
// ---------------------------------------------------------------------------

export {
  createChromeStorageMiddleware,
} from './chrome-storage-adapter';

export type {
  ChromeStorageArea,
  ChromeStorageConfig,
} from './chrome-storage-adapter';

// ---------------------------------------------------------------------------
// Store Initialization Helper
// ---------------------------------------------------------------------------

/**
 * Store initialization result containing all vanilla store instances.
 *
 * Used by the service worker to hold references to all stores after
 * initialization. Typed as an interface so consumers can destructure
 * only the stores they need.
 */
export interface StoreInstances {
  /** Active signal scores and history */
  signalStore: ReturnType<typeof import('./signal-store').createSignalStore>;
  /** Token data cache (price, safety, metadata) */
  tokenStore: ReturnType<typeof import('./token-store').createTokenStore>;
  /** User preferences and configuration */
  settingsStore: ReturnType<typeof import('./settings-store').createSettingsStore>;
  /** Tracked trading positions */
  positionStore: ReturnType<typeof import('./position-store').createPositionStore>;
}

/**
 * Initializes all vanilla Zustand stores for the service worker context.
 *
 * This is the primary initialization entry point called once during
 * service worker startup in `entrypoints/background.ts`. Creates all
 * four stores with Chrome storage persistence middleware.
 *
 * Each store:
 * 1. Creates the Zustand vanilla store with initial state
 * 2. Connects the chrome-storage-adapter middleware
 * 3. Loads persisted state from chrome.storage on first access
 *
 * @returns Object containing all initialized store instances.
 *
 * @example
 * ```typescript
 * // In entrypoints/background.ts (top-level, synchronous registration)
 * import { initializeStores } from '@/store';
 *
 * const stores = initializeStores();
 *
 * // Access store state
 * const signals = stores.signalStore.getState().signals;
 *
 * // Update store state
 * stores.signalStore.getState().addSignal(newSignal);
 * ```
 */
export function initializeStores(): StoreInstances {
  const { createSignalStore: createSignal } = require('./signal-store');
  const { createTokenStore: createToken } = require('./token-store');
  const { createSettingsStore: createSettings } = require('./settings-store');
  const { createPositionStore: createPosition } = require('./position-store');

  return {
    signalStore: createSignal(),
    tokenStore: createToken(),
    settingsStore: createSettings(),
    positionStore: createPosition(),
  };
}
