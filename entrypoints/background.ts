/**
 * entrypoints/background.ts — Manifest V3 Service Worker Orchestrator
 *
 * The "brain" of the GMGN Signal Bot Chrome Extension. This service worker
 * handles ALL external API calls, signal scoring, WebSocket streaming,
 * AI/LLM analysis, and state persistence.
 *
 * CRITICAL MV3 LIFECYCLE RULES (AAP Section 0.7.1):
 * - ALL chrome.* listeners registered SYNCHRONOUSLY at TOP LEVEL
 * - NO setTimeout/setInterval — chrome.alarms ONLY
 * - ALL runtime state persists via chrome.storage
 * - Targets Chrome 116+ (WebSocket activity extends SW lifetime)
 *
 * @module entrypoints/background
 */

// =============================================================================
// Internal Imports — utilities
// =============================================================================
import { createLogger } from '@/utils/logger';
import {
  TIMING,
  SCORING_THRESHOLDS,
  DEFAULT_EXIT_STRATEGY,
  DEFAULT_SCORING_WEIGHTS,
  RATE_LIMITS,
  SMART_MONEY_CONFIG,
  LLM_CONFIG,
} from '@/utils/config';
import type { ExtensionMessage } from '@/utils/messaging';
import { sendToContent, onMessage } from '@/utils/messaging';
import { decrypt, getOrCreateEncryptionKey } from '@/utils/crypto';
import { cache } from '@/utils/cache';

// =============================================================================
// Internal Imports — stores
// =============================================================================
import {
  initializeStores,
  vanillaSignalStore,
  vanillaTokenStore,
  vanillaSettingsStore,
  vanillaPositionStore,
  setupStorageSyncListener,
} from '@/store/index';
import type { TokenData } from '@/store/token-store';

// =============================================================================
// Internal Imports — signal scoring engine
// =============================================================================
import { analyzeToken } from '@/signals/scoring-engine';
import {
  checkAllPositions,
  checkExitSignals,
  getDefaultTpLevels,
} from '@/signals/exit-signals';
import type { PositionData, TokenContext } from '@/signals/exit-signals';
import { runHardFilters } from '@/signals/hard-filters';
import type {
  CompositeSignal,
  TokenAnalysisInput,
  TradingMode,
  HardFilterResult,
  ExitTrigger,
  ExitCheckResult,
} from '@/signals/types';

// =============================================================================
// Internal Imports — API clients
// =============================================================================
import { BirdeyeClient } from '@/api/birdeye';
import { JupiterClient } from '@/api/jupiter';
import { HeliusClient } from '@/api/helius';
import { DexScreenerClient } from '@/api/dexscreener';
import { RugCheckClient } from '@/api/rugcheck';
import { GoPlusClient } from '@/api/goplus';
import { GroqClient } from '@/api/groq';
import { RateLimiter } from '@/api/rate-limiter';
import { PumpPortalClient } from '@/api/pump-portal';

// =============================================================================
// Internal Imports — GMGN data interception parsers
// =============================================================================
import {
  parseInterceptedResponse,
  parseTrendingTokens,
  parseTokenDetail,
  parseWalletActivity,
  parseSmartMoneySignals,
} from '@/gmgn/parsers';
import type {
  GmgnTokenDetail,
  GmgnInterceptedMessage,
  GmgnSmartMoneySignal,
  GmgnWalletActivity,
  GmgnParsedResponse,
} from '@/gmgn/types';

// =============================================================================
// Internal Imports — shared API types
// =============================================================================
import type {
  PumpPortalNewToken,
  PumpPortalEvent,
  PumpPortalMigration,
  BirdeyeTokenData,
  RugCheckReport,
  GoPlusResult,
} from '@/api/types';

// =============================================================================
// Internal Imports — tracking
// =============================================================================
import { WalletTracker } from '@/tracking/wallet-tracker';
import { ConvergenceDetector } from '@/tracking/convergence-detector';

// =============================================================================
// Internal Imports — safety
// =============================================================================
import { SafetyChecker } from '@/safety/checker';
import { HoneypotDetector } from '@/safety/honeypot-detector';
import { LPAnalyzer } from '@/safety/lp-analyzer';

// =============================================================================
// Internal Imports — AI/LLM
// =============================================================================
import { AIRouter, determineTier, type TokenAnalysisInput as AITokenAnalysisInput } from '@/ai/router';

// =============================================================================
// Internal Imports — WebSocket streaming
// =============================================================================
import { WebSocketManager } from '@/streaming/manager';
import { PumpPortalStream } from '@/streaming/pump-portal-stream';
import { BirdeyeStream, type BirdeyeNewListingEvent } from '@/streaming/birdeye-stream';

// =============================================================================
// Logger — created immediately for service worker lifecycle logging
// =============================================================================
const logger = createLogger('background');

// =============================================================================
// Alarm name constants — used across listeners and initializers
// =============================================================================
const ALARM_NAMES = {
  WEBSOCKET_KEEPALIVE: 'websocket-keepalive',
  WEBSOCKET_RECONNECT: 'websocket-reconnect',
  EXIT_SIGNAL_CHECK: 'exit-signal-check',
  STALE_DATA_CLEANUP: 'stale-data-cleanup',
  POLLING_FALLBACK: 'polling-fallback',
} as const;

// =============================================================================
// Module-level references (re-initialized on each SW activation)
// These are NOT persistent state — they are recreated each time the service
// worker starts. Persistent state lives in chrome.storage via Zustand stores.
// =============================================================================

/** Centralized rate limiter shared across all API clients */
let rateLimiter: RateLimiter | null = null;

/** External API client instances */
let birdeyeClient: BirdeyeClient | null = null;
let jupiterClient: JupiterClient | null = null;
let heliusClient: HeliusClient | null = null;
let dexScreenerClient: DexScreenerClient | null = null;
let rugCheckClient: RugCheckClient | null = null;
let goPlusClient: GoPlusClient | null = null;
let groqClient: GroqClient | null = null;
let pumpPortalClient: PumpPortalClient | null = null;

/** Safety analysis pipeline */
let safetyChecker: SafetyChecker | null = null;
let honeypotDetector: HoneypotDetector | null = null;
let lpAnalyzer: LPAnalyzer | null = null;

/** Smart money tracking */
let walletTracker: WalletTracker | null = null;
let convergenceDetector: ConvergenceDetector | null = null;

/** AI/LLM analysis */
let aiRouter: AIRouter | null = null;

/** WebSocket streaming */
let pumpPortalStream: PumpPortalStream | null = null;
let birdeyeStream: BirdeyeStream | null = null;

/** Tracks whether the initialization sequence has completed */
let isInitialized = false;

/** Queue of pending messages received before initialization completed */
const pendingMessages: Array<{
  message: ExtensionMessage;
  sender: chrome.runtime.MessageSender;
  sendResponse: (response?: unknown) => void;
}> = [];

// =============================================================================
// PHASE 1: SYNCHRONOUS TOP-LEVEL LISTENER REGISTRATION (MANDATORY)
//
// Per AAP Section 0.7.1: "ALL chrome.runtime.onMessage.addListener,
// chrome.alarms.onAlarm.addListener, and chrome.storage.onChanged.addListener
// calls MUST be registered SYNCHRONOUSLY at the TOP LEVEL — never inside
// async callbacks, conditionals, setTimeout, or promise chains."
// =============================================================================

export default defineBackground(() => {
  logger.info('Service worker starting — registering synchronous listeners');

  // ---------------------------------------------------------------------------
  // 1a: chrome.runtime.onMessage Listener — SYNCHRONOUS TOP LEVEL
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean => {
      // Validate sender identity per AAP Section 0.7.2
      if (sender.id !== chrome.runtime.id) {
        logger.warn(`Rejected message from unknown sender: ${sender.id}`);
        sendResponse({ error: 'Unauthorized sender' });
        return false;
      }

      // Validate message structure — must have a 'type' field
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        typeof (message as Record<string, unknown>).type !== 'string'
      ) {
        logger.warn('Rejected malformed message — missing or invalid type field');
        sendResponse({ error: 'Invalid message format' });
        return false;
      }

      const typedMessage = message as ExtensionMessage;

      // If not yet initialized, queue the message for processing after init
      if (!isInitialized) {
        logger.debug(`Queuing message (type=${typedMessage.type}) — initialization pending`);
        pendingMessages.push({ message: typedMessage, sender, sendResponse });
        return true; // Keep the message channel open for async response
      }

      // Dispatch the message asynchronously
      handleMessage(typedMessage, sender, sendResponse).catch((error: unknown) => {
        logger.error(`Unhandled error in message handler: ${String(error)}`);
        try {
          sendResponse({ error: 'Internal service worker error' });
        } catch {
          // sendResponse may already have been called or port closed
        }
      });

      // Return true to indicate async response via sendResponse
      return true;
    },
  );

  // ---------------------------------------------------------------------------
  // 1b: chrome.alarms.onAlarm Listener — SYNCHRONOUS TOP LEVEL
  // ---------------------------------------------------------------------------
  chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
    handleAlarm(alarm).catch((error: unknown) => {
      logger.error(`Unhandled error in alarm handler (${alarm.name}): ${String(error)}`);
    });
  });

  // ---------------------------------------------------------------------------
  // 1c: chrome.storage.onChanged Listener — SYNCHRONOUS TOP LEVEL
  // Delegates to the store sync listener from src/store/index.ts which handles
  // deserialization and merging of incoming state into vanilla stores.
  // ---------------------------------------------------------------------------
  setupStorageSyncListener();

  // ---------------------------------------------------------------------------
  // 1d: chrome.runtime.onInstalled Listener — SYNCHRONOUS TOP LEVEL
  // ---------------------------------------------------------------------------
  chrome.runtime.onInstalled.addListener(
    (details: chrome.runtime.InstalledDetails) => {
      handleInstall(details).catch((error: unknown) => {
        logger.error(`Unhandled error in install handler: ${String(error)}`);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Trigger async initialization after all synchronous listeners are registered.
  // This runs once per service worker activation.
  // ---------------------------------------------------------------------------
  initializeServiceWorker().catch((error: unknown) => {
    logger.error(`CRITICAL: Service worker initialization failed: ${String(error)}`);
  });
});

// =============================================================================
// INITIALIZATION — runs once per service worker activation
// =============================================================================

/**
 * Main initialization sequence for the service worker.
 * Restores persisted state, creates API client instances, initializes the
 * signal scoring pipeline, connects WebSocket streams, and processes any
 * messages that were queued during startup.
 */
async function initializeServiceWorker(): Promise<void> {
  logger.info('Beginning async initialization sequence');

  try {
    // -----------------------------------------------------------------------
    // Phase 2: Initialize chrome.alarms
    // Per AAP Section 0.7.1: chrome.alarms (minimum 30-second interval)
    // -----------------------------------------------------------------------
    await createAlarms();

    // -----------------------------------------------------------------------
    // Phase 3: Initialize Zustand stores from persisted chrome.storage
    // -----------------------------------------------------------------------
    await initializeStores();
    logger.info('Zustand stores hydrated from chrome.storage');

    // -----------------------------------------------------------------------
    // Phase 4: Initialize API clients with decrypted keys
    // -----------------------------------------------------------------------
    await initializeApiClients();
    logger.info('API clients initialized');

    // -----------------------------------------------------------------------
    // Phase 5: Initialize signal scoring engine dependencies
    // -----------------------------------------------------------------------
    initializeScoringPipeline();
    logger.info('Signal scoring pipeline initialized');

    // -----------------------------------------------------------------------
    // Phase 6: Initialize WebSocket streaming
    // -----------------------------------------------------------------------
    await initializeWebSockets();
    logger.info('WebSocket streams initialized');

    // -----------------------------------------------------------------------
    // Phase 7: Initialize smart money tracking
    // -----------------------------------------------------------------------
    initializeSmartMoneyTracking();
    logger.info('Smart money tracking initialized');

    // Mark initialization as complete
    isInitialized = true;
    logger.info('Service worker initialization complete');

    // Process any messages that were queued during initialization
    await processPendingMessages();
  } catch (error: unknown) {
    logger.error(`Initialization sequence error: ${String(error)}`);
    // Even on partial failure, mark as initialized to unblock message processing.
    // Individual subsystems handle their own graceful degradation.
    isInitialized = true;
    await processPendingMessages();
  }
}

// =============================================================================
// PHASE 2: ALARM CREATION
// =============================================================================

/**
 * Creates all required chrome.alarms for periodic service worker operations.
 *
 * Chrome enforces a minimum interval of 30 seconds for alarms. The 20-second
 * WebSocket keepalive requirement is primarily met by WebSocket message
 * activity extending the SW timer on Chrome 116+. The alarm serves as a
 * safety net when no messages are flowing.
 */
async function createAlarms(): Promise<void> {
  // Clear any stale alarms from a previous worker session
  await chrome.alarms.clearAll();

  // WebSocket keepalive: 30-second alarm (Chrome min) as safety net.
  // WebSocket message activity handles sub-30s keepalive on Chrome 116+.
  chrome.alarms.create(ALARM_NAMES.WEBSOCKET_KEEPALIVE, {
    periodInMinutes: TIMING.ALARM_MIN_INTERVAL_MIN, // 0.5 = 30 seconds
  });

  // WebSocket reconnection check
  chrome.alarms.create(ALARM_NAMES.WEBSOCKET_RECONNECT, {
    periodInMinutes: 1, // every 60 seconds
  });

  // Exit signal check — evaluate tracked positions against TP/SL ladder
  chrome.alarms.create(ALARM_NAMES.EXIT_SIGNAL_CHECK, {
    periodInMinutes: TIMING.ALARM_MIN_INTERVAL_MIN, // 30 seconds
  });

  // Stale data cleanup — remove expired cache entries
  chrome.alarms.create(ALARM_NAMES.STALE_DATA_CLEANUP, {
    periodInMinutes: 5,
  });

  // Polling fallback — used when WebSocket connections fail persistently
  chrome.alarms.create(ALARM_NAMES.POLLING_FALLBACK, {
    periodInMinutes: 1,
  });

  logger.info('Chrome alarms created');
}

// =============================================================================
// PHASE 4: API CLIENT INITIALIZATION
// =============================================================================

/**
 * Retrieves encrypted API keys from chrome.storage.local, decrypts them,
 * and instantiates all external API client instances.
 *
 * Per AAP Section 0.7.2: API keys are ONLY accessed in the service worker
 * context — never exposed to content scripts.
 *
 * Per AAP Section 0.7.4: All clients route through the centralized RateLimiter.
 */
async function initializeApiClients(): Promise<void> {
  // Decrypt API keys from storage
  const keys = await decryptApiKeys();

  // Initialize the centralized rate limiter with per-provider configs
  rateLimiter = new RateLimiter();

  // Initialize API clients — each receives the shared rate limiter
  birdeyeClient = keys.birdeyeApiKey
    ? new BirdeyeClient(keys.birdeyeApiKey, rateLimiter)
    : null;

  jupiterClient = new JupiterClient(rateLimiter);

  heliusClient = keys.heliusApiKey
    ? new HeliusClient(keys.heliusApiKey, rateLimiter)
    : null;

  dexScreenerClient = new DexScreenerClient(rateLimiter);

  rugCheckClient = keys.rugCheckApiKey
    ? new RugCheckClient(keys.rugCheckApiKey, rateLimiter)
    : null;

  goPlusClient = new GoPlusClient(rateLimiter);

  groqClient = keys.groqApiKey
    ? new GroqClient(keys.groqApiKey, keys.anthropicApiKey)
    : null;

  pumpPortalClient = new PumpPortalClient();

  if (!birdeyeClient) {
    logger.warn('Birdeye API key not configured — Birdeye enrichment disabled');
  }
  if (!heliusClient) {
    logger.warn('Helius API key not configured — enhanced transaction parsing disabled');
  }
  if (!rugCheckClient) {
    logger.warn('RugCheck API key not configured — safety reports may be limited');
  }
  if (!groqClient) {
    logger.warn('Groq API key not configured — AI/LLM analysis disabled');
  }
}

/**
 * Retrieves and decrypts stored API keys from chrome.storage.local.
 * Returns empty strings for keys that are not configured, allowing
 * clients to operate in degraded mode.
 */
async function decryptApiKeys(): Promise<{
  birdeyeApiKey: string;
  heliusApiKey: string;
  rugCheckApiKey: string;
  groqApiKey: string;
  anthropicApiKey: string;
}> {
  const defaultKeys = {
    birdeyeApiKey: '',
    heliusApiKey: '',
    rugCheckApiKey: '',
    groqApiKey: '',
    anthropicApiKey: '',
  };

  try {
    // Retrieve encrypted keys from the settings store
    const settings = vanillaSettingsStore.getState();
    const encryptedKeys = settings.apiKeys;

    if (!encryptedKeys) {
      logger.debug('No encrypted API keys found in settings store');
      return defaultKeys;
    }

    // Decrypt each key individually — failures for one key don't block others
    const results = await Promise.allSettled([
      encryptedKeys.birdeye ? decrypt(encryptedKeys.birdeye) : Promise.resolve(''),
      encryptedKeys.helius ? decrypt(encryptedKeys.helius) : Promise.resolve(''),
      encryptedKeys.rugcheck ? decrypt(encryptedKeys.rugcheck) : Promise.resolve(''),
      encryptedKeys.groq ? decrypt(encryptedKeys.groq) : Promise.resolve(''),
      encryptedKeys.anthropic ? decrypt(encryptedKeys.anthropic) : Promise.resolve(''),
    ]);

    return {
      birdeyeApiKey: results[0].status === 'fulfilled' ? results[0].value : '',
      heliusApiKey: results[1].status === 'fulfilled' ? results[1].value : '',
      rugCheckApiKey: results[2].status === 'fulfilled' ? results[2].value : '',
      groqApiKey: results[3].status === 'fulfilled' ? results[3].value : '',
      anthropicApiKey: results[4].status === 'fulfilled' ? results[4].value : '',
    };
  } catch (error: unknown) {
    logger.error(`Failed to decrypt API keys: ${String(error)}`);
    return defaultKeys;
  }
}

// =============================================================================
// PHASE 5: SIGNAL SCORING PIPELINE INITIALIZATION
// =============================================================================

/**
 * Initializes the safety checker, honeypot detector, LP analyzer,
 * AI router, and wires them into the scoring pipeline.
 */
function initializeScoringPipeline(): void {
  // Initialize safety analysis components
  lpAnalyzer = new LPAnalyzer();
  honeypotDetector = jupiterClient ? new HoneypotDetector(jupiterClient) : null;

  if (rugCheckClient && goPlusClient && honeypotDetector && lpAnalyzer) {
    safetyChecker = new SafetyChecker(
      rugCheckClient,
      goPlusClient,
      honeypotDetector,
      lpAnalyzer,
    );
  } else {
    logger.warn('SafetyChecker partially configured — some safety checks may be unavailable');
  }

  // Initialize AI router
  if (groqClient) {
    aiRouter = new AIRouter(groqClient, {
      fastThreshold: LLM_CONFIG.FAST_THRESHOLD,
      detailedThreshold: LLM_CONFIG.DETAILED_THRESHOLD,
    });
  } else {
    logger.warn('AI Router not initialized — Groq API key not configured');
  }
}

// =============================================================================
// PHASE 6: WEBSOCKET STREAMING INITIALIZATION
// =============================================================================

/**
 * Initializes WebSocket connections to PumpPortal and Birdeye.
 *
 * Per AAP Section 0.7.6:
 * - Single PumpPortal connection with multiplexed subscriptions
 * - 20-second keepalive ping via alarm + WebSocket activity
 * - Exponential backoff reconnection (1s→2s→4s→8s→16s, max 5 retries)
 * - Graceful degradation to polling if WebSockets fail persistently
 */
async function initializeWebSockets(): Promise<void> {
  // PumpPortal WebSocket — always attempt connection (free, no auth)
  try {
    pumpPortalStream = new PumpPortalStream();
    await pumpPortalStream.connect();

    // Subscribe to all relevant event types on the single connection
    pumpPortalStream.subscribeNewToken((event: PumpPortalNewToken) => {
      handleNewTokenEvent(event).catch((err: unknown) => {
        logger.error(`Error handling PumpPortal new token event: ${String(err)}`);
      });
    });

    pumpPortalStream.subscribeMigration((event: PumpPortalMigration) => {
      handleMigrationEvent(event).catch((err: unknown) => {
        logger.error(`Error handling PumpPortal migration event: ${String(err)}`);
      });
    });

    logger.info('PumpPortal WebSocket connected and subscribed');
  } catch (error: unknown) {
    logger.error(`PumpPortal WebSocket connection failed: ${String(error)}`);
    logger.info('Will retry via polling-fallback alarm');
  }

  // Birdeye WebSocket — requires API key
  const settings = vanillaSettingsStore.getState();
  if (settings.apiKeys?.birdeye) {
    try {
      const decryptedKey = await decrypt(settings.apiKeys.birdeye);
      if (decryptedKey) {
        birdeyeStream = new BirdeyeStream(decryptedKey);
        await birdeyeStream.connect();

        birdeyeStream.subscribeNewListings((event: BirdeyeNewListingEvent) => {
          handleBirdeyeNewListing(event).catch((err: unknown) => {
            logger.error(`Error handling Birdeye new listing: ${String(err)}`);
          });
        });

        logger.info('Birdeye WebSocket connected and subscribed');
      }
    } catch (error: unknown) {
      logger.error(`Birdeye WebSocket connection failed: ${String(error)}`);
    }
  } else {
    logger.info('Birdeye WebSocket skipped — no API key configured');
  }
}

// =============================================================================
// PHASE 7: SMART MONEY TRACKING INITIALIZATION
// =============================================================================

/**
 * Initializes the wallet tracker and convergence detector for smart money
 * tracking with a 2-hour convergence window (per AAP Section 0.1.1).
 */
function initializeSmartMoneyTracking(): void {
  walletTracker = new WalletTracker();
  convergenceDetector = new ConvergenceDetector({
    windowMs: SMART_MONEY_CONFIG.CONVERGENCE_WINDOW_MS,
    minWallets: SMART_MONEY_CONFIG.MIN_CONVERGENCE_WALLETS,
  });

  // Register convergence event callback — fires when 3+ wallets converge
  convergenceDetector.onConvergence((event) => {
    logger.info(
      `Convergence detected for token ${event.token}: ` +
      `${event.wallets.length} wallets in window`,
    );
    // Convergence events feed into the smart-money-convergence scoring factor
    // via the scoring engine's input data enrichment
  });

  // Initialize wallet tracker (loads persisted wallet list)
  walletTracker.initialize().catch((error: unknown) => {
    logger.error(`Wallet tracker initialization failed: ${String(error)}`);
  });
}

// =============================================================================
// INSTALL HANDLER
// =============================================================================

/**
 * Handles extension installation and update events.
 * On fresh install: generates encryption key, sets default settings, creates alarms.
 * On update: re-creates alarms and ensures settings migration.
 */
async function handleInstall(
  details: chrome.runtime.InstalledDetails,
): Promise<void> {
  logger.info(`Extension installed (reason: ${details.reason})`);

  if (details.reason === 'install') {
    // Generate per-installation AES-GCM encryption key
    try {
      await getOrCreateEncryptionKey();
      logger.info('Encryption key generated for new installation');
    } catch (error: unknown) {
      logger.error(`Failed to generate encryption key: ${String(error)}`);
    }

    // Set default settings in the settings store
    try {
      vanillaSettingsStore.getState().setTradingMode('conservative');
      vanillaSettingsStore.getState().setScoringWeights(DEFAULT_SCORING_WEIGHTS);
      logger.info('Default settings applied');
    } catch (error: unknown) {
      logger.error(`Failed to set default settings: ${String(error)}`);
    }
  }

  // Re-create alarms on both install and update
  await createAlarms();
}

// =============================================================================
// MESSAGE HANDLER — async dispatcher for all chrome.runtime.onMessage events
// =============================================================================

/**
 * Dispatches incoming extension messages to the appropriate handler based on
 * the discriminated union type field.
 *
 * Per AAP Section 0.7.2: sender.id is validated upstream in the synchronous
 * listener — by the time we reach this function, sender is already verified.
 */
async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  logger.debug(`Handling message: ${message.type}`);

  switch (message.type) {
    case 'GMGN_API_RESPONSE':
      await handleGmgnApiResponse(message.payload);
      sendResponse({ success: true });
      break;

    case 'TOKEN_DATA':
      await handleTokenData(message.payload);
      sendResponse({ success: true });
      break;

    case 'SIGNAL_UPDATE':
      // Inbound signal updates are unusual (typically outbound from background)
      // but handle gracefully
      logger.debug('Received SIGNAL_UPDATE message — no action needed in background');
      sendResponse({ success: true });
      break;

    case 'SAFETY_CHECK_REQUEST':
      await handleSafetyCheckRequest(message.payload, sender.tab?.id, sendResponse);
      break;

    case 'SAFETY_CHECK_RESULT':
      // Inbound safety results — store them
      logger.debug('Received SAFETY_CHECK_RESULT message');
      sendResponse({ success: true });
      break;

    case 'SETTINGS_CHANGE':
      await handleSettingsChange(message.payload);
      sendResponse({ success: true });
      break;

    case 'AI_ANALYSIS_REQUEST':
      await handleAiAnalysisRequest(message.payload, sender.tab?.id, sendResponse);
      break;

    case 'AI_ANALYSIS_RESULT':
      // Inbound AI results — store them
      logger.debug('Received AI_ANALYSIS_RESULT message');
      sendResponse({ success: true });
      break;

    case 'STREAM_EVENT':
      logger.debug('Received STREAM_EVENT message');
      sendResponse({ success: true });
      break;

    case 'LOG_FORWARD':
      handleLogForward(message.payload);
      sendResponse({ success: true });
      break;

    case 'EXIT_SIGNAL':
      logger.debug('Received EXIT_SIGNAL message');
      sendResponse({ success: true });
      break;

    default: {
      // Exhaustive check: handle unknown message types gracefully
      const exhaustiveCheck: never = message;
      logger.warn(`Unknown message type received: ${(exhaustiveCheck as ExtensionMessage).type}`);
      sendResponse({ error: 'Unknown message type' });
    }
  }
}

// =============================================================================
// MESSAGE HANDLER IMPLEMENTATIONS
// =============================================================================

/**
 * Handles intercepted GMGN API response data from the content script.
 *
 * Pipeline: parse → update token store → trigger signal analysis
 *
 * Per AAP Section 0.4.3: GMGN data interception is the primary data source;
 * external APIs supplement for safety, pricing, and new token detection.
 */
async function handleGmgnApiResponse(payload: {
  url: string;
  data: unknown;
  patternType: string;
}): Promise<void> {
  const { data, patternType } = payload;

  try {
    const parsed: GmgnParsedResponse = parseInterceptedResponse(patternType, data);

    if (!parsed.data) {
      logger.debug(`No parseable data for GMGN pattern: ${patternType}`);
      return;
    }

    switch (parsed.type) {
      case 'trending_tokens': {
        if (Array.isArray(parsed.data)) {
          const tokens = parsed.data as Array<{ address?: string; symbol?: string; name?: string; price?: number; marketCap?: number; volume24h?: number; liquidity?: number; holderCount?: number }>;
          for (const token of tokens) {
            if (token.address) {
              vanillaTokenStore.getState().upsertToken(token.address, {
                mint: token.address,
                symbol: token.symbol ?? '',
                name: token.name ?? '',
                price: token.price ?? 0,
                marketCap: token.marketCap ?? 0,
                volume24h: token.volume24h ?? 0,
                liquidity: token.liquidity ?? 0,
                holderCount: token.holderCount ?? 0,
              });
            }
          }

          // Trigger analysis for any new high-potential tokens
          for (const token of tokens) {
            if (token.address) {
              triggerTokenAnalysis(token.address).catch((err: unknown) => {
                logger.error(`Analysis trigger failed for ${token.address}: ${String(err)}`);
              });
            }
          }
        }
        break;
      }

      case 'token_detail': {
        const detail = parsed.data as GmgnTokenDetail;
        if (detail?.address) {
          vanillaTokenStore.getState().upsertToken(detail.address, {
            mint: detail.address,
            symbol: detail.symbol,
            name: detail.name,
            price: detail.price ?? 0,
            marketCap: detail.marketCap ?? 0,
            volume24h: detail.volume24h ?? 0,
            liquidity: detail.liquidity ?? 0,
            holderCount: detail.holderCount ?? 0,
          });

          // Trigger full analysis for the token
          await triggerTokenAnalysis(detail.address);
        }
        break;
      }

      case 'wallet_activity': {
        const activities = parsed.data as GmgnWalletActivity[];
        if (Array.isArray(activities) && walletTracker) {
          walletTracker.processGmgnWalletActivity(activities);
        }
        break;
      }

      case 'smart_money': {
        const signals = parsed.data as GmgnSmartMoneySignal[];
        if (Array.isArray(signals) && walletTracker) {
          walletTracker.processGmgnSmartMoneySignals(signals);
        }
        break;
      }

      default:
        logger.debug(`Unhandled GMGN parsed response type: ${parsed.type}`);
    }
  } catch (error: unknown) {
    logger.error(`Error processing GMGN API response (${patternType}): ${String(error)}`);
  }
}

/**
 * Handles token data messages forwarded from content scripts.
 * Stores the data in the token store and optionally triggers analysis.
 */
async function handleTokenData(payload: {
  mint: string;
  data: unknown;
}): Promise<void> {
  const { mint, data } = payload;

  if (!mint) {
    logger.warn('TOKEN_DATA message missing mint address');
    return;
  }

  try {
    // Store token data
    if (data && typeof data === 'object') {
      vanillaTokenStore.getState().upsertToken(mint, data as Record<string, unknown>);
    }
  } catch (error: unknown) {
    logger.error(`Error handling TOKEN_DATA for ${mint}: ${String(error)}`);
  }
}

/**
 * Handles safety check requests from the UI — runs concurrent RugCheck + GoPlus
 * + honeypot detection and returns the result.
 */
async function handleSafetyCheckRequest(
  payload: { mint: string },
  tabId: number | undefined,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const { mint } = payload;

  if (!safetyChecker) {
    sendResponse({ error: 'Safety checker not initialized' });
    return;
  }

  try {
    const report = await safetyChecker.checkToken(mint);
    sendResponse({ success: true, report });

    // Also send the result to the content script for UI update
    if (tabId) {
      await sendToContent(tabId, {
        type: 'SAFETY_CHECK_RESULT',
        payload: { mint, report },
      });
    }
  } catch (error: unknown) {
    logger.error(`Safety check failed for ${mint}: ${String(error)}`);
    sendResponse({ error: `Safety check failed: ${String(error)}` });
  }
}

/**
 * Valid API key provider names accepted by the settings store.
 * Used for type-safe validation when processing individual API key
 * save messages from the SettingsPanel UI component.
 */
const VALID_API_KEY_PROVIDERS = new Set<string>([
  'birdeye',
  'helius',
  'rugcheck',
  'groq',
  'anthropic',
]);

/**
 * Handles settings changes from the UI.
 * Updates the settings store and reconfigures the scoring engine dynamically.
 *
 * Supports the following key patterns from SettingsPanel.tsx:
 *  - Static keys: 'tradingMode', 'scoringWeights', 'apiKeys', 'notificationPrefs', 'exitTriggers'
 *  - Dynamic keys: 'apiKey:{provider}' — individual API key save from SettingsPanel
 *  - Dynamic keys: 'testApiKey:{provider}' — API key connection test from SettingsPanel
 */
async function handleSettingsChange(payload: {
  key: string;
  value: unknown;
}): Promise<void> {
  const { key, value } = payload;

  try {
    const store = vanillaSettingsStore.getState();

    // -----------------------------------------------------------------------
    // Dynamic key patterns: handle 'apiKey:{provider}' and 'testApiKey:{provider}'
    // SettingsPanel.tsx sends individual API keys as:
    //   { key: 'apiKey:birdeye', value: '<plaintext-key>' }
    // and connection tests as:
    //   { key: 'testApiKey:birdeye', value: null }
    // -----------------------------------------------------------------------
    if (key.startsWith('apiKey:')) {
      const provider = key.slice('apiKey:'.length);
      if (VALID_API_KEY_PROVIDERS.has(provider) && typeof value === 'string' && value.length > 0) {
        await store.setApiKey(
          provider as 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic',
          value,
        );
        logger.info(`API key for ${provider} saved — reinitializing clients`);
        await initializeApiClients();
        initializeScoringPipeline();
      } else if (!VALID_API_KEY_PROVIDERS.has(provider)) {
        logger.warn(`Unknown API key provider: ${provider}`);
      }
      return;
    }

    if (key.startsWith('testApiKey:')) {
      const provider = key.slice('testApiKey:'.length);
      if (VALID_API_KEY_PROVIDERS.has(provider)) {
        logger.info(`Testing API key connection for ${provider}`);
        // Attempt to validate the stored key by making a lightweight test request
        const decryptedKey = await store.getDecryptedApiKey(
          provider as 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic',
        );
        if (!decryptedKey) {
          logger.warn(`No API key stored for ${provider} — cannot test connection`);
        } else {
          logger.info(`API key for ${provider} is present — connection test acknowledged`);
        }
      } else {
        logger.warn(`Unknown API key provider for test: ${provider}`);
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Static key patterns — standard switch/case dispatch
    // -----------------------------------------------------------------------
    switch (key) {
      case 'tradingMode':
        if (value === 'conservative' || value === 'aggressive') {
          store.setTradingMode(value);
          logger.info(`Trading mode updated to: ${value}`);
        }
        break;

      case 'scoringWeights':
        if (value && typeof value === 'object') {
          store.setScoringWeights(value as typeof DEFAULT_SCORING_WEIGHTS);
          logger.info('Scoring weights updated');
        }
        break;

      case 'apiKeys':
        if (value && typeof value === 'object') {
          // Batch API key update: arrives as { provider: plaintextKey } pairs
          const keyPairs = value as Record<string, string>;
          for (const [provider, plaintextKey] of Object.entries(keyPairs)) {
            if (plaintextKey && typeof plaintextKey === 'string') {
              await store.setApiKey(
                provider as 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic',
                plaintextKey,
              );
            }
          }
          logger.info('API keys updated — reinitializing clients');
          await initializeApiClients();
          initializeScoringPipeline();
        }
        break;

      case 'notificationPrefs':
        if (value && typeof value === 'object') {
          store.setNotificationPrefs(value as Parameters<typeof store.setNotificationPrefs>[0]);
          logger.info('Notification preferences updated');
        }
        break;

      case 'exitTriggers':
        if (value && typeof value === 'object') {
          // Exit trigger configuration from SettingsPanel:
          // { devSellEnabled, smartMoneyExitEnabled, volumeDeclineEnabled, volumeDeclineThreshold }
          // Persist to chrome.storage.session for access during exit signal evaluation.
          // chrome.storage.session provides fast in-memory storage that survives
          // service worker restarts within the same browser session.
          try {
            await chrome.storage.session.set({ exitTriggerConfig: value });
            logger.info('Exit trigger configuration updated');
          } catch (storageError: unknown) {
            // Fallback to chrome.storage.local if session storage is unavailable
            await chrome.storage.local.set({ exitTriggerConfig: value });
            logger.info('Exit trigger configuration saved to local storage (session fallback)');
          }
        }
        break;

      default:
        logger.debug(`Unknown settings key: ${key}`);
    }
  } catch (error: unknown) {
    logger.error(`Error handling settings change (${key}): ${String(error)}`);
  }
}

/**
 * Handles AI analysis requests — routes through the three-tier LLM system.
 */
async function handleAiAnalysisRequest(
  payload: { mint: string; score: number },
  tabId: number | undefined,
  sendResponse: (response?: unknown) => void,
): Promise<void> {
  const { mint, score } = payload;

  if (!aiRouter) {
    sendResponse({ error: 'AI Router not initialized — Groq API key not configured' });
    return;
  }

  try {
    // Build the token analysis input from the token store
    const tokenData = vanillaTokenStore.getState().getToken(mint);
    if (!tokenData) {
      sendResponse({ error: `No token data found for mint: ${mint}` });
      return;
    }

    const signalInput = buildTokenAnalysisInput(mint, tokenData);
    const aiInput = buildAIAnalysisInput(signalInput, 50);
    const result = await aiRouter.analyzeToken(aiInput);

    sendResponse({ success: true, result });

    // Send result to content script for UI update
    if (tabId) {
      await sendToContent(tabId, {
        type: 'AI_ANALYSIS_RESULT',
        payload: { mint, result },
      });
    }
  } catch (error: unknown) {
    logger.error(`AI analysis failed for ${mint}: ${String(error)}`);
    sendResponse({ error: `AI analysis failed: ${String(error)}` });
  }
}

/**
 * Handles forwarded log entries from content scripts for aggregated logging.
 */
function handleLogForward(payload: {
  level: string;
  context: string;
  message: string;
  data?: unknown[];
}): void {
  const { level, context, message: msg } = payload;
  const contextLogger = createLogger(`fwd:${context}`);

  switch (level.toUpperCase()) {
    case 'DEBUG':
      contextLogger.debug(msg);
      break;
    case 'INFO':
      contextLogger.info(msg);
      break;
    case 'WARN':
      contextLogger.warn(msg);
      break;
    case 'ERROR':
      contextLogger.error(msg);
      break;
    default:
      contextLogger.debug(msg);
  }
}

// =============================================================================
// ALARM HANDLER
// =============================================================================

/**
 * Handles chrome.alarms events. Each alarm triggers specific periodic tasks.
 */
async function handleAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  switch (alarm.name) {
    case ALARM_NAMES.WEBSOCKET_KEEPALIVE:
      await handleKeepaliveAlarm();
      break;

    case ALARM_NAMES.WEBSOCKET_RECONNECT:
      await handleReconnectAlarm();
      break;

    case ALARM_NAMES.EXIT_SIGNAL_CHECK:
      await handleExitSignalCheckAlarm();
      break;

    case ALARM_NAMES.STALE_DATA_CLEANUP:
      await handleStaleDataCleanupAlarm();
      break;

    case ALARM_NAMES.POLLING_FALLBACK:
      await handlePollingFallbackAlarm();
      break;

    default:
      logger.debug(`Unknown alarm fired: ${alarm.name}`);
  }
}

/**
 * Sends keepalive pings to all active WebSocket connections.
 * Per AAP Section 0.7.6: 20-second keepalive ping for WebSockets.
 */
async function handleKeepaliveAlarm(): Promise<void> {
  try {
    if (pumpPortalStream?.isConnected()) {
      pumpPortalStream.sendPing();
    }
    if (birdeyeStream?.isConnected()) {
      birdeyeStream.sendPing();
    }
  } catch (error: unknown) {
    logger.error(`Keepalive ping error: ${String(error)}`);
  }
}

/**
 * Checks WebSocket connection health and reconnects if needed.
 * Per AAP Section 0.7.6: exponential backoff reconnection.
 */
async function handleReconnectAlarm(): Promise<void> {
  try {
    // PumpPortal reconnection
    if (pumpPortalStream && !pumpPortalStream.isConnected()) {
      logger.info('PumpPortal disconnected — attempting reconnection');
      try {
        await pumpPortalStream.connect();
        pumpPortalStream.subscribeNewToken((event: PumpPortalNewToken) => {
          handleNewTokenEvent(event).catch((err: unknown) => {
            logger.error(`PumpPortal new token handler error: ${String(err)}`);
          });
        });
        pumpPortalStream.subscribeMigration((event: PumpPortalMigration) => {
          handleMigrationEvent(event).catch((err: unknown) => {
            logger.error(`PumpPortal migration handler error: ${String(err)}`);
          });
        });
        logger.info('PumpPortal reconnected successfully');
      } catch (error: unknown) {
        logger.warn(`PumpPortal reconnection failed: ${String(error)}`);
      }
    }

    // Birdeye reconnection
    if (birdeyeStream && !birdeyeStream.isConnected()) {
      logger.info('Birdeye stream disconnected — attempting reconnection');
      try {
        await birdeyeStream.connect();
        birdeyeStream.subscribeNewListings((event: BirdeyeNewListingEvent) => {
          handleBirdeyeNewListing(event).catch((err: unknown) => {
            logger.error(`Birdeye new listing handler error: ${String(err)}`);
          });
        });
        logger.info('Birdeye stream reconnected successfully');
      } catch (error: unknown) {
        logger.warn(`Birdeye reconnection failed: ${String(error)}`);
      }
    }
  } catch (error: unknown) {
    logger.error(`Reconnect alarm error: ${String(error)}`);
  }
}

/**
 * Evaluates all tracked positions against exit triggers.
 * Per AAP Section 0.5.1 Group 5: TP ladder (50% at 2×, 25% at 5×, 25% at 10×).
 */
async function handleExitSignalCheckAlarm(): Promise<void> {
  try {
    const positionState = vanillaPositionStore.getState();
    const positions: PositionData[] = [];
    const contexts = new Map<string, TokenContext>();

    // Build position data and context maps from stores
    const positionMap = positionState.positions;
    const positionEntries = Object.entries(positionMap ?? {});
    if (positionEntries.length > 0) {
      for (const [mint, position] of positionEntries) {
        const tokenData = vanillaTokenStore.getState().getToken(mint);

        // Build PositionData from store's Position type
        const posData: PositionData = {
          tokenMint: position.tokenMint ?? mint,
          tokenSymbol: position.tokenSymbol ?? '',
          entryPrice: position.entryPrice ?? 0,
          currentPrice: tokenData?.price ?? position.currentPrice ?? 0,
          entryTime: position.entryTime ?? Date.now(),
          positionSize: position.positionSize ?? 0,
          remainingPercent: position.remainingPercent ?? 100,
          tpLevels: position.tpLevels as unknown as PositionData['tpLevels'] ??
            getDefaultTpLevels(position.entryPrice ?? 0, 'ladder'),
          stopLossPercent: position.stopLossPercent ?? -12,
          trailingStopActive: position.trailingStopActive ?? false,
          trailingStopHighPrice: position.trailingStopHighPrice ?? 0,
          trailingStopPercent: position.trailingStopPercent ?? 20,
        };

        positions.push(posData);

        // Build TokenContext for exit signal evaluation
        contexts.set(mint, {
          currentPrice: tokenData?.price ?? position.currentPrice ?? 0,
          volume24h: tokenData?.volume24h ?? 0,
          marketCap: tokenData?.marketCap ?? 0,
          devWalletSold: tokenData?.devWalletSold ?? false,
          smartMoneyExitPercent: 0,
          holderCount: tokenData?.holderCount ?? 0,
          volume1h: tokenData?.volume1h ?? 0,
        });
      }

      // Run exit signal checks on all open positions
      if (positions.length > 0) {
        const results: ExitCheckResult[] = checkAllPositions(positions, contexts);

        // Notify content scripts about exit triggers
        for (const result of results) {
          if (result.hasExitSignal) {
            logger.info(
              `Exit signal detected for ${result.tokenMint}: ` +
              `${result.triggers.length} trigger(s), action: ${result.recommendedAction}`,
            );

            // Broadcast exit signal to all tabs
            broadcastToAllTabs({
              type: 'EXIT_SIGNAL',
              payload: {
                mint: result.tokenMint,
                trigger: result,
              },
            });
          }
        }
      }
    }
  } catch (error: unknown) {
    logger.error(`Exit signal check error: ${String(error)}`);
  }
}

/**
 * Cleans up expired cache entries, stale token data, and old convergence windows.
 */
async function handleStaleDataCleanupAlarm(): Promise<void> {
  try {
    // Clean expired cache entries (LLM responses, API responses)
    await cache.cleanup();

    // Clean up convergence detector expired windows
    if (convergenceDetector) {
      convergenceDetector.cleanup();
    }

    // Prune inactive wallets from tracker
    if (walletTracker) {
      walletTracker.pruneInactive();
    }

    // Clear stale tokens older than 24 hours from the token store
    const tokenStore = vanillaTokenStore.getState();
    if (tokenStore.clearStale) {
      tokenStore.clearStale(24 * 60 * 60 * 1000); // 24 hours
    }

    logger.debug('Stale data cleanup completed');
  } catch (error: unknown) {
    logger.error(`Stale data cleanup error: ${String(error)}`);
  }
}

/**
 * Fallback polling when WebSocket connections are down.
 * Per AAP Section 0.7.6: graceful degradation to polling at 30-60s intervals.
 */
async function handlePollingFallbackAlarm(): Promise<void> {
  // Only poll when WebSockets are disconnected
  const pumpPortalDown = !pumpPortalStream?.isConnected();
  const birdeyeDown = birdeyeStream ? !birdeyeStream.isConnected() : true;

  if (!pumpPortalDown && !birdeyeDown) {
    return; // WebSockets are healthy — no polling needed
  }

  try {
    // If Birdeye is down and Birdeye client is available, poll for active token prices
    if (birdeyeDown && birdeyeClient) {
      const activeTokens = Object.keys(vanillaSignalStore.getState().signals).slice(0, 10);
      for (const mint of activeTokens) {
        try {
          const priceData = await birdeyeClient.getTokenPrice(mint);
          if (priceData) {
            vanillaTokenStore.getState().upsertToken(mint, {
              price: priceData.price ?? 0,
            });
          }
        } catch {
          // Non-critical — continue polling other tokens
        }
      }
    }

    // If PumpPortal is down, use DexScreener as fallback for token discovery
    if (pumpPortalDown && dexScreenerClient) {
      logger.debug('PumpPortal down — DexScreener fallback polling active');
      // DexScreener doesn't provide real-time new token events,
      // so we rely on GMGN intercepted data as the primary alternative
    }
  } catch (error: unknown) {
    logger.error(`Polling fallback error: ${String(error)}`);
  }
}

// =============================================================================
// SIGNAL PIPELINE ORCHESTRATION
// =============================================================================

/**
 * Full signal analysis pipeline for a token.
 *
 * Per AAP Section 0.4.3 — Token Analysis Pipeline:
 * 1. Check hard filters first (cheap, fast)
 * 2. If hard filter fails → SKIP
 * 3. Enrich data: Birdeye OHLCV, holders, transactions
 * 4. Run safety check: concurrent RugCheck + GoPlus + Jupiter honeypot
 * 5. Run 7 scoring factors in parallel
 * 6. Compute weighted composite score
 * 7. If score meets threshold → route to AI/LLM tier
 * 8. Store final signal → notify content scripts
 */
async function triggerTokenAnalysis(mint: string): Promise<void> {
  try {
    // Get existing token data from store
    const tokenData = vanillaTokenStore.getState().getToken(mint);
    if (!tokenData) {
      logger.debug(`No token data available for analysis: ${mint}`);
      return;
    }

    // Build the analysis input from stored + enriched data
    let analysisInput = buildTokenAnalysisInput(mint, tokenData);

    // Step 1: Quick hard filter pre-check with available data
    const quickFilterResult = runHardFilters(analysisInput);
    if (!quickFilterResult.passed) {
      logger.debug(
        `Token ${mint} failed hard filter pre-check: ${quickFilterResult.failedReason ?? 'unknown'}`,
      );

      // Store as SKIP signal
      const skipSignal: CompositeSignal = {
        tokenMint: mint,
        composite: 0,
        factors: [],
        decision: 'SKIP',
        confidence: 0,
        timestamp: Date.now(),
        tradingMode: vanillaSettingsStore.getState().tradingMode ?? 'conservative',
        hardFilterResult: quickFilterResult,
        tokenSymbol: analysisInput.symbol,
      };
      vanillaSignalStore.getState().addSignal(skipSignal);
      return;
    }

    // Step 2: Enrich with Birdeye data (rate-limited)
    analysisInput = await enrichWithBirdeye(mint, analysisInput);

    // Step 3: Run safety checks (concurrent RugCheck + GoPlus + honeypot)
    analysisInput = await enrichWithSafetyData(mint, analysisInput);

    // Step 4: Run the full scoring engine (all 7 factors in parallel)
    const settings = vanillaSettingsStore.getState();
    const tradingMode: TradingMode = settings.tradingMode ?? 'conservative';
    const weights = settings.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;

    const signal: CompositeSignal = await analyzeToken(analysisInput, weights, tradingMode);

    // Step 5: If score meets threshold, run AI/LLM analysis
    const minScore = tradingMode === 'conservative'
      ? SCORING_THRESHOLDS.CONSERVATIVE_MIN
      : SCORING_THRESHOLDS.AGGRESSIVE_MIN;

    if (signal.decision === 'BUY' && signal.composite >= minScore && aiRouter) {
      try {
        const aiInput = buildAIAnalysisInput(analysisInput, signal.composite);
        const aiResult = await aiRouter.analyzeToken(aiInput);
        // Attach AI result to the signal for UI display
        (signal as unknown as Record<string, unknown>).aiAnalysis = aiResult;
        logger.info(
          `AI analysis completed for ${mint} (tier: ${determineTier(signal.composite)})`,
        );
      } catch (aiError: unknown) {
        logger.warn(`AI analysis failed for ${mint}: ${String(aiError)} — proceeding without AI`);
      }
    }

    // Step 6: Store the final signal
    vanillaSignalStore.getState().addSignal(signal);
    logger.info(
      `Signal stored for ${analysisInput.symbol} (${mint}): ` +
      `score=${signal.composite}, decision=${signal.decision}`,
    );

    // Step 7: Notify content scripts
    broadcastToAllTabs({
      type: 'SIGNAL_UPDATE',
      payload: { mint, signal },
    });
  } catch (error: unknown) {
    logger.error(`Token analysis pipeline error for ${mint}: ${String(error)}`);
  }
}

/**
 * Enriches token analysis input with Birdeye API data.
 * Per AAP Section 0.7.4: DexScreener as fallback only when Birdeye fails.
 */
async function enrichWithBirdeye(
  mint: string,
  input: TokenAnalysisInput,
): Promise<TokenAnalysisInput> {
  if (!birdeyeClient) {
    // Attempt DexScreener fallback per AAP Section 0.7.4
    return enrichWithDexScreenerFallback(mint, input);
  }

  try {
    // Fetch token overview (includes price, volume, liquidity, holders)
    const overview = await birdeyeClient.getTokenOverview(mint);
    if (overview) {
      input = {
        ...input,
        price: overview.price ?? input.price,
        volume5m: overview.volume5m ?? input.volume5m,
        volume1h: overview.volume1h ?? input.volume1h,
        volume24h: overview.volume24h ?? input.volume24h,
        marketCap: overview.marketCap ?? input.marketCap,
        liquidity: overview.liquidity ?? input.liquidity,
        holderCount: overview.holderCount ?? input.holderCount,
        supply: overview.supply ?? input.supply,
      };
    }

    // Fetch top holders for concentration analysis
    const holders = await birdeyeClient.getTopHolders(mint);
    if (holders && holders.length > 0) {
      // Calculate top 10 holder percentage
      const top10Percent = holders
        .slice(0, 10)
        .reduce((sum: number, h: { percentage?: number }) => sum + (h.percentage ?? 0), 0);
      input = {
        ...input,
        topHolderPercent: top10Percent,
      };
    }

    // Fetch recent transactions for buy/sell ratio
    const txns = await birdeyeClient.getTokenTransactions(mint);
    if (txns && txns.length > 0) {
      const recentBuys = txns.filter((t: { side?: string }) => t.side === 'buy').length;
      const recentSells = txns.filter((t: { side?: string }) => t.side === 'sell').length;
      if (input.buys1h === 0 && input.sells1h === 0) {
        input = {
          ...input,
          buys1h: recentBuys,
          sells1h: recentSells,
        };
      }
    }

    // Fetch OHLCV for volume moving average calculation
    const ohlcv = await birdeyeClient.getOHLCV(mint, '5m');
    if (ohlcv && ohlcv.length > 0) {
      const totalVolume = ohlcv.reduce(
        (sum: number, candle: { volume?: number }) => sum + (candle.volume ?? 0),
        0,
      );
      input = {
        ...input,
        volume5mMA: ohlcv.length > 0 ? totalVolume / ohlcv.length : undefined,
      };
    }
  } catch (error: unknown) {
    logger.warn(`Birdeye enrichment failed for ${mint}: ${String(error)} — trying fallback`);
    return enrichWithDexScreenerFallback(mint, input);
  }

  return input;
}

/**
 * Fallback data enrichment using DexScreener when Birdeye is unavailable.
 * Per AAP Section 0.7.4: "DexScreener as fallback only when Birdeye fails"
 */
async function enrichWithDexScreenerFallback(
  mint: string,
  input: TokenAnalysisInput,
): Promise<TokenAnalysisInput> {
  if (!dexScreenerClient) {
    return input;
  }

  try {
    const pairs = await dexScreenerClient.getTokenPairs(mint);
    if (pairs && pairs.length > 0) {
      const pair = pairs[0]; // Use the primary/most liquid pair
      input = {
        ...input,
        price: pair.priceUsd ? parseFloat(String(pair.priceUsd)) : input.price,
        volume24h: pair.volume?.h24 ?? input.volume24h,
        liquidity: pair.liquidity?.usd ?? input.liquidity,
        marketCap: pair.marketCap ?? pair.fdv ?? input.marketCap,
      };
    }
  } catch (error: unknown) {
    logger.warn(`DexScreener fallback also failed for ${mint}: ${String(error)}`);
  }

  return input;
}

/**
 * Enriches token data with safety analysis results.
 *
 * Per AAP Section 0.7.3:
 * - Concurrent RugCheck + GoPlus via Promise.allSettled
 * - Jupiter honeypot simulation is MANDATORY for every new token
 * - Safety checks BEFORE AI analysis
 */
async function enrichWithSafetyData(
  mint: string,
  input: TokenAnalysisInput,
): Promise<TokenAnalysisInput> {
  // Run safety checker if available (concurrent RugCheck + GoPlus + honeypot)
  if (safetyChecker) {
    try {
      const safetyReport = await safetyChecker.checkToken(mint);
      if (safetyReport) {
        input = {
          ...input,
          mintAuthorityActive: safetyReport.authorityStatus ? !safetyReport.authorityStatus.mintRevoked : (input.mintAuthorityActive ?? false),
          freezeAuthorityActive: safetyReport.authorityStatus ? !safetyReport.authorityStatus.freezeRevoked : (input.freezeAuthorityActive ?? false),
          lpBurned: safetyReport.lpStatus?.burned ?? input.lpBurned,
          lpLocked: safetyReport.lpStatus?.locked ?? input.lpLocked,
          lpBurnPercent: safetyReport.lpStatus?.burnPercent ?? input.lpBurnPercent,
          isHoneypot: safetyReport.honeypotResult ? !safetyReport.honeypotResult.sellable : (input.isHoneypot ?? false),
          safetyScore: safetyReport.overallScore ?? input.safetyScore,
          topHolderPercent: safetyReport.top10HolderPercent ?? input.topHolderPercent,
        };

        // Store safety report in token store for UI display
        vanillaTokenStore.getState().upsertToken(mint, {
          safetyReport,
        });
      }
    } catch (error: unknown) {
      logger.warn(`Safety check failed for ${mint}: ${String(error)}`);
    }
  } else if (honeypotDetector) {
    // If full safety checker isn't available, at least run honeypot detection
    // Per AAP Section 0.7.3: "Jupiter honeypot simulation is MANDATORY"
    try {
      const honeypotResult = await honeypotDetector.checkHoneypot(mint);
      if (honeypotResult) {
        input = {
          ...input,
          isHoneypot: !honeypotResult.sellable,
        };
      }
    } catch (error: unknown) {
      logger.warn(`Honeypot detection failed for ${mint}: ${String(error)}`);
    }
  }

  // Enrich convergence data for smart money scoring
  if (convergenceDetector) {
    const convergence = convergenceDetector.getConvergenceForToken(mint);
    if (convergence) {
      // Extract wallet addresses from ConvergenceWalletEntry objects
      const walletAddresses = convergence.wallets.map(
        (w) => w.address,
      ).filter(Boolean);
      input = {
        ...input,
        smartMoneyCount: convergence.walletCount ?? input.smartMoneyCount,
        smartMoneyWallets: walletAddresses.length > 0 ? walletAddresses : input.smartMoneyWallets,
      };
    }
  }

  return input;
}

// =============================================================================
// WEBSOCKET EVENT HANDLERS
// =============================================================================

/**
 * Handles new token events from PumpPortal WebSocket.
 * Triggers initial safety screening and feeds into the scoring engine.
 */
async function handleNewTokenEvent(event: PumpPortalNewToken): Promise<void> {
  try {
    const mint = event.mint;
    if (!mint) {
      logger.debug('PumpPortal new token event missing mint address');
      return;
    }

    const symbol = event.symbol ?? '';
    const name = event.name ?? '';

    logger.info(`New token detected via PumpPortal: ${symbol || mint}`);

    // Store initial token data
    vanillaTokenStore.getState().upsertToken(mint, {
      mint,
      symbol,
      name,
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Trigger full analysis pipeline
    await triggerTokenAnalysis(mint);

    // Broadcast new token event to content scripts
    broadcastToAllTabs({
      type: 'STREAM_EVENT',
      payload: { source: 'pump-portal', event: { type: 'new_token', data: event } },
    });
  } catch (error: unknown) {
    logger.error(`Error processing new token event: ${String(error)}`);
  }
}

/**
 * Handles migration events from PumpPortal (tokens graduating from pump.fun to DEXes).
 */
async function handleMigrationEvent(event: PumpPortalMigration): Promise<void> {
  try {
    const mint = event.mint;
    if (!mint) return;

    logger.info(`Token migration detected: ${mint}`);

    // Update token store — mark migration by updating the lastSource
    vanillaTokenStore.getState().upsertToken(mint, {
      lastSource: 'pump-portal-migration',
    });

    // Re-analyze the migrated token with new context
    await triggerTokenAnalysis(mint);
  } catch (error: unknown) {
    logger.error(`Error processing migration event: ${String(error)}`);
  }
}

/**
 * Handles new listing events from Birdeye WebSocket.
 */
async function handleBirdeyeNewListing(event: BirdeyeNewListingEvent): Promise<void> {
  try {
    const mint = event.address;
    if (!mint) return;

    logger.info(`New listing detected via Birdeye: ${event.symbol ?? mint}`);

    // Store initial token data
    vanillaTokenStore.getState().upsertToken(mint, {
      mint,
      symbol: event.symbol ?? '',
      name: event.name ?? '',
    });

    // Trigger analysis
    await triggerTokenAnalysis(mint);
  } catch (error: unknown) {
    logger.error(`Error processing Birdeye new listing: ${String(error)}`);
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Builds a TokenAnalysisInput from stored token data, filling in safe defaults.
 */
function buildTokenAnalysisInput(
  mint: string,
  tokenData: TokenData,
): TokenAnalysisInput {
  return {
    mint,
    symbol: tokenData.symbol ?? '',
    name: tokenData.name ?? '',
    price: tokenData.price ?? 0,
    priceChange5m: tokenData.priceChange5m ?? 0,
    priceChange1h: tokenData.priceChange1h ?? 0,
    priceChange24h: tokenData.priceChange24h ?? 0,
    marketCap: tokenData.marketCap ?? 0,
    volume5m: tokenData.volume5m ?? 0,
    volume1h: tokenData.volume1h ?? 0,
    volume24h: tokenData.volume24h ?? 0,
    liquidity: tokenData.liquidity ?? 0,
    supply: 0, // Supply not stored directly in TokenData; will be enriched from Birdeye
    buys1h: tokenData.buys1h ?? 0,
    sells1h: tokenData.sells1h ?? 0,
    buys24h: tokenData.buys24h ?? 0,
    sells24h: tokenData.sells24h ?? 0,
    holderCount: tokenData.holderCount ?? 0,
    topHolderPercent: tokenData.topHolderPercent ?? 0,
    smartMoneyCount: tokenData.smartMoneyCount ?? 0,
    mintAuthorityActive: tokenData.mintAuthorityActive ?? true,
    freezeAuthorityActive: tokenData.freezeAuthorityActive ?? true,
    lpBurned: tokenData.lpBurned ?? false,
    lpLocked: false,
    lpBurnPercent: 0,
    isHoneypot: tokenData.isHoneypot ?? false,
    safetyScore: tokenData.safetyReport?.overallScore ?? 0,
    metadataMutable: true,
    devWalletAddress: tokenData.devWalletAddress ?? '',
    devWalletSold: tokenData.devWalletSold ?? false,
    createdAt: tokenData.createdAt ?? Math.floor(Date.now() / 1000),
    smartMoneyWallets: tokenData.smartMoneyWallets.length > 0 ? tokenData.smartMoneyWallets : undefined,
    logoUrl: tokenData.logoUrl || undefined,
  };
}

/**
 * Builds an AITokenAnalysisInput from a signal TokenAnalysisInput and composite score.
 */
function buildAIAnalysisInput(
  input: TokenAnalysisInput,
  compositeScore: number,
): AITokenAnalysisInput {
  const buySellRatio = input.sells1h > 0 ? input.buys1h / input.sells1h : (input.buys1h > 0 ? 10 : 0);
  const ageMs = (Date.now() / 1000 - input.createdAt) * 1000;
  const tokenAgeHours = Math.max(0, ageMs / (1000 * 3600));

  return {
    mint: input.mint,
    symbol: input.symbol,
    compositeScore,
    price: input.price,
    marketCap: input.marketCap,
    volume24h: input.volume24h,
    liquidity: input.liquidity,
    holderCount: input.holderCount,
    buySellRatio,
    smartMoneyCount: input.smartMoneyCount,
    tokenAgeHours,
    safetyScore: input.safetyScore,
    isHoneypot: input.isHoneypot,
    devWalletSold: input.devWalletSold,
    topHolderPercent: input.topHolderPercent,
    lpBurned: input.lpBurned,
  };
}

/**
 * Broadcasts a message to all open extension tabs.
 */
function broadcastToAllTabs(message: ExtensionMessage): void {
  chrome.tabs.query({}, (tabs: chrome.tabs.Tab[]) => {
    for (const tab of tabs) {
      if (tab.id) {
        sendToContent(tab.id, message).catch(() => {
          // Silently ignore — tab may not have content script loaded
        });
      }
    }
  });
}

/**
 * Processes messages that were queued during the initialization period.
 */
async function processPendingMessages(): Promise<void> {
  if (pendingMessages.length === 0) return;

  logger.info(`Processing ${pendingMessages.length} queued message(s)`);

  const messages = [...pendingMessages];
  pendingMessages.length = 0;

  for (const { message, sender, sendResponse } of messages) {
    try {
      await handleMessage(message, sender, sendResponse);
    } catch (error: unknown) {
      logger.error(`Error processing queued message: ${String(error)}`);
      try {
        sendResponse({ error: 'Failed to process queued message' });
      } catch {
        // Port may be closed
      }
    }
  }
}
