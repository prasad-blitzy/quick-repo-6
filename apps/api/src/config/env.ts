/**
 * Environment Variable Validation and Configuration Module
 *
 * This is the MOST FOUNDATIONAL module in the entire backend. It validates ALL
 * required and optional environment variables at startup using Zod, provides
 * fully typed access to configuration values, and throws descriptive errors
 * listing ALL validation failures if any are detected.
 *
 * Every other backend module imports from this file to access configuration.
 *
 * @module config/env
 */

import { z } from "zod";
import "dotenv/config";

/**
 * Zod schema defining the shape and validation rules for every environment
 * variable consumed by the Trading Intelligence Application backend.
 *
 * - Required fields with no `.default()` cause startup failure if missing.
 * - Optional fields supply sensible defaults matching `.env.example` and the AAP.
 * - `z.coerce.number()` converts process.env string values to numbers.
 * - Enum fields restrict values to explicitly allowed sets.
 */
export const envSchema = z.object({
  // ---------------------------------------------------------------------------
  // Database Configuration
  // ---------------------------------------------------------------------------

  /** Full PostgreSQL connection string used by Drizzle ORM. REQUIRED. */
  DATABASE_URL: z.string().url(),

  /**
   * Toggle between local PostgreSQL (`pg` driver) and Supabase (`postgres`
   * driver with `prepare: false` for pgBouncer transaction pooler compatibility).
   * @see AAP Rule 0.7.4 — seamless switching via environment variables
   */
  DATABASE_PROVIDER: z.enum(["local", "supabase"]).default("local"),

  // ---------------------------------------------------------------------------
  // Redis Configuration
  // ---------------------------------------------------------------------------

  /** Redis 7 connection URL for BullMQ job queues. */
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // ---------------------------------------------------------------------------
  // OpenRouter LLM Configuration
  // ---------------------------------------------------------------------------

  /** OpenRouter API key (starts with sk-or-). REQUIRED — no default. */
  OPENROUTER_API_KEY: z.string().min(1),

  /** OpenRouter API base URL used as `baseURL` for ChatOpenAI. */
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1"),

  /**
   * Stage 1 — Filter: Binary relevance classification.
   * DeepSeek V3.2 — $0.25/$0.38 per 1M tokens.
   */
  FILTER_MODEL: z.string().default("deepseek/deepseek-v3-0324"),

  /**
   * Stage 2 — Sentiment: Nuanced financial sentiment analysis.
   * Claude Haiku 4.5 — $1.00/$5.00 per 1M tokens.
   */
  SENTIMENT_MODEL: z.string().default("anthropic/claude-haiku-4-5-20241022"),

  /**
   * Stage 3 — Trade Detection: Identifies actionable trade opportunities.
   * Claude Haiku 4.5 — $1.00/$5.00 per 1M tokens.
   */
  TRADE_DETECT_MODEL: z.string().default("anthropic/claude-haiku-4-5-20241022"),

  /**
   * Stage 4 — Recommendation: Generates structured trade recommendations.
   * Only ~25% of articles reach this stage (conditional short-circuiting).
   * Claude Sonnet 4.6 — $3.00/$15.00 per 1M tokens.
   */
  RECOMMEND_MODEL: z.string().default("anthropic/claude-sonnet-4-6-20250514"),

  // ---------------------------------------------------------------------------
  // Telegram Bot Configuration
  // ---------------------------------------------------------------------------

  /**
   * Telegram Bot API token from @BotFather.
   * Format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
   * REQUIRED — no default.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(1),

  // ---------------------------------------------------------------------------
  // External API Keys
  // ---------------------------------------------------------------------------

  /**
   * Finnhub API key — primary US stock news and real-time quotes source.
   * Free tier: 60 API calls/minute.
   * REQUIRED — no default.
   */
  FINNHUB_API_KEY: z.string().min(1),

  /**
   * Alpha Vantage API key — historical price data and NEWS_SENTIMENT endpoint.
   * Free tier: 25 API calls/day.
   * OPTIONAL — defaults to empty string (feature disabled when empty).
   */
  ALPHA_VANTAGE_API_KEY: z.string().default(""),

  /**
   * CoinGecko API key — crypto trending coins and market data.
   * Free tier: 30 API calls/minute (works without key).
   * OPTIONAL — defaults to empty string.
   */
  COINGECKO_API_KEY: z.string().default(""),

  /**
   * CryptoCompare API key — crypto news and historical OHLCV data.
   * Free tier: 100,000 API calls/month.
   * OPTIONAL — defaults to empty string.
   */
  CRYPTOCOMPARE_API_KEY: z.string().default(""),

  // ---------------------------------------------------------------------------
  // Application Server Configuration
  // ---------------------------------------------------------------------------

  /** Runtime environment. Controls logging format, error detail, optimizations. */
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /**
   * Express HTTP server listen port.
   * Uses `z.coerce.number()` because process.env values are always strings.
   */
  PORT: z.coerce.number().int().positive().default(3000),

  /** Frontend URL for CORS origin whitelist (Vite dev server in development). */
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  /**
   * Pino structured logger minimum severity level.
   * @see Pino log level documentation
   */
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // ---------------------------------------------------------------------------
  // Queue Tuning Configuration
  // ---------------------------------------------------------------------------

  /**
   * Cron expression for the news-polling repeatable BullMQ job.
   * Default: every 5 minutes.
   * @see AAP Section 0.5.1 Group 7
   */
  NEWS_POLL_INTERVAL: z.string().default("*/5 * * * *"),

  /**
   * Maximum concurrent analysis pipeline jobs. Keep low to respect OpenRouter
   * rate limits.
   */
  ANALYSIS_CONCURRENCY: z.coerce.number().int().positive().default(3),

  /**
   * Maximum concurrent Telegram notification sends.
   * Telegram limit: 30 messages/second.
   */
  NOTIFICATION_CONCURRENCY: z.coerce.number().int().positive().default(5),

  // ---------------------------------------------------------------------------
  // RSS Feed URLs (Indian Markets & Financial News)
  // ---------------------------------------------------------------------------

  /** Economic Times — Markets section RSS feed. */
  RSS_ECONOMIC_TIMES: z
    .string()
    .url()
    .default(
      "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    ),

  /** Financial Express — Market news feed. */
  RSS_FINANCIAL_EXPRESS: z
    .string()
    .url()
    .default("https://www.financialexpress.com/market/feed/"),

  /** Business Standard — Markets section RSS feed. */
  RSS_BUSINESS_STANDARD: z
    .string()
    .url()
    .default("https://www.business-standard.com/rss/markets-106.rss"),
});

// -----------------------------------------------------------------------------
// Schema parsing and validation
// -----------------------------------------------------------------------------

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const fieldErrors = result.error.flatten().fieldErrors;

  console.error("❌ Invalid environment variables:");
  console.error(JSON.stringify(fieldErrors, null, 2));
  throw new Error("Invalid environment variables. Check your .env file.");
}

/**
 * Validated and fully typed environment configuration.
 *
 * Every property is guaranteed to be present and correctly typed after Zod
 * validation at startup. Required fields are `string`; numeric fields are
 * `number`; enum fields are their respective union types.
 */
export const env: Env = result.data;

/**
 * TypeScript type representing the validated environment configuration,
 * inferred directly from the Zod schema.
 */
export type Env = z.infer<typeof envSchema>;
