/**
 * src/utils/formatting.ts — Display Formatters for Crypto Trading Data
 *
 * Pure utility module providing memecoin-aware display formatting functions
 * for prices, market caps, percentages, relative timestamps, and volumes.
 * Used by UI components (TokenCard, ScoreGauge, SignalPanel, ExitStrategy,
 * NewTokenFeed) and logging utilities.
 *
 * Design principles:
 * - No external dependencies — uses only built-in JS/TS APIs (Intl, Math, Date)
 * - Pure functions — no side effects, no state, no DOM access
 * - TypeScript strict mode — all parameters and return types fully typed
 * - Memecoin-aware — handles 6-8+ decimal place prices without showing $0.00
 * - Robust edge-case handling — NaN, Infinity, null, undefined never throw
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured result from formatPercent providing both the formatted text
 * and a semantic color hint for UI rendering.
 */
export interface FormattedPercent {
  /** Formatted percentage string with sign prefix, e.g., "+12.35%" or "-5.67%" */
  text: string;
  /** Semantic color hint: 'positive' for gains, 'negative' for losses, 'neutral' for zero/invalid */
  colorHint: 'positive' | 'negative' | 'neutral';
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/** Unicode subscript digit characters for subscript notation of tiny prices */
const SUBSCRIPT_DIGITS: Record<string, string> = {
  '0': '\u2080',
  '1': '\u2081',
  '2': '\u2082',
  '3': '\u2083',
  '4': '\u2084',
  '5': '\u2085',
  '6': '\u2086',
  '7': '\u2087',
  '8': '\u2088',
  '9': '\u2089',
};

/**
 * Converts a non-negative integer to its Unicode subscript representation.
 * For example, 5 → "₅", 12 → "₁₂".
 */
function toSubscript(n: number): string {
  return String(n)
    .split('')
    .map((digit) => SUBSCRIPT_DIGITS[digit] ?? digit)
    .join('');
}

/**
 * Validates and sanitizes a numeric input. Returns NaN for truly invalid values,
 * or the sanitized number otherwise. Coerces null/undefined to NaN.
 */
function sanitizeNumber(n: unknown): number {
  if (n === null || n === undefined) {
    return NaN;
  }
  const num = Number(n);
  return num;
}

/**
 * Checks whether a number is finite and usable for formatting.
 * Returns false for NaN, Infinity, -Infinity.
 */
function isValidNumber(n: number): boolean {
  return Number.isFinite(n);
}

/**
 * Abbreviates a large absolute number using K/M/B/T suffixes.
 * Returns an object with the scaled value and suffix string.
 * Used by both formatMarketCap and formatVolume.
 */
function abbreviateNumber(absValue: number): { scaled: number; suffix: string } {
  if (absValue >= 1_000_000_000_000) {
    return { scaled: absValue / 1_000_000_000_000, suffix: 'T' };
  }
  if (absValue >= 1_000_000_000) {
    return { scaled: absValue / 1_000_000_000, suffix: 'B' };
  }
  if (absValue >= 1_000_000) {
    return { scaled: absValue / 1_000_000, suffix: 'M' };
  }
  if (absValue >= 1_000) {
    return { scaled: absValue / 1_000, suffix: 'K' };
  }
  return { scaled: absValue, suffix: '' };
}

/**
 * Formats an abbreviated number with 1-2 meaningful decimal places.
 * - If the fractional part is effectively zero, returns 0 decimals for clean display.
 * - If >= 100, shows 1 decimal (e.g., 123.4K).
 * - If >= 10, shows 1 decimal (e.g., 12.5M).
 * - Otherwise, shows 2 decimals (e.g., 1.23B).
 */
function formatAbbreviatedValue(scaled: number): string {
  if (scaled >= 100) {
    const formatted = scaled.toFixed(1);
    // Remove trailing .0 for clean display (e.g., 100.0 → 100)
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
  }
  if (scaled >= 10) {
    const formatted = scaled.toFixed(1);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
  }
  const formatted = scaled.toFixed(2);
  // Remove trailing zeros: 1.50 → 1.5, 2.00 → 2
  return formatted.replace(/\.?0+$/, '') || formatted;
}

/**
 * Formats a dollar-prefixed abbreviated value (used by marketcap and volume).
 * Handles edge cases for NaN, Infinity, zero, and negative numbers.
 */
function formatDollarAbbreviated(n: number): string {
  const num = sanitizeNumber(n);
  if (!isValidNumber(num)) {
    return '$—';
  }
  if (num === 0) {
    return '$0';
  }

  const isNegative = num < 0;
  const absValue = Math.abs(num);
  const { scaled, suffix } = abbreviateNumber(absValue);
  const formattedValue = suffix ? formatAbbreviatedValue(scaled) : formatSmallDollarValue(absValue);

  return `${isNegative ? '-' : ''}$${formattedValue}${suffix}`;
}

/**
 * Formats a small dollar value (< 1000) with appropriate decimal places.
 */
function formatSmallDollarValue(absValue: number): string {
  if (absValue >= 1) {
    return absValue.toFixed(2).replace(/\.?0+$/, '') || '0';
  }
  return absValue.toFixed(2);
}

// ---------------------------------------------------------------------------
// Month names for date formatting
// ---------------------------------------------------------------------------

const MONTH_NAMES: readonly string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Formats a token price with memecoin-aware dynamic decimal places.
 *
 * Memecoin prices frequently have 6-8+ decimal places (e.g., $0.00000123).
 * This formatter adapts precision based on the price magnitude:
 *
 * - Prices >= $1,000: Locale-aware comma separators + 2 decimals (e.g., "$1,234.56")
 * - Prices >= $1: 2 decimal places (e.g., "$1.23")
 * - Prices >= $0.01: 4 decimal places (e.g., "$0.0123")
 * - Prices >= $0.0001: 6 decimal places (e.g., "$0.000123")
 * - Prices < $0.0001: Subscript notation for leading zeros (e.g., "$0.0₅123")
 *   The subscript digit indicates the count of leading zeros after the decimal,
 *   followed by up to 4 significant digits.
 *
 * @param n - The price value in USD. Accepts any numeric type.
 * @returns A formatted price string with "$" prefix. Returns "$—" for invalid inputs.
 *
 * @example
 * formatPrice(1234.567)    // "$1,234.57"
 * formatPrice(1.23)        // "$1.23"
 * formatPrice(0.0123)      // "$0.0123"
 * formatPrice(0.000123)    // "$0.000123"
 * formatPrice(0.00000123)  // "$0.0₅123"
 * formatPrice(0)           // "$0.00"
 * formatPrice(NaN)         // "$—"
 */
export function formatPrice(n: number): string {
  const num = sanitizeNumber(n);

  if (!isValidNumber(num)) {
    return '$—';
  }

  if (num === 0) {
    return '$0.00';
  }

  const isNegative = num < 0;
  const absValue = Math.abs(num);
  const prefix = isNegative ? '-$' : '$';

  // Large prices: use locale-aware comma separators with 2 decimal places
  if (absValue >= 1000) {
    // Use Intl.NumberFormat for consistent locale-aware formatting
    const formatter = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${prefix}${formatter.format(absValue)}`;
  }

  // Standard prices >= $1: 2 decimal places
  if (absValue >= 1) {
    return `${prefix}${absValue.toFixed(2)}`;
  }

  // Mid-range prices >= $0.01: 4 decimal places
  if (absValue >= 0.01) {
    return `${prefix}${absValue.toFixed(4)}`;
  }

  // Small prices >= $0.0001: 6 decimal places
  if (absValue >= 0.0001) {
    return `${prefix}${absValue.toFixed(6)}`;
  }

  // Very small memecoin prices < $0.0001: subscript notation
  // Count leading zeros after the decimal point and display as $0.0₍n₎XXXX
  return `${prefix}${formatSubscriptPrice(absValue)}`;
}

/**
 * Formats a very small price using subscript notation.
 * Converts a price like 0.00000123 to "0.0₅123" where ₅ indicates
 * 5 leading zeros after the decimal point.
 *
 * @param absValue - Absolute price value, must be < 0.0001 and > 0
 * @returns Formatted string with subscript zero count notation
 */
function formatSubscriptPrice(absValue: number): string {
  // Convert to string to count leading zeros after decimal
  // Use toPrecision to get sufficient digits without scientific notation
  // For very tiny numbers, we need enough precision to see significant digits
  const precisionStr = absValue.toPrecision(4);

  // Handle scientific notation output (e.g., "1.230e-7")
  if (precisionStr.includes('e')) {
    const [mantissa, exponent] = precisionStr.split('e');
    const exp = Math.abs(parseInt(exponent, 10));
    const mantissaDigits = mantissa.replace('.', '');
    // Leading zeros after decimal = exponent - 1
    const leadingZeros = exp - 1;

    if (leadingZeros >= 1) {
      // Show the significant digits after the subscript zero count
      const significantDigits = mantissaDigits.replace(/0+$/, '').slice(0, 4);
      return `0.0${toSubscript(leadingZeros)}${significantDigits}`;
    }
  }

  // Fallback: manually count leading zeros in the decimal representation
  const fullStr = absValue.toFixed(20);
  const afterDecimal = fullStr.split('.')[1] ?? '';
  let leadingZeros = 0;
  for (const char of afterDecimal) {
    if (char === '0') {
      leadingZeros++;
    } else {
      break;
    }
  }

  if (leadingZeros >= 4) {
    // Extract up to 4 significant digits after the leading zeros
    const significantPart = afterDecimal.slice(leadingZeros, leadingZeros + 4).replace(/0+$/, '');
    return `0.0${toSubscript(leadingZeros)}${significantPart || '0'}`;
  }

  // If fewer than 4 leading zeros, just show full decimal representation
  return absValue.toFixed(leadingZeros + 4);
}

/**
 * Formats a market capitalization value with K/M/B/T abbreviation.
 *
 * Abbreviation thresholds:
 * - < $1,000: Raw number with "$" prefix (e.g., "$500")
 * - >= $1,000: K suffix (e.g., "$12.5K")
 * - >= $1,000,000: M suffix (e.g., "$1.5M")
 * - >= $1,000,000,000: B suffix (e.g., "$3.4B")
 * - >= $1,000,000,000,000: T suffix (e.g., "$1.1T")
 *
 * @param n - The market cap value in USD.
 * @returns A formatted abbreviated string with "$" prefix. Returns "$—" for invalid inputs.
 *
 * @example
 * formatMarketCap(500)           // "$500"
 * formatMarketCap(12500)         // "$12.5K"
 * formatMarketCap(1500000)       // "$1.5M"
 * formatMarketCap(3400000000)    // "$3.4B"
 * formatMarketCap(1100000000000) // "$1.1T"
 * formatMarketCap(0)             // "$0"
 * formatMarketCap(NaN)           // "$—"
 */
export function formatMarketCap(n: number): string {
  return formatDollarAbbreviated(n);
}

/**
 * Formats a numeric value as a percentage with sign prefix and color hint.
 *
 * Returns a `FormattedPercent` object containing:
 * - `text`: The formatted string with sign prefix (e.g., "+12.35%", "-5.67%", "0.00%")
 * - `colorHint`: Semantic hint for UI coloring ('positive', 'negative', or 'neutral')
 *
 * @param n - The percentage value (e.g., 12.345 for +12.345%). Not pre-divided by 100.
 * @returns A `FormattedPercent` object with formatted text and color hint.
 *
 * @example
 * formatPercent(12.345)   // { text: "+12.35%", colorHint: "positive" }
 * formatPercent(-5.67)    // { text: "-5.67%", colorHint: "negative" }
 * formatPercent(0)        // { text: "0.00%", colorHint: "neutral" }
 * formatPercent(NaN)      // { text: "—%", colorHint: "neutral" }
 * formatPercent(Infinity) // { text: "—%", colorHint: "neutral" }
 */
export function formatPercent(n: number): FormattedPercent {
  const num = sanitizeNumber(n);

  if (!isValidNumber(num)) {
    return { text: '—%', colorHint: 'neutral' };
  }

  if (num === 0) {
    return { text: '0.00%', colorHint: 'neutral' };
  }

  // Clamp display for extremely large percentages (beyond ±999,999.99%)
  const clampedAbs = Math.min(Math.abs(num), 999_999.99);
  const formatted = clampedAbs.toFixed(2);

  if (num > 0) {
    return { text: `+${formatted}%`, colorHint: 'positive' };
  }

  return { text: `-${formatted}%`, colorHint: 'negative' };
}

/**
 * Formats a Unix timestamp as a human-readable relative time string.
 *
 * Auto-detects whether the timestamp is in seconds or milliseconds:
 * - Timestamps < 10^12 are treated as seconds and multiplied by 1000
 * - Timestamps >= 10^12 are treated as milliseconds
 *
 * Relative time formatting:
 * - < 5 seconds: "just now"
 * - < 60 seconds: "Xs ago" (e.g., "30s ago")
 * - < 60 minutes: "Xm ago" (e.g., "5m ago")
 * - < 24 hours: "Xh ago" (e.g., "2h ago")
 * - < 7 days: "Xd ago" (e.g., "3d ago")
 * - >= 7 days: Formatted date "MMM DD" (e.g., "Mar 14")
 *
 * Future timestamps are displayed as "in Xm", "in Xh", etc.
 *
 * @param timestamp - Unix timestamp in seconds or milliseconds.
 * @returns A human-readable relative time string. Returns "—" for invalid inputs.
 *
 * @example
 * formatTimeAgo(Date.now() - 3600000)  // "1h ago"
 * formatTimeAgo(Date.now() - 30000)    // "30s ago"
 * formatTimeAgo(Date.now() - 2000)     // "just now"
 * formatTimeAgo(1710400000)            // Auto-detects seconds, e.g., "Mar 14"
 */
export function formatTimeAgo(timestamp: number): string {
  const ts = sanitizeNumber(timestamp);

  if (!isValidNumber(ts) || ts < 0) {
    return '—';
  }

  // Auto-detect seconds vs milliseconds
  // Unix timestamps in seconds are < 10^12 until year 33658
  // Millisecond timestamps are >= 10^12 since ~2001
  const tsMs = ts < 1_000_000_000_000 ? ts * 1000 : ts;

  const now = Date.now();
  const diffMs = now - tsMs;

  // Handle timestamp of 0 (epoch) — treat as invalid/unknown
  if (tsMs === 0) {
    return '—';
  }

  // Future timestamps
  if (diffMs < 0) {
    const futureDiff = Math.abs(diffMs);
    return formatFutureTime(futureDiff);
  }

  // Past timestamps
  return formatPastTime(diffMs, tsMs);
}

/**
 * Formats a future time difference as "in Xm", "in Xh", etc.
 */
function formatFutureTime(diffMs: number): string {
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  if (hours < 24) {
    return `in ${hours}h`;
  }
  if (days < 7) {
    return `in ${days}d`;
  }
  // For far future, just show the date
  const futureDate = new Date(Date.now() + diffMs);
  return `${MONTH_NAMES[futureDate.getUTCMonth()]} ${futureDate.getUTCDate()}`;
}

/**
 * Formats a past time difference as "Xs ago", "Xm ago", etc.
 */
function formatPastTime(diffMs: number, tsMs: number): string {
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days < 7) {
    return `${days}d ago`;
  }

  // >= 7 days: show formatted date "MMM DD"
  const date = new Date(tsMs);
  const month = MONTH_NAMES[date.getUTCMonth()];
  const day = date.getUTCDate();
  return `${month} ${day}`;
}

/**
 * Formats a trading volume value with K/M/B abbreviation.
 *
 * Uses the same abbreviation scheme as formatMarketCap but is semantically
 * distinct for volume-specific display contexts.
 *
 * @param n - The volume value in USD.
 * @returns A formatted abbreviated string with "$" prefix. Returns "$—" for invalid inputs.
 *
 * @example
 * formatVolume(250000)    // "$250K"
 * formatVolume(1500000)   // "$1.5M"
 * formatVolume(500)       // "$500"
 * formatVolume(0)         // "$0"
 * formatVolume(NaN)       // "$—"
 */
export function formatVolume(n: number): string {
  return formatDollarAbbreviated(n);
}
