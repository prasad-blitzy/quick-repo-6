/**
 * Reddit RSS Feed Reader — Trading Intelligence API
 *
 * Fetches social sentiment posts from financial subreddits via their public
 * RSS feeds. Currently configured for two high-signal subreddits:
 *
 * - **r/wallstreetbets** — US retail investor sentiment, meme stocks, options flow
 * - **r/IndianStreetBets** — Indian retail investor sentiment, NSE/BSE discussion
 *
 * Architecture:
 * - Uses the `rss-parser` npm package with a custom `User-Agent` header
 *   (required by Reddit for RSS access without HTTP 429 blocks).
 * - Rate limited to 100 queries/minute via a dedicated Bottleneck instance
 *   (`getRedditLimiter()`) per AAP Rule 0.7.4 — per-API isolation.
 * - Per-subreddit graceful degradation: one subreddit failing does NOT
 *   prevent fetching from the other (AAP Rule 0.7.4).
 * - Extracts stock/crypto ticker symbols from post titles using `$SYMBOL`
 *   cashtag patterns and standalone all-caps word heuristics.
 *
 * All returned articles use the `NormalizedArticle` interface with
 * `market: "social"` and `source: "Reddit"` for downstream pipeline routing.
 *
 * @module services/news-fetcher/reddit
 * @see {@link https://www.reddit.com/wiki/rss} Reddit RSS documentation
 */

import RssParser from "rss-parser";
import { createLogger } from "../../lib/logger.js";
import { getRedditLimiter } from "../../lib/rate-limiter.js";
import { REDDIT_URLS } from "../../config/constants.js";
import type { NormalizedArticle } from "./types.js";

// ---------------------------------------------------------------------------
// Module-Level Setup — Logger, Rate Limiter, RSS Parser
// ---------------------------------------------------------------------------

/**
 * Child Pino logger with `{ module: "reddit" }` context binding.
 * All log entries from this module automatically include the module field
 * for structured filtering in log aggregation tools.
 */
const logger = createLogger("reddit");

/**
 * Dedicated Bottleneck rate limiter for Reddit RSS/API access.
 * Configured for 100 queries/minute with maxConcurrent=1 and minTime=600ms.
 * This is an isolated limiter — it does NOT affect rate limits for any
 * other API source (per AAP Rule 0.7.4).
 */
const limiter = getRedditLimiter();

/**
 * RSS parser instance configured with a descriptive User-Agent header.
 * Reddit requires a valid User-Agent for RSS feed access; requests
 * without one may receive HTTP 429 (Too Many Requests) or 403 (Forbidden).
 */
const parser = new RssParser({
  headers: {
    "User-Agent": "TradingIntelligenceBot/1.0",
  },
});

// ---------------------------------------------------------------------------
// Subreddit Configuration
// ---------------------------------------------------------------------------

/**
 * Subreddit targets for social sentiment ingestion. Each entry defines:
 * - `name` — Subreddit name for logging and metadata tagging
 * - `url` — RSS feed URL sourced from the constants module
 * - `market` — Market classification for NormalizedArticle (always "social")
 */
const SUBREDDITS = [
  {
    name: "wallstreetbets",
    url: REDDIT_URLS.WALLSTREETBETS,
    market: "social" as const,
  },
  {
    name: "IndianStreetBets",
    url: REDDIT_URLS.INDIAN_STREET_BETS,
    market: "social" as const,
  },
] as const;

// ---------------------------------------------------------------------------
// Common Non-Ticker Words Filter Set
// ---------------------------------------------------------------------------

/**
 * Set of common all-caps English words that appear in financial subreddit
 * titles but are NOT stock/crypto ticker symbols. This prevents false
 * positives in the heuristic ticker extraction from standalone uppercase
 * words (3–5 characters).
 *
 * Curated from frequent r/wallstreetbets and r/IndianStreetBets vocabulary.
 */
const COMMON_NON_TICKER_WORDS: ReadonlySet<string> = new Set([
  "THE",
  "AND",
  "FOR",
  "WITH",
  "FROM",
  "THIS",
  "THAT",
  "YOLO",
  "GAIN",
  "LOSS",
  "HOLD",
  "SELL",
  "BUY",
  "ALL",
  "ARE",
  "WAS",
  "HAS",
  "HAD",
  "HOW",
  "WHY",
  "WHO",
  "NOT",
  "BUT",
  "ITS",
  "OUR",
  "CAN",
  "NOW",
  "NEW",
  "DAY",
  "GET",
  "GOT",
  "LET",
  "SAY",
  "PUT",
  "RUN",
  "TRY",
  "TOP",
  "BIG",
  "RED",
  "ANY",
  "JUST",
  "LIKE",
  "OVER",
  "BEEN",
  "WHEN",
  "WHAT",
  "DOES",
  "WILL",
  "THAN",
  "THEY",
  "INTO",
  "SOME",
  "ONLY",
  "TAKE",
  "MADE",
  "MAKE",
  "MUCH",
  "THEN",
  "THEM",
  "WELL",
  "BACK",
  "CALL",
  "PUTS",
  "DOWN",
  "LONG",
  "BEAR",
  "BULL",
  "PUMP",
  "DUMP",
  "MOON",
  "HODL",
  "EDIT",
  "POST",
  "LINK",
  "FREE",
  "HELP",
  "NEED",
  "WANT",
  "WENT",
  "WEEK",
  "YEAR",
  "GOOD",
  "BEST",
  "LAST",
  "NEXT",
  "KEEP",
  "EVEN",
  "EVER",
  "SHIT",
  "FUCK",
  "LMAO",
  "TLDR",
]);

// ---------------------------------------------------------------------------
// Symbol Extraction Helper
// ---------------------------------------------------------------------------

/**
 * Extracts potential stock/crypto ticker symbols from a post title.
 *
 * Uses a two-phase extraction strategy:
 *
 * 1. **Cashtag matching** — Captures `$SYMBOL` patterns (e.g., `$AAPL`,
 *    `$BTC`) which are the conventional ticker notation on financial
 *    subreddits. These are high-confidence matches.
 *
 * 2. **Standalone uppercase heuristic** — Captures all-caps words of 3–5
 *    characters (e.g., `NVDA`, `TSLA`) that may be tickers written without
 *    the `$` prefix. Filtered against {@link COMMON_NON_TICKER_WORDS} to
 *    reduce false positives.
 *
 * Returns a deduplicated array of uppercase symbols.
 *
 * @param title — The post title to extract symbols from.
 * @returns Array of unique uppercase ticker symbols (may be empty).
 *
 * @example
 * extractSymbols("$AAPL is mooning! Buy NVDA too")
 * // => ["AAPL", "NVDA"]
 *
 * @example
 * extractSymbols("YOLO on $GME puts")
 * // => ["GME"]  (YOLO and PUTS are filtered as common words)
 */
function extractSymbols(title: string): string[] {
  const symbols: string[] = [];

  // Phase 1: Match $SYMBOL cashtag patterns (high confidence)
  const dollarMatches = title.match(/\$([A-Z]{1,5})\b/g);
  if (dollarMatches) {
    for (const match of dollarMatches) {
      const symbol = match.replace("$", "");
      if (!symbols.includes(symbol)) {
        symbols.push(symbol);
      }
    }
  }

  // Phase 2: Match standalone all-caps words (3–5 chars) as potential tickers
  const capsMatches = title.match(/\b([A-Z]{3,5})\b/g);
  if (capsMatches) {
    for (const word of capsMatches) {
      if (!COMMON_NON_TICKER_WORDS.has(word) && !symbols.includes(word)) {
        symbols.push(word);
      }
    }
  }

  // Return deduplicated array (Set handles any remaining duplicates)
  return [...new Set(symbols)];
}

// ---------------------------------------------------------------------------
// Main Export — fetchRedditPosts
// ---------------------------------------------------------------------------

/**
 * Fetches and normalizes posts from all configured financial subreddits.
 *
 * Concurrently requests RSS feeds for r/wallstreetbets and r/IndianStreetBets
 * via `Promise.allSettled()`, ensuring that a failure in one subreddit does
 * not prevent fetching from the other (graceful degradation per AAP Rule
 * 0.7.4). Each request is scheduled through the Reddit-specific Bottleneck
 * rate limiter to respect the 100 queries/minute free-tier limit.
 *
 * For each successfully fetched feed, items are mapped to the
 * {@link NormalizedArticle} standardized format with:
 * - `source: "Reddit"`
 * - `market: "social"`
 * - Symbols extracted from post titles via cashtag and heuristic matching
 * - Metadata including subreddit name, author, and categories
 *
 * Posts without a valid URL are filtered out since URL is the deduplication
 * key in the downstream database insert (AAP Rule 0.7.4 — URL-based
 * deduplication).
 *
 * @returns Array of normalized articles from all subreddits. Returns an
 *          empty array if all subreddits fail (never throws).
 *
 * @example
 * ```typescript
 * import { fetchRedditPosts } from "./reddit.js";
 *
 * const posts = await fetchRedditPosts();
 * console.log(`Fetched ${posts.length} Reddit posts`);
 * ```
 */
export async function fetchRedditPosts(): Promise<NormalizedArticle[]> {
  logger.info("Starting Reddit RSS feed fetch");

  // Fetch all subreddit feeds concurrently via Promise.allSettled
  // Each request is rate-limited through the dedicated Reddit limiter
  const results = await Promise.allSettled(
    SUBREDDITS.map((sub) =>
      limiter.schedule(() => parser.parseURL(sub.url)),
    ),
  );

  const articles: NormalizedArticle[] = [];

  // Process each subreddit result independently for graceful degradation
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const subreddit = SUBREDDITS[i];

    // Safety check — should never be undefined given SUBREDDITS is fixed-length
    if (!result || !subreddit) {
      continue;
    }

    if (result.status === "rejected") {
      // Log the error but do NOT rethrow — other subreddits may still succeed
      logger.error(
        {
          subreddit: subreddit.name,
          error: result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        },
        "Failed to fetch Reddit RSS feed for subreddit",
      );
      continue;
    }

    // Process fulfilled result — map RSS items to NormalizedArticle
    const feed = result.value;
    const feedItems = feed.items;

    logger.info(
      { subreddit: subreddit.name, itemCount: feedItems.length },
      "Successfully fetched Reddit RSS feed",
    );

    for (const item of feedItems) {
      // URL is required for deduplication — skip items without one
      const url = item.link;
      if (!url || url.trim().length === 0) {
        logger.debug(
          { subreddit: subreddit.name, title: item.title },
          "Skipping Reddit post without URL",
        );
        continue;
      }

      // Determine publication date — fall back to current time if unavailable
      const publishedAt = item.pubDate
        ? new Date(item.pubDate)
        : new Date();

      // Extract content from the RSS item — prefer contentSnippet (plain text)
      // over content (may contain HTML), defaulting to null if neither exists
      const content: string | null = item.contentSnippet
        ?? item.content
        ?? null;

      // Extract ticker symbols from the post title
      const title = item.title ?? "Untitled";
      const symbols = extractSymbols(title);

      // Build metadata with Reddit-specific fields for downstream analysis
      const metadata: Record<string, unknown> = {
        subreddit: subreddit.name,
        author: item.creator ?? null,
        categories: item.categories ?? [],
      };

      articles.push({
        title,
        url,
        source: "Reddit",
        market: subreddit.market,
        content,
        summary: null,
        symbols,
        publishedAt,
        metadata,
      });
    }
  }

  logger.info(
    { totalArticles: articles.length },
    "Reddit RSS feed fetch complete",
  );

  return articles;
}
