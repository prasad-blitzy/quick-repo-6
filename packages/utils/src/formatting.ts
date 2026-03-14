/**
 * @module formatting
 * @description Financial data formatting helper functions for the Trading Intelligence Application.
 *
 * This is a leaf module consumed by both `apps/api` (Express backend) and `apps/web`
 * (React frontend) via the `@trading-intelligence/utils` barrel export.
 *
 * CRITICAL DESIGN RULES:
 * - Monetary values are always received as `string` (PostgreSQL `numeric(12,4)` serialisation).
 * - NO floating-point arithmetic is performed on monetary strings — only display formatting.
 * - All functions are pure (no side-effects, no state, no I/O).
 * - All functions handle invalid / edge-case inputs gracefully without throwing.
 * - Named exports only — no default export (tree-shakeable).
 */

import { format, formatDistanceToNow, parseISO } from "date-fns";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely parses a string into a finite number.
 * Returns `NaN` for empty strings, whitespace-only strings, null-like values.
 */
function safeParseNumber(value: string): number {
  if (value.trim() === "") {
    return NaN;
  }
  return Number(value);
}

/**
 * Coerces a `number | string` value into a number.
 * Returns `NaN` when the result is not finite.
 */
function coerceToNumber(value: number | string): number {
  const num = typeof value === "string" ? safeParseNumber(value) : value;
  return Number.isFinite(num) ? num : NaN;
}

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

/**
 * Formats a monetary value string for display using locale-aware currency
 * formatting via `Intl.NumberFormat`.
 *
 * @param value    - Numeric string from PostgreSQL `numeric(12,4)`. **NEVER** a `number`.
 * @param currency - ISO 4217 currency code. Defaults to `'USD'`.
 * @param locale   - BCP 47 locale string. Defaults to `'en-US'`.
 *                   Automatically switched to `'en-IN'` when `currency` is `'INR'`
 *                   and no explicit locale is supplied, so Indian number grouping
 *                   (lakhs / crores) is used.
 * @returns Formatted currency string (e.g. `$1,234.5678`, `₹45,678.00`), or
 *          the literal string `'—'` for invalid / empty inputs.
 *
 * @example
 * formatCurrency('1234.5678');            // "$1,234.57"
 * formatCurrency('45678', 'INR');         // "₹45,678.00"
 * formatCurrency('', 'USD');              // "—"
 */
export function formatCurrency(
  value: string,
  currency?: string,
  locale?: string,
): string {
  const parsed = safeParseNumber(value);
  if (Number.isNaN(parsed)) {
    return "—";
  }

  const resolvedCurrency = currency ?? "USD";

  // When currency is INR and no explicit locale was provided, use Indian locale
  // so that Intl.NumberFormat groups digits in lakhs / crores.
  const resolvedLocale =
    locale ?? (resolvedCurrency === "INR" ? "en-IN" : "en-US");

  // Determine the number of fractional digits to preserve from the original
  // string so that we do not discard precision silently.
  const dotIndex = value.indexOf(".");
  const originalFractionDigits =
    dotIndex === -1 ? 0 : value.length - dotIndex - 1;

  // Clamp between 0 and 4 (numeric(12,4) max).
  const fractionDigits = Math.min(Math.max(originalFractionDigits, 2), 4);

  try {
    const formatter = new Intl.NumberFormat(resolvedLocale, {
      style: "currency",
      currency: resolvedCurrency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    return formatter.format(parsed);
  } catch {
    // Intl.NumberFormat can throw for unknown currency codes or locales.
    return "—";
  }
}

// ---------------------------------------------------------------------------
// formatPercentage
// ---------------------------------------------------------------------------

/**
 * Formats a numeric percentage value for display.
 *
 * Accepts both `number` (for in-memory confidence scores) and `string`
 * (for P&L percentages stored as `numeric` in PostgreSQL).
 *
 * @param value    - The percentage value.
 * @param decimals - Number of decimal places. Defaults to `2`.
 * @returns A signed percentage string such as `'+12.34%'`, `'-5.67%'`, or `'0.00%'`.
 *          Returns `'—'` for `NaN` / non-finite inputs.
 *
 * @example
 * formatPercentage(12.345);     // "+12.35%"
 * formatPercentage('-5.67');    // "-5.67%"
 * formatPercentage(0);          // "0.00%"
 */
export function formatPercentage(
  value: number | string,
  decimals?: number,
): string {
  const num = coerceToNumber(value);
  if (Number.isNaN(num)) {
    return "—";
  }

  const resolvedDecimals = decimals ?? 2;
  const fixed = num.toFixed(resolvedDecimals);

  if (num > 0) {
    return `+${fixed}%`;
  }
  // `toFixed` already includes the minus sign for negative values.
  // For zero we omit the sign.
  return `${fixed}%`;
}

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

/**
 * Formats an ISO 8601 date string for display using a `date-fns` pattern.
 *
 * @param isoString - An ISO 8601 date/time string (e.g. `'2026-03-13T14:30:00Z'`).
 * @param formatStr - A `date-fns` format pattern.
 *                    Defaults to `'MMM dd, yyyy HH:mm'` → `"Mar 13, 2026 14:30"`.
 * @returns The formatted date string, or `'Invalid date'` if the input cannot
 *          be parsed.
 *
 * @example
 * formatDate('2026-03-13T14:30:00Z');                  // "Mar 13, 2026 14:30"
 * formatDate('2026-03-13T14:30:00Z', 'yyyy-MM-dd');    // "2026-03-13"
 * formatDate('not-a-date');                             // "Invalid date"
 */
export function formatDate(isoString: string, formatStr?: string): string {
  try {
    const date = parseISO(isoString);
    // parseISO returns an Invalid Date for malformed strings; detect that.
    if (Number.isNaN(date.getTime())) {
      return "Invalid date";
    }
    const resolvedFormat = formatStr ?? "MMM dd, yyyy HH:mm";
    return format(date, resolvedFormat);
  } catch {
    return "Invalid date";
  }
}

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

/**
 * Formats an ISO 8601 date string as a human-readable relative time span.
 *
 * @param isoString - An ISO 8601 date/time string.
 * @returns A relative time string such as `'5 minutes ago'`, `'2 hours ago'`,
 *          or `'Invalid date'` for unparseable inputs.
 *
 * @example
 * // Assuming "now" is 2026-03-13T15:00:00Z:
 * formatRelativeTime('2026-03-13T14:55:00Z'); // "5 minutes ago"
 */
export function formatRelativeTime(isoString: string): string {
  try {
    const date = parseISO(isoString);
    if (Number.isNaN(date.getTime())) {
      return "Invalid date";
    }
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return "Invalid date";
  }
}

// ---------------------------------------------------------------------------
// formatCompactNumber
// ---------------------------------------------------------------------------

/**
 * Abbreviates large numbers for display (e.g. article view counts, market
 * capitalisation, trading volume).
 *
 * Uses `Intl.NumberFormat` with `notation: 'compact'` for locale-aware
 * abbreviated output.
 *
 * @param value - A numeric value. This accepts `number` because it is used for
 *                display counts — NOT monetary values.
 * @returns Abbreviated string such as `'1.2K'`, `'1.5M'`, `'2B'`, or `'0'`.
 *          Returns `'—'` for `NaN` / non-finite inputs.
 *
 * @example
 * formatCompactNumber(1200);       // "1.2K"
 * formatCompactNumber(1500000);    // "1.5M"
 * formatCompactNumber(2000000000); // "2B"
 * formatCompactNumber(0);          // "0"
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }

  try {
    const formatter = new Intl.NumberFormat("en-US", {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    });
    return formatter.format(value);
  } catch {
    // Fallback for environments where compact notation is unsupported.
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// formatSentiment
// ---------------------------------------------------------------------------

/**
 * Formats a sentiment score for display with a sign prefix and fixed 3-decimal
 * precision matching the PostgreSQL `numeric(5,3)` column type.
 *
 * @param score - A number in the range `[-1.000, 1.000]`.
 * @returns A formatted string such as `'+0.850'` or `'-0.320'`.
 *          Returns `'—'` for `NaN` / non-finite inputs.
 *
 * @example
 * formatSentiment(0.85);   // "+0.850"
 * formatSentiment(-0.32);  // "-0.320"
 * formatSentiment(0);      // "0.000"
 */
export function formatSentiment(score: number): string {
  if (!Number.isFinite(score)) {
    return "—";
  }

  const fixed = score.toFixed(3);

  if (score > 0) {
    return `+${fixed}`;
  }
  // `toFixed` already prepends minus for negatives; zero has no sign.
  return fixed;
}

// ---------------------------------------------------------------------------
// formatRiskReward
// ---------------------------------------------------------------------------

/**
 * Formats a risk-reward ratio (stored as PostgreSQL `numeric`) into a
 * human-readable `'1:X.X'` string for trade opportunity cards.
 *
 * @param ratio - A numeric string representing the reward-to-risk multiple.
 *                **NEVER** pass a `number` — values come from PostgreSQL
 *                `numeric` serialisation.
 * @returns A display string such as `'1:2.5'` or `'1:0.8'`.
 *          Returns `'—'` for invalid / empty / zero inputs.
 *
 * @example
 * formatRiskReward('2.5');   // "1:2.5"
 * formatRiskReward('0.8');   // "1:0.8"
 * formatRiskReward('');      // "—"
 * formatRiskReward('0');     // "—"
 */
export function formatRiskReward(ratio: string): string {
  const parsed = safeParseNumber(ratio);
  if (Number.isNaN(parsed) || parsed === 0) {
    return "—";
  }

  // Display with up to 2 decimal places, stripping unnecessary trailing zeros.
  const display = parseFloat(parsed.toFixed(2)).toString();
  return `1:${display}`;
}
