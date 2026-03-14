/**
 * src/utils/config.ts — Application Constants and Configuration
 *
 * The foundational configuration module for the GMGN Signal Bot Chrome Extension.
 * Imported by virtually every other module in the codebase:
 *   - src/api/*.ts        — API clients read base URLs and rate limit configs
 *   - src/signals/*.ts    — Scoring engine reads default weights and thresholds
 *   - src/streaming/*.ts  — WebSocket managers read endpoint URLs
 *   - src/ai/router.ts    — LLM router reads tier thresholds and model configs
 *   - src/safety/*.ts     — Safety checkers read filter thresholds
 *   - src/store/*.ts      — Settings store reads default values
 *
 * All values use `as const` assertions for TypeScript literal type inference.
 * No external dependencies — pure TypeScript constants only.
 */

// =============================================================================
// Section 1: API Base URLs
// =============================================================================

/**
 * Centralized registry of all external API base URLs.
 * Each URL is the exact production endpoint as specified in the AAP.
 */
export const API_BASE_URLS = {
  /** Birdeye REST API — token analytics, price, OHLCV, transactions, top holders */
  BIRDEYE: 'https://public-api.birdeye.so',
  /** RugCheck REST API — token safety reports, insider detection, risk scoring */
  RUGCHECK: 'https://api.rugcheck.xyz',
  /** GoPlus Security API — Solana token security: mint/freeze authority, holder distribution */
  GOPLUS: 'https://api.gopluslabs.io',
  /** Jupiter Price API — real-time token price quotes */
  JUPITER_PRICE: 'https://price.jup.ag',
  /** Jupiter Quote API — swap simulation for honeypot detection */
  JUPITER_QUOTE: 'https://quote-api.jup.ag',
  /** Helius RPC API — enhanced Solana transaction parsing, webhooks, token metadata */
  HELIUS: 'https://api.helius.xyz',
  /** DexScreener REST API — fallback token data: price, volume, liquidity, pair info */
  DEXSCREENER: 'https://api.dexscreener.com',
  /** Groq LLM API — AI inference with llama-3.1-8b-instant and llama-3.3-70b-versatile */
  GROQ: 'https://api.groq.com',
  /** Anthropic Claude API — narrative analysis for top 5% highest-confidence signals */
  ANTHROPIC: 'https://api.anthropic.com',
} as const;

/**
 * Individual named constants for direct imports by API client modules.
 * These mirror the values in API_BASE_URLS for convenience.
 */
export const BIRDEYE_BASE: string = API_BASE_URLS.BIRDEYE;
export const RUGCHECK_BASE: string = API_BASE_URLS.RUGCHECK;
export const GOPLUS_BASE: string = API_BASE_URLS.GOPLUS;
export const JUPITER_BASE: string = API_BASE_URLS.JUPITER_PRICE;
export const HELIUS_BASE: string = API_BASE_URLS.HELIUS;
export const DEXSCREENER_BASE: string = API_BASE_URLS.DEXSCREENER;
export const GROQ_BASE: string = API_BASE_URLS.GROQ;

// =============================================================================
// Section 2: WebSocket URLs
// =============================================================================

/**
 * PumpPortal WebSocket endpoint for real-time pump.fun events.
 * Supports subscribeNewToken, subscribeTokenTrade, and subscribeMigration.
 * Single connection with multiplexed subscriptions per PumpPortal guidelines.
 */
export const PUMP_PORTAL_WS: string = 'wss://pumpportal.fun/api/data';

/**
 * Birdeye WebSocket endpoint for real-time price and transaction streams.
 * Requires API key authentication on connection.
 */
export const BIRDEYE_WS: string = 'wss://public-api.birdeye.so';

// =============================================================================
// Section 3: Default Scoring Weights
// =============================================================================

/**
 * Default weights for the 7-factor composite scoring engine.
 * Weights MUST sum to exactly 1.0 (100%).
 *
 * These are defaults — actual runtime weights are user-configurable via the
 * settings store (src/store/settings-store.ts) and the SettingsPanel UI.
 *
 * Weight rationale:
 *   - Volume spike and smart money convergence are the strongest predictive
 *     signals, each weighted at 20%.
 *   - Liquidity and buy/sell ratio are critical execution safety factors at 15% each.
 *   - Holder growth, token age, and safety score provide contextual confirmation at 10% each.
 */
export const DEFAULT_SCORING_WEIGHTS = {
  /** Volume spike detection: 3–8× increase over 5-minute moving average */
  volumeSpike: 0.20,
  /** Smart money convergence: 3+ qualified wallets entering same token in 2h window */
  smartMoneyConvergence: 0.20,
  /** Buy/sell ratio analysis: minimum ≥1.3× for accumulation signal */
  buySellRatio: 0.15,
  /** Holder growth tracking: organic wallet growth retained ≥24h */
  holderGrowth: 0.10,
  /** Liquidity thresholds: $3K–$30K minimum, volume ≥10× position size */
  liquidity: 0.15,
  /** Token age filters: ≤3h early accumulation, ≤12h gem scanning */
  tokenAge: 0.10,
  /** Safety score validation: RugCheck ≥300, top holder ≤20% concentration */
  safetyScore: 0.10,
} as const;

// =============================================================================
// Section 4: Signal Scoring Thresholds
// =============================================================================

/**
 * Composite score thresholds for BUY signal generation.
 * Conservative mode requires a high-confidence score (≥80), while aggressive
 * mode allows moderate signals (≥45) for higher-risk/higher-reward trading.
 */
export const SCORING_THRESHOLDS = {
  /** ≥80 composite score required for conservative trading mode */
  CONSERVATIVE_MIN: 80,
  /** ≥45 composite score required for aggressive trading mode */
  AGGRESSIVE_MIN: 45,
} as const;

// =============================================================================
// Section 5: Rate Limit Configurations
// =============================================================================

/**
 * Per-API token bucket rate limiter configurations.
 * Each entry defines the sustained request rate and burst capacity.
 * Used by src/api/rate-limiter.ts to enforce per-provider throttling.
 *
 * Rate limits are derived from official API documentation and plan tiers:
 *   - Birdeye: Starter plan allows 15 RPS
 *   - Jupiter: Free tier allows 1 RPS
 *   - DexScreener: 300 requests/minute = 5 RPS sustained
 *   - Helius: Developer plan allows 10 RPS
 *   - GMGN Trading: 1 call per 5 seconds = 0.2 RPS
 */
export const RATE_LIMITS = {
  /** Birdeye Starter plan: 15 requests per second */
  BIRDEYE: { requestsPerSecond: 15, burstSize: 15 },
  /** Jupiter free tier: 1 request per second */
  JUPITER: { requestsPerSecond: 1, burstSize: 1 },
  /** DexScreener: 300 req/min ≈ 5 RPS sustained, burst to 10 */
  DEXSCREENER: { requestsPerSecond: 5, burstSize: 10 },
  /** Helius Developer plan: 10 requests per second */
  HELIUS: { requestsPerSecond: 10, burstSize: 10 },
  /** RugCheck: best-effort, no documented strict limit */
  RUGCHECK: { requestsPerSecond: 5, burstSize: 5 },
  /** GoPlus Security: free tier, best-effort rate */
  GOPLUS: { requestsPerSecond: 5, burstSize: 5 },
  /** Groq LLM: per-model RPM limits, conservative default */
  GROQ: { requestsPerSecond: 2, burstSize: 5 },
  /** GMGN Trading API: 1 call per 5 seconds */
  GMGN_TRADING: { requestsPerSecond: 0.2, burstSize: 1 },
} as const;

// =============================================================================
// Section 6: Hard Filter Thresholds
// =============================================================================

/**
 * Binary pass/fail safety gates that override the composite score to SKIP.
 * If ANY hard filter fails, the token is immediately classified as SKIP
 * regardless of how high its composite score may be.
 *
 * These thresholds cannot be overridden by high scores in other factors.
 */
export const HARD_FILTER_THRESHOLDS = {
  /** Bundled launch with >10% sniper supply = automatic SKIP */
  MAX_SNIPER_SUPPLY_PERCENT: 10,
  /** Liquidity below $3,000 USD = automatic SKIP */
  MIN_LIQUIDITY_USD: 3_000,
  /** Top 10 holders controlling >50% of supply = automatic SKIP */
  MAX_TOP_10_HOLDER_PERCENT: 50,
  /** RugCheck safety score minimum threshold */
  MIN_SAFETY_SCORE: 300,
  /** Single holder concentration above 20% = penalized in scoring */
  MAX_TOP_HOLDER_CONCENTRATION: 20,
} as const;

// =============================================================================
// Section 7: Exit Strategy Defaults
// =============================================================================

/**
 * Default exit strategy configurations for take-profit and stop-loss management.
 * The ladder strategy is the primary exit method:
 *   - Sell 50% at 2× entry price
 *   - Sell 25% at 5× entry price
 *   - Sell 25% at 10× entry price
 *   - Let remainder ride with trailing stop
 *
 * Day-trade and swing-trade profiles provide percentage-based TP/SL levels.
 */
export const DEFAULT_EXIT_STRATEGY = {
  /** Ladder take-profit strategy: staged exits at multiplier targets */
  LADDER: [
    { sellPercent: 50, multiplier: 2 },   // Sell 50% at 2×
    { sellPercent: 25, multiplier: 5 },   // Sell 25% at 5×
    { sellPercent: 25, multiplier: 10 },  // Sell 25% at 10×
  ],
  /** Day-trade profile: tight TP/SL for short-term positions */
  DAY_TRADE: {
    takeProfitLevels: [15, 30, 60] as readonly number[],  // +15%, +30%, +60%
    stopLoss: -12,                                          // -12% stop loss
  },
  /** Swing-trade profile: wider TP/SL for multi-day positions */
  SWING_TRADE: {
    takeProfitLevels: [40, 100, 200, 500] as readonly number[],  // +40%, +100%, +200%, +500%
    stopLoss: -18,                                                  // -18% stop loss
  },
} as const;

// =============================================================================
// Section 8: LLM Configuration
// =============================================================================

/**
 * Three-tier LLM routing configuration for AI-enhanced token analysis.
 * Maintains the 80/15/5 distribution to optimize cost:
 *   - 80% of analyses use fast tier (cheapest: llama-3.1-8b-instant)
 *   - 15% use detailed tier (moderate: llama-3.3-70b-versatile)
 *   - 5% use premium tier (expensive: Claude Sonnet for narrative analysis)
 *
 * Routing is based on initial composite score thresholds.
 * All LLM responses are cached with a 5-minute TTL to reduce redundant calls.
 */
export const LLM_CONFIG = {
  /** Model tier definitions with target usage percentage */
  TIERS: {
    /** Fast screening: 80% of all analyses. Quick pass/fail for low-score tokens. */
    FAST: { model: 'llama-3.1-8b-instant', percentage: 80 },
    /** Detailed analysis: 15% of analyses. Comprehensive evaluation for mid-score tokens. */
    DETAILED: { model: 'llama-3.3-70b-versatile', percentage: 15 },
    /** Premium narrative: 5% of analyses. Full narrative analysis for highest-confidence signals. */
    PREMIUM: { model: 'claude-sonnet', percentage: 5 },
  },
  /** Cache TTL for LLM responses: 5 minutes (300,000 ms) */
  CACHE_TTL_MS: 5 * 60 * 1000,
  /** Composite scores below this threshold use the FAST tier */
  FAST_THRESHOLD: 45,
  /** Composite scores between FAST_THRESHOLD and this use DETAILED tier.
   *  Scores above this threshold use PREMIUM tier. */
  DETAILED_THRESHOLD: 80,
} as const;

// =============================================================================
// Section 9: Smart Money & Convergence Config
// =============================================================================

/**
 * Configuration for smart money wallet tracking and convergence detection.
 * A convergence event fires when 3+ qualified smart money wallets enter
 * the same token within a configurable time window (default 2 hours).
 */
export const SMART_MONEY_CONFIG = {
  /** Minimum number of qualified wallets required for convergence signal */
  MIN_CONVERGENCE_WALLETS: 3,
  /** Time window for convergence detection: 2 hours in milliseconds */
  CONVERGENCE_WINDOW_MS: 2 * 60 * 60 * 1000,
  /** Position size above 80% of historical average indicates conviction */
  CONVICTION_THRESHOLD_PERCENT: 80,
} as const;

// =============================================================================
// Section 10: Timing & Keepalive Constants
// =============================================================================

/**
 * Timing constants for WebSocket management, API calls, and Chrome Extension
 * lifecycle management. These values are critical for Manifest V3 compliance
 * where service workers terminate after ~30 seconds of inactivity.
 */
export const TIMING = {
  /** WebSocket keepalive ping interval: 20 seconds.
   *  Prevents Chrome 116+ service worker idle termination and detects dead connections. */
  WEBSOCKET_KEEPALIVE_MS: 20 * 1000,
  /** Chrome alarms minimum interval: 0.5 minutes (30 seconds).
   *  This is the minimum period allowed by chrome.alarms API. */
  ALARM_MIN_INTERVAL_MIN: 0.5,
  /** MutationObserver callback debounce: 250ms.
   *  Prevents excessive processing when GMGN DOM updates rapidly. */
  MUTATION_OBSERVER_DEBOUNCE_MS: 250,
  /** Default timeout for external API requests: 10 seconds. */
  API_DEFAULT_TIMEOUT_MS: 10 * 1000,
  /** Base delay for exponential backoff reconnection: 1 second.
   *  Backoff sequence: 1s → 2s → 4s → 8s → 16s */
  RECONNECT_BACKOFF_BASE_MS: 1_000,
  /** Maximum number of reconnection attempts before falling back to polling. */
  RECONNECT_MAX_RETRIES: 5,
} as const;

// =============================================================================
// Section 11: Token Age Filters
// =============================================================================

/**
 * Token age filter thresholds for the scoring engine.
 * Memecoin trading opportunities are time-sensitive — older tokens have
 * diminished upside potential for the strategies targeted by this extension.
 */
export const TOKEN_AGE = {
  /** ≤3 hours: Early accumulation mode — highest scoring potential */
  EARLY_ACCUMULATION_MAX_MS: 3 * 60 * 60 * 1000,
  /** ≤12 hours: Gem scanning mode — moderate scoring potential */
  GEM_SCANNING_MAX_MS: 12 * 60 * 60 * 1000,
  /** Minimum bonding curve progress for pump.fun tokens (30%).
   *  Only 0.4%–1.8% of pump.fun tokens graduate to DEXes;
   *  filtering at ≥30% reduces noise from ultra-early failures. */
  BONDING_CURVE_MIN_PERCENT: 30,
} as const;

// =============================================================================
// Section 12: Liquidity Thresholds
// =============================================================================

/**
 * Liquidity validation thresholds for the scoring engine.
 * Ensures tokens have sufficient liquidity for safe entry and exit.
 */
export const LIQUIDITY = {
  /** Minimum liquidity for early pump.fun tokens: $3,000 USD */
  MIN_PUMP_FUN_USD: 3_000,
  /** Minimum liquidity for established tokens: $30,000 USD */
  MIN_ESTABLISHED_USD: 30_000,
  /** Volume must be at least 10× the intended position size for safe exits */
  VOLUME_POSITION_RATIO: 10,
  /** Minimum 5-minute volume: $200 USD */
  MIN_5M_VOLUME_USD: 200,
  /** Minimum 1-hour volume: $2,000 USD */
  MIN_1H_VOLUME_USD: 2_000,
} as const;

// =============================================================================
// Section 13: Extension Info
// =============================================================================

/**
 * Extension metadata constants.
 * Used by the manifest configuration and UI components.
 */
export const EXTENSION_INFO = {
  /** Current extension version */
  VERSION: '1.0.0',
  /** Extension display name */
  NAME: 'GMGN Signal Bot',
  /** Minimum Chrome version required.
   *  Chrome 116+ is when WebSocket activity began extending service worker lifetime. */
  MIN_CHROME_VERSION: '116',
} as const;

// =============================================================================
// Section 14: UI Configuration
// =============================================================================

/**
 * UI rendering constants for the Shadow DOM sidebar overlay.
 * The extension renders a fixed sidebar panel on the right edge of the
 * GMGN page, completely isolated from GMGN's CSS via Shadow DOM.
 */
export const UI_CONFIG = {
  /** Sidebar panel width in pixels */
  SIDEBAR_WIDTH_PX: 350,
  /** z-index for the Shadow DOM host container.
   *  Maximum 32-bit signed integer ensures the overlay renders above
   *  all GMGN UI elements including modals and dropdowns. */
  Z_INDEX: 2147483647,
  /** DOM element ID for the Shadow DOM host container */
  SHADOW_DOM_HOST_ID: 'gmgn-signal-bot',
} as const;

// =============================================================================
// Section 15: Solana-Specific Constants
// =============================================================================

/**
 * Solana blockchain constants used across the extension.
 */
export const SOLANA = {
  /** Chain identifier for API calls (Birdeye, DexScreener, etc.) */
  CHAIN_ID: 'solana',
  /** Solana token burn address — used for LP burn verification.
   *  If this address holds majority of LP tokens, liquidity is considered burned. */
  LP_BURN_ADDRESS: '1nc1nerator11111111111111111111111111111111',
  /** Native SOL token mint address — used for SOL pair identification */
  SOL_MINT: 'So11111111111111111111111111111111111111112',
} as const;
