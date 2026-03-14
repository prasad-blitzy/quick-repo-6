/**
 * src/safety/honeypot-detector.ts — Jupiter-Based Honeypot Sell Simulation
 *
 * Implements sell-side simulation for Solana SPL tokens to detect honeypot
 * conditions (tokens that can be bought but not sold). Uses Jupiter's
 * `/quote` endpoint directly via `JupiterClient.getQuote()` to simulate a
 * TOKEN → SOL swap, and interprets the result to determine sellability,
 * estimated tax, and price impact.
 *
 * Per AAP Section 0.5.1 Group 6:
 * "Jupiter-based sell simulation; requests a quote for TOKEN → SOL swap
 *  with a small test amount; a valid quote means the token is sellable
 *  (not a honeypot); timeout or error flags the token as potentially
 *  dangerous"
 *
 * Per AAP Section 0.7.3 (CRITICAL RULE):
 * "Jupiter honeypot simulation is mandatory: Every new token must undergo
 *  a sell simulation via Jupiter's `/quote` endpoint before being scored —
 *  tokens that cannot be sold are classified as honeypots and filtered out"
 *
 * Per AAP Section 0.4.3 (Signal Pipeline Integration):
 * "src/signals/factors/safety-score.ts ← src/safety/honeypot-detector.ts:
 *  Validates token sellability via Jupiter quote simulation"
 *
 * Per AAP Section 0.4.6 (External API Integration Map):
 * "Jupiter → src/api/jupiter.ts → honeypot-detector.ts. Trigger: safety
 *  check for every new token. Rate limit: Token bucket 1 RPS (free tier)
 *  via rate-limiter.ts"
 *
 * Consumers:
 * - `src/safety/checker.ts` — calls `checkHoneypot()` as part of the
 *   multi-source safety orchestration pipeline
 * - `src/signals/factors/safety-score.ts` — references honeypot result
 *   when computing the safety factor sub-score
 *
 * @module safety/honeypot-detector
 */

import type { HoneypotResult } from './types';
import { JupiterClient } from '../api/jupiter';
import type { JupiterQuote } from '../api/types';
import { createLogger, type Logger } from '../utils/logger';
import { SOLANA } from '../utils/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default timeout in milliseconds for the honeypot detection simulation.
 * If the Jupiter quote does not return within this window, the token is
 * flagged as potentially dangerous (timedOut = true, sellable = false).
 *
 * 15 seconds gives Jupiter's free-tier endpoint ample time to respond
 * while preventing indefinite hangs that would block the safety pipeline.
 */
const DEFAULT_DETECTION_TIMEOUT_MS = 15_000;

/**
 * Price impact threshold in percent above which a token is considered
 * extremely illiquid or likely a soft-honeypot (technically sellable but
 * practically worthless due to extreme slippage).
 *
 * A 50% price impact effectively means the seller would lose half their
 * value to slippage — functionally equivalent to a honeypot for small
 * positions.
 */
const HIGH_PRICE_IMPACT_THRESHOLD = 50;

/**
 * Tax threshold in percent above which a sell is flagged as having a
 * suspicious tax mechanism. Legitimate tokens typically have 0% sell
 * tax; anything above 10% is highly unusual on Solana.
 */
const HIGH_TAX_THRESHOLD = 10;

/**
 * Default test amount in raw token units (lamports equivalent) used for
 * the sell simulation when calling `JupiterClient.getQuote()`.
 *
 * Set to 1,000,000 (1M smallest units) which is typically a very small
 * amount for most SPL tokens. For a token with 6 decimals: 1,000,000 =
 * 1.0 token. For a token with 9 decimals: 1,000,000 = 0.001 token.
 *
 * Using a small amount avoids distorting the price impact calculation
 * while still testing the fundamental ability to create a sell route.
 */
const DEFAULT_TEST_AMOUNT = 1_000_000;

/**
 * Default number of retry attempts for `simulateSellWithRetry()`.
 * Two attempts give one retry after the initial failure, which handles
 * transient Jupiter API issues without excessive delay at 1 RPS.
 */
const DEFAULT_RETRY_ATTEMPTS = 2;

/**
 * Delay in milliseconds between retry attempts in `simulateSellWithRetry()`.
 * Set to 1,100ms to respect Jupiter's 1 RPS free-tier rate limit while
 * adding a small buffer for safety.
 */
const RETRY_DELAY_MS = 1_100;

/**
 * Alternative test amount for retry attempts — uses 10× the default
 * amount to exercise a different order-of-magnitude in case the initial
 * test amount is below the minimum route threshold on some DEX pools.
 */
const ALTERNATIVE_TEST_AMOUNT = 10_000_000;

// ---------------------------------------------------------------------------
// HoneypotDetector Class
// ---------------------------------------------------------------------------

/**
 * Detects honeypot conditions for Solana SPL tokens by simulating a
 * TOKEN → SOL sell via Jupiter's aggregator quote endpoint.
 *
 * A "honeypot" in the memecoin context is a token where:
 * 1. The buy-side DEX route works normally (token can be purchased).
 * 2. The sell-side DEX route is blocked, has extreme tax, or fails
 *    entirely (token cannot be sold, locking the buyer's funds).
 *
 * Detection methodology:
 * - Request a Jupiter `/quote` for a TOKEN → SOL swap with ExactIn
 *   swap mode and a small test amount.
 * - A valid quote response → token is sellable (not a honeypot).
 * - A "no route found" error → token cannot be sold (honeypot).
 * - A timeout → token is potentially dangerous (network or LP issues).
 * - Extreme price impact (>50%) → soft-honeypot (technically sellable
 *   but practically worthless due to illiquidity).
 *
 * Thread-safety note: This class is stateless and can be shared across
 * concurrent analysis tasks in the service worker.
 *
 * @example
 * ```typescript
 * const jupiterClient = new JupiterClient(rateLimiter);
 * const detector = new HoneypotDetector(jupiterClient);
 *
 * // Single check
 * const result = await detector.checkHoneypot('TokenMintAddress...');
 * if (!result.sellable) {
 *   console.warn('Token is a honeypot:', result.error);
 * }
 *
 * // With retry for transient failures
 * const retryResult = await detector.simulateSellWithRetry('TokenMintAddress...');
 * ```
 */
export class HoneypotDetector {
  /** Jupiter API client used for sell simulation via getQuote() */
  private readonly jupiterClient: JupiterClient;

  /** Structured logger tagged 'honeypot-detector' for filtering in DevTools */
  private readonly logger: Logger;

  /** Timeout in ms for the sell simulation; configurable for testing */
  private readonly timeoutMs: number;

  /**
   * Creates a new HoneypotDetector instance.
   *
   * @param jupiterClient - Pre-configured Jupiter API client with rate
   *   limiting. The client is created in the service worker and shared.
   *   Must expose `getQuote(inputMint, outputMint, amount, swapMode)`.
   * @param timeoutMs - Optional override for the detection timeout.
   *   Defaults to 15,000ms (15 seconds).
   */
  constructor(
    jupiterClient: JupiterClient,
    timeoutMs: number = DEFAULT_DETECTION_TIMEOUT_MS,
  ) {
    this.jupiterClient = jupiterClient;
    this.logger = createLogger('honeypot-detector');
    this.timeoutMs = timeoutMs;

    this.logger.info('HoneypotDetector initialized', { timeoutMs: this.timeoutMs });
  }

  // =========================================================================
  // Public — checkHoneypot()
  // =========================================================================

  /**
   * Performs a honeypot detection simulation for a given SPL token.
   *
   * This is the primary public method — runs a sell simulation by calling
   * `jupiterClient.getQuote(mint, SOL_MINT, amount, 'ExactIn')` and
   * evaluating the result.
   *
   * Execution flow:
   *   1. Call `jupiterClient.getQuote(mint, SOLANA.SOL_MINT, testAmount, 'ExactIn')`
   *      wrapped in a timeout.
   *   2. If a valid quote is returned → token is sellable (NOT a honeypot).
   *   3. If the call fails, times out, or returns an error → token MAY be
   *      a honeypot. Fail-safe: assume the worst.
   *   4. Return a typed `HoneypotResult`.
   *
   * @param mint - Solana mint address of the token to test.
   * @param testAmount - Optional raw token amount for the sell simulation.
   *   Defaults to 1,000,000 (smallest meaningful test size).
   * @returns HoneypotResult with sellability, estimated tax, price impact,
   *   and any error details.
   */
  async checkHoneypot(
    mint: string,
    testAmount: number = DEFAULT_TEST_AMOUNT,
  ): Promise<HoneypotResult> {
    this.logger.debug(`Starting honeypot check for ${mint}`, {
      testAmount,
      timeoutMs: this.timeoutMs,
      outputMint: SOLANA.SOL_MINT,
    });

    try {
      // Wrap the getQuote call in a timeout to prevent indefinite hangs
      const quote = await this.getQuoteWithTimeout(mint, testAmount);

      // Valid quote returned — token is sellable
      return this.evaluateQuote(quote, mint);
    } catch (err: unknown) {
      // Handle timeout specifically
      if (err instanceof Error && err.message === 'HONEYPOT_DETECTION_TIMEOUT') {
        this.logger.warn(
          `Sell simulation timed out for ${mint} — potential honeypot (fail-safe)`,
          { timeoutMs: this.timeoutMs },
        );
        return {
          sellable: false,
          estimatedTax: 100,
          error: `Sell simulation timed out after ${this.timeoutMs}ms`,
          timedOut: true,
        };
      }

      // Handle all other errors — classify and return fail-safe result
      return this.handleCheckError(err, mint);
    }
  }

  // =========================================================================
  // Public — simulateSellWithRetry()
  // =========================================================================

  /**
   * Enhanced sell simulation with retry logic for transient failures.
   *
   * Tries the sell simulation up to `attempts` times. On the first failure,
   * retries with an alternative test amount (10× default) to handle cases
   * where the initial amount is too small for certain DEX pool minimums.
   * Only marks as honeypot if ALL attempts fail.
   *
   * Rate-limit aware: Jupiter free tier is 1 RPS, so retries are spaced
   * with a 1.1-second delay between attempts.
   *
   * @param mint - Solana mint address of the token to test.
   * @param attempts - Maximum number of attempts (default: 2).
   * @returns HoneypotResult — sellable only if at least one attempt succeeds.
   */
  async simulateSellWithRetry(
    mint: string,
    attempts: number = DEFAULT_RETRY_ATTEMPTS,
  ): Promise<HoneypotResult> {
    const effectiveAttempts = Math.max(1, Math.floor(attempts));

    this.logger.info(
      `Starting sell simulation with retry for ${mint}`,
      { maxAttempts: effectiveAttempts },
    );

    let lastResult: HoneypotResult | null = null;

    for (let attempt = 1; attempt <= effectiveAttempts; attempt++) {
      // Use default amount on first attempt, alternative amount on retries
      const testAmount = attempt === 1
        ? DEFAULT_TEST_AMOUNT
        : ALTERNATIVE_TEST_AMOUNT;

      this.logger.debug(
        `Attempt ${attempt}/${effectiveAttempts} for ${mint}`,
        { testAmount },
      );

      const result = await this.checkHoneypot(mint, testAmount);

      // If sellable on any attempt, return immediately — token is NOT a honeypot
      if (result.sellable) {
        this.logger.info(
          `Honeypot check for ${mint}: sellable=true on attempt ${attempt}`,
          { estimatedTax: result.estimatedTax, priceImpactPct: result.priceImpactPct },
        );
        return result;
      }

      lastResult = result;

      // If this was a timeout or rate limit, retry makes sense.
      // If it was a definitive "no route", retry with different amount.
      this.logger.debug(
        `Attempt ${attempt} failed for ${mint}: ${result.error ?? 'unknown error'}`,
      );

      // Space retries to respect Jupiter's 1 RPS rate limit
      if (attempt < effectiveAttempts) {
        await this.delay(RETRY_DELAY_MS);
      }
    }

    // All attempts failed — return the last failure result
    this.logger.warn(
      `All ${effectiveAttempts} sell simulation attempts failed for ${mint} — classifying as honeypot`,
      { lastError: lastResult?.error },
    );

    return lastResult ?? {
      sellable: false,
      estimatedTax: 100,
      error: `All ${effectiveAttempts} sell simulation attempts failed`,
      timedOut: false,
    };
  }

  // =========================================================================
  // Private — getQuoteWithTimeout()
  // =========================================================================

  /**
   * Wraps `JupiterClient.getQuote()` in a timeout race.
   *
   * Calls `getQuote(mint, SOLANA.SOL_MINT, testAmount, 'ExactIn')` — the
   * core sell simulation. If the Jupiter API does not respond within
   * `this.timeoutMs`, the promise rejects with a
   * `HONEYPOT_DETECTION_TIMEOUT` error.
   *
   * @param mint - Solana mint address of the token to simulate selling.
   * @param testAmount - Raw token amount for the sell simulation.
   * @returns Parsed JupiterQuote with route plan, amounts, and price impact.
   * @throws Error with message 'HONEYPOT_DETECTION_TIMEOUT' on timeout.
   * @throws Any error propagated from JupiterClient.getQuote().
   */
  private async getQuoteWithTimeout(
    mint: string,
    testAmount: number,
  ): Promise<JupiterQuote> {
    return new Promise<JupiterQuote>((resolve, reject) => {
      let settled = false;

      // Timeout handler — fires if Jupiter doesn't respond in time
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('HONEYPOT_DETECTION_TIMEOUT'));
        }
      }, this.timeoutMs);

      // Call getQuote with TOKEN → SOL, ExactIn mode per AAP requirements
      this.jupiterClient
        .getQuote(mint, SOLANA.SOL_MINT, testAmount, 'ExactIn')
        .then((quote: JupiterQuote) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(quote);
          }
        })
        .catch((err: unknown) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  // =========================================================================
  // Private — evaluateQuote()
  // =========================================================================

  /**
   * Evaluates a successful Jupiter quote to produce a HoneypotResult.
   *
   * A valid quote means the token IS sellable. However, we still check:
   * - Price impact: >50% suggests soft honeypot (extreme illiquidity)
   * - Estimated tax: derived from price impact and route fee analysis
   * - Route plan: validates that actual DEX routes exist
   *
   * Per AAP (Token-2022 risks): "Modern Solana tokens using Token-2022
   * may have PermanentDelegate and DefaultAccountState: frozen extensions
   * that introduce novel rug vectors" — these can manifest as hidden sell
   * taxes visible in inflated price impact.
   *
   * @param quote - Valid JupiterQuote from the sell simulation.
   * @param mint - Token mint address for logging context.
   * @returns HoneypotResult with sellable=true and computed metrics.
   */
  private evaluateQuote(quote: JupiterQuote, mint: string): HoneypotResult {
    // Parse price impact from string to number
    const priceImpact = Math.abs(parseFloat(quote.priceImpactPct) || 0);

    // Calculate estimated tax from the quote data
    const estimatedTax = this.calculateEstimatedTax(quote);

    // Parse the quoted output amount (SOL received in lamports)
    const quotedAmount = parseInt(quote.outAmount, 10);
    const validQuotedAmount = Number.isFinite(quotedAmount) && quotedAmount > 0
      ? quotedAmount
      : undefined;

    // Log route plan details for debugging
    this.logger.debug(
      `Quote evaluation for ${mint}: swapMode=${quote.swapMode}, ` +
      `routes=${quote.routePlan.length}, inAmount=${quote.inAmount}, ` +
      `outAmount=${quote.outAmount}`,
    );

    // Check for extreme price impact — soft honeypot condition
    if (priceImpact >= HIGH_PRICE_IMPACT_THRESHOLD) {
      this.logger.warn(
        `Extreme price impact for ${mint}: ${priceImpact.toFixed(2)}% — soft honeypot warning`,
        { estimatedTax, quotedAmount: validQuotedAmount, routes: quote.routePlan.length },
      );

      return {
        sellable: true,
        estimatedTax,
        quotedAmount: validQuotedAmount,
        priceImpactPct: priceImpact,
        error: `Extreme price impact: ${priceImpact.toFixed(2)}% — soft honeypot`,
        timedOut: false,
      };
    }

    // Check for suspicious sell tax
    if (estimatedTax > HIGH_TAX_THRESHOLD) {
      this.logger.warn(
        `High estimated sell tax for ${mint}: ${estimatedTax}%`,
        { priceImpact, quotedAmount: validQuotedAmount },
      );
    }

    // Token passed honeypot detection — safe to trade
    this.logger.info(
      `Honeypot check for ${mint}: sellable=true, tax=${estimatedTax}%, ` +
      `impact=${priceImpact.toFixed(2)}%`,
    );

    return {
      sellable: true,
      estimatedTax,
      quotedAmount: validQuotedAmount,
      priceImpactPct: priceImpact,
      timedOut: false,
    };
  }

  // =========================================================================
  // Private — calculateEstimatedTax()
  // =========================================================================

  /**
   * Estimates the effective sell tax percentage from a Jupiter quote.
   *
   * On Solana, most SPL tokens have zero explicit sell tax. However,
   * Token-2022 tokens with transfer fee extensions and some custom
   * programs can impose sell taxes that appear as inflated price impact
   * in Jupiter quotes.
   *
   * The estimation considers:
   * 1. Price impact (primary signal) — Jupiter aggregates all costs
   *    including slippage, pool fees, and transfer taxes into this value.
   * 2. Route plan fee analysis — individual route steps report feeAmount
   *    which can reveal per-hop costs.
   * 3. Input/output amount ratio — comparing inAmount to outAmount
   *    provides a gross cost check.
   *
   * Tax concern thresholds (from AAP):
   * - 0–5%:   Normal (slippage + DEX fees).
   * - 5–20%:  Suspicious (may have built-in sell tax).
   * - 20–50%: High risk (likely intentional sell restriction).
   * - 50–100%: Critical (effectively a honeypot even if technically sellable).
   *
   * @param quote - Valid JupiterQuote to analyze.
   * @returns Estimated sell tax as a percentage (0–100).
   */
  private calculateEstimatedTax(quote: JupiterQuote): number {
    // Primary signal: price impact from Jupiter
    const priceImpact = Math.abs(parseFloat(quote.priceImpactPct) || 0);

    // Normal slippage range for memecoins on Raydium/Orca/Meteora
    const NORMAL_SLIPPAGE_THRESHOLD = 5;
    const BASELINE_SLIPPAGE = 3;

    if (priceImpact <= NORMAL_SLIPPAGE_THRESHOLD) {
      // Within normal slippage — no detectable tax
      return 0;
    }

    // Calculate fee-based tax from route plan
    const routeFeePercent = this.calculateRouteFees(quote);

    // Subtract baseline slippage to estimate the tax component
    // Use the higher of price-impact-derived and fee-derived estimates
    const impactDerivedTax = Math.max(0, priceImpact - BASELINE_SLIPPAGE);
    const effectiveTax = Math.max(impactDerivedTax, routeFeePercent);

    return Math.min(100, Math.round(effectiveTax * 100) / 100);
  }

  // =========================================================================
  // Private — calculateRouteFees()
  // =========================================================================

  /**
   * Calculates the total fee percentage from the Jupiter route plan.
   *
   * Iterates over each route step's `swapInfo.feeAmount` and computes
   * the total fees as a percentage of the input amount. This provides
   * an independent tax estimate that complements the price impact figure.
   *
   * @param quote - Valid JupiterQuote with routePlan.
   * @returns Total fee as a percentage of the input amount (0–100).
   */
  private calculateRouteFees(quote: JupiterQuote): number {
    if (!quote.routePlan || quote.routePlan.length === 0) {
      return 0;
    }

    const inAmount = parseInt(quote.inAmount, 10);
    if (!Number.isFinite(inAmount) || inAmount <= 0) {
      return 0;
    }

    let totalFees = 0;
    for (const step of quote.routePlan) {
      const feeAmount = parseInt(step.swapInfo.feeAmount, 10);
      if (Number.isFinite(feeAmount) && feeAmount > 0) {
        totalFees += feeAmount;
      }
    }

    // Convert total fees to percentage of input amount
    const feePercent = (totalFees / inAmount) * 100;
    return Math.min(100, Math.round(feePercent * 100) / 100);
  }

  // =========================================================================
  // Private — handleCheckError()
  // =========================================================================

  /**
   * Handles errors from the honeypot check and returns a fail-safe
   * HoneypotResult.
   *
   * CRITICAL: Never crash the safety pipeline. On ANY unhandled error,
   * returns `{ sellable: false, estimatedTax: 100 }` to ensure the token
   * is treated as unsafe and filtered by hard filters (fail-safe: assume
   * honeypot).
   *
   * Error classification:
   * - Timeout / AbortError: "Sell simulation timed out"
   * - Network errors: "Jupiter API unreachable"
   * - Rate limit (429): "Jupiter rate limit hit — queuing retry"
   * - No route: "No swap route found — token may have no liquidity"
   * - Parse errors: "Invalid Jupiter response"
   *
   * @param err - The caught error from getQuoteWithTimeout.
   * @param mint - Token mint address for logging context.
   * @returns Fail-safe HoneypotResult with sellable=false.
   */
  private handleCheckError(err: unknown, mint: string): HoneypotResult {
    let errorMessage: string;
    let isTimeout = false;

    if (err instanceof Error) {
      const messageLower = err.message.toLowerCase();

      // Classify the error type for human-readable reporting
      if (
        messageLower.includes('timeout') ||
        messageLower.includes('abort') ||
        err.name === 'AbortError' ||
        err.name === 'TimeoutError'
      ) {
        errorMessage = `Sell simulation timed out for ${mint}`;
        isTimeout = true;
        this.logger.warn(errorMessage, { originalError: err.message });
      } else if (
        messageLower.includes('no route') ||
        messageLower.includes('could not find')
      ) {
        errorMessage = `No swap route found for ${mint} — token may have no liquidity`;
        this.logger.warn(errorMessage);
      } else if (
        messageLower.includes('rate limit') ||
        messageLower.includes('429') ||
        messageLower.includes('too many')
      ) {
        errorMessage = `Jupiter rate limit hit during check for ${mint} — queuing retry`;
        this.logger.warn(errorMessage);
      } else if (
        messageLower.includes('network') ||
        messageLower.includes('fetch') ||
        messageLower.includes('econnrefused')
      ) {
        errorMessage = `Jupiter API unreachable during check for ${mint}`;
        this.logger.error(errorMessage, { originalError: err.message });
      } else if (
        messageLower.includes('parse') ||
        messageLower.includes('json') ||
        messageLower.includes('invalid')
      ) {
        errorMessage = `Invalid Jupiter response during check for ${mint}`;
        this.logger.error(errorMessage, { originalError: err.message });
      } else {
        errorMessage = `Jupiter API error during sell simulation for ${mint}: ${err.message}`;
        this.logger.error(errorMessage);
      }
    } else {
      errorMessage = `Unexpected error during honeypot check for ${mint}: ${String(err)}`;
      this.logger.error(errorMessage);
    }

    // Fail-safe: always return sellable=false with 100% tax on any error
    return {
      sellable: false,
      estimatedTax: 100,
      error: errorMessage,
      timedOut: isTimeout,
    };
  }

  // =========================================================================
  // Private — delay()
  // =========================================================================

  /**
   * Returns a promise that resolves after the specified delay.
   * Used to space retry attempts and respect Jupiter's 1 RPS rate limit.
   *
   * @param ms - Delay duration in milliseconds.
   * @returns Promise that resolves after the delay.
   */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
