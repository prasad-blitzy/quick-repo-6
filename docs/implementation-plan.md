# Trading Intelligence — Implementation Plan

**Version:** 1.0.0 | **Date:** March 2026

---

## Introduction

This document defines the **10-phase sequential implementation plan** for the Trading Intelligence Application — a multi-market financial news analysis platform that aggregates news from 30+ sources, processes articles through a tiered AI analysis pipeline, and delivers actionable trade recommendations via Telegram bot and a React web dashboard. Each phase has a **concrete validation gate** that MUST pass before proceeding to the next phase. Phases are ordered by dependency — scaffold → data → infrastructure → services → AI → queues → bot → API → UI → deployment — ensuring that every module builds on a verified foundation. Context should be cleared between phases to prevent context pollution that degrades code quality in long implementation sessions.

---

## Phase Overview

| Phase | Name | Key Deliverables | Validation |
|-------|------|------------------|------------|
| 1 | Project Scaffold | Monorepo structure, configs, Docker | `pnpm install && pnpm build` succeeds |
| 2 | Database & ORM | Drizzle schemas, migrations, seed | Migration runs, seed data queryable |
| 3 | Core Infrastructure | Logger, rate limiter, OpenRouter client | Unit tests pass for all utilities |
| 4 | News Ingestion | 8 fetcher modules, orchestrator | Each fetcher returns parsed articles |
| 5 | AI Analysis Pipeline | LangGraph 4-node graph | Pipeline processes sample article end-to-end |
| 6 | Queue System | 3 BullMQ queues + workers | Cron job triggers, articles flow through pipeline |
| 7 | Telegram Bot | grammY commands, keyboards, alerts | Bot responds to /start, /settings, /status |
| 8 | REST API | Express routes, middleware | All API endpoints return correct responses |
| 9 | React Dashboard | Pages, components, hooks | Dashboard renders with mock data |
| 10 | Tests & Deployment | Unit/integration tests, Docker, PM2 | All tests pass, Docker build succeeds |

---

## Phase 1: Project Scaffold and Configuration

### Goal

Establish the Turborepo monorepo structure with all workspace packages, TypeScript configuration, Docker services, and development tooling. No business logic is implemented in this phase — the focus is entirely on a compilable, well-configured foundation.

### Prerequisites

- Node.js 24.x LTS installed
- pnpm 9.x installed
- Docker 24.x+ and Docker Compose 2.x+ installed

### Files to Create

| File | Purpose |
|------|---------|
| `pnpm-workspace.yaml` | Workspace packages: `apps/*`, `packages/*` |
| `turbo.json` | Task pipeline: build (depends on `^build`), dev (persistent), lint, test, db:migrate, db:seed, db:push |
| `package.json` | Root package: name `trading-intelligence`, private: true, type: `module`, scripts for turbo, devDeps: turbo ^2.8.16, typescript ~5.9.x, prettier ^3.5.x, eslint ^9.x, packageManager: pnpm@9.15.0, engines: node >=24.0.0 |
| `tsconfig.base.json` | Strict mode: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`, module: NodeNext, moduleResolution: NodeNext |
| `.eslintrc.js` | TypeScript parser, `no-any` error, `no-console` warn |
| `.prettierrc` | 2-space indent, single quotes, trailing commas |
| `.gitignore` | node_modules, dist, .turbo, .env, *.local, coverage |
| `.env.example` | All environment variables documented with comments |
| `docker-compose.yml` | PostgreSQL 16 (`postgres:16-alpine`) + Redis 7 (`redis:7-alpine`) with healthchecks and named volumes |
| `README.md` | MODIFY: Replace placeholder with comprehensive project documentation, setup instructions, and architecture overview |
| `packages/types/package.json` | Shared types package: `@trading-intelligence/types` |
| `packages/types/tsconfig.json` | Extends base, declaration output enabled |
| `packages/types/src/index.ts` | Barrel export for all type modules |
| `packages/types/src/news.ts` | `NewsArticle`, `Market` enum, `NewsSource` interfaces |
| `packages/types/src/trade.ts` | `TradeOpportunity`, `Direction`, `Timeframe`, `TradePerformance` types |
| `packages/types/src/user.ts` | `UserSettings`, `NotificationPreference` interfaces |
| `packages/types/src/api.ts` | API request/response envelope types, pagination types |
| `packages/types/src/queue.ts` | Queue job payload types for all 3 queues |
| `packages/config/package.json` | Shared config package: `@trading-intelligence/config` |
| `packages/config/tsconfig.json` | Shared TS base reference |
| `packages/config/eslint.js` | Shared ESLint rules |
| `packages/utils/package.json` | Shared utilities package: `@trading-intelligence/utils` |
| `packages/utils/tsconfig.json` | Utils TypeScript config |
| `packages/utils/src/index.ts` | Barrel export for utilities |
| `packages/utils/src/formatting.ts` | Currency, percentage, date formatting helpers |
| `packages/utils/src/validation.ts` | Shared Zod validation schemas for API boundaries |

### Key Configuration Details

- **TypeScript strict mode** — All packages compile under `strict: true` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitReturns` enabled. No `any` types permitted; use `unknown` with type guards.
- **ESM-first module system** — All packages use `"type": "module"` in package.json with NodeNext module target. Import paths must include file extensions for Node.js ESM compatibility.
- **Docker services** — PostgreSQL 16 (`postgres:16-alpine`) with named volume for data persistence, health check via `pg_isready`. Redis 7 (`redis:7-alpine`) with `appendonly yes` for persistence, health check via `redis-cli ping`.

### Validation Test

```bash
# 1. Install dependencies
pnpm install

# 2. Build all packages (should succeed with no errors)
pnpm build

# 3. Verify TypeScript strict mode compilation
pnpm --filter @trading-intelligence/types build
pnpm --filter @trading-intelligence/utils build

# 4. Verify Docker services start
docker compose up -d postgres redis
docker compose ps  # Both services should be "healthy"

# 5. Verify workspace references resolve
pnpm --filter api exec -- node -e "console.log('workspace OK')"
```

### Pass Criteria

All commands exit with code 0, Docker services are healthy, TypeScript compiles without errors under strict mode.

---

## Phase 2: Database and ORM Setup

### Goal

Define all 7 database tables with Drizzle ORM, run migrations against PostgreSQL, and verify the schema with seed data. This phase establishes the data layer that every subsequent service depends on.

### Prerequisites

- Phase 1 complete (monorepo compiles, Docker services running)
- PostgreSQL 16 running via Docker Compose

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/package.json` | Backend dependencies: express ^4.21.x, grammy ^1.41.1, drizzle-orm ^0.45.x, bullmq ^5.71.x, @langchain/langgraph ^1.2.2, @langchain/openai ^1.2.x, @langchain/core ^1.1.x, pino ^10.3.x, zod ^3.25.x, pg ^8.13.x, postgres ^3.4.x, ioredis ^5.6.x, bottleneck ^2.19.5, rss-parser ^3.13.x, cors ^2.8.x, dotenv ^16.4.x, helmet ^8.0.x, @bull-board/api ^6.19.0, @bull-board/express ^6.20.3, stock-nse-india ^1.3.0 |
| `apps/api/tsconfig.json` | Extends base, NodeNext module, source paths for `src/` |
| `apps/api/drizzle.config.ts` | Schema path (`./src/db/schema`), migration output dir (`./src/db/migrations`), DB URL from environment |
| `apps/api/src/config/env.ts` | Zod-validated environment variable loader with typed config export |
| `apps/api/src/config/constants.ts` | Queue names, API endpoint URLs, default configurations, polling intervals |
| `apps/api/src/db/schema/enums.ts` | PostgreSQL enums: `market` (us_stock, indian_equity, crypto, social), `direction` (long, short), `status` (active, closed, expired, cancelled), `timeframe` (intraday, swing, position), `pipeline_step` (filter, sentiment, trade_detect, recommend) |
| `apps/api/src/db/schema/news-articles.ts` | `news_articles` table: UUID primary key, `text[]` for symbols, JSONB for raw API response, UNIQUE index on `url` column for deduplication |
| `apps/api/src/db/schema/trade-opportunities.ts` | `trade_opportunities` table: `numeric(12,4)` for entry_price, stop_loss, take_profit; FK to news_articles |
| `apps/api/src/db/schema/trade-performance.ts` | `trade_performance` table: P&L tracking with `numeric(12,4)` for actual prices and profit/loss |
| `apps/api/src/db/schema/user-settings.ts` | `user_settings` table: UNIQUE constraint on `telegram_chat_id`, preference arrays for markets/timeframes |
| `apps/api/src/db/schema/api-sources.ts` | `api_sources` table: managed data source registry with rate limit config and error tracking |
| `apps/api/src/db/schema/analysis-logs.ts` | `analysis_logs` table: token counts (`input_tokens`, `output_tokens`), cost tracking, JSONB result, FK to news_articles |
| `apps/api/src/db/schema/notification-logs.ts` | `notification_logs` table: delivery status tracking, FK to trade_opportunities and user_settings |
| `apps/api/src/db/schema/relations.ts` | Drizzle ORM relation definitions between all 7 tables |
| `apps/api/src/db/schema/index.ts` | Barrel export for all schema modules and enums |
| `apps/api/src/db/index.ts` | Drizzle client factory with local PostgreSQL / Supabase toggle (`prepare: false` for Supabase pgBouncer) |
| `apps/api/src/db/seed.ts` | Seed script with sample API sources (all 8 configured), a test user with default preferences, and sample data |

### Critical Rules (AAP Section 0.7.2 — Financial Data Precision)

- **All price fields** — Must use PostgreSQL `numeric(12, 4)`. NEVER use JavaScript floating-point (`number`) for price storage. Applies to: `entry_price`, `stop_loss`, `take_profit`, `actual_entry`, `actual_exit`, `profit_loss`.
- **Sentiment scores** — Must use `numeric(5, 3)` for range -1.000 to 1.000, providing millisentiment precision.
- **Confidence scores** — Must use `numeric(3, 2)` for range 0.00 to 1.00.
- **URL deduplication** — UNIQUE constraint on `news_articles.url` column (AAP Rule 0.7.4). Duplicate URLs from different polling cycles are silently skipped via `ON CONFLICT DO NOTHING`.
- **Telegram chat ID uniqueness** — UNIQUE constraint on `user_settings.telegram_chat_id`.
- **Supabase compatibility** — When `DATABASE_PROVIDER=supabase`, the Drizzle connection MUST set `prepare: false` to work with Supabase's pgBouncer transaction pooler (AAP Rule 0.7.4).

### Database Schema Relationships

```
news_articles (1) ──→ (N) trade_opportunities    [article_id FK]
news_articles (1) ──→ (N) analysis_logs          [article_id FK]
trade_opportunities (1) ──→ (1) trade_performance [opportunity_id FK]
trade_opportunities (1) ──→ (N) notification_logs [opportunity_id FK]
user_settings (1) ──→ (N) notification_logs       [user_id FK]
```

### Key Indexes for Query Performance

| Table | Index | Purpose |
|-------|-------|---------|
| `news_articles` | `(published_at, source)` | Efficient time-range queries filtered by source |
| `news_articles` | `(url)` UNIQUE | URL-based deduplication on insert |
| `news_articles` | `(is_analyzed)` | Quickly find unanalyzed articles |
| `trade_opportunities` | `(created_at, market, status)` | Dashboard filtering and sorting |
| `trade_opportunities` | `(symbol, status)` | Per-symbol active opportunity lookup |
| `user_settings` | `(telegram_chat_id)` UNIQUE | Fast subscriber lookup by Telegram chat ID |
| `analysis_logs` | `(article_id, pipeline_step)` | Per-article pipeline step lookup |
| `notification_logs` | `(opportunity_id, user_id)` | Prevent duplicate notifications |

### Validation Test

```bash
# Ensure Docker PostgreSQL is running
docker compose up -d postgres

# Push schema to database (generates and applies migration)
pnpm --filter api db:push

# Run seed script
pnpm --filter api db:seed

# Verify all 7 tables exist
docker exec trading-intel-postgres psql -U trading -d trading_intelligence -c "\dt"
# Should list: news_articles, trade_opportunities, trade_performance,
#              user_settings, api_sources, analysis_logs, notification_logs

# Verify seed data is queryable
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "SELECT count(*) FROM api_sources;"
# Should return count > 0

# Verify unique constraint on news_articles.url
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "INSERT INTO news_articles (url, title, source, market) VALUES ('https://test.com', 'Test', 'finnhub', 'us_stock');"
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "INSERT INTO news_articles (url, title, source, market) VALUES ('https://test.com', 'Duplicate', 'finnhub', 'us_stock');"
# Second insert should fail with unique violation
```

### Pass Criteria

All 7 tables created with correct column types (verify `numeric(12,4)` for prices), seed data queryable, foreign keys enforced, unique constraints active on `url` and `telegram_chat_id`.

---

## Phase 3: Core Infrastructure

### Goal

Create reusable infrastructure services that all downstream modules depend on: Pino structured logger, Bottleneck rate limiter factory, and OpenRouter LLM client factory.

### Prerequisites

- Phase 2 complete (database schema deployed, seed data queryable)

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/lib/logger.ts` | Pino v10.x logger factory with child logger support, `pino-pretty` transport in development, structured JSON in production |
| `apps/api/src/lib/rate-limiter.ts` | Bottleneck instance factory with per-API configurations: Finnhub (60 req/min), CoinGecko (30 req/min), Alpha Vantage (25 req/day), CryptoCompare (100K req/month), Binance (6000 weight/min), Reddit (100 QPM) |
| `apps/api/src/lib/openrouter.ts` | ChatOpenAI factory with `baseURL: "https://openrouter.ai/api/v1"`, per-stage model selection (DeepSeek V3.2, Claude Haiku 4.5, Claude Sonnet 4.6), `temperature: 0` enforced |

### Key Rules

- **Per-API Bottleneck isolation** (AAP Rule 0.7.4) — Each external API source gets its own dedicated Bottleneck instance configured to its specific free-tier limits. No shared rate limiter across different APIs.
- **Temperature = 0** (AAP Rule 0.7.3) — ALL OpenRouter calls must use `temperature: 0` for deterministic, reproducible financial analysis outputs.
- **Model tier mapping** — The OpenRouter client factory must map pipeline stages to their designated models:

| Pipeline Stage | Model | OpenRouter Model ID | Cost (input/output per 1M tokens) |
|----------------|-------|--------------------|------------------------------------|
| Filter | DeepSeek V3.2 | `deepseek/deepseek-chat` | $0.25 / $0.38 |
| Sentiment | Claude Haiku 4.5 | `anthropic/claude-3.5-haiku` | $1.00 / $5.00 |
| Trade Detection | Claude Haiku 4.5 | `anthropic/claude-3.5-haiku` | $1.00 / $5.00 |
| Recommendation | Claude Sonnet 4.6 | `anthropic/claude-sonnet-4` | $3.00 / $15.00 |

### Validation Test

```typescript
// Test logger creates child loggers with context
import { createLogger } from './src/lib/logger.js';
const log = createLogger('test-service');
log.info({ event: 'startup' }, 'Service initialized');
// Should output structured JSON with level, time, name, event, msg fields

const childLog = log.child({ requestId: 'abc-123' });
childLog.warn('Something happened');
// Should include requestId in output

// Test rate limiter factory creates isolated instances
import { createLimiter } from './src/lib/rate-limiter.js';
const finnhubLimiter = createLimiter('finnhub');
const coingeckoLimiter = createLimiter('coingecko');
// finnhubLimiter should allow 60 req/min
// coingeckoLimiter should allow 30 req/min
// They must be independent — exhausting one does not affect the other

// Test OpenRouter client factory
import { createOpenRouterClient } from './src/lib/openrouter.js';
const filterModel = createOpenRouterClient('filter');
// Verify: baseURL === 'https://openrouter.ai/api/v1'
// Verify: temperature === 0
// Verify: modelName matches DeepSeek V3.2

const recommendModel = createOpenRouterClient('recommend');
// Verify: modelName matches Claude Sonnet 4.6
```

### Pass Criteria

Logger outputs structured JSON with child logger context propagation, rate limiters are independently configured per API source, OpenRouter client targets correct `baseURL` with `temperature: 0` and correct model IDs per pipeline stage.

---

## Phase 4: News Ingestion Services

### Goal

Build all 8 API-specific fetcher modules with rate limiting, plus the orchestrator that invokes them all and returns a unified stream of normalized `NewsArticle` objects.

### Prerequisites

- Phase 3 complete (logger, rate limiter, and OpenRouter client operational)

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/services/news-fetcher/index.ts` | Orchestrator that invokes all source-specific fetchers in parallel, aggregates results, handles individual failures gracefully |
| `apps/api/src/services/news-fetcher/finnhub.ts` | Finnhub REST client for `/api/v1/news` (general + company news) and `/api/v1/quote` (US stock quotes) |
| `apps/api/src/services/news-fetcher/rss-parser.ts` | Generic RSS feed parser configured with Economic Times, Financial Express, Business Standard, CNBC, and MarketWatch feed URLs |
| `apps/api/src/services/news-fetcher/reddit.ts` | Reddit RSS feed reader for r/wallstreetbets, r/IndianStreetBets, r/CryptoCurrency subreddits |
| `apps/api/src/services/news-fetcher/coingecko.ts` | CoinGecko API client for `/api/v3/search/trending` and `/api/v3/coins/markets` endpoints |
| `apps/api/src/services/news-fetcher/cryptocompare.ts` | CryptoCompare news API client (`/data/v2/news/`) and historical data endpoints |
| `apps/api/src/services/news-fetcher/binance.ts` | Binance public REST API for `/api/v3/klines` and `/api/v3/ticker/price` endpoints |
| `apps/api/src/services/news-fetcher/alpha-vantage.ts` | Alpha Vantage `NEWS_SENTIMENT` function and `TIME_SERIES_DAILY` historical data endpoints |
| `apps/api/src/services/news-fetcher/nse-india.ts` | `stock-nse-india` npm package wrapper for NSE India equity quotes and symbol lookup |

### Data Source Coverage

| Market | News Sources | Price Data |
|--------|-------------|------------|
| US Stocks | Finnhub news (free, 60 req/min) + CNBC/MarketWatch RSS | Finnhub quotes + Alpha Vantage historical |
| Indian Equities | Economic Times + Financial Express + Business Standard RSS feeds | stock-nse-india (free NSE scraper) |
| Crypto | CryptoCompare news + CoinGecko trending | Binance API (free) + CoinGecko market data |
| Social | Reddit RSS (free, r/wallstreetbets, r/IndianStreetBets, r/CryptoCurrency) | N/A |

### Key Rules

- **Per-API Bottleneck isolation** (AAP Rule 0.7.4) — Each fetcher module is wrapped with its own dedicated Bottleneck instance configured to the API's specific free-tier rate limits.
- **Normalized output** — All fetchers return normalized `NewsArticle` objects matching the shared type from `@trading-intelligence/types`. Raw API responses are stored in the JSONB `raw_data` column for debugging.
- **Graceful degradation** (AAP Rule 0.7.4) — Individual API source failures MUST NOT halt the entire polling cycle. Each fetcher catches its own errors, logs them via Pino, and increments the `error_count` on the corresponding `api_sources` record.
- **URL deduplication** — Handled at the database level via the UNIQUE constraint on `news_articles.url`. The orchestrator uses `INSERT ... ON CONFLICT (url) DO NOTHING` to silently skip duplicates.

### Validation Test

```bash
# Test each fetcher individually (requires API keys in .env)
# Alternatively, run unit tests with mock HTTP responses

# Finnhub fetcher test
pnpm --filter api tsx src/services/news-fetcher/finnhub.ts
# Should return array of normalized NewsArticle objects from Finnhub API

# RSS parser test
pnpm --filter api tsx src/services/news-fetcher/rss-parser.ts
# Should parse Economic Times, Financial Express, and Business Standard RSS feeds

# CoinGecko test
pnpm --filter api tsx src/services/news-fetcher/coingecko.ts
# Should return trending coins and market data

# Orchestrator integration test
pnpm --filter api tsx src/services/news-fetcher/index.ts
# Should invoke all enabled fetchers, aggregate results, handle individual failures
# Output: total article count, per-source counts, any errors logged
```

### Pass Criteria

Each fetcher returns properly typed `NewsArticle[]` arrays, rate limiters activate and throttle requests appropriately, individual fetcher failures are caught and logged without crashing the orchestrator, and the orchestrator aggregates all results into a single array.

---

## Phase 5: AI Analysis Pipeline

### Goal

Build the 4-node LangGraph.js directed graph with conditional short-circuiting that routes only ~25% of articles to the expensive recommendation model. Implement Zod-validated structured output, tiered model routing via OpenRouter, and Domain Knowledge Chain-of-Thought (DK-CoT) prompting for financial analysis.

### Prerequisites

- Phase 4 complete (news fetchers operational)
- OpenRouter API key configured in `.env`

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/services/analyzer/state.ts` | LangGraph `Annotation`-based typed state definition: article data, filter result, sentiment scores, trade detection, recommendation output |
| `apps/api/src/services/analyzer/schemas.ts` | Zod schemas: `FilterResultSchema`, `SentimentResultSchema`, `TradeDetectionResultSchema`, `TradeRecommendationSchema` — used with `withStructuredOutput()` |
| `apps/api/src/services/analyzer/prompts.ts` | System prompt templates for all 4 pipeline stages with DK-CoT pattern, anti-hallucination instructions, and 2–3 few-shot examples per stage |
| `apps/api/src/services/analyzer/models.ts` | Per-stage model configuration via OpenRouter: DeepSeek V3.2 for filter, Claude Haiku 4.5 for sentiment and trade detection, Claude Sonnet 4.6 for recommendation |
| `apps/api/src/services/analyzer/nodes/filter.ts` | Binary relevance classifier using DeepSeek V3.2 — determines if article is financially relevant (yes/no) |
| `apps/api/src/services/analyzer/nodes/sentiment.ts` | Sentiment analyzer using Claude Haiku 4.5 — produces score in [-1.000, 1.000] with negative news weighted 2–3x |
| `apps/api/src/services/analyzer/nodes/trade-detect.ts` | Trade opportunity detector using Claude Haiku 4.5 — identifies if article implies a tradeable opportunity |
| `apps/api/src/services/analyzer/nodes/recommend.ts` | Recommendation generator using Claude Sonnet 4.6 — produces full trade recommendation via `withStructuredOutput()` with Zod schema |
| `apps/api/src/services/analyzer/index.ts` | `StateGraph` assembly: connect all 4 nodes, define conditional edges for early termination, compile the graph |

### Pipeline Architecture

```
                    ┌─────────┐
    Article ──────→ │ FILTER  │ (DeepSeek V3.2 — $0.25/1M tokens)
                    └────┬────┘
                         │
                    not_relevant? ──→ END (skip ~60% of articles)
                         │
                    ┌────▼──────┐
                    │ SENTIMENT │ (Claude Haiku 4.5 — $1.00/$5.00)
                    └────┬──────┘
                         │
                    low_impact? ──→ END (skip ~15% more)
                         │
                    ┌────▼────────────┐
                    │ TRADE DETECTION │ (Claude Haiku 4.5 — $1.00/$5.00)
                    └────┬────────────┘
                         │
                    no_opportunity? ──→ END
                         │
                    ┌────▼──────────────┐
                    │ RECOMMENDATION    │ (Claude Sonnet 4.6 — $3.00/$15.00)
                    └────┬──────────────┘
                         │
                    Store in DB + Enqueue Notification
```

**Cost optimization:** Only ~25% of articles reach the expensive recommendation model, achieving ~75% LLM cost reduction compared to running all articles through the full pipeline.

### Critical LLM Rules (AAP Section 0.7.3)

1. **`temperature: 0`** on ALL LLM calls — deterministic, reproducible financial reasoning.
2. **`withStructuredOutput()`** with Zod schemas — no free-form text parsing permitted.
3. **DK-CoT prompting** — System prompts incorporate financial domain knowledge into reasoning chains (e.g., "Consider: earnings surprises of >5% historically move stock price by 3-7% in the following session").
4. **Anti-hallucination instructions** — EVERY system prompt MUST include: *"Do NOT fabricate price targets, earnings numbers, or analyst ratings not present in the source material."*
5. **Negative news weighting** — Sentiment analysis stage weights negative financial news 2–3x higher than positive news, reflecting empirical research that negative news has 2–3x the market impact of positive news.
6. **Few-shot examples** — Each pipeline stage prompt includes 2–3 worked examples for improved accuracy (up to 9% improvement over zero-shot).
7. **Conditional edges** — `not_relevant → END`, `low_impact → END`, `no_opportunity → END` to short-circuit processing.

### Validation Test

```typescript
// Test with a sample article through the full pipeline
const sampleArticle = {
  title: "Apple Reports Record Q1 Revenue of $123B, Beating Estimates by 8%",
  content: "Apple Inc. reported record quarterly revenue of $123.9 billion for Q1 2026, " +
           "beating analyst estimates of $114.2 billion by approximately 8%. The company " +
           "cited strong iPhone 17 demand and growing Services revenue.",
  source: "finnhub",
  market: "us_stock",
  url: "https://example.com/apple-q1-2026",
  publishedAt: new Date()
};

const result = await pipeline.invoke({ article: sampleArticle });

// Verify:
// 1. Filter node ran and marked article as relevant (is_relevant: true)
// 2. Sentiment node ran and produced score in [-1.000, 1.000]
// 3. Trade detection identified opportunity (has_opportunity: true)
// 4. Recommendation node produced structured output with:
//    - direction: "long" or "short"
//    - entry_price: numeric value
//    - stop_loss: numeric value
//    - take_profit: numeric value
//    - confidence: 0.00 to 1.00
//    - timeframe: "intraday" | "swing" | "position"
// 5. All price targets validate against Zod schema
// 6. Conditional short-circuit test: submit irrelevant article → stops at filter

// Test with irrelevant article
const irrelevantArticle = {
  title: "Best Pizza Recipes for Summer 2026",
  content: "Try these amazing pizza recipes for your next barbecue...",
  source: "rss",
  market: "us_stock",
  url: "https://example.com/pizza",
  publishedAt: new Date()
};

const irrelevantResult = await pipeline.invoke({ article: irrelevantArticle });
// Should stop at filter node — no sentiment, trade detection, or recommendation
```

### Pass Criteria

Pipeline processes relevant articles end-to-end with Zod-validated structured output, conditional routing correctly short-circuits irrelevant articles at the filter stage, all LLM calls use `temperature: 0`, sentiment scores fall in [-1.000, 1.000] range, and pipeline results are logged to `analysis_logs` table with token counts and cost.

---

## Phase 6: Queue System

### Goal

Wire BullMQ queues and workers to automate the complete ingestion → analysis → notification pipeline. Three independent queues handle distinct responsibilities with configurable concurrency, retry policies, and priority levels.

### Prerequisites

- Phase 5 complete (LangGraph pipeline processes articles)
- Redis 7 running via Docker Compose

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/queues/index.ts` | Redis connection factory (IORedis), queue registry, Bull Board adapter setup for monitoring at `/admin/queues` |
| `apps/api/src/queues/news-polling.queue.ts` | Repeatable cron job queue: `*/5 * * * *` (every 5 minutes), invokes news fetcher orchestrator |
| `apps/api/src/queues/analysis.queue.ts` | Analysis processing queue with configurable concurrency (default: 3), rate limiting to respect OpenRouter limits |
| `apps/api/src/queues/notifications.queue.ts` | Notification dispatch queue with priority levels (breaking news = priority 1), rate limiting for Telegram API (30 msg/sec) |
| `apps/api/src/queues/workers/news-polling.worker.ts` | Worker: invokes news fetcher orchestrator → deduplicates articles by URL → stores in `news_articles` table → enqueues unanalyzed articles to analysis queue |
| `apps/api/src/queues/workers/analysis.worker.ts` | Worker: receives article IDs → runs LangGraph pipeline → stores results in `analysis_logs` and `trade_opportunities` tables → enqueues trade opportunities to notification queue |
| `apps/api/src/queues/workers/notifications.worker.ts` | Worker: receives trade opportunity → matches against subscriber preferences (market, confidence, timeframes) → formats MarkdownV2 alert → sends via Telegram bot API |

### Queue Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│  news-polling    │     │    analysis       │     │   notifications      │
│  Queue           │────→│    Queue          │────→│   Queue              │
│                  │     │                   │     │                      │
│  Cron: */5 * * * │     │  Concurrency: 3   │     │  Priority: 1-5       │
│  Retry: 3x exp   │     │  Retry: 3x exp    │     │  Rate: 30 msg/sec    │
│  Backoff: 30s    │     │  Backoff: 60s     │     │  Retry: 5x exp       │
└──────────────────┘     └──────────────────┘     └──────────────────────┘
```

### Key Rules (AAP Section 0.7.6)

1. **Three SEPARATE queues** — `news-polling`, `analysis`, and `notifications` are independent BullMQ queues with separate worker instances. No shared queue for different job types.
2. **Breaking news priority** — The notification queue supports priority levels: priority 1 (breaking/urgent), priority 3 (standard), priority 5 (digest/batch).
3. **Exponential backoff retry** — All workers use BullMQ's built-in retry with exponential backoff for transient failures (network errors, API rate limits, temporary service outages).
4. **Configurable concurrency** — Worker concurrency is configurable per queue via environment variables. The analysis worker limits concurrency to respect OpenRouter API rate limits.
5. **Bull Board monitoring** — All 3 queues are registered with `@bull-board/express` for real-time monitoring at the `/admin/queues` endpoint.

### Validation Test

```bash
# Ensure Redis and PostgreSQL are running
docker compose up -d redis postgres

# Start the application with all workers
pnpm --filter api dev

# Verify queue registration:
# 1. Open http://localhost:3000/admin/queues in browser
#    → Should show all 3 queues: news-polling, analysis, notifications

# 2. Check news-polling cron job is registered:
#    → Bull Board should show repeatable job with "*/5 * * * *" pattern

# 3. Wait for first polling cycle (or trigger manually):
#    → Check news_articles table for new rows
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "SELECT count(*) FROM news_articles WHERE created_at > NOW() - INTERVAL '10 minutes';"

# 4. Verify analysis queue processes articles:
#    → Check analysis_logs table for new entries
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "SELECT count(*) FROM analysis_logs WHERE created_at > NOW() - INTERVAL '10 minutes';"

# 5. Verify notification queue (if trade opportunities detected):
#    → Check notification_logs table
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "SELECT count(*) FROM notification_logs WHERE created_at > NOW() - INTERVAL '10 minutes';"
```

### Pass Criteria

Cron job registers and fires on schedule, articles flow from news-polling → analysis → notification queues, Bull Board dashboard shows all 3 queues with job counts, retry policies activate on simulated failures, and worker concurrency is properly bounded.

---

## Phase 7: Telegram Bot

### Goal

Build the grammY-based Telegram bot with command handlers, inline keyboard preference management, and MarkdownV2-formatted trade alert delivery.

### Prerequisites

- Phase 6 complete (queue system operational)
- Telegram bot token obtained from @BotFather and configured in `.env`

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/bot/index.ts` | grammY `Bot` instantiation, middleware registration (error handling, logging), long polling startup |
| `apps/api/src/bot/commands/start.ts` | `/start` command handler: creates new user in `user_settings` table with default preferences, sends welcome message with getting started instructions |
| `apps/api/src/bot/commands/settings.ts` | `/settings` command handler: reads current preferences from database, presents inline keyboard with market toggles, confidence slider, and timeframe selection |
| `apps/api/src/bot/commands/status.ts` | `/status` command handler: queries queue health (job counts, failure rates), recent pipeline statistics (articles analyzed, opportunities found), and system uptime |
| `apps/api/src/bot/keyboards.ts` | Inline keyboard builders for: market selection (US Stocks ✅/❌, Indian Equities ✅/❌, Crypto ✅/❌), confidence threshold (0.5/0.6/0.7/0.8/0.9), timeframe selection (Intraday/Swing/Positional) |
| `apps/api/src/bot/callbacks.ts` | Callback query handlers for inline keyboard button presses: update user preferences in database, refresh the inline keyboard to reflect new state |
| `apps/api/src/services/notifier/index.ts` | Subscriber matching engine: given a trade opportunity, query `user_settings` to find all users whose market, min_confidence, and timeframe preferences match the opportunity attributes |
| `apps/api/src/services/notifier/formatter.ts` | MarkdownV2 trade alert message formatter: constructs formatted message with emoji direction indicators, inline code prices, risk-reward ratio, and confidence badge |

### Trade Alert Message Format

```
🟢 LONG Opportunity — AAPL

📊 *Market:* US Stock
⏱ *Timeframe:* Swing (2\-5 days)
📈 *Confidence:* 85%

💰 *Entry:* `$189\.50`
🛑 *Stop Loss:* `$184\.25`
🎯 *Take Profit:* `$198\.75`
📐 *Risk/Reward:* 1:1\.76

📰 *Source:* Finnhub — "Apple Reports Record Q1 Revenue"

⚠️ _This is an AI\-generated analysis, not financial advice\._
```

### Key Rules (AAP Section 0.7.5)

1. **MarkdownV2 escaping** — ALL special characters must be escaped with `\` per Telegram Bot API specification. Characters requiring escaping: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`
2. **Emoji directional indicators** — 🟢 for LONG recommendations, 🔴 for SHORT recommendations for instant visual comprehension.
3. **Inline code blocks** — All price values wrapped in backtick inline code for monospace formatting and visual distinction.
4. **Subscriber preference matching** — Notifications sent ONLY to users whose preference filters match the trade opportunity: enabled markets, minimum confidence threshold, and selected timeframes.

### Validation Test

```bash
# Set TELEGRAM_BOT_TOKEN in .env
# Start the application
pnpm --filter api dev

# In Telegram, message your bot:

# Test 1: /start command
# → Should register user in user_settings table
# → Should display welcome message with bot description
# → Should show default preferences summary

# Test 2: /settings command
# → Should display inline keyboard with market toggles
# → Each market shows ✅ (enabled) or ❌ (disabled)
# → Tapping a market button toggles its state

# Test 3: Tap a market toggle button
# → Should update preference in database
# → Should refresh the inline keyboard with new state
# → Should send confirmation message

# Test 4: /status command
# → Should show queue statistics (jobs completed, failed, waiting)
# → Should show recent pipeline stats (articles analyzed, opportunities found)
# → Should show system health (DB connected, Redis connected)

# Test 5: Programmatic notification test
# → Create a mock trade opportunity matching test user's preferences
# → Enqueue to notifications queue
# → Verify user receives MarkdownV2-formatted alert
# → Verify no Telegram parse errors (check notification_logs for delivery status)
```

### Pass Criteria

All 3 commands respond correctly with properly formatted messages, inline keyboards update preferences in the database and reflect changes immediately, trade alerts render with correct MarkdownV2 formatting (no Telegram API parse errors), subscriber matching correctly filters users by market, confidence, and timeframe preferences.

---

## Phase 8: REST API and Middleware

### Goal

Create the Express REST API that serves data to the React dashboard, including paginated/filterable endpoints for news, opportunities, performance, and settings, plus middleware for error handling, request logging, and CORS.

### Prerequisites

- Phase 7 complete (Telegram bot operational)
- All database tables populated with data from the pipeline

### Files to Create

| File | Purpose |
|------|---------|
| `apps/api/src/middleware/error-handler.ts` | Global Express error handling middleware: catches all unhandled errors, logs structured error details via Pino, returns JSON error responses with appropriate HTTP status codes |
| `apps/api/src/middleware/request-logger.ts` | `pino-http` request/response logging middleware: logs method, URL, status code, response time for every request |
| `apps/api/src/middleware/cors.ts` | CORS configuration middleware: allows frontend origin (`http://localhost:5173` in dev, configurable via env), handles preflight OPTIONS requests |
| `apps/api/src/routes/index.ts` | Express router aggregator: mounts all route modules under `/api` prefix |
| `apps/api/src/routes/news.routes.ts` | `GET /api/news` — Paginated news feed with query params: `page`, `limit`, `market` filter, `source` filter, `startDate`/`endDate` range, `isAnalyzed` flag |
| `apps/api/src/routes/opportunities.routes.ts` | `GET /api/opportunities` — Filterable, sortable trade opportunities: `market`, `status` (active/closed/expired), `direction` (long/short), `minConfidence`, `symbol`, sort by `created_at`/`confidence` |
| `apps/api/src/routes/performance.routes.ts` | `GET /api/performance` — Performance tracking with aggregations: win rate, total P&L, average profit, average loss, performance by market, accuracy over time, date range filter |
| `apps/api/src/routes/settings.routes.ts` | `GET /api/settings/:chatId` — Retrieve user preferences; `PUT /api/settings/:chatId` — Update user preferences (markets, confidence, timeframes, active status) |
| `apps/api/src/routes/health.routes.ts` | `GET /api/health` — Dependency status report: PostgreSQL connection, Redis connection, queue health (job counts), external API source status (last successful fetch, error counts) |
| `apps/api/src/index.ts` | Express application bootstrap: middleware chain (helmet, cors, request-logger, JSON parser), route mounting, Bull Board at `/admin/queues`, bot long polling start, queue worker initialization, graceful shutdown handlers |

### API Response Envelope

All API responses follow a consistent envelope format:

```typescript
// Success response
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}

// Error response
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid market filter value"
  }
}
```

### Validation Test

```bash
# Start the server with all services
pnpm --filter api dev

# Test health endpoint
curl -s http://localhost:3000/api/health | jq .
# → { "status": "healthy", "postgres": "connected", "redis": "connected",
#      "queues": { "news-polling": { ... }, "analysis": { ... }, "notifications": { ... } },
#      "apiSources": [ ... ] }

# Test news endpoint with pagination
curl -s "http://localhost:3000/api/news?page=1&limit=10" | jq .
# → { "success": true, "data": [...], "pagination": { "page": 1, "limit": 10, "total": ... } }

# Test news endpoint with market filter
curl -s "http://localhost:3000/api/news?market=us_stock&page=1&limit=5" | jq .
# → Returns only US stock news articles

# Test opportunities endpoint with filters
curl -s "http://localhost:3000/api/opportunities?market=us_stock&status=active&minConfidence=0.7" | jq .
# → { "success": true, "data": [...], "pagination": { ... } }

# Test performance endpoint
curl -s "http://localhost:3000/api/performance?startDate=2026-01-01" | jq .
# → { "success": true, "data": { "winRate": ..., "totalPnl": ..., "avgProfit": ..., ... } }

# Test settings endpoints
curl -s "http://localhost:3000/api/settings/12345" | jq .
# → User settings for Telegram chat ID 12345

curl -s -X PUT "http://localhost:3000/api/settings/12345" \
  -H "Content-Type: application/json" \
  -d '{"markets": ["us_stock", "crypto"], "minConfidence": 0.8}' | jq .
# → Updated settings

# Test Bull Board dashboard
# Open http://localhost:3000/admin/queues in browser
# → Should render interactive queue monitoring dashboard

# Test CORS headers
curl -sI "http://localhost:3000/api/health" -H "Origin: http://localhost:5173"
# → Should include Access-Control-Allow-Origin header

# Test error handling
curl -s "http://localhost:3000/api/news?market=invalid_market" | jq .
# → { "success": false, "error": { "code": "VALIDATION_ERROR", ... } }
```

### Pass Criteria

All 5 endpoint groups return valid JSON matching the envelope format, pagination works correctly, filters produce accurate subsets, health check reports real-time dependency status, Bull Board renders the interactive queue dashboard, CORS allows the frontend origin, and error handler returns structured JSON errors with appropriate HTTP status codes.

---

## Phase 9: React Dashboard

### Goal

Build the dark-themed, responsive React frontend with sidebar navigation, live news feed, trade opportunities board with filters, historical performance charts, and settings management. The dashboard connects to the Express API via Vite's dev server proxy.

### Prerequisites

- Phase 8 complete (all REST API endpoints operational)

### Files to Create

| File | Purpose |
|------|---------|
| `apps/web/package.json` | Frontend dependencies: react ^19.1.x, react-dom ^19.1.x, react-router-dom ^7.x, recharts ^2.15.x, axios ^1.8.x, clsx ^2.1.x, date-fns ^4.x |
| `apps/web/tsconfig.json` | Frontend TypeScript config with JSX support |
| `apps/web/vite.config.ts` | Vite config with `@vitejs/plugin-react`, API proxy to `http://localhost:3000` |
| `apps/web/vercel.json` | Vercel deployment config: rewrites for SPA routing, build command, output directory |
| `apps/web/index.html` | HTML shell: dark theme `<meta>`, viewport meta, root `<div id="root">`, font imports |
| `apps/web/src/main.tsx` | React app bootstrap: `ReactDOM.createRoot`, `BrowserRouter` provider |
| `apps/web/src/App.tsx` | Route definitions: `/` → NewsFeed, `/opportunities` → TradeOpportunities, `/performance` → Performance, `/settings` → Settings |
| `apps/web/src/styles/globals.css` | CSS custom properties for dark theme: `--bg-primary: #0f1117`, `--bg-surface: #1a1d27`, `--text-primary: #e4e6eb`, `--text-secondary: #8b8d94`, `--accent-green: #22c55e`, `--accent-red: #ef4444`, `--accent-blue: #3b82f6` |
| `apps/web/src/layouts/DashboardLayout.tsx` | Layout shell: persistent sidebar on left, content area on right, responsive — sidebar collapses to hamburger on mobile |
| `apps/web/src/components/Sidebar.tsx` | Navigation sidebar: route links for News Feed, Trade Opportunities, Performance, Settings; active state highlighting; collapsible on mobile |
| `apps/web/src/pages/NewsFeed.tsx` | Live news feed: market tabs (All, US, India, Crypto, Social), article cards with sentiment badges, infinite scroll pagination, time-relative display |
| `apps/web/src/pages/TradeOpportunities.tsx` | Trade board: filter bar (market, status, direction, confidence), card grid displaying active opportunities with direction indicators (🟢/🔴), entry/stop/target prices, confidence score |
| `apps/web/src/pages/Performance.tsx` | Performance dashboard: win/loss ratio donut chart, cumulative P&L line chart, performance by market bar chart, accuracy over time area chart, key statistics cards |
| `apps/web/src/pages/Settings.tsx` | Settings form: Telegram chat ID input, market checkboxes, confidence threshold slider, timeframe selection, notification frequency, save button with success feedback |
| `apps/web/src/components/NewsCard.tsx` | News article card: title, source badge, published time (relative), market tag, sentiment score indicator (green/yellow/red), truncated content preview |
| `apps/web/src/components/TradeCard.tsx` | Trade opportunity card: direction indicator (🟢 LONG / 🔴 SHORT), symbol prominently displayed, entry/stop/target prices, risk-reward ratio, confidence badge, timeframe tag |
| `apps/web/src/components/FilterBar.tsx` | Reusable filter/sort control bar: dropdown selects for categorical filters, range inputs for numeric filters, sort direction toggle |
| `apps/web/src/components/PerformanceChart.tsx` | Recharts-based chart wrapper: accepts data and chart type config, responsive container, dark theme colors, tooltip formatting |
| `apps/web/src/components/HealthIndicator.tsx` | System health status indicator: green dot (healthy), yellow dot (degraded), red dot (unhealthy), tooltip with dependency details on hover |
| `apps/web/src/hooks/useApi.ts` | Generic data fetching hook: SWR-like pattern with loading state, error state, data caching, refetch function, configurable polling interval |
| `apps/web/src/hooks/useNews.ts` | News-specific data hook: wraps `useApi` for `/api/news`, adds pagination logic, market filter state, infinite scroll support |
| `apps/web/src/hooks/useOpportunities.ts` | Opportunities-specific data hook: wraps `useApi` for `/api/opportunities`, manages filter state, sort state, pagination |
| `apps/web/src/lib/api-client.ts` | Axios instance: base URL from environment (defaults to `/api` for Vite proxy), request/response interceptors for error handling, timeout configuration |
| `apps/web/src/types/index.ts` | Frontend-specific type definitions: re-exports from `@trading-intelligence/types`, plus UI-specific types for component props and hook return values |

### UI Design Specifications

- **Dark theme** — CSS custom properties for all colors; background `#0f1117`, surface `#1a1d27`, borders `#2d3039`, primary text `#e4e6eb`, secondary text `#8b8d94`
- **Responsive layout** — Sidebar visible on screens ≥1024px, collapses to hamburger menu below 1024px; cards reflow from multi-column grid to single-column stack on mobile
- **Typography** — System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`), 14px base, 1.5 line-height
- **Component states** — Loading skeletons during data fetch, empty states with descriptive messages and icons, error states with retry buttons

### Validation Test

```bash
# Start backend API (required for proxy)
pnpm --filter api dev &

# Start frontend dev server
pnpm --filter web dev

# Open http://localhost:5173 in browser

# Visual checks:
# 1. Dark theme renders correctly — dark background (#0f1117), light text, proper contrast
# 2. Sidebar navigation shows all 4 routes with icons and labels
# 3. Active page is highlighted in sidebar
# 4. Clicking sidebar links navigates between pages without full reload

# News Feed page:
# 5. Market tabs (All, US, India, Crypto, Social) are displayed
# 6. News cards show title, source, time, sentiment indicator
# 7. Infinite scroll loads more articles on scroll
# 8. Empty state displayed if no articles

# Trade Opportunities page:
# 9. Filter bar with market, status, direction, confidence controls
# 10. Trade cards show direction indicator, symbol, prices, confidence
# 11. Cards are laid out in responsive grid

# Performance page:
# 12. Charts render (win/loss ratio, P&L over time, by market)
# 13. Statistics cards show key metrics

# Settings page:
# 14. Form fields for markets, confidence, timeframes
# 15. Save button triggers API call

# Responsive test:
# 16. Resize browser to <1024px — sidebar collapses to hamburger menu
# 17. Cards reflow to single-column layout on mobile

# API integration test:
# 18. Open browser DevTools → Network tab
# 19. Verify API calls go through Vite proxy to backend (no CORS errors)

# Production build test:
pnpm --filter web build
ls apps/web/dist/
# → Should contain index.html, assets/ directory with JS and CSS bundles
```

### Pass Criteria

Dashboard renders with dark theme on all pages, all 4 pages are accessible via sidebar navigation, components display correct layouts with proper data binding, API integration works through Vite proxy without CORS errors, responsive layout adapts correctly at mobile breakpoints, and production build generates valid static assets.

---

## Phase 10: Tests and Deployment

### Goal

Add comprehensive unit and integration tests for all services, create Docker deployment configuration, and set up PM2 for production process management. This phase hardens the system for production use.

### Prerequisites

- Phase 9 complete (all application features functional)

### Test Files to Create

| File | Purpose |
|------|---------|
| `apps/api/tests/unit/services/news-fetcher.test.ts` | Mock HTTP responses for all 8 fetcher modules, test normalized output, test error handling, test deduplication logic |
| `apps/api/tests/unit/services/analyzer.test.ts` | Mock LLM responses via OpenRouter, test conditional routing (relevant vs irrelevant articles), test Zod schema validation, test state transitions |
| `apps/api/tests/unit/services/notifier.test.ts` | Test subscriber matching logic (market filter, confidence threshold, timeframe filter), test MarkdownV2 message formatting and escaping |
| `apps/api/tests/unit/queues/workers.test.ts` | Test worker job processing with mocked dependencies, test retry behavior on failure, test job completion and state transitions |
| `apps/api/tests/unit/bot/commands.test.ts` | Test `/start`, `/settings`, `/status` command handlers with mock grammY context, test inline keyboard generation, test callback query handling |
| `apps/api/tests/integration/news-ingestion.test.ts` | End-to-end test: trigger polling → verify articles stored in DB → verify analysis queue populated (requires Docker PostgreSQL + Redis) |
| `apps/api/tests/integration/analysis-pipeline.test.ts` | Full LangGraph pipeline test with mock LLM responses → verify analysis logs → verify trade opportunities created → verify notification queue populated |
| `apps/api/tests/integration/notification-delivery.test.ts` | Trade opportunity → subscriber matching → message formatting → delivery tracking test (Telegram send mocked) |
| `apps/api/tests/integration/api-routes.test.ts` | Supertest-based HTTP endpoint tests: test all routes, pagination, filters, error responses, CORS headers |
| `apps/web/src/__tests__/pages/NewsFeed.test.tsx` | React Testing Library: test news feed renders, market tabs work, cards display article data, loading/empty states |
| `apps/web/src/__tests__/pages/TradeOpportunities.test.tsx` | Test trade board renders, filter bar interactions, card grid layout, direction indicators |
| `apps/web/src/__tests__/components/NewsCard.test.tsx` | Test news card displays title, source, time, sentiment badge, handles missing data |

### Deployment Files to Create

| File | Purpose |
|------|---------|
| `apps/api/Dockerfile` | Multi-stage Docker build: Stage 1 (deps) — install pnpm + dependencies; Stage 2 (build) — TypeScript compilation; Stage 3 (production) — minimal Node.js 24 alpine image, non-root user, health check, `CMD ["node", "dist/index.js"]` |
| `apps/api/ecosystem.config.js` | PM2 ecosystem config: cluster mode with `max` instances (auto-detect CPUs), environment variable passthrough, log file paths, restart policy (max 10 restarts), watch disabled in production |

### Dockerfile Architecture

```dockerfile
# Stage 1: Dependencies
FROM node:24-alpine AS deps
# Install pnpm, copy package manifests, install production dependencies

# Stage 2: Build
FROM deps AS build
# Copy source code, compile TypeScript, prune dev dependencies

# Stage 3: Production
FROM node:24-alpine AS production
# Create non-root user, copy built artifacts, expose port, health check
# USER node
# CMD ["node", "dist/index.js"]
```

### Validation Test

```bash
# ================================
# Unit Tests
# ================================

# Run all unit tests (both API and web)
pnpm test

# Run API unit tests specifically
cd apps/api && npx vitest run --no-watch
# → All tests should pass

# Run web unit tests specifically
cd apps/web && npx vitest run --no-watch
# → All tests should pass

# ================================
# Integration Tests
# ================================

# Ensure Docker services are running
docker compose up -d postgres redis

# Run API integration tests
pnpm --filter api test:integration
# → All integration tests should pass

# ================================
# Docker Build
# ================================

# Build the Docker image
docker build -t trading-intel-api apps/api/
# → Multi-stage build should complete without errors

# Verify the image runs
docker run --rm trading-intel-api node --version
# → Should output v24.x.x

# Verify non-root user
docker run --rm trading-intel-api whoami
# → Should output "node" (not "root")

# ================================
# Frontend Production Build
# ================================

pnpm --filter web build
ls -la apps/web/dist/
# → Should contain: index.html, assets/ directory with .js and .css bundles

# Verify production bundle size is reasonable
du -sh apps/web/dist/
# → Should be < 5MB for initial bundle

# ================================
# Full System Smoke Test
# ================================

docker compose up -d
# Wait for all services to be healthy (postgres, redis, api)

# Health check
curl -s http://localhost:3000/api/health | jq .
# → { "status": "healthy", ... }

# Verify all endpoints respond
curl -s http://localhost:3000/api/news?page=1&limit=1 | jq .success
# → true

curl -s http://localhost:3000/api/opportunities?page=1&limit=1 | jq .success
# → true

# Clean up
docker compose down
```

### Pass Criteria

All unit tests pass with zero failures, all integration tests pass with Docker services, Docker image builds successfully with multi-stage optimization and non-root user, frontend production build generates optimized static assets, and full system smoke test returns healthy status from all endpoints.

---

## Appendix A: Environment Setup

### Required API Keys

All API keys must be configured in a `.env` file at the repository root. See `.env.example` for the complete variable list with documentation.

| Service | Variable | How to Obtain | Rate Limit (Free Tier) |
|---------|----------|---------------|----------------------|
| OpenRouter | `OPENROUTER_API_KEY` | Sign up at [openrouter.ai](https://openrouter.ai), create API key in dashboard | Per-model limits |
| Finnhub | `FINNHUB_API_KEY` | Register at [finnhub.io](https://finnhub.io) for free API key | 60 calls/min |
| Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | Register at [alphavantage.co](https://www.alphavantage.co) for free key | 25 calls/day |
| CoinGecko | `COINGECKO_API_KEY` | Register at [coingecko.com](https://www.coingecko.com) for Demo API key | 30 calls/min |
| CryptoCompare | `CRYPTOCOMPARE_API_KEY` | Register at [cryptocompare.com](https://www.cryptocompare.com) for API key | 100,000 calls/month |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) on Telegram, use `/newbot` command | 30 msgs/sec |

### Database Configuration

The application supports two database providers via the `DATABASE_PROVIDER` environment variable:

**Local PostgreSQL (default):**

```env
DATABASE_PROVIDER=local
DATABASE_URL=postgresql://trading:trading_secret@localhost:5432/trading_intelligence
```

Start with Docker Compose:

```bash
docker compose up -d postgres
```

**Supabase (cloud):**

```env
DATABASE_PROVIDER=supabase
DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

> **Important:** When using Supabase, the Drizzle ORM connection automatically sets `prepare: false` to ensure compatibility with Supabase's pgBouncer transaction pooler. This is configured in `apps/api/src/db/index.ts` and requires no manual intervention.

### Redis Configuration

```env
REDIS_URL=redis://localhost:6379
```

Start with Docker Compose:

```bash
docker compose up -d redis
```

### Complete Quick Start

```bash
# 1. Clone and install
git clone <repository-url>
cd trading-intelligence
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Start infrastructure
docker compose up -d postgres redis

# 4. Initialize database
pnpm --filter api db:push
pnpm --filter api db:seed

# 5. Start development servers
pnpm dev
# API: http://localhost:3000
# Web: http://localhost:5173
# Bull Board: http://localhost:3000/admin/queues
```

---

## Appendix B: Troubleshooting

### Common Issues and Solutions

| Issue | Symptom | Solution |
|-------|---------|----------|
| **PostgreSQL connection refused** | `ECONNREFUSED 127.0.0.1:5432` | Verify Docker is running: `docker compose ps`. Check `DATABASE_URL` in `.env`. Restart: `docker compose restart postgres` |
| **Redis connection refused** | `ECONNREFUSED 127.0.0.1:6379` | Verify Redis container: `docker compose ps`. Check `REDIS_URL` in `.env`. Restart: `docker compose restart redis` |
| **OpenRouter 401 Unauthorized** | `Authentication error` from LLM calls | Verify `OPENROUTER_API_KEY` is set correctly in `.env`. Check API key is active at [openrouter.ai/keys](https://openrouter.ai/keys) |
| **OpenRouter 402 Payment Required** | `Insufficient credits` | Add credits to your OpenRouter account. Check model pricing at [openrouter.ai/models](https://openrouter.ai/models) |
| **Telegram bot not responding** | Bot doesn't reply to commands | Verify `TELEGRAM_BOT_TOKEN` is correct. Check for polling conflicts (only one long-polling instance allowed per bot). Restart the API server |
| **Telegram MarkdownV2 parse error** | `Bad Request: can't parse entities` | Check the message formatter for unescaped special characters. All of `_ * [ ] ( ) ~ ` ` ` > # + - = | { } . !` must be escaped with `\` |
| **Supabase pgBouncer errors** | `prepared statement does not exist` | Ensure `DATABASE_PROVIDER=supabase` is set in `.env`. The Drizzle connection sets `prepare: false` automatically when this variable is set |
| **pnpm workspace resolution** | `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` | Run `pnpm install` from the repository root. Verify `pnpm-workspace.yaml` includes `apps/*` and `packages/*` |
| **TypeScript strict mode errors** | `Type 'X' is not assignable to type 'Y'` | All code must compile under strict mode. Use explicit type annotations, handle `undefined` from indexed access, avoid `any` |
| **Rate limiter blocking requests** | Fetchers returning empty results | Check Bottleneck configuration for the specific API. Free-tier limits may require spreading requests. Check `api_sources` table for `error_count` |
| **BullMQ jobs stuck in queue** | Jobs not being processed | Verify Redis is connected. Check worker is running. Inspect failed jobs in Bull Board at `/admin/queues` |
| **Vite proxy not working** | CORS errors from frontend | Verify Vite config has proxy for `/api` pointing to `http://localhost:3000`. Ensure API server is running |
| **Docker build fails** | Multi-stage build errors | Check `apps/api/Dockerfile` syntax. Verify `pnpm-lock.yaml` is committed. Try: `docker build --no-cache -t trading-intel-api apps/api/` |
| **Node.js version mismatch** | Unexpected runtime errors | This project requires Node.js 24.x LTS. Check: `node --version`. Install via nvm: `nvm install 24` |

### Debug Commands

```bash
# Check all service health
curl -s http://localhost:3000/api/health | jq .

# View recent logs (if using PM2 in production)
pm2 logs trading-intelligence --lines 50

# Inspect queue state
# Open http://localhost:3000/admin/queues in browser

# Check database state
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public';"

# Check Redis connection
docker exec trading-intel-redis redis-cli ping
# → PONG

# Verify rate limiter state
# Check api_sources table for error counts and last success timestamps
docker exec trading-intel-postgres psql -U trading -d trading_intelligence \
  -c "SELECT name, is_active, error_count, last_success_at FROM api_sources;"
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | March 2026 | Initial 10-phase implementation plan |
