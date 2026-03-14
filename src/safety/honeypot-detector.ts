/**
 * src/safety/honeypot-detector.ts — Jupiter-Based Honeypot Detection
 *
 * Implements sell-side simulation for Solana SPL tokens to detect honeypot
 * conditions (tokens that can be bought but not sold). Uses Jupiter's
 * `/quote` endpoint to simulate a TOKEN → SOL swap, and interprets the
 * result to determine sellability, estimated tax, and price impact.
 *
 * Per AAP Section 0.5.1 Group 6:
 * "Jupiter-based sell simulation; requests a quote for TOKEN → SOL swap
 *  with a small test amount; a valid quote means the token is sellable
 *  (not a honeypot); timeout or error flags the token as potentially
 *  dangerous"
 *
 * Per AAP Section 0.7.3:
 * "Jupiter honeypot simulation is mandatory: Every new token must undergo
 *  a sell simulation via Jupiter's `/quote` endpoint before being scored —
 *  tokens that cannot be sold are classified as honeypots and filtered out"
 *
 * Consumers:
 * - `src/safety/checker.ts` — calls `detectHoneypot()` as part of the
 *   multi-source safety orchestration pipeline
 * - `src/signals/factors/safety-score.ts` — references honeypot result
 *   when computing the safety factor sub-score
 *
 * @module safety/honeypot-detector
 */

import type { HoneypotResult } from './types';
import { JupiterClient } from '../api/jupiter';
import { createLogger } from '../utils/logger';
import { SOLANA } from '../utils/config';

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger tagged 'honeypot-detector' for filtering in DevTools.
 */
const logger = createLogger('honeypot-detector');

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
 * the sell simulation. This mirrors JupiterClient.DEFAULT_SELL_TEST_AMOUNT.
 *
 * Using a small amount avoids distorting the price impact calculation
 * while still testing the fundamental ability to create a sell route.
 */
const DEFAULT_TEST_AMOUNT = 1_000_000;

// ---------------------------------------------------------------------------
// HoneypotDetector Class
// ---------------------------------------------------------------------------

/**
 * Detects honeypot conditions for Solana SPL tokens by simulating a
 * TOKEN → SOL sell via Jupiter's aggregator.
 *
 * A "honeypot" in the memecoin context is a token where:
 * 1. The buy-side DEX route works normally (token can be purchased).
 * 2. The sell-side DEX route is blocked, has extreme tax, or fails
 *    entirely (token cannot be sold, locking the buyer's funds).
 *
 * Detection methodology:
 * - Request a Jupiter `/quote` for a TOKEN → SOL swap with a small
 *   test amount.
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
 * const result = await detector.detectHoneypot('TokenMintAddress...');
 * if (!result.sellable) {
 *   console.warn('Token is a honeypot:', result.error);
 * }
 * ```
 */
export class HoneypotDetector {
  /** Jupiter API client used for sell simulation */
  private readonly jupiterClient: JupiterClient;

  /** Timeout in ms for the sell simulation; configurable for testing */
  private readonly timeoutMs: number;

  /**
   * Creates a new HoneypotDetector instance.
   *
   * @param jupiterClient - Pre-configured Jupiter API client with rate
   *   limiting. The client is created in the service worker and shared.
   * @param timeoutMs - Optional override for the detection timeout.
   *   Defaults to 15,000ms (15 seconds).
   */
  constructor(
    jupiterClient: JupiterClient,
    timeoutMs: number = DEFAULT_DETECTION_TIMEOUT_MS,
  ) {
    this.jupiterClient = jupiterClient;
    this.timeoutMs = timeoutMs;
    logger.info('HoneypotDetector initialized', { timeoutMs: this.timeoutMs });
  }

  // =========================================================================
  // Public — detectHoneypot()
  // =========================================================================

  /**
   * Performs a honeypot detection simulation for a given SPL token.
   *
   * Execution flow:
   *   1. Call `JupiterClient.simulateSell(tokenMint, testAmount)` with a
   *      timeout wrapper.
   *   2. Interpret the simulation result:
   *      - `sellable: true`  → extract tax estimate from price impact
   *      - `sellable: false` → classify as honeypot with error detail
   *   3. Return a typed `HoneypotResult` for aggregation by `checker.ts`.
   *
   * Fail-safe behavior: on any unexpected error, returns
   * `{ sellable: false, estimatedTax: 100, error: <message> }` to ensure
   * the token is treated as unsafe and filtered by hard filters.
   *
   * @param tokenMint - Solana mint address of the token to test.
   * @param testAmount - Optional raw token amount for the sell simulation.
   *   Defaults to 1,000,000 (smallest meaningful test size).
   * @returns HoneypotResult with sellability, estimated tax, price impact,
   *   and any error details.
   */
  async detectHoneypot(
    tokenMint: string,
    testAmount: number = DEFAULT_TEST_AMOUNT,
  ): Promise<HoneypotResult> {
    logger.debug('Starting honeypot detection', {
      tokenMint,
      testAmount,
      timeoutMs: this.timeoutMs,
    });

    try {
      // Wrap the sell simulation in a timeout to prevent indefinite hangs
      const simulationResult = await this.simulateWithTimeout(
        tokenMint,
        testAmount,
      );

      // Interpret the simulation result into a HoneypotResult
      return this.interpretResult(simulationResult, tokenMint);
    } catch (err: unknown) {
      // Handle timeout specifically
      if (err instanceof Error && err.message === 'HONEYPOT_DETECTION_TIMEOUT') {
        logger.warn('Honeypot detection timed out', {
          tokenMint,
          timeoutMs: this.timeoutMs,
        });
        return {
          sellable: false,
          estimatedTax: 100,
          error: `Sell simulation timed out after ${this.timeoutMs}ms`,
          timedOut: true,
        };
      }

      // Handle any other unexpected errors
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Honeypot detection failed with unexpected error', {
        tokenMint,
        error: errorMsg,
      });
      return {
        sellable: false,
        estimatedTax: 100,
        error: `Honeypot detection error: ${errorMsg}`,
        timedOut: false,
      };
    }
  }

  // =========================================================================
  // Public — batchDetect()
  // =========================================================================

  /**
   * Performs honeypot detection for multiple tokens concurrently.
   *
   * Uses `Promise.allSettled` to ensure all tokens are tested even if
   * individual detections fail. Results are returned in a Map keyed by
   * mint address for O(1) lookup.
   *
   * @param tokenMints - Array of Solana mint addresses to test.
   * @param testAmount - Optional raw token amount for each simulation.
   * @returns Map of mint address → HoneypotResult for each tested token.
   */
  async batchDetect(
    tokenMints: string[],
    testAmount: number = DEFAULT_TEST_AMOUNT,
  ): Promise<Map<string, HoneypotResult>> {
    logger.info('Starting batch honeypot detection', {
      tokenCount: tokenMints.length,
    });

    const results = new Map<string, HoneypotResult>();

    const settled = await Promise.allSettled(
      tokenMints.map(async (mint) => {
        const result = await this.detectHoneypot(mint, testAmount);
        return { mint, result };
      }),
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.set(outcome.value.mint, outcome.value.result);
      } else {
        // This should not happen since detectHoneypot catches all errors,
        // but handle defensively
        const mint = tokenMints[settled.indexOf(outcome)] ?? 'unknown';
        results.set(mint, {
          sellable: false,
          estimatedTax: 100,
          error: `Batch detection failed: ${String(outcome.reason)}`,
          timedOut: false,
        });
      }
    }

    const sellableCount = Array.from(results.values()).filter(
      (r) => r.sellable,
    ).length;
    logger.info('Batch honeypot detection complete', {
      total: tokenMints.length,
      sellable: sellableCount,
      honeypots: tokenMints.length - sellableCount,
    });

    return results;
  }

  // =========================================================================
  // Private — simulateWithTimeout()
  // =========================================================================

  /**
   * Wraps `JupiterClient.simulateSell()` in a timeout race.
   *
   * If the Jupiter API does not respond within `this.timeoutMs`, the
   * promise rejects with a `HONEYPOT_DETECTION_TIMEOUT` error which is
   * caught by the calling method and translated into a `timedOut: true`
   * HoneypotResult.
   *
   * @param tokenMint - Solana mint address of the token to simulate.
   * @param testAmount - Raw token amount for the sell simulation.
   * @returns Jupiter simulation result.
   * @throws Error with message 'HONEYPOT_DETECTION_TIMEOUT' on timeout.
   */
  private async simulateWithTimeout(
    tokenMint: string,
    testAmount: number,
  ): Promise<{
    sellable: boolean;
    quote: unknown | null;
    priceImpact: number;
  }> {
    return new Promise<{
      sellable: boolean;
      quote: unknown | null;
      priceImpact: number;
    }>((resolve, reject) => {
      let settled = false;

      // Timeout handler
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('HONEYPOT_DETECTION_TIMEOUT'));
        }
      }, this.timeoutMs);

      // Actual simulation
      this.jupiterClient
        .simulateSell(tokenMint, testAmount)
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
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
  // Private — interpretResult()
  // =========================================================================

  /**
   * Interprets a Jupiter sell simulation result into a typed
   * `HoneypotResult` object.
   *
   * Interpretation logic:
   * - `sellable: true` with low price impact → safe token
   * - `sellable: true` with high price impact (>50%) → soft honeypot
   *   (technically sellable but extreme slippage makes it dangerous)
   * - `sellable: false` → confirmed honeypot (no route, blocked, or error)
   *
   * Tax estimation:
   * Price impact on Jupiter aggregator quotes includes both actual
   * slippage and any on-chain sell-tax mechanisms. For most Solana SPL
   * tokens, the price impact is purely slippage (no tax). However, some
   * Token-2022 tokens with transfer fee extensions will show inflated
   * price impact that effectively acts as a sell tax.
   *
   * @param result - Raw simulation result from JupiterClient.simulateSell().
   * @param tokenMint - Mint address for logging context.
   * @returns Typed HoneypotResult for the safety pipeline.
   */
  private interpretResult(
    result: { sellable: boolean; quote: unknown | null; priceImpact: number },
    tokenMint: string,
  ): HoneypotResult {
    if (!result.sellable) {
      logger.warn('Token identified as honeypot — sell simulation failed', {
        tokenMint,
        priceImpact: result.priceImpact,
      });
      return {
        sellable: false,
        estimatedTax: 100,
        priceImpactPct: result.priceImpact,
        error: 'Jupiter sell simulation returned no valid route',
        timedOut: false,
      };
    }

    // Token is sellable — compute estimated tax from price impact
    const priceImpact = Math.abs(result.priceImpact);
    const estimatedTax = this.estimateTax(priceImpact);

    // Extract quoted output amount if available
    const quotedAmount = this.extractQuotedAmount(result.quote);

    // Check for soft honeypot conditions (extreme slippage)
    if (priceImpact >= HIGH_PRICE_IMPACT_THRESHOLD) {
      logger.warn('Token has extreme price impact — soft honeypot', {
        tokenMint,
        priceImpact,
        estimatedTax,
      });
      return {
        sellable: true,
        estimatedTax,
        quotedAmount,
        priceImpactPct: priceImpact,
        error: `Extreme price impact: ${priceImpact.toFixed(2)}% — soft honeypot`,
        timedOut: false,
      };
    }

    // Check for high tax indicators
    if (estimatedTax > HIGH_TAX_THRESHOLD) {
      logger.warn('Token may have high sell tax', {
        tokenMint,
        priceImpact,
        estimatedTax,
      });
    }

    logger.debug('Token passed honeypot detection', {
      tokenMint,
      sellable: true,
      priceImpact,
      estimatedTax,
      quotedAmount,
    });

    return {
      sellable: true,
      estimatedTax,
      quotedAmount,
      priceImpactPct: priceImpact,
      timedOut: false,
    };
  }

  // =========================================================================
  // Private — estimateTax()
  // =========================================================================

  /**
   * Estimates the effective sell tax from Jupiter's quoted price impact.
   *
   * On Solana, most SPL tokens have zero explicit sell tax. However,
   * Token-2022 tokens with transfer fee extensions and some custom
   * programs can impose sell taxes that appear as inflated price impact
   * in Jupiter quotes.
   *
   * Heuristic: If the price impact is below 5%, we treat it as normal
   * DEX slippage with 0% estimated tax. Above 5%, we subtract a 3%
   * baseline slippage allowance to estimate the tax component.
   *
   * @param priceImpact - Absolute price impact percentage from Jupiter.
   * @returns Estimated sell tax as a percentage (0–100).
   */
  private estimateTax(priceImpact: number): number {
    // Normal slippage range for memecoins on Raydium/Orca
    const NORMAL_SLIPPAGE_THRESHOLD = 5;
    const BASELINE_SLIPPAGE = 3;

    if (priceImpact <= NORMAL_SLIPPAGE_THRESHOLD) {
      // Within normal slippage — no detectable tax
      return 0;
    }

    // Subtract baseline slippage to estimate the tax component
    const estimatedTax = Math.max(0, priceImpact - BASELINE_SLIPPAGE);
    return Math.min(100, Math.round(estimatedTax * 100) / 100);
  }

  // =========================================================================
  // Private — extractQuotedAmount()
  // =========================================================================

  /**
   * Extracts the quoted output amount from a Jupiter quote response object.
   *
   * The Jupiter `/quote` response includes `outAmount` as a string
   * representing raw lamports of the output token (SOL). This method
   * safely extracts and converts it to a number, returning undefined
   * if the quote is null or the field is missing.
   *
   * @param quote - Raw Jupiter quote object (unknown type).
   * @returns Quoted output amount in raw units, or undefined.
   */
  private extractQuotedAmount(quote: unknown): number | undefined {
    if (quote === null || quote === undefined || typeof quote !== 'object') {
      return undefined;
    }

    const quoteObj = quote as Record<string, unknown>;

    // Jupiter v6 API returns outAmount as a string
    if (typeof quoteObj.outAmount === 'string') {
      const amount = parseInt(quoteObj.outAmount, 10);
      if (Number.isFinite(amount) && amount > 0) {
        return amount;
      }
    }

    // Also try numeric outAmount
    if (typeof quoteObj.outAmount === 'number' && Number.isFinite(quoteObj.outAmount)) {
      return quoteObj.outAmount;
    }

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Convenience Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new HoneypotDetector instance.
 *
 * Convenience factory for use in service worker initialization where
 * constructor injection is preferred over direct `new` calls.
 *
 * @param jupiterClient - Pre-configured Jupiter API client.
 * @param timeoutMs - Optional detection timeout override.
 * @returns New HoneypotDetector instance.
 */
export function createHoneypotDetector(
  jupiterClient: JupiterClient,
  timeoutMs?: number,
): HoneypotDetector {
  return new HoneypotDetector(jupiterClient, timeoutMs);
}
