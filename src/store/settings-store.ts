/**
 * src/store/settings-store.ts — Zustand Store for User Preferences
 *
 * Manages all user-configurable settings for the GMGN Signal Bot Chrome
 * Extension, including trading mode selection, 7-factor scoring weight
 * customization, take-profit / stop-loss profile management, encrypted
 * API key storage, notification preferences, and UI panel visibility.
 *
 * Per AAP Section 0.5.1 Group 10:
 * "Zustand store for user preferences; state includes tradingMode,
 *  scoringWeights, tpSlProfiles, apiKeys (encrypted), notificationPrefs;
 *  persisted to chrome.storage.sync for cross-device sync"
 *
 * Writers (Producers): SettingsPanel.tsx (user input)
 * Readers (Consumers): scoring-engine.ts (weight config), ai/router.ts (tier thresholds)
 * Persistence: chrome.storage.sync (cross-device synchronization)
 *
 * CRITICAL: This store uses chrome.storage.sync (NOT chrome.storage.local) for
 * cross-device synchronization of user preferences. EXCEPTION: API keys are
 * encrypted ciphertext — they travel over sync safely since they cannot be
 * decrypted without the per-installation AES-GCM key in chrome.storage.local.
 *
 * Per AAP Section 0.7.2:
 * - API keys NEVER exposed to content scripts
 * - getDecryptedApiKey() should ONLY be called from the service worker context
 * - All keys stored as encrypted ciphertext strings via src/utils/crypto.ts
 *
 * Per AAP Section 0.7.3:
 * - All 7 factor weights must be user-configurable via the settings panel
 * - The scoring engine reads weights from this store at analysis time
 *
 * Uses zustand/vanilla for service worker context (non-React/Preact).
 * All state is persisted via the chrome-storage-adapter middleware with
 * debounced writes and cross-context synchronization.
 *
 * @module store/settings-store
 */

import { createStore } from 'zustand/vanilla';
import { createChromeStorageMiddleware } from './chrome-storage-adapter';
import {
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_EXIT_STRATEGY,
  SCORING_THRESHOLDS,
  LLM_CONFIG,
} from '../utils/config';
import { encrypt, decrypt } from '../utils/crypto';
import { createLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger for settings store operations.
 * Tagged with 'settings-store' for source identification in logs.
 */
const logger = createLogger('settings-store');

// ---------------------------------------------------------------------------
// Trading Mode Type
// ---------------------------------------------------------------------------

/**
 * Discriminated trading mode type controlling signal generation aggressiveness.
 *
 * - `'conservative'` — Signals require ≥80 composite score for BUY signal
 *   generation. Suitable for lower-risk strategies focusing on high-confidence
 *   setups. Per AAP user examples: "≥80 composite score: High-confidence
 *   signal (conservative mode)."
 *
 * - `'aggressive'` — Signals require ≥45 composite score for BUY signal
 *   generation. Suitable for higher-risk/higher-reward strategies that accept
 *   moderate-confidence setups. Per AAP user examples: "≥45 composite score:
 *   Moderate signal (aggressive mode)."
 */
export type TradingMode = 'conservative' | 'aggressive';

// ---------------------------------------------------------------------------
// Scoring Weights Interface
// ---------------------------------------------------------------------------

/**
 * Configurable weights for the 7-factor composite scoring engine.
 *
 * All weights should ideally sum to 1.0 (100%). The scoring engine
 * (src/signals/scoring-engine.ts) reads these weights at analysis time
 * to compute the weighted composite score for each token.
 *
 * Default weights from DEFAULT_SCORING_WEIGHTS in src/utils/config.ts:
 *   - volumeSpike: 0.20, smartMoneyConvergence: 0.20
 *   - buySellRatio: 0.15, liquidity: 0.15
 *   - holderGrowth: 0.10, tokenAge: 0.10, safetyScore: 0.10
 *
 * Per AAP Section 0.7.3: "All 7 factor weights must be user-configurable
 * via the settings panel; the scoring engine reads weights from the Zustand
 * settings-store at analysis time, not from hardcoded constants"
 */
export interface ScoringWeights {
  /** Weight for volume spike detection factor (3–8× increase over 5m MA) */
  volumeSpike: number;
  /** Weight for smart money convergence factor (3+ wallets in 2h window) */
  smartMoneyConvergence: number;
  /** Weight for buy/sell ratio analysis factor (minimum ≥1.3× accumulation) */
  buySellRatio: number;
  /** Weight for holder growth tracking factor (organic retention ≥24h) */
  holderGrowth: number;
  /** Weight for liquidity thresholds factor ($3K–$30K minimum) */
  liquidity: number;
  /** Weight for token age filters factor (≤3h early, ≤12h gem scanning) */
  tokenAge: number;
  /** Weight for safety score validation factor (RugCheck ≥300, holder ≤20%) */
  safetyScore: number;
}

// ---------------------------------------------------------------------------
// Take-Profit / Stop-Loss Profile Interface
// ---------------------------------------------------------------------------

/**
 * A named take-profit / stop-loss configuration profile.
 *
 * Each profile defines a ladder of staged exit points (sell a percentage of
 * the position at each price multiplier target) and a stop-loss threshold.
 *
 * Default profiles per AAP Section 0.1.1:
 *   - Ladder: Sell 50% at 2×, 25% at 5×, 25% at 10× (trailing stop for remainder)
 *   - Day-trade: +15%/+30%/+60% TP, -12% SL (from DEFAULT_EXIT_STRATEGY.DAY_TRADE)
 *   - Swing trade: +40%/+100%/+200%/+500% TP, -18% SL (from DEFAULT_EXIT_STRATEGY.SWING_TRADE)
 */
export interface TpSlProfile {
  /** Human-readable profile name (e.g., 'ladder', 'day-trade', 'swing-trade') */
  name: string;
  /**
   * Staged take-profit exit ladder.
   * Each entry specifies what percentage of the remaining position to sell
   * when the price reaches the given multiplier of the entry price.
   */
  takeProfitLadder: Array<{ sellPercent: number; multiplier: number }>;
  /** Stop-loss threshold as a negative percentage (e.g., -12 for -12% SL) */
  stopLoss: number;
}

// ---------------------------------------------------------------------------
// Notification Preferences Interface
// ---------------------------------------------------------------------------

/**
 * User-configurable notification preferences for signal and exit alerts.
 *
 * Controls which types of events trigger notifications and the minimum
 * score threshold for alert generation.
 */
export interface NotificationPrefs {
  /** Master toggle — when false, all notifications are suppressed */
  enabled: boolean;
  /** Minimum composite score required to trigger a signal notification */
  minScoreForAlert: number;
  /** Whether notification sounds are enabled */
  soundEnabled: boolean;
  /** Notify when exit signal triggers fire (dev sell, TP/SL hit, volume decline) */
  exitAlerts: boolean;
  /** Notify when high-confidence new tokens are detected from PumpPortal */
  newTokenAlerts: boolean;
  /** Notify when smart money convergence events are detected */
  smartMoneyAlerts: boolean;
}

// ---------------------------------------------------------------------------
// Encrypted API Keys Interface
// ---------------------------------------------------------------------------

/**
 * Encrypted API key storage for all external service providers.
 *
 * These are AES-GCM encrypted ciphertext strings, NOT plaintext keys.
 * Encryption/decryption is performed via src/utils/crypto.ts using a
 * per-installation key stored in chrome.storage.local.
 *
 * Per AAP Section 0.7.2:
 * - API keys NEVER exposed to content scripts
 * - Decryption happens ONLY in the service worker context
 * - Empty string ('') indicates no key has been configured for that provider
 */
export interface EncryptedApiKeys {
  /** Encrypted Birdeye API key — token analytics (Starter $99/mo) */
  birdeye: string;
  /** Encrypted Helius API key — enhanced Solana RPC (Developer $49/mo) */
  helius: string;
  /** Encrypted RugCheck API key — token safety reports (free) */
  rugcheck: string;
  /** Encrypted Groq API key — LLM inference (free tier) */
  groq: string;
  /** Encrypted Anthropic API key — Claude narrative analysis (pay-per-use) */
  anthropic: string;
}

// ---------------------------------------------------------------------------
// Settings Store State Interface
// ---------------------------------------------------------------------------

/**
 * The complete state shape for the settings Zustand store.
 *
 * All properties are persisted to chrome.storage.sync for cross-device
 * synchronization. chrome.storage.sync limits: 100KB total, 8KB per item —
 * the settings state is well within these limits.
 */
export interface SettingsStoreState {
  /** Trading mode: conservative (≥80 score) or aggressive (≥45 score) */
  tradingMode: TradingMode;
  /** Configurable scoring weights for the 7 factors (should sum to 1.0) */
  scoringWeights: ScoringWeights;
  /** Name of the active take-profit / stop-loss profile */
  activeTpSlProfile: string;
  /** All available TP/SL profiles (built-in defaults + user-defined) */
  tpSlProfiles: TpSlProfile[];
  /** Encrypted API keys — NEVER exposed to content scripts */
  apiKeys: EncryptedApiKeys;
  /** Notification preferences for signal and exit alerts */
  notificationPrefs: NotificationPrefs;
  /** Whether the extension overlay sidebar panel is visible */
  panelVisible: boolean;
  /**
   * LLM fast tier threshold — composite scores below this use the fastest
   * LLM tier (llama-3.1-8b-instant). Default from LLM_CONFIG.FAST_THRESHOLD.
   */
  llmFastThreshold: number;
  /**
   * LLM detailed tier threshold — composite scores between FAST_THRESHOLD
   * and this value use the detailed tier (llama-3.3-70b-versatile).
   * Scores above this use the premium tier (Claude Sonnet).
   * Default from LLM_CONFIG.DETAILED_THRESHOLD.
   */
  llmDetailedThreshold: number;
}

// ---------------------------------------------------------------------------
// Settings Store Actions Interface
// ---------------------------------------------------------------------------

/**
 * Action methods available on the settings store.
 *
 * All mutating actions update the in-memory Zustand state and trigger
 * debounced persistence to chrome.storage.sync via the middleware.
 * Async actions (setApiKey, getDecryptedApiKey) interact with the
 * Web Crypto API for encryption/decryption.
 */
export interface SettingsStoreActions {
  /**
   * Sets the trading mode (conservative or aggressive).
   * Conservative mode requires ≥80 composite score for BUY signals.
   * Aggressive mode requires ≥45 composite score.
   *
   * @param mode - The target trading mode
   */
  setTradingMode: (mode: TradingMode) => void;

  /**
   * Updates a single scoring weight factor.
   * Does NOT automatically normalize weights to sum to 1.0 — the UI
   * (SettingsPanel.tsx) is responsible for enforcing the sum constraint.
   *
   * @param factor - The scoring factor key to update
   * @param value  - The new weight value (typically 0.0–1.0)
   */
  setScoringWeight: (factor: keyof ScoringWeights, value: number) => void;

  /**
   * Replaces all scoring weights at once with the provided values.
   * Used when the UI sends a complete weight configuration update.
   *
   * @param weights - Complete new scoring weights object
   */
  setScoringWeights: (weights: ScoringWeights) => void;

  /**
   * Resets all scoring weights to their default values from
   * DEFAULT_SCORING_WEIGHTS in src/utils/config.ts.
   */
  resetScoringWeights: () => void;

  /**
   * Sets the active TP/SL profile by its name.
   * The name must match one of the profiles in the tpSlProfiles array.
   *
   * @param name - The profile name to activate
   */
  setActiveTpSlProfile: (name: string) => void;

  /**
   * Adds or updates a TP/SL profile. If a profile with the same name
   * already exists, it is replaced. New profiles are appended.
   *
   * @param profile - The TP/SL profile to upsert
   */
  upsertTpSlProfile: (profile: TpSlProfile) => void;

  /**
   * Encrypts and stores an API key for the specified provider.
   * The plaintext key is encrypted via AES-GCM before being persisted
   * in the store state. An empty string clears the key.
   *
   * @param provider     - The API provider key name
   * @param plaintextKey - The plaintext API key to encrypt and store
   */
  setApiKey: (provider: keyof EncryptedApiKeys, plaintextKey: string) => Promise<void>;

  /**
   * Retrieves and decrypts an API key for the specified provider.
   * CRITICAL: This method should ONLY be called from the service worker
   * context per AAP Section 0.7.2 security rules.
   *
   * Returns an empty string if no key is stored or decryption fails.
   *
   * @param provider - The API provider key name
   * @returns The decrypted plaintext API key, or '' if unavailable
   */
  getDecryptedApiKey: (provider: keyof EncryptedApiKeys) => Promise<string>;

  /**
   * Updates notification preferences with partial values.
   * Only the specified fields are updated; unspecified fields retain
   * their current values.
   *
   * @param prefs - Partial notification preferences to merge
   */
  setNotificationPrefs: (prefs: Partial<NotificationPrefs>) => void;

  /**
   * Toggles the extension overlay sidebar panel visibility.
   * Flips panelVisible between true and false.
   */
  togglePanel: () => void;

  /**
   * Returns the minimum composite score threshold for the current
   * trading mode.
   *
   * @returns 80 for conservative mode, 45 for aggressive mode
   */
  getScoreThreshold: () => number;
}

// ---------------------------------------------------------------------------
// Combined Settings Store Type
// ---------------------------------------------------------------------------

/**
 * Full settings store type combining state and actions.
 * Used as the type parameter for the vanilla Zustand createStore call.
 */
export type SettingsStore = SettingsStoreState & SettingsStoreActions;

// ---------------------------------------------------------------------------
// Default TP/SL Profile Builders
// ---------------------------------------------------------------------------

/**
 * Builds the default set of TP/SL profiles from the centralized
 * DEFAULT_EXIT_STRATEGY configuration constants.
 *
 * Three built-in profiles:
 * 1. **Ladder**: Staged exits at price multiplier targets (2×, 5×, 10×)
 * 2. **Day-trade**: Percentage-based TP/SL for short-term positions
 * 3. **Swing-trade**: Wider percentage-based TP/SL for multi-day positions
 *
 * @returns Array of default TpSlProfile objects
 */
function buildDefaultTpSlProfiles(): TpSlProfile[] {
  // Ladder profile — uses multiplier-based exits directly from config
  const ladderProfile: TpSlProfile = {
    name: 'ladder',
    takeProfitLadder: DEFAULT_EXIT_STRATEGY.LADDER.map((level) => ({
      sellPercent: level.sellPercent,
      multiplier: level.multiplier,
    })),
    stopLoss: -12,
  };

  // Day-trade profile — converts percentage TP levels to multiplier format
  // Sell percentages: 50% first exit, 25% each for subsequent exits
  const dayTradeSellPercents = [50, 25, 25];
  const dayTradeProfile: TpSlProfile = {
    name: 'day-trade',
    takeProfitLadder: DEFAULT_EXIT_STRATEGY.DAY_TRADE.takeProfitLevels.map(
      (level, index) => ({
        sellPercent: dayTradeSellPercents[index] ?? 25,
        multiplier: 1 + level / 100,
      }),
    ),
    stopLoss: DEFAULT_EXIT_STRATEGY.DAY_TRADE.stopLoss,
  };

  // Swing-trade profile — equal 25% exits at each target level
  const swingTradeProfile: TpSlProfile = {
    name: 'swing-trade',
    takeProfitLadder: DEFAULT_EXIT_STRATEGY.SWING_TRADE.takeProfitLevels.map(
      (level) => ({
        sellPercent: 25,
        multiplier: 1 + level / 100,
      }),
    ),
    stopLoss: DEFAULT_EXIT_STRATEGY.SWING_TRADE.stopLoss,
  };

  return [ladderProfile, dayTradeProfile, swingTradeProfile];
}

// ---------------------------------------------------------------------------
// Store Creator Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new vanilla Zustand settings store with chrome.storage.sync
 * persistence via the chrome-storage-adapter middleware.
 *
 * Intended to be called once during service worker initialization in
 * entrypoints/background.ts. The returned store uses vanilla Zustand API
 * (.getState(), .setState(), .subscribe()) — NOT React/Preact hooks.
 *
 * For Preact UI consumption, the content script reads store state via
 * chrome.storage.onChanged synchronization and creates hook-based wrappers.
 *
 * CRITICAL: Uses chrome.storage.sync (NOT local) for cross-device settings
 * synchronization. chrome.storage.sync limits: 100KB total, 8KB per item.
 *
 * @returns A vanilla Zustand StoreApi<SettingsStore> instance
 *
 * @example
 * ```typescript
 * // In the service worker (background.ts)
 * import { createSettingsStore } from '@/store/settings-store';
 * const settingsStore = createSettingsStore();
 *
 * // Read current trading mode
 * const mode = settingsStore.getState().tradingMode;
 *
 * // Get score threshold for signal generation
 * const threshold = settingsStore.getState().getScoreThreshold();
 *
 * // Set an API key (encrypts before storing)
 * await settingsStore.getState().setApiKey('birdeye', 'my-api-key-here');
 *
 * // Retrieve decrypted key (service worker ONLY)
 * const key = await settingsStore.getState().getDecryptedApiKey('birdeye');
 * ```
 */
export function createSettingsStore() {
  return createStore<SettingsStore>()(
    createChromeStorageMiddleware<SettingsStore>(
      'settings-store',
      'sync',
      (set, get) => ({
        // -----------------------------------------------------------------
        // Initial State — defaults from centralized config constants
        // -----------------------------------------------------------------

        /** Default trading mode: conservative (requires ≥80 composite score) */
        tradingMode: 'conservative' as TradingMode,

        /** Default scoring weights from src/utils/config.ts */
        scoringWeights: {
          volumeSpike: DEFAULT_SCORING_WEIGHTS.volumeSpike,
          smartMoneyConvergence: DEFAULT_SCORING_WEIGHTS.smartMoneyConvergence,
          buySellRatio: DEFAULT_SCORING_WEIGHTS.buySellRatio,
          holderGrowth: DEFAULT_SCORING_WEIGHTS.holderGrowth,
          liquidity: DEFAULT_SCORING_WEIGHTS.liquidity,
          tokenAge: DEFAULT_SCORING_WEIGHTS.tokenAge,
          safetyScore: DEFAULT_SCORING_WEIGHTS.safetyScore,
        },

        /** Default active profile is the ladder strategy */
        activeTpSlProfile: 'ladder',

        /** Built-in TP/SL profiles from config defaults */
        tpSlProfiles: buildDefaultTpSlProfiles(),

        /** All API keys start empty (unconfigured) */
        apiKeys: {
          birdeye: '',
          helius: '',
          rugcheck: '',
          groq: '',
          anthropic: '',
        },

        /** Default notification preferences */
        notificationPrefs: {
          enabled: true,
          minScoreForAlert: 70,
          soundEnabled: false,
          exitAlerts: true,
          newTokenAlerts: true,
          smartMoneyAlerts: true,
        },

        /** Panel starts visible by default */
        panelVisible: true,

        /** LLM tier routing thresholds from config */
        llmFastThreshold: LLM_CONFIG.FAST_THRESHOLD,
        llmDetailedThreshold: LLM_CONFIG.DETAILED_THRESHOLD,

        // -----------------------------------------------------------------
        // Actions
        // -----------------------------------------------------------------

        setTradingMode: (mode: TradingMode): void => {
          set({ tradingMode: mode });
          logger.info(`Trading mode changed to: ${mode}`);
        },

        setScoringWeight: (factor: keyof ScoringWeights, value: number): void => {
          set((state) => ({
            scoringWeights: { ...state.scoringWeights, [factor]: value },
          }));
          logger.debug(`Scoring weight '${factor}' updated to: ${value}`);
        },

        setScoringWeights: (weights: ScoringWeights): void => {
          set({ scoringWeights: weights });
          logger.debug('All scoring weights updated');
        },

        resetScoringWeights: (): void => {
          set({
            scoringWeights: {
              volumeSpike: DEFAULT_SCORING_WEIGHTS.volumeSpike,
              smartMoneyConvergence: DEFAULT_SCORING_WEIGHTS.smartMoneyConvergence,
              buySellRatio: DEFAULT_SCORING_WEIGHTS.buySellRatio,
              holderGrowth: DEFAULT_SCORING_WEIGHTS.holderGrowth,
              liquidity: DEFAULT_SCORING_WEIGHTS.liquidity,
              tokenAge: DEFAULT_SCORING_WEIGHTS.tokenAge,
              safetyScore: DEFAULT_SCORING_WEIGHTS.safetyScore,
            },
          });
          logger.info('Scoring weights reset to defaults');
        },

        setActiveTpSlProfile: (name: string): void => {
          const profiles = get().tpSlProfiles;
          const profileExists = profiles.some((p) => p.name === name);
          if (!profileExists) {
            logger.error(`TP/SL profile '${name}' not found — keeping current profile`);
            return;
          }
          set({ activeTpSlProfile: name });
          logger.info(`Active TP/SL profile changed to: ${name}`);
        },

        upsertTpSlProfile: (profile: TpSlProfile): void => {
          set((state) => {
            const filteredProfiles = state.tpSlProfiles.filter(
              (p) => p.name !== profile.name,
            );
            return { tpSlProfiles: [...filteredProfiles, profile] };
          });
          logger.info(`TP/SL profile '${profile.name}' upserted`);
        },

        setApiKey: async (
          provider: keyof EncryptedApiKeys,
          plaintextKey: string,
        ): Promise<void> => {
          try {
            // Encrypt the plaintext key before storing; empty string clears the key
            const encrypted = plaintextKey ? await encrypt(plaintextKey) : '';
            set((state) => ({
              apiKeys: { ...state.apiKeys, [provider]: encrypted },
            }));
            logger.info(`API key updated for provider: ${provider}`);
          } catch (err) {
            logger.error(`Failed to encrypt API key for ${provider}`, err);
            // Do not update state on encryption failure to prevent data loss
          }
        },

        getDecryptedApiKey: async (
          provider: keyof EncryptedApiKeys,
        ): Promise<string> => {
          const encrypted = get().apiKeys[provider];
          if (!encrypted) {
            return '';
          }
          try {
            return await decrypt(encrypted);
          } catch (err) {
            logger.error(`Failed to decrypt API key for ${provider}`, err);
            return '';
          }
        },

        setNotificationPrefs: (prefs: Partial<NotificationPrefs>): void => {
          set((state) => ({
            notificationPrefs: { ...state.notificationPrefs, ...prefs },
          }));
          logger.debug('Notification preferences updated');
        },

        togglePanel: (): void => {
          set((state) => ({ panelVisible: !state.panelVisible }));
        },

        getScoreThreshold: (): number => {
          const mode = get().tradingMode;
          return mode === 'conservative'
            ? SCORING_THRESHOLDS.CONSERVATIVE_MIN
            : SCORING_THRESHOLDS.AGGRESSIVE_MIN;
        },
      }),
    ),
  );
}
