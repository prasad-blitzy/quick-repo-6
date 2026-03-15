/**
 * CryptoCompare News API Client — Trading Intelligence API
 *
 * Fetches crypto-specific news articles from the CryptoCompare
 * `/data/v2/news/` endpoint. Authentication uses the `authorization` header
 * with the `Apikey` prefix (NOT `Bearer`), per CryptoCompare API convention.
 *
 * Rate limiting is enforced via a DEDICATED Bottleneck instance configured
 * for the CryptoCompare free-tier quota of 100,000 calls/month
 * (maxConcurrent: 2, minTime: 100ms, reservoir: 100,000). This complies
 * with AAP Rule 0.7.4 requiring per-API Bottleneck isolation.
 *
 * Graceful degradation (AAP Rule 0.7.4): If the API key is missing, the
 * endpoint fails, or the response is malformed, this module logs the issue
 * and returns an empty array — it NEVER throws. Individual API source
 * failures must not halt the entire polling cycle.
 *
 * @module services/news-fetcher/cryptocompare
 * @see {@link https://min-api.cryptocompare.com/documentation/news} CryptoCompare News API
 */

import { createLogger } from "../../lib/logger.js";
import { getCryptoCompareLimiter } from "../../lib/rate-limiter.js";
import { env } from "../../config/env.js";
import { API_BASE_URLS, DEFAULTS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Module-scoped Logger and Rate Limiter
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "cryptocompare" }` context binding.
 * Used for structured logging of API fetch operations, response validation,
 * article normalization counts, and error handling.
 */
const logger = createLogger("cryptocompare");

/**
 * Dedicated Bottleneck rate limiter for CryptoCompare API calls.
 * Configured for the free tier: 100,000 calls/month, maxConcurrent=2,
 * minTime=100ms. Singleton — created once and reused across invocations.
 */
const limiter = getCryptoCompareLimiter();

// ---------------------------------------------------------------------------
// CryptoCompare API Response Types
// ---------------------------------------------------------------------------

/**
 * Structure of the `source_info` nested object within a CryptoCompare
 * news article item. Contains metadata about the publishing source.
 */
interface CryptoCompareSourceInfo {
  /** Human-readable name of the source (e.g., "CoinDesk", "Decrypt") */
  name: string;
  /** URL to the source's logo or icon image */
  img: string;
  /** ISO language code of the source (e.g., "EN") */
  lang: string;
}

/**
 * Individual news article item from the CryptoCompare `/data/v2/news/`
 * API response. Fields match the CryptoCompare API documentation.
 */
interface CryptoCompareNewsItem {
  /** Unique article identifier (string) */
  id: string;
  /** Globally unique identifier for the article */
  guid: string;
  /** Publication timestamp as a Unix epoch in SECONDS (not milliseconds) */
  published_on: number;
  /** URL to the article's featured image */
  imageurl: string;
  /** Headline / title of the article */
  title: string;
  /** Full URL to the original article on the source website */
  url: string;
  /** Full body text of the article */
  body: string;
  /**
   * Pipe-separated string of tags (e.g., "BTC|ETH|DeFi|Regulation").
   * Tags include both crypto ticker symbols AND topic labels; we use a
   * heuristic (length ≤ 5) to extract probable ticker symbols.
   */
  tags: string;
  /** Pipe-separated string of categories (e.g., "BTC|Trading|Altcoin") */
  categories: string;
  /** Name of the publishing source (e.g., "CoinDesk") */
  source: string;
  /** Nested metadata about the publishing source */
  source_info: CryptoCompareSourceInfo;
}

/**
 * Top-level response envelope from the CryptoCompare `/data/v2/news/`
 * endpoint. `Type === 100` indicates a successful response.
 */
interface CryptoCompareNewsResponse {
  /** Response type code — 100 indicates success */
  Type: number;
  /** Human-readable status message (e.g., "News list successfully returned") */
  Message: string;
  /** Array of news article items */
  Data: CryptoCompareNewsItem[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * CryptoCompare API success response type code. The `Type` field in the
 * response envelope equals 100 when the request was successful.
 */
const SUCCESS_TYPE = 100;

/**
 * Maximum character length for the summary field. Article bodies longer
 * than this are truncated; shorter bodies are used verbatim.
 */
const SUMMARY_MAX_LENGTH = 500;

/**
 * Maximum character length for a tag to be considered a probable ticker
 * symbol. Tags with ≤5 characters (e.g., "BTC", "ETH", "DOGE") are
 * treated as symbols; longer tags (e.g., "Regulation", "DeFi") are
 * topic labels and are excluded from the symbols array.
 */
const MAX_SYMBOL_TAG_LENGTH = 5;

// ---------------------------------------------------------------------------
// Exported Fetcher Function
// ---------------------------------------------------------------------------

/**
 * Fetches the latest crypto news articles from the CryptoCompare API,
 * normalizes them into the standardized {@link NormalizedArticle} format,
 * and returns the result array.
 *
 * Behavior:
 * 1. Checks if `CRYPTOCOMPARE_API_KEY` is configured — returns `[]` if not.
 * 2. Constructs the API URL with `lang=EN` and `sortOrder=latest` params.
 * 3. Sends the request through the dedicated Bottleneck rate limiter.
 * 4. Validates the response envelope (`Type === 100`).
 * 5. Maps each `CryptoCompareNewsItem` to a `NormalizedArticle`:
 *    - Extracts probable ticker symbols from pipe-separated tags.
 *    - Converts Unix timestamp (seconds) to a JavaScript `Date`.
 *    - Preserves source-specific metadata as a JSONB-compatible object.
 * 6. Returns the normalized articles array.
 *
 * On ANY error (network, HTTP, parsing, runtime), the function logs the
 * error and returns `[]` — it NEVER throws (graceful degradation).
 *
 * @returns Promise resolving to an array of normalized crypto news articles,
 *          or an empty array if the API key is missing, the request fails,
 *          or the response is malformed.
 *
 * @example
 * ```typescript
 * import { fetchCryptoCompareNews } from "./cryptocompare.js";
 *
 * const articles = await fetchCryptoCompareNews();
 * console.log(`Fetched ${articles.length} CryptoCompare articles`);
 * ```
 */
export async function fetchCryptoCompareNews(): Promise<NormalizedArticle[]> {
  try {
    // Step 1 — Guard: API key must be configured
    if (!env.CRYPTOCOMPARE_API_KEY) {
      logger.info(
        "CRYPTOCOMPARE_API_KEY not set — skipping CryptoCompare news fetch",
      );
      return [];
    }

    // Step 2 — Construct the API endpoint URL
    const url = `${API_BASE_URLS.CRYPTOCOMPARE}/data/v2/news/?lang=EN&sortOrder=latest`;

    // Step 3 — Build request headers with Apikey auth (NOT Bearer)
    const headers: Record<string, string> = {
      Accept: "application/json",
      authorization: `Apikey ${env.CRYPTOCOMPARE_API_KEY}`,
    };

    logger.debug({ url }, "Fetching CryptoCompare news");

    // Step 4 — Execute rate-limited API request via Bottleneck scheduler.
    // AbortSignal.timeout prevents indefinite hangs on unresponsive API servers.
    const response = await limiter.schedule(() =>
      fetch(url, { headers, signal: AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS) }).then((res) => {
        if (!res.ok) {
          throw new Error(
            `CryptoCompare API error: ${String(res.status)} ${res.statusText}`,
          );
        }
        return res.json() as Promise<CryptoCompareNewsResponse>;
      }),
    );

    // Step 5 — Validate response envelope success code
    if (response.Type !== SUCCESS_TYPE) {
      logger.warn(
        { type: response.Type, message: response.Message },
        "CryptoCompare API returned non-success response type",
      );
      return [];
    }

    // Step 6 — Defensive check: ensure Data is an array
    if (!Array.isArray(response.Data)) {
      logger.warn(
        "CryptoCompare API response Data field is not an array — returning empty",
      );
      return [];
    }

    // Step 7 — Normalize each news item to the standardized NormalizedArticle format
    const articles: NormalizedArticle[] = response.Data.map(
      (item): NormalizedArticle => {
        // Extract probable ticker symbols from pipe-separated tags.
        // Heuristic: tags with ≤5 characters are likely symbols (BTC, ETH, DOGE),
        // while longer tags are topic labels (Regulation, DeFi, NFT News).
        const symbols: string[] = item.tags
          ? item.tags
              .split("|")
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && t.length <= MAX_SYMBOL_TAG_LENGTH)
          : [];

        // Prepare body and summary — handle empty/missing body gracefully.
        const body: string = item.body ?? "";
        const hasBody: boolean = body.length > 0;

        const summary: string | null = hasBody
          ? body.length > SUMMARY_MAX_LENGTH
            ? body.substring(0, SUMMARY_MAX_LENGTH)
            : body
          : null;

        return {
          title: item.title,
          url: item.url,
          source: "CryptoCompare",
          market: "crypto",
          content: hasBody ? body : null,
          summary,
          symbols,
          publishedAt: new Date(item.published_on * 1000),
          metadata: {
            originalSource: item.source,
            categories: item.categories,
            imageUrl: item.imageurl,
            guid: item.guid,
          },
        };
      },
    );

    logger.info(
      { articleCount: articles.length },
      "Fetched and normalized CryptoCompare news articles",
    );

    return articles;
  } catch (error: unknown) {
    // Graceful degradation — log the error and return empty array.
    // Individual API source failures must not halt the polling cycle (AAP 0.7.4).
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch CryptoCompare news",
    );
    return [];
  }
}
