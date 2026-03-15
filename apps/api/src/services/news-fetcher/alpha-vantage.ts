/**
 * Alpha Vantage REST API Client — Trading Intelligence API
 *
 * Fetches US market news sentiment data from the Alpha Vantage NEWS_SENTIMENT
 * endpoint. This module supplements the Finnhub news fetcher by providing an
 * alternative source of US stock news with BUILT-IN sentiment analysis scores
 * per ticker — these pre-computed sentiment values are preserved in article
 * metadata for downstream comparison with the LangGraph pipeline's own
 * sentiment analysis.
 *
 * API Details:
 * - **Endpoint**: `?function=NEWS_SENTIMENT&apikey=...&sort=LATEST&limit=50`
 * - **Base URL**: `https://www.alphavantage.co/query` (via `API_BASE_URLS.ALPHA_VANTAGE`)
 * - **Auth**: `apikey` query parameter — `env.ALPHA_VANTAGE_API_KEY`
 * - **Rate Limit**: 25 calls/day on the free tier — extremely conservative
 * - **Optional**: `ALPHA_VANTAGE_API_KEY` defaults to `""` — when empty,
 *   fetching is skipped and an empty array is returned
 *
 * Date Format Note:
 * Alpha Vantage uses a non-standard date format `"YYYYMMDDTHHMMSS"` (e.g.,
 * `"20260313T120000"`) instead of ISO 8601. A dedicated parser converts this
 * to JavaScript `Date` objects.
 *
 * @module services/news-fetcher/alpha-vantage
 * @see {@link https://www.alphavantage.co/documentation/#news-sentiment} API docs
 */

import { createLogger } from "../../lib/logger.js";
import { getAlphaVantageLimiter } from "../../lib/rate-limiter.js";
import { env } from "../../config/env.js";
import { API_BASE_URLS, DEFAULTS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Logger — Child logger scoped to the alpha-vantage module
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "alpha-vantage" }` context binding.
 * Used for structured logging of API fetch operations, key validation,
 * response error handling, and article normalization counts.
 */
const logger = createLogger("alpha-vantage");

// ---------------------------------------------------------------------------
// Rate Limiter — Dedicated Alpha Vantage Bottleneck instance
// ---------------------------------------------------------------------------

/**
 * Dedicated Bottleneck rate limiter for Alpha Vantage API calls.
 * Configured for the free tier: 25 calls/day, maxConcurrent=1, minTime=5000ms.
 *
 * Per AAP Rule 0.7.4: Each external API source MUST have its own dedicated
 * Bottleneck instance. No shared rate limiter across different APIs.
 */
const limiter = getAlphaVantageLimiter();

// ---------------------------------------------------------------------------
// Alpha Vantage NEWS_SENTIMENT API Response Types
// ---------------------------------------------------------------------------

/**
 * Top-level response shape from the Alpha Vantage NEWS_SENTIMENT endpoint.
 * The `feed` array contains individual news articles with sentiment metadata.
 *
 * Note: When the API returns an error or rate-limit notice, the response
 * has `{ "Note": "..." }` or `{ "Error Message": "..." }` instead of this
 * structure — those cases are handled separately in the fetch logic.
 */
interface AlphaVantageNewsResponse {
  items: string;
  sentiment_score_definition: string;
  relevance_score_definition: string;
  feed: AlphaVantageNewsFeedItem[];
}

/**
 * Individual news article from the Alpha Vantage NEWS_SENTIMENT feed.
 * Contains pre-computed sentiment scores at both the overall level and
 * per-ticker level — these are preserved in `metadata` for downstream
 * comparison with the LangGraph pipeline's own analysis.
 */
interface AlphaVantageNewsFeedItem {
  title: string;
  url: string;
  /** Non-standard date format: "YYYYMMDDTHHMMSS" (e.g., "20260313T120000") */
  time_published: string;
  authors: string[];
  summary: string;
  banner_image: string | null;
  source: string;
  category_within_source: string;
  source_domain: string;
  topics: Array<{ topic: string; relevance_score: string }>;
  overall_sentiment_score: number;
  overall_sentiment_label: string;
  ticker_sentiment: Array<{
    ticker: string;
    relevance_score: string;
    ticker_sentiment_score: string;
    ticker_sentiment_label: string;
  }>;
}

/**
 * Shape of Alpha Vantage error or rate-limit responses.
 * The API returns these instead of the normal response when:
 * - `"Note"`: API call frequency exceeded (rate limit hit)
 * - `"Error Message"`: Invalid API key or malformed request
 * - `"Information"`: General informational messages
 */
interface AlphaVantageErrorResponse {
  Note?: string;
  "Error Message"?: string;
  Information?: string;
}

// ---------------------------------------------------------------------------
// Date Parsing Helper
// ---------------------------------------------------------------------------

/**
 * Parses Alpha Vantage's non-standard date format into a JavaScript Date.
 *
 * Alpha Vantage uses `"YYYYMMDDTHHMMSS"` format (e.g., `"20260313T120000"`)
 * instead of ISO 8601. This function extracts the components and constructs
 * a proper ISO 8601 string for the Date constructor.
 *
 * @param dateStr — Date string in "YYYYMMDDTHHMMSS" format.
 * @returns A JavaScript Date object representing the parsed timestamp (UTC).
 *
 * @example
 * ```typescript
 * parseAlphaVantageDate("20260313T120000");
 * // => Date: 2026-03-13T12:00:00.000Z
 * ```
 */
function parseAlphaVantageDate(dateStr: string): Date {
  // Format: "20260313T120000"
  //          01234567890123456
  //          YYYYMMDDTHHMMSS
  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(4, 6);
  const day = dateStr.slice(6, 8);
  const hour = dateStr.slice(9, 11);
  const minute = dateStr.slice(11, 13);
  const second = dateStr.slice(13, 15);

  // Construct ISO 8601 string and parse via Date constructor
  const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const parsed = new Date(isoString);

  // Validate the parsed date — return current time if parsing fails
  if (Number.isNaN(parsed.getTime())) {
    logger.warn({ dateStr }, "Failed to parse Alpha Vantage date — using current time");
    return new Date();
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Type Guard — Alpha Vantage Error Response Detection
// ---------------------------------------------------------------------------

/**
 * Type guard that checks whether an API response is an error/rate-limit
 * notice rather than a valid NEWS_SENTIMENT response.
 *
 * Alpha Vantage returns error objects with `Note`, `Error Message`, or
 * `Information` keys instead of the expected `feed` array when the API key
 * is invalid, the rate limit is hit, or the request is malformed.
 *
 * @param data — The parsed JSON response from the API.
 * @returns `true` if the response is an error response, `false` if it
 *          appears to be a valid NEWS_SENTIMENT response.
 */
function isErrorResponse(
  data: AlphaVantageNewsResponse | AlphaVantageErrorResponse,
): data is AlphaVantageErrorResponse {
  const record = data as Record<string, unknown>;
  return (
    "Note" in record ||
    "Error Message" in record ||
    "Information" in record
  );
}

// ---------------------------------------------------------------------------
// Main Fetch Function — fetchAlphaVantageNews
// ---------------------------------------------------------------------------

/**
 * Fetches the latest US market news with sentiment analysis from the
 * Alpha Vantage NEWS_SENTIMENT endpoint.
 *
 * Behavior:
 * 1. Checks if `ALPHA_VANTAGE_API_KEY` is configured — if empty, returns `[]`
 *    immediately (API key is optional; feature is disabled without it).
 * 2. Builds the NEWS_SENTIMENT URL with sort=LATEST and limit=50.
 * 3. Schedules the HTTP fetch through the dedicated Bottleneck rate limiter
 *    (25 calls/day on the free tier).
 * 4. Detects API error responses (`Note`, `Error Message`, `Information`)
 *    and returns `[]` gracefully.
 * 5. Maps the response `feed` array to `NormalizedArticle[]` with:
 *    - Ticker symbols extracted from per-ticker sentiment data
 *    - Non-standard date format parsed to Date objects
 *    - Pre-computed sentiment scores preserved in metadata
 * 6. On any error, logs it and returns `[]` (graceful degradation per AAP 0.7.4).
 *
 * @returns An array of normalized articles from Alpha Vantage NEWS_SENTIMENT.
 *          Returns `[]` on error, missing API key, or empty feed.
 */
export async function fetchAlphaVantageNews(): Promise<NormalizedArticle[]> {
  try {
    // Step 1: Check if the API key is configured
    // ALPHA_VANTAGE_API_KEY defaults to "" in env.ts — when empty, skip fetching
    if (!env.ALPHA_VANTAGE_API_KEY) {
      logger.info("Alpha Vantage API key not configured — skipping fetch");
      return [];
    }

    // Step 2: Build the NEWS_SENTIMENT endpoint URL
    const url =
      `${API_BASE_URLS.ALPHA_VANTAGE}?function=NEWS_SENTIMENT` +
      `&apikey=${env.ALPHA_VANTAGE_API_KEY}` +
      `&sort=LATEST` +
      `&limit=50`;

    logger.info("Fetching news from Alpha Vantage NEWS_SENTIMENT endpoint");

    // Step 3: Schedule the fetch through the dedicated rate limiter
    // The limiter ensures we don't exceed 25 calls/day on the free tier.
    // AbortSignal.timeout prevents indefinite hangs on unresponsive API servers.
    const data: unknown = await limiter.schedule(() =>
      fetch(url, { signal: AbortSignal.timeout(DEFAULTS.FETCH_TIMEOUT_MS) }).then((res) => {
        if (!res.ok) {
          throw new Error(
            `Alpha Vantage API error: HTTP ${String(res.status)} ${res.statusText}`,
          );
        }
        return res.json() as Promise<unknown>;
      }),
    );

    // Step 4: Detect error responses (rate limit, invalid key, malformed request)
    // Alpha Vantage returns { "Note": "..." } or { "Error Message": "..." }
    // instead of the expected response structure on error
    const response = data as AlphaVantageNewsResponse | AlphaVantageErrorResponse;

    if (isErrorResponse(response)) {
      const errorMsg =
        response.Note ??
        response["Error Message"] ??
        response.Information ??
        "Unknown API error";
      logger.warn({ errorMsg }, "Alpha Vantage API returned error response");
      return [];
    }

    // Step 5: Validate that the response has a feed array
    const validResponse = response as AlphaVantageNewsResponse;
    if (!Array.isArray(validResponse.feed)) {
      logger.warn("Alpha Vantage response missing feed array — returning empty");
      return [];
    }

    // Step 6: Map feed items to NormalizedArticle format
    const articles: NormalizedArticle[] = [];

    for (const item of validResponse.feed) {
      // Validate required fields exist before mapping
      if (!item.title || !item.url) {
        logger.debug({ item: item.url ?? "unknown" }, "Skipping article with missing title or URL");
        continue;
      }

      // Extract ticker symbols from the per-ticker sentiment array
      const symbols: string[] = Array.isArray(item.ticker_sentiment)
        ? item.ticker_sentiment
            .map((t) => t.ticker)
            .filter((ticker): ticker is string => typeof ticker === "string" && ticker.length > 0)
        : [];

      // Parse the non-standard Alpha Vantage date format
      const publishedAt = parseAlphaVantageDate(item.time_published);

      // Build metadata preserving Alpha Vantage's built-in sentiment data
      const metadata: Record<string, unknown> = {
        sentiment_score: item.overall_sentiment_score,
        sentiment_label: item.overall_sentiment_label,
        source_domain: item.source_domain,
        topics: item.topics,
      };

      articles.push({
        title: item.title,
        url: item.url,
        source: "AlphaVantage",
        market: "us_stock",
        content: null, // Alpha Vantage NEWS_SENTIMENT provides summaries only
        summary: item.summary || null,
        symbols,
        publishedAt,
        metadata,
      });
    }

    logger.info(
      { count: articles.length, totalFeed: validResponse.feed.length },
      "Alpha Vantage news fetched and normalized successfully",
    );

    return articles;
  } catch (error: unknown) {
    // Graceful degradation per AAP Rule 0.7.4:
    // Catch all errors, log them, and return empty array.
    // The orchestrator handles error_count incrementing on the api_sources record.
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to fetch Alpha Vantage news — returning empty array",
    );
    return [];
  }
}
