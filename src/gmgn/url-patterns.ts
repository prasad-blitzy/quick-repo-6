/**
 * @fileoverview GMGN Internal API URL Pattern Registry.
 *
 * Pure utility module that maps GMGN.ai's internal API URL patterns to
 * identifiers that downstream parsers and handlers use for data routing.
 *
 * This module is completely self-contained — ZERO external or internal
 * imports. It defines regex patterns for known GMGN API routes and exposes
 * a fast matching function called on every intercepted fetch/XHR request.
 *
 * Consumers:
 * - `src/gmgn/interceptor.ts`  — calls `matchesGmgnApi(url)` to decide interception
 * - `src/gmgn/parsers.ts`      — routes data to the correct parser via pattern type
 * - `entrypoints/content.ts`   — may use pattern types for message routing
 *
 * @module src/gmgn/url-patterns
 */

// =============================================================================
// Pattern Type Definitions
// =============================================================================

/**
 * Discriminated string literal union for all recognized GMGN API pattern types.
 *
 * Each value maps to a specific class of GMGN internal API endpoints and
 * is consumed by `src/gmgn/parsers.ts` to route intercepted responses
 * to the appropriate parser function.
 *
 * - `trending_tokens` — Trending/rank token listings and alternative token lists
 * - `token_detail`    — Detailed per-token information by mint address
 * - `wallet_activity` — Individual wallet trading activity log
 * - `smart_money`     — Smart money wallet signals and classifications
 * - `token_holders`   — Token holder distribution list
 * - `token_security`  — Token safety/security data from GMGN
 * - `token_trade_history` — Token trade history records
 * - `kol_activity`    — KOL (Key Opinion Leader) trading activity
 */
export type GmgnPatternType =
  | 'trending_tokens'
  | 'token_detail'
  | 'wallet_activity'
  | 'smart_money'
  | 'token_holders'
  | 'token_security'
  | 'token_trade_history'
  | 'kol_activity';

// =============================================================================
// URL Pattern Interface
// =============================================================================

/**
 * Describes a single GMGN internal API URL pattern entry.
 *
 * Each entry in the registry maps a regex to a `GmgnPatternType` identifier,
 * with a human-readable description for logging and debugging purposes.
 */
export interface UrlPattern {
  /** Case-insensitive regex that matches the URL path segment of a GMGN API route. */
  readonly regex: RegExp;

  /** The `GmgnPatternType` identifier returned when this pattern matches. */
  readonly type: GmgnPatternType;

  /**
   * Human-readable description of the API route this pattern represents.
   * Includes example URL path for reference.
   */
  readonly description: string;
}

// =============================================================================
// URL Pattern Registry
// =============================================================================

/**
 * Immutable registry of GMGN internal API URL patterns.
 *
 * Each entry maps a regex (tested against the full URL string, including
 * both absolute URLs like `https://gmgn.ai/defi/...` and relative paths
 * like `/defi/...`) to a pattern type identifier.
 *
 * **Ordering matters**: patterns are tested sequentially, so more specific
 * patterns (e.g., `/api/v1/token_holders/`) must appear before more general
 * ones (e.g., `/api/v1/token/`) to avoid false matches. The `token_security`
 * and `token_trade_his` patterns are placed before `token_detail` for this reason.
 *
 * All regex patterns use the case-insensitive flag (`/i`).
 *
 * The registry is designed to be extensible — add new entries as additional
 * GMGN frontend API routes are discovered through observation.
 */
export const GMGN_URL_PATTERNS: readonly UrlPattern[] = [
  // ─── Trending / Rank endpoints ──────────────────────────────────────
  {
    regex: /\/defi\/quotation\/v1\/rank\/[a-z]+\/swaps\//i,
    type: 'trending_tokens',
    description:
      'GMGN trending tokens ranked by swaps (e.g., /defi/quotation/v1/rank/sol/swaps/1h)',
  },
  {
    regex: /\/defi\/quotation\/v1\/tokens\//i,
    type: 'trending_tokens',
    description:
      'GMGN alternative token listing endpoint (e.g., /defi/quotation/v1/tokens/sol)',
  },

  // ─── Wallet activity ────────────────────────────────────────────────
  {
    regex: /\/api\/v1\/wallet_activity\//i,
    type: 'wallet_activity',
    description:
      'GMGN wallet trading activity (e.g., /api/v1/wallet_activity/{address})',
  },

  // ─── Smart money ────────────────────────────────────────────────────
  {
    regex: /\/api\/v1\/smartmoney\//i,
    type: 'smart_money',
    description:
      'GMGN smart money signals (e.g., /api/v1/smartmoney/{address})',
  },

  // ─── Token holders ──────────────────────────────────────────────────
  {
    regex: /\/api\/v1\/token_holders\//i,
    type: 'token_holders',
    description:
      'GMGN token holder list (e.g., /api/v1/token_holders/{address})',
  },

  // ─── Token security ─────────────────────────────────────────────────
  {
    regex: /\/api\/v1\/token_security\//i,
    type: 'token_security',
    description:
      'GMGN token safety/security data (e.g., /api/v1/token_security/{address})',
  },

  // ─── Token trade history ────────────────────────────────────────────
  {
    regex: /\/api\/v1\/token_trade_his\//i,
    type: 'token_trade_history',
    description:
      'GMGN token trade history (e.g., /api/v1/token_trade_his/{address})',
  },

  // ─── KOL activity ───────────────────────────────────────────────────
  {
    regex: /\/api\/v1\/kol\//i,
    type: 'kol_activity',
    description:
      'GMGN KOL (Key Opinion Leader) activity (e.g., /api/v1/kol/{address})',
  },

  // ─── Token detail (MUST be LAST among /api/v1/token* patterns) ─────
  // This is the most general pattern and would match token_holders,
  // token_security, token_trade_his if placed earlier.
  {
    regex: /\/api\/v1\/token\/[a-zA-Z0-9]+/i,
    type: 'token_detail',
    description:
      'GMGN token detail by address (e.g., /api/v1/token/{address})',
  },
] as const;

// =============================================================================
// Core Matching Function
// =============================================================================

/**
 * Tests a URL against all known GMGN internal API patterns.
 *
 * This function is called on **every** `fetch()` and `XMLHttpRequest`
 * originating from the GMGN page context, so it must be fast:
 * - O(n) where n = number of patterns (currently ~10)
 * - No allocations on the hot path when no match is found
 * - No URL parsing — simple regex `.test()` on the raw string
 *
 * Handles both absolute URLs (`https://gmgn.ai/defi/...`) and relative
 * paths (`/defi/...`), as well as URLs with query parameters, since the
 * regex patterns match against path segments (not anchored to start/end).
 *
 * @param url — The full URL string or relative path to test.
 * @returns The `GmgnPatternType` identifier if any pattern matches,
 *          or `null` if the URL does not match any known GMGN API route.
 *
 * @example
 * ```ts
 * matchesGmgnApi('/defi/quotation/v1/rank/sol/swaps/1h');
 * // => 'trending_tokens'
 *
 * matchesGmgnApi('https://gmgn.ai/api/v1/token/So111...112');
 * // => 'token_detail'
 *
 * matchesGmgnApi('https://api.birdeye.so/defi/price');
 * // => null
 * ```
 */
export function matchesGmgnApi(url: string): GmgnPatternType | null {
  // Fast exit for empty or obviously non-API strings.
  // Typical page-context URLs that are not API calls (e.g., static assets,
  // data URIs, blob URLs) will fail the loop quickly since none of them
  // contain the `/defi/quotation/` or `/api/v1/` path segments.
  if (!url) {
    return null;
  }

  for (let i = 0; i < GMGN_URL_PATTERNS.length; i++) {
    if (GMGN_URL_PATTERNS[i].regex.test(url)) {
      return GMGN_URL_PATTERNS[i].type;
    }
  }

  return null;
}

// =============================================================================
// Description Lookup
// =============================================================================

/**
 * Returns a human-readable description of a GMGN pattern type.
 *
 * Useful for structured logging, debug output, and developer tooling.
 * When multiple patterns map to the same type (e.g., two patterns for
 * `'trending_tokens'`), this returns the description of the **first**
 * matching entry in the registry.
 *
 * @param type — A `GmgnPatternType` value to look up.
 * @returns The description string from the matching registry entry,
 *          or `'Unknown pattern'` if the type is not found.
 *
 * @example
 * ```ts
 * getPatternDescription('trending_tokens');
 * // => 'GMGN trending tokens ranked by swaps (e.g., /defi/quotation/v1/rank/sol/swaps/1h)'
 *
 * getPatternDescription('token_detail');
 * // => 'GMGN token detail by address (e.g., /api/v1/token/{address})'
 * ```
 */
export function getPatternDescription(type: GmgnPatternType): string {
  for (let i = 0; i < GMGN_URL_PATTERNS.length; i++) {
    if (GMGN_URL_PATTERNS[i].type === type) {
      return GMGN_URL_PATTERNS[i].description;
    }
  }
  return 'Unknown pattern';
}
