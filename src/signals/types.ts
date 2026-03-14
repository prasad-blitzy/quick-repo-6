/**
 * @fileoverview Core Signal Engine Type Definitions
 *
 * Foundational type definitions for the GMGN Signal Bot's signal scoring engine.
 * This file contains ZERO imports and ZERO runtime code — only TypeScript interfaces
 * and type aliases used across the entire signals module, stores, AI router, and UI components.
 *
 * Consumers:
 * - src/signals/scoring-engine.ts — TokenAnalysisInput, CompositeSignal, FactorResult, ScoringWeights, TradingMode, HardFilterResult
 * - src/signals/hard-filters.ts — TokenAnalysisInput, HardFilterResult
 * - src/signals/exit-signals.ts — ExitTrigger, ExitCheckResult, ExitReason
 * - src/signals/factors/*.ts — All 7 factor modules use TokenAnalysisInput, FactorResult
 * - src/store/signal-store.ts — CompositeSignal
 * - src/store/position-store.ts — ExitTrigger, ExitCheckResult, ExitReason
 * - src/store/settings-store.ts — ScoringWeights, TradingMode
 * - src/ai/router.ts — TokenAnalysisInput
 * - src/utils/messaging.ts — Signal types in message payloads
 * - src/components/TokenCard.tsx, SignalPanel.tsx, ScoreGauge.tsx — CompositeSignal display
 */

// =============================================================================
// Factor Names
// =============================================================================

/**
 * All 7 scoring factor names used in the signal scoring engine.
 * These correspond 1:1 to the keys in {@link ScoringWeights} and to
 * the factor module filenames in `src/signals/factors/`.
 */
export type FactorName =
  | 'volumeSpike'
  | 'smartMoneyConvergence'
  | 'buySellRatio'
  | 'holderGrowth'
  | 'liquidity'
  | 'tokenAge'
  | 'safetyScore';

// =============================================================================
// Factor Result
// =============================================================================

/**
 * Output from a single factor scoring module.
 *
 * Each of the 7 factor modules (volume spike, smart money convergence, buy/sell ratio,
 * holder growth, liquidity, token age, safety score) returns a FactorResult after
 * evaluating a token against its specific criteria.
 */
export interface FactorResult {
  /**
   * Factor name identifier matching one of the {@link FactorName} values.
   * Examples: `'volumeSpike'`, `'smartMoneyConvergence'`, `'safetyScore'`
   */
  name: string;

  /**
   * Score from 0 to 100 representing how well the token performs on this factor.
   * - 0 = worst possible score (fails all criteria for this factor)
   * - 100 = best possible score (exceeds all criteria for this factor)
   * - Integer values only (rounded by factor modules)
   */
  score: number;

  /**
   * Weight assigned to this factor for composite score calculation.
   * - Range: 0 to 1 (inclusive)
   * - All factor weights should sum to approximately 1.0
   * - Sourced from user-configurable {@link ScoringWeights} or default constants
   */
  weight: number;

  /**
   * Optional metadata with factor-specific details for UI display and debugging.
   * Each factor module populates this with its own relevant data, for example:
   * - Volume spike: `{ spikeMultiplier: 5.2, volumeToMcRatio: 0.45 }`
   * - Smart money: `{ walletCount: 4, convictionScore: 0.82 }`
   * - Safety: `{ riskFactors: ['mintActive'], rugCheckScore: 450 }`
   */
  metadata: Record<string, unknown>;
}

// =============================================================================
// Trading Mode
// =============================================================================

/**
 * Trading mode determines the composite score threshold for BUY signal generation.
 *
 * - `'conservative'`: Requires composite score ≥80 for BUY signal.
 *   Suitable for lower-risk traders who want higher-confidence entries.
 *
 * - `'aggressive'`: Requires composite score ≥45 for BUY signal.
 *   Suitable for traders willing to accept higher risk for earlier entries.
 */
export type TradingMode = 'conservative' | 'aggressive';

// =============================================================================
// Scoring Weights
// =============================================================================

/**
 * Configurable weights for the 7 scoring factors in the signal engine.
 *
 * All values should be in the range [0, 1] and should sum to approximately 1.0.
 * The scoring engine normalizes weights if they do not sum exactly to 1.0.
 *
 * Per AAP Section 0.7.3: "All 7 factor weights must be user-configurable
 * via the settings panel; the scoring engine reads weights from the Zustand
 * settings-store at analysis time, not from hardcoded constants."
 */
export interface ScoringWeights {
  /** Weight for volume spike detection factor (default: ~0.20) */
  volumeSpike: number;

  /** Weight for smart money convergence factor (default: ~0.20) */
  smartMoneyConvergence: number;

  /** Weight for buy/sell ratio analysis factor (default: ~0.15) */
  buySellRatio: number;

  /** Weight for holder growth tracking factor (default: ~0.10) */
  holderGrowth: number;

  /** Weight for liquidity validation factor (default: ~0.15) */
  liquidity: number;

  /** Weight for token age filter factor (default: ~0.10) */
  tokenAge: number;

  /** Weight for safety score integration factor (default: ~0.10) */
  safetyScore: number;
}

// =============================================================================
// Token Analysis Input
// =============================================================================

/**
 * Comprehensive token data input for signal analysis.
 *
 * Combines data from multiple sources:
 * - GMGN.ai intercepted API responses (primary)
 * - Birdeye REST/WebSocket enrichment (OHLCV, holders, transactions)
 * - PumpPortal WebSocket events (new token detection)
 * - RugCheck + GoPlus safety analysis (pre-populated before scoring)
 * - Jupiter honeypot simulation (pre-populated before scoring)
 *
 * This interface is consumed by:
 * - All 7 factor scoring modules
 * - Hard filter safety gates
 * - AI/LLM analysis router
 * - Scoring engine orchestrator
 */
export interface TokenAnalysisInput {
  // === Identity ===

  /** Token mint address (Solana base58 public key, e.g., 'So11111111111111111111111111111111111111112') */
  mint: string;

  /** Token ticker symbol (e.g., 'BONK', 'WIF', 'POPCAT') */
  symbol: string;

  /** Full token name (e.g., 'Bonk', 'dogwifhat') */
  name: string;

  // === Price Data ===

  /** Current token price in USD */
  price: number;

  /** 5-minute price change as a percentage (e.g., 15.5 means +15.5%) */
  priceChange5m: number;

  /** 1-hour price change as a percentage (e.g., -3.2 means -3.2%) */
  priceChange1h: number;

  /** 24-hour price change as a percentage */
  priceChange24h: number;

  // === Market Data ===

  /** Market capitalization in USD */
  marketCap: number;

  /**
   * 5-minute trading volume in USD.
   * Used by volume-spike.ts for spike detection against the 5m moving average.
   * Minimum threshold: $200 for valid signal.
   */
  volume5m: number;

  /**
   * 1-hour trading volume in USD.
   * Minimum threshold: $2,000 for valid volume spike signal.
   */
  volume1h: number;

  /** 24-hour trading volume in USD */
  volume24h: number;

  /**
   * Total liquidity in USD across all DEX pools.
   * Used by liquidity.ts factor and hard-filters.ts ($3K minimum).
   */
  liquidity: number;

  /** Token total supply (raw token units) */
  supply: number;

  // === Trading Activity ===

  /**
   * Number of buy transactions in the last 1 hour.
   * Used by buy-sell-ratio.ts factor module.
   */
  buys1h: number;

  /**
   * Number of sell transactions in the last 1 hour.
   * Used by buy-sell-ratio.ts factor module.
   */
  sells1h: number;

  /**
   * Number of buy transactions in the last 24 hours.
   * Used for extended buy/sell ratio analysis.
   */
  buys24h: number;

  /**
   * Number of sell transactions in the last 24 hours.
   * Used for extended buy/sell ratio analysis.
   */
  sells24h: number;

  // === Holder Data ===

  /**
   * Number of unique token holders.
   * Used by holder-growth.ts factor module for organic growth analysis.
   */
  holderCount: number;

  /**
   * Percentage of total supply held by the top 10 holders (0-100).
   * Used by safety-score.ts (>20% penalized) and hard-filters.ts (>50% = fail).
   */
  topHolderPercent: number;

  /**
   * Number of smart money wallets currently holding this token.
   * Used by smart-money-convergence.ts factor module.
   */
  smartMoneyCount: number;

  // === Safety & Authority ===

  /**
   * Whether the token's mint authority is still active.
   * `true` = risky (creator can mint unlimited tokens).
   * Used by safety-score.ts and hard-filters.ts (active = hard fail).
   */
  mintAuthorityActive: boolean;

  /**
   * Whether the token's freeze authority is still active.
   * `true` = risky (creator can freeze any token account).
   * Used by safety-score.ts and hard-filters.ts (active = hard fail).
   */
  freezeAuthorityActive: boolean;

  /**
   * Whether LP (liquidity pool) tokens have been burned.
   * Burned LP prevents the creator from removing liquidity (rug pull prevention).
   * Used by liquidity.ts factor and hard-filters.ts.
   */
  lpBurned: boolean;

  /**
   * Whether LP (liquidity pool) tokens are locked in a time-lock contract.
   * Locked LP provides time-limited rug pull protection.
   * Used by liquidity.ts factor and hard-filters.ts.
   */
  lpLocked: boolean;

  /**
   * LP burn percentage (0-100).
   * Percentage of LP tokens that have been sent to the burn address.
   */
  lpBurnPercent: number;

  /**
   * Whether this token has been identified as a honeypot via Jupiter sell simulation.
   * `true` means the token cannot be sold (trap token).
   * Determined by src/safety/honeypot-detector.ts via Jupiter /quote endpoint.
   */
  isHoneypot: boolean;

  /**
   * RugCheck safety score (0-1000 scale).
   * ≥300 = considered safe by RugCheck standards.
   * Used by safety-score.ts factor module.
   */
  safetyScore: number;

  /**
   * Whether the token's metadata is mutable.
   * `true` = risky (creator can change token name, symbol, logo to impersonate other tokens).
   * Used by safety-score.ts factor module.
   */
  metadataMutable: boolean;

  // === Sniper & Bundle Detection ===

  /**
   * Percentage of total supply acquired by snipers/bundled wallets (0-100).
   * >10% triggers the bundled launch hard filter fail.
   * Optional: may not be available for all tokens.
   */
  sniperSupplyPercent?: number;

  // === Developer Wallet ===

  /**
   * Developer/creator wallet address (Solana base58 public key).
   * Used for dev wallet monitoring in exit signal detection.
   */
  devWalletAddress: string;

  /**
   * Whether the developer/creator has sold their token holdings.
   * `true` indicates a potential rug pull signal — used as a critical exit trigger.
   */
  devWalletSold: boolean;

  // === Token Age ===

  /**
   * Token creation timestamp in Unix seconds (NOT milliseconds).
   * Used by token-age.ts factor module:
   * - ≤3 hours old = early accumulation mode (highest score)
   * - ≤12 hours old = gem scanning mode
   * - >12 hours old = diminished score
   */
  createdAt: number;

  // === Volume Moving Averages (from Birdeye OHLCV enrichment) ===

  /**
   * 5-minute moving average of volume in USD.
   * Used by volume-spike.ts to calculate spike multiplier (current volume / MA).
   * Optional: populated from Birdeye OHLCV data enrichment.
   */
  volume5mMA?: number;

  // === Smart Money Details (from tracking module) ===

  /**
   * List of smart money wallet addresses currently holding this token.
   * Used by smart-money-convergence.ts for detailed convergence and conviction analysis.
   * Optional: populated from the tracking module's convergence detector.
   */
  smartMoneyWallets?: string[];

  // === Logo/Metadata ===

  /**
   * Token logo URL for display in the UI overlay.
   * Optional: may not be available for very new tokens.
   */
  logoUrl?: string;
}

// =============================================================================
// Hard Filter Result
// =============================================================================

/**
 * Result of running all hard filter safety gates against a token.
 *
 * Hard filters are absolute binary pass/fail checks that cannot be overridden
 * by high composite scores. If ANY hard filter fails, the token is immediately
 * classified as SKIP regardless of factor scores.
 *
 * Per AAP Section 0.7.3: "Hard filters are absolute: If any hard filter fails,
 * the token is immediately classified as SKIP regardless of composite score."
 *
 * Hard filter checks include:
 * 1. Bundled launch with >10% sniper supply
 * 2. Active mint authority
 * 3. Active freeze authority
 * 4. No LP lock/burn
 * 5. Liquidity <$3K
 * 6. Top 10 holders >50% of supply
 */
export interface HardFilterResult {
  /**
   * Whether ALL hard filters passed.
   * `true` = safe to proceed with factor scoring.
   * `false` = immediate SKIP decision, no further analysis.
   */
  passed: boolean;

  /**
   * List of hard filter names that failed.
   * Empty array if all filters passed.
   * Example: `['mint-authority-active', 'min-liquidity']`
   */
  failedFilters: string[];

  /**
   * Human-readable reason for failure.
   * `null` if all filters passed.
   * Example: `'Failed 2 hard filter(s): mint-authority-active, min-liquidity'`
   */
  failedReason: string | null;

  /**
   * Unix timestamp in milliseconds when hard filters were checked.
   * Recorded via `Date.now()`.
   */
  checkedAt: number;
}

// =============================================================================
// Exit Reason
// =============================================================================

/**
 * Reason for an exit signal trigger on an active position.
 *
 * Each exit reason corresponds to a specific market condition or event:
 *
 * - `'tp-ladder'`: Take-profit ladder level hit (e.g., price reached 2×, 5×, or 10× entry)
 * - `'stop-loss'`: Stop-loss threshold breached (day-trade: -12%, swing: -18%)
 * - `'trailing-stop'`: Trailing stop triggered (price dropped X% from highest observed)
 * - `'dev-sell'`: Developer/creator wallet sold tokens — potential rug pull signal
 * - `'smart-money-exit'`: Smart money wallets reducing positions by 40-60%
 * - `'volume-decline'`: Volume-to-market-cap ratio fell below 10%
 * - `'manual'`: User-initiated manual exit from the UI
 */
export type ExitReason =
  | 'tp-ladder'
  | 'stop-loss'
  | 'trailing-stop'
  | 'dev-sell'
  | 'smart-money-exit'
  | 'volume-decline'
  | 'manual';

// =============================================================================
// Exit Trigger
// =============================================================================

/**
 * Individual exit trigger event detected for an active position.
 *
 * Multiple exit triggers can fire simultaneously for the same position
 * (e.g., both volume decline and smart money exit may trigger at once).
 * The system uses the highest severity trigger to determine the recommended action.
 */
export interface ExitTrigger {
  /**
   * Type of exit trigger, matching one of the {@link ExitReason} values.
   * Determines the category of the exit signal.
   */
  type: ExitReason;

  /**
   * Human-readable description of why this exit was triggered.
   * Example: `'Price reached 2× entry (2.34×)'`
   * Example: `'Developer wallet has sold tokens — potential rug pull signal'`
   */
  reason: string;

  /**
   * Severity level of this exit trigger.
   * - `'critical'`: Immediate action required (e.g., dev sell, stop-loss hit, 60%+ smart money exit)
   * - `'warning'`: Monitor closely, partial exit recommended (e.g., TP ladder level, volume decline)
   */
  severity: 'critical' | 'warning';

  /**
   * Recommended percentage of remaining position to sell (0-100).
   * - 100 = close entire remaining position (e.g., stop-loss, dev sell)
   * - 50 = sell half of remaining (e.g., first TP ladder level)
   * - 25 = sell quarter of remaining (e.g., later TP ladder levels)
   */
  sellPercent: number;

  /**
   * Take-profit multiplier that was reached (only for `'tp-ladder'` type).
   * Example: `2` means price reached 2× the entry price.
   * `undefined` for non-TP trigger types.
   */
  multiplier?: number;

  /**
   * Unix timestamp in milliseconds when this trigger was detected.
   * Recorded via `Date.now()`.
   */
  timestamp: number;
}

// =============================================================================
// Exit Check Result
// =============================================================================

/**
 * Comprehensive result of checking all exit conditions for a single active position.
 *
 * Produced by the exit signal monitor (`src/signals/exit-signals.ts`) which checks
 * each tracked position against TP/SL ladders, market conditions, and wallet activity.
 * Consumed by the position store and ExitStrategy UI component.
 */
export interface ExitCheckResult {
  /** Token mint address (Solana base58 public key) identifying the position */
  tokenMint: string;

  /**
   * Whether any exit signal was triggered for this position.
   * `true` if at least one {@link ExitTrigger} was detected.
   */
  hasExitSignal: boolean;

  /**
   * List of all active exit triggers detected for this position.
   * May contain multiple triggers if several conditions are met simultaneously.
   * Empty array if no exit signals were detected.
   */
  triggers: ExitTrigger[];

  /**
   * Highest severity level among all detected triggers.
   * - `'critical'`: At least one trigger requires immediate action
   * - `'warning'`: Highest trigger is advisory (partial exit recommended)
   * - `'none'`: No exit signals detected
   */
  highestSeverity: 'critical' | 'warning' | 'none';

  /**
   * Recommended action based on the aggregate analysis of all triggers.
   * - `'CLOSE_ALL'`: Close entire remaining position (critical triggers present)
   * - `'PARTIAL_EXIT'`: Sell a portion of the position (warning triggers only)
   * - `'HOLD'`: No action needed (no triggers detected)
   */
  recommendedAction: 'CLOSE_ALL' | 'PARTIAL_EXIT' | 'HOLD';

  /**
   * Unix timestamp in milliseconds when this exit check was performed.
   * Recorded via `Date.now()`.
   */
  timestamp: number;
}

// =============================================================================
// Composite Signal
// =============================================================================

/**
 * Final output of the signal scoring engine — the most important type in the system.
 *
 * A CompositeSignal represents the complete analysis result for a single token,
 * combining all 7 factor scores, hard filter results, and the trading decision.
 * This is what gets stored in the signal store and displayed in the UI overlay.
 *
 * Produced by: `src/signals/scoring-engine.ts` → `analyzeToken()`
 * Stored in: `src/store/signal-store.ts`
 * Displayed by: `src/components/SignalPanel.tsx`, `TokenCard.tsx`, `ScoreGauge.tsx`
 */
export interface CompositeSignal {
  /** Token mint address (Solana base58 public key) */
  tokenMint: string;

  /**
   * Composite score from 0 to 100, computed as the weighted average of all factor scores.
   * - 0 = lowest possible (all factors scored 0 or hard filter failed)
   * - 100 = highest possible (all factors scored 100)
   * - Always an integer (rounded by the scoring engine)
   *
   * Decision thresholds (per trading mode):
   * - Conservative mode: ≥80 → BUY
   * - Aggressive mode: ≥45 → BUY
   */
  composite: number;

  /**
   * Individual factor results with scores, weights, and metadata.
   * Contains exactly 7 entries (one per factor module) when all factors complete,
   * or fewer if the token was filtered before factor analysis.
   */
  factors: FactorResult[];

  /**
   * Trading decision produced by the scoring engine.
   * - `'BUY'`: Composite score meets or exceeds the trading mode threshold
   * - `'SKIP'`: Score below threshold, hard filter failed, or invalid input
   * - `'EXIT'`: Position exit signal (used when re-scoring active positions)
   */
  decision: 'BUY' | 'SKIP' | 'EXIT';

  /**
   * Confidence level from 0 to 1 based on data completeness and factor consistency.
   * - 0 = no confidence (all data missing or all factors failed)
   * - 1 = full confidence (all factors completed with consistent scores)
   *
   * Calculated as a blend of:
   * - Factor completion rate (how many of 7 factors successfully returned results)
   * - Score consistency (low variance among factor scores)
   */
  confidence: number;

  /**
   * Unix timestamp in milliseconds when this signal was generated.
   * Recorded via `Date.now()`.
   */
  timestamp: number;

  /**
   * Which trading mode was active when this signal was generated.
   * Records the mode to allow retrospective analysis of signal quality per mode.
   */
  tradingMode: TradingMode;

  /**
   * Result of hard filter checks applied before factor scoring.
   * Contains pass/fail status and details of any failed filters.
   */
  hardFilterResult: HardFilterResult;

  /**
   * Optional token symbol for display purposes in UI components.
   * Example: `'BONK'`, `'WIF'`
   */
  tokenSymbol?: string;

  /**
   * Whether AI/LLM analysis has been appended to this signal.
   * `true` indicates the signal was enriched by the three-tier LLM router
   * after passing initial scoring thresholds.
   * `undefined` or `false` means no AI analysis was performed.
   */
  aiAnalysisAttached?: boolean;
}
