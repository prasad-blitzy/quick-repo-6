/**
 * News Article Card Component — `apps/web/src/components/NewsCard.tsx`
 *
 * Displays a single news article in the Trading Intelligence dashboard's
 * live news feed. Each card renders:
 * - Source badge with color-coding by data source type
 * - Market label with flag/symbol emoji (🇺🇸 US, 🇮🇳 India, ₿ Crypto, 💬 Social)
 * - Relative published time ("5 minutes ago") via date-fns
 * - Article title and content snippet (3-line clamp)
 * - Ticker symbol badges
 * - Analysis pipeline status indicator (✓ Analyzed / ⏳ Pending)
 * - External "Read →" link opening in a new tab
 *
 * Styling: Consumes CSS custom properties and utility classes from
 * `globals.css` exclusively — no CSS modules, no CSS-in-JS, no
 * component library. Dark theme only.
 *
 * @module apps/web/src/components/NewsCard
 */

import clsx from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { Market } from '../types';
import type { NewsArticle } from '../types';

// ---------------------------------------------------------------------------
// Props Interface
// ---------------------------------------------------------------------------

/**
 * Props accepted by the {@link NewsCard} component.
 *
 * @property article  — The news article data object to render.
 * @property className — Optional additional CSS class(es) appended to the
 *                       root card element via `clsx`.
 */
interface NewsCardProps {
  article: NewsArticle;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helper — Source Badge Class Mapper
// ---------------------------------------------------------------------------

/**
 * Maps a lowercase news source identifier to a badge CSS class variant.
 *
 * Badge class mapping:
 * - `badge-info`    — Finnhub, Alpha Vantage, CNBC, MarketWatch (financial APIs)
 * - `badge-warning` — CoinGecko, CryptoCompare, Binance (crypto sources)
 * - `badge-success` — RSS feeds: Economic Times, Financial Express, Business Standard
 * - `badge-danger`  — Reddit (social/meme sentiment)
 * - `badge-info`    — Default fallback for unrecognised sources
 *
 * @param source - Lowercase source identifier from `NewsArticle.source`.
 * @returns The corresponding badge variant CSS class name.
 */
function getSourceBadgeClass(source: string): string {
  const lower = source.toLowerCase();

  // Crypto data sources
  if (
    lower.includes('coingecko') ||
    lower.includes('cryptocompare') ||
    lower.includes('binance')
  ) {
    return 'badge-warning';
  }

  // Indian market RSS feeds
  if (
    lower.includes('economic-times') ||
    lower.includes('financial-express') ||
    lower.includes('business-standard') ||
    lower.includes('rss')
  ) {
    return 'badge-success';
  }

  // Social / Reddit
  if (lower.includes('reddit')) {
    return 'badge-danger';
  }

  // Financial APIs (Finnhub, Alpha Vantage, CNBC, MarketWatch) and fallback
  return 'badge-info';
}

// ---------------------------------------------------------------------------
// Helper — Market Label Mapper
// ---------------------------------------------------------------------------

/**
 * Converts a {@link Market} enum value into a human-readable label prefixed
 * with a flag or symbol emoji for instant visual identification.
 *
 * @param market - The market category enum value.
 * @returns A display string such as `"🇺🇸 US Stocks"` or `"₿ Crypto"`.
 */
function getMarketLabel(market: Market): string {
  const labels: Record<Market, string> = {
    [Market.US_STOCK]: '🇺🇸 US',
    [Market.INDIAN_EQUITY]: '🇮🇳 India',
    [Market.CRYPTO]: '₿ Crypto',
    [Market.SOCIAL]: '💬 Social',
  };

  return labels[market] ?? market;
}

// ---------------------------------------------------------------------------
// Helper — Capitalise Source Name for Display
// ---------------------------------------------------------------------------

/**
 * Transforms a kebab-case or lowercase source identifier into a
 * human-readable display name.
 *
 * Examples:
 * - `'finnhub'`            → `'Finnhub'`
 * - `'economic-times-rss'` → `'Economic Times Rss'`
 * - `'coingecko'`          → `'Coingecko'`
 *
 * @param source - The raw source identifier string.
 * @returns A capitalised display-friendly source name.
 */
function formatSourceName(source: string): string {
  return source
    .split('-')
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : ''))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Helper — Sentiment Score Display
// ---------------------------------------------------------------------------

/**
 * Converts a nullable sentiment score string into a display object with
 * an emoji indicator, text label, and badge CSS class.
 *
 * Sentiment scores are stored as PostgreSQL `numeric(5,3)` mapped to
 * `string | null` in the shared `NewsArticle` type. The score ranges
 * from -1.000 (very negative) to +1.000 (very positive).
 *
 * Per AAP Rule 0.7.3: negative financial news has 2–3x the market
 * impact of positive news, reflected in the wider negative threshold.
 *
 * | Score Range       | Display            | Badge Class     |
 * |-------------------|--------------------|-----------------|
 * | ≥ 0.300           | 📈 Bullish         | badge-success   |
 * | 0.050 to 0.299    | 🟢 Positive        | badge-success   |
 * | -0.049 to 0.049   | ➡️ Neutral         | badge-neutral   |
 * | -0.299 to -0.050  | 🔴 Negative        | badge-danger    |
 * | ≤ -0.300          | 📉 Bearish         | badge-danger    |
 * | null              | (not displayed)    | —               |
 *
 * @param score — Sentiment score as a string or null.
 * @returns Display object or null if score is not available.
 */
function getSentimentDisplay(
  score: string | null,
): { emoji: string; label: string; badgeClass: string } | null {
  if (score === null || score === '') return null;

  const numericScore = parseFloat(score);
  if (Number.isNaN(numericScore)) return null;

  if (numericScore >= 0.3) {
    return { emoji: '📈', label: 'Bullish', badgeClass: 'badge-success' };
  }
  if (numericScore >= 0.05) {
    return { emoji: '🟢', label: 'Positive', badgeClass: 'badge-success' };
  }
  if (numericScore > -0.05) {
    return { emoji: '➡️', label: 'Neutral', badgeClass: 'badge-neutral' };
  }
  if (numericScore > -0.3) {
    return { emoji: '🔴', label: 'Negative', badgeClass: 'badge-danger' };
  }
  return { emoji: '📉', label: 'Bearish', badgeClass: 'badge-danger' };
}

// ---------------------------------------------------------------------------
// NewsCard Component
// ---------------------------------------------------------------------------

/**
 * News article card component for the live news feed.
 *
 * Renders a dark-themed card using the `.card` base class from `globals.css`
 * with a fade-in entrance animation. The card is divided into three sections:
 *
 * 1. **Header** — Source badge, market label badge, sentiment badge, and
 *    relative timestamp.
 * 2. **Body** — Article title and 3-line-clamped content snippet.
 * 3. **Footer** — Ticker symbol badges, analysis status indicator, and an
 *    external "Read →" link.
 *
 * @example
 * ```tsx
 * <NewsCard article={article} className="custom-class" />
 * ```
 */
export default function NewsCard({ article, className }: NewsCardProps) {
  // Format the published timestamp as a relative distance string.
  // Wrapping in a try-catch guards against malformed date strings from the API.
  let timeAgo: string;
  try {
    timeAgo = formatDistanceToNow(new Date(article.publishedAt), {
      addSuffix: true,
    });
  } catch {
    timeAgo = 'Unknown time';
  }

  const sourceBadgeClass = getSourceBadgeClass(article.source);
  const sourceName = formatSourceName(article.source);
  const marketLabel = getMarketLabel(article.market);
  const sentimentDisplay = getSentimentDisplay(article.sentimentScore);

  return (
    <article
      className={clsx('card', 'animate-fade-in', className)}
      aria-label={`News article: ${article.title}`}
    >
      {/* ── Card Header ─────────────────────────────────────────── */}
      <div className="card-header">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Source badge */}
          <span className={clsx('badge', sourceBadgeClass)}>
            {sourceName}
          </span>

          {/* Market label badge */}
          <span className="badge badge-neutral">
            {marketLabel}
          </span>

          {/* Sentiment badge — shown only when sentimentScore is non-null */}
          {sentimentDisplay !== null && (
            <span
              className={clsx('badge', sentimentDisplay.badgeClass)}
              title={`Sentiment: ${article.sentimentScore ?? 'N/A'}`}
            >
              {sentimentDisplay.emoji} {sentimentDisplay.label}
            </span>
          )}
        </div>

        {/* Relative timestamp */}
        <time
          className="text-secondary text-xs whitespace-nowrap"
          dateTime={article.publishedAt}
          title={article.publishedAt}
        >
          {timeAgo}
        </time>
      </div>

      {/* ── Card Body ───────────────────────────────────────────── */}
      <div className="card-body">
        <h3 className="card-title mb-2">{article.title}</h3>

        {article.content.length > 0 && (
          <p className="line-clamp-3 break-words">
            {article.content}
          </p>
        )}
      </div>

      {/* ── Card Footer ─────────────────────────────────────────── */}
      <div className="card-footer">
        {/* Ticker symbol badges */}
        <div className="flex items-center gap-1 flex-wrap">
          {article.symbols.length > 0
            ? article.symbols.map((symbol) => (
                <span
                  key={symbol}
                  className="badge badge-accent text-xs"
                >
                  {symbol}
                </span>
              ))
            : (
                <span className="text-tertiary text-xs">No symbols</span>
              )}
        </div>

        <div className="flex items-center gap-2">
          {/* Analysis pipeline status indicator */}
          <span
            className={clsx(
              'badge',
              article.isAnalyzed ? 'badge-success' : 'badge-warning',
            )}
          >
            {article.isAnalyzed ? '✓ Analyzed' : '⏳ Pending'}
          </span>

          {/* External article link */}
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm whitespace-nowrap"
            aria-label={`Read full article: ${article.title}`}
          >
            Read →
          </a>
        </div>
      </div>
    </article>
  );
}
