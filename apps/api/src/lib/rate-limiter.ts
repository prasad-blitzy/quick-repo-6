/**
 * Per-API Bottleneck Rate Limiter Factory — Trading Intelligence API
 *
 * Creates and manages ISOLATED Bottleneck rate limiter instances for each
 * external API source. This is a CRITICAL requirement from AAP Rule 0.7.4:
 * "Per-API Bottleneck isolation — Each external API source MUST have its own
 * dedicated Bottleneck instance configured to its specific free-tier limits.
 * NO shared rate limiter across different APIs."
 *
 * Architecture:
 * - Singleton pattern via internal Map — each source gets exactly ONE limiter
 * - Lazy initialization — limiters are created on first access and cached
 * - Event-driven observability — error and depleted handlers registered for
 *   structured logging of rate limiter health
 * - Graceful shutdown — `disconnectAll()` disconnects every active limiter
 *
 * Supported API sources and their free-tier limits:
 *
 * | Source        | maxConcurrent | minTime(ms) | Reservoir    | Refresh         |
 * |---------------|---------------|-------------|--------------|-----------------|
 * | FINNHUB       | 1             | 1000        | 60           | 60 / 60s        |
 * | ALPHA_VANTAGE | 1             | 5000        | 25           | 25 / 86,400s    |
 * | COINGECKO     | 1             | 2000        | 30           | 30 / 60s        |
 * | CRYPTOCOMPARE | 2             | 100         | 100,000      | 100K / 30d      |
 * | BINANCE       | 5             | 100         | 1,200        | 1200 / 60s      |
 * | NSE_INDIA     | 1             | 3000        | —            | —               |
 * | REDDIT        | 1             | 600         | 100          | 100 / 60s       |
 * | OPENROUTER    | 3             | 500         | —            | —               |
 *
 * @module lib/rate-limiter
 * @see {@link https://github.com/SGrondin/bottleneck} Bottleneck documentation
 */

import Bottleneck from "bottleneck";
import { RATE_LIMITS } from "../config/constants.js";
import { createLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Logger — Child logger scoped to the rate-limiter module
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "rate-limiter" }` context binding.
 * Used for structured logging of limiter creation, errors, reservoir
 * depletion warnings, and shutdown events.
 */
const logger = createLogger("rate-limiter");

// ---------------------------------------------------------------------------
// Type Definition — API Source Union
// ---------------------------------------------------------------------------

/**
 * Union type of all valid external API source identifiers, derived directly
 * from the keys of the `RATE_LIMITS` constant object. This ensures type
 * safety — only API sources with predefined rate limit configurations can
 * be used to create or retrieve a limiter.
 *
 * Current members:
 * `"FINNHUB" | "ALPHA_VANTAGE" | "COINGECKO" | "CRYPTOCOMPARE" | "BINANCE" | "NSE_INDIA" | "REDDIT" | "OPENROUTER"`
 */
export type ApiSource = keyof typeof RATE_LIMITS;

// ---------------------------------------------------------------------------
// Limiter Store — Singleton Map
// ---------------------------------------------------------------------------

/**
 * Internal registry of all created Bottleneck instances, keyed by API source
 * name. Ensures exactly one limiter per source (singleton pattern) with lazy
 * initialization on first access.
 */
const limiters = new Map<string, Bottleneck>();

// ---------------------------------------------------------------------------
// Factory Function — createLimiter
// ---------------------------------------------------------------------------

/**
 * Creates or retrieves a cached Bottleneck rate limiter for the specified
 * API source. If a limiter for the source already exists in the internal
 * registry, the cached instance is returned. Otherwise, a new instance is
 * created from the corresponding entry in {@link RATE_LIMITS}, event
 * handlers are registered, and the limiter is stored in the registry.
 *
 * Event handlers registered:
 * - `"error"` — Logs rate limiter errors to prevent unhandled rejections
 * - `"depleted"` — Warns when the reservoir is exhausted and requests queue
 *
 * @param source — One of the 8 valid API source identifiers from RATE_LIMITS.
 * @returns The Bottleneck instance configured for the specified source.
 *
 * @example
 * ```typescript
 * const limiter = createLimiter("FINNHUB");
 * const data = await limiter.schedule(() => fetch("https://finnhub.io/api/v1/news"));
 * ```
 */
export function createLimiter(source: ApiSource): Bottleneck {
  // Return cached limiter if one already exists for this source
  const existing = limiters.get(source);
  if (existing) {
    return existing;
  }

  // Retrieve the pre-defined Bottleneck configuration for this API source.
  // Each entry in RATE_LIMITS maps directly to Bottleneck constructor options
  // (maxConcurrent, minTime, reservoir, reservoirRefreshAmount, etc.)
  const config = RATE_LIMITS[source];

  // Create a new Bottleneck instance with the source-specific configuration
  const limiter = new Bottleneck(config);

  // Register error handler to prevent unhandled promise rejections.
  // This is critical for graceful degradation — individual API source
  // failures must not crash the application (AAP Rule 0.7.4).
  limiter.on("error", (error: unknown) => {
    logger.error({ source, error }, "Rate limiter error");
  });

  // Register depleted handler for observability. When the reservoir reaches
  // zero, new requests are queued until the reservoir refreshes. This warns
  // operators that rate limit capacity has been exhausted.
  limiter.on("depleted", () => {
    logger.warn(
      { source },
      "Rate limiter reservoir depleted — requests will be queued",
    );
  });

  // Cache the limiter in the registry for future access
  limiters.set(source, limiter);

  // Log the creation event with the full configuration for debugging
  logger.info({ source, config }, "Created rate limiter");

  return limiter;
}

// ---------------------------------------------------------------------------
// Generic Getter — getLimiter
// ---------------------------------------------------------------------------

/**
 * Retrieves or creates a Bottleneck rate limiter for the specified API source.
 * This is functionally equivalent to {@link createLimiter} but provides a
 * more semantically appropriate name for callers that only want to "get"
 * an existing limiter rather than explicitly "create" one.
 *
 * @param source — One of the 8 valid API source identifiers.
 * @returns The Bottleneck instance configured for the specified source.
 */
export function getLimiter(source: ApiSource): Bottleneck {
  return createLimiter(source);
}

// ---------------------------------------------------------------------------
// Graceful Shutdown — disconnectAll
// ---------------------------------------------------------------------------

/**
 * Disconnects ALL active rate limiters and clears the internal registry.
 * This should be called during application shutdown to release all internal
 * Bottleneck timers and prevent the process from hanging.
 *
 * Each limiter's `disconnect()` method is called concurrently via
 * `Promise.all()` for maximum shutdown speed. After disconnection,
 * the registry is cleared so limiters can be re-created if needed.
 *
 * @returns A promise that resolves when all limiters have been disconnected.
 *
 * @example
 * ```typescript
 * process.on("SIGTERM", async () => {
 *   await disconnectAll();
 *   process.exit(0);
 * });
 * ```
 */
export async function disconnectAll(): Promise<void> {
  const activeCount = limiters.size;

  if (activeCount === 0) {
    logger.info("No active rate limiters to disconnect");
    return;
  }

  logger.info({ activeCount }, "Disconnecting all rate limiters");

  // Disconnect all limiter instances concurrently
  const promises = Array.from(limiters.values()).map((limiter) =>
    limiter.disconnect(),
  );
  await Promise.all(promises);

  // Clear the registry so limiters can be re-created if the application
  // restarts or reconnects
  limiters.clear();

  logger.info(
    { disconnectedCount: activeCount },
    "All rate limiters disconnected",
  );
}

// ---------------------------------------------------------------------------
// Pre-configured Named Getter Functions — One Per API Source
// ---------------------------------------------------------------------------
// These provide typed, discoverable access to each API-specific limiter.
// Consuming modules import the specific getter for their API, eliminating
// the need to know the string constant for the source name.
// ---------------------------------------------------------------------------

/**
 * Returns the Bottleneck rate limiter for the **Finnhub API** (US stock news
 * and quotes). Configured for the free tier: 60 calls/minute with
 * maxConcurrent=1 and minTime=1000ms.
 *
 * @returns Bottleneck instance for Finnhub API calls.
 */
export function getFinnhubLimiter(): Bottleneck {
  return createLimiter("FINNHUB");
}

/**
 * Returns the Bottleneck rate limiter for the **CoinGecko API** (crypto
 * trending coins and market data). Configured for the free tier: 30
 * calls/minute with maxConcurrent=1 and minTime=2000ms.
 *
 * @returns Bottleneck instance for CoinGecko API calls.
 */
export function getCoinGeckoLimiter(): Bottleneck {
  return createLimiter("COINGECKO");
}

/**
 * Returns the Bottleneck rate limiter for the **CryptoCompare API** (crypto
 * news and historical data). Configured for the free tier: 100,000
 * calls/month with maxConcurrent=2 and minTime=100ms.
 *
 * @returns Bottleneck instance for CryptoCompare API calls.
 */
export function getCryptoCompareLimiter(): Bottleneck {
  return createLimiter("CRYPTOCOMPARE");
}

/**
 * Returns the Bottleneck rate limiter for the **Alpha Vantage API** (historical
 * data and NEWS_SENTIMENT endpoint). Configured for the free tier: 25
 * calls/day with maxConcurrent=1 and minTime=5000ms.
 *
 * @returns Bottleneck instance for Alpha Vantage API calls.
 */
export function getAlphaVantageLimiter(): Bottleneck {
  return createLimiter("ALPHA_VANTAGE");
}

/**
 * Returns the Bottleneck rate limiter for the **Binance REST API** (real-time
 * crypto klines and trades). Configured conservatively at 1200 weight/minute
 * (actual limit is 6000) with maxConcurrent=5 and minTime=100ms.
 *
 * @returns Bottleneck instance for Binance API calls.
 */
export function getBinanceLimiter(): Bottleneck {
  return createLimiter("BINANCE");
}

/**
 * Returns the Bottleneck rate limiter for the **NSE India** scraper
 * (Indian equity real-time quotes via stock-nse-india). Configured with
 * conservative scraping pacing: maxConcurrent=1, minTime=3000ms,
 * no reservoir (rate-based only).
 *
 * @returns Bottleneck instance for NSE India scraping.
 */
export function getNseIndiaLimiter(): Bottleneck {
  return createLimiter("NSE_INDIA");
}

/**
 * Returns the Bottleneck rate limiter for the **Reddit RSS/API**
 * (r/wallstreetbets and r/IndianStreetBets sentiment). Configured for
 * the free tier: 100 queries/minute with maxConcurrent=1 and minTime=600ms.
 *
 * @returns Bottleneck instance for Reddit API calls.
 */
export function getRedditLimiter(): Bottleneck {
  return createLimiter("REDDIT");
}

/**
 * Returns the Bottleneck rate limiter for the **OpenRouter LLM gateway**
 * (multi-model AI inference via ChatOpenAI). Configured with conservative
 * defaults: maxConcurrent=3, minTime=500ms, no reservoir (per-model limits
 * are managed upstream by OpenRouter).
 *
 * @returns Bottleneck instance for OpenRouter API calls.
 */
export function getOpenRouterLimiter(): Bottleneck {
  return createLimiter("OPENROUTER");
}
