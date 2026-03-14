# Trading Intelligence Application

> Multi-market financial news analysis platform with AI-powered trade recommendations

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24.x_LTS-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Overview

Trading Intelligence is a production-ready financial news analysis platform that aggregates news from **30+ sources** across US stocks, Indian equities (NSE/BSE), and cryptocurrency markets. Articles flow through a **four-stage AI analysis pipeline** powered by LangGraph.js and OpenRouter, delivering actionable trade recommendations via Telegram bot and a React web dashboard.

### Key Features

- **Multi-market news aggregation** — US stocks, Indian equities, and crypto from 30+ sources (Finnhub, CoinGecko, CryptoCompare, RSS feeds, Reddit)
- **AI-powered 4-stage analysis pipeline** — Filter → Sentiment → Trade Detection → Recommendation with conditional short-circuiting
- **Tiered LLM strategy via OpenRouter** — DeepSeek V3.2 for filtering, Claude Haiku 4.5 for sentiment/trade detection, Claude Sonnet 4.6 for recommendations (~75% cost reduction)
- **Telegram bot for real-time trade alerts** — grammY-based bot with inline keyboards, MarkdownV2 formatting, and emoji indicators (🟢 LONG / 🔴 SHORT)
- **React web dashboard with dark theme** — Live news feed, trade opportunities board, performance charts, and settings management
- **BullMQ job queue infrastructure** — Three queues (news-polling, analysis, notifications) with Redis 7, cron scheduling, and priority levels
- **PostgreSQL database with Drizzle ORM** — 7 core tables with proper financial decimal precision, URL-based deduplication, and Supabase compatibility

---

## Architecture

This project is structured as a **Turborepo + pnpm workspaces monorepo** with the following workspace packages:

| Workspace | Description |
|---|---|
| `apps/api` | Node.js Express backend (TypeScript) — REST API, Telegram bot, job queues, AI pipeline |
| `apps/web` | React + Vite + TypeScript frontend — Dark-themed dashboard with charts and filters |
| `packages/types` | Shared TypeScript interfaces and enums for cross-workspace type safety |
| `packages/config` | Shared ESLint and TypeScript configuration |
| `packages/utils` | Shared formatting and validation utilities (Zod schemas, currency helpers) |

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         External Data Sources                          │
│  Finnhub · Alpha Vantage · CoinGecko · CryptoCompare · Binance · RSS  │
│  Economic Times · Financial Express · Business Standard · Reddit       │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  News Polling Worker (BullMQ · 5-min cron)                              │
│  Fetches articles → Deduplicates by URL → Stores in PostgreSQL          │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Analysis Worker (BullMQ)                                                │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  ┌───────────────┐  │
│  │   Filter    │→│ Sentiment  │→│ Trade Detection │→│ Recommendation │  │
│  │ DeepSeek   │  │ Claude     │  │ Claude Haiku   │  │ Claude Sonnet  │  │
│  │ V3.2       │  │ Haiku 4.5  │  │ 4.5            │  │ 4.6            │  │
│  └────────────┘  └────────────┘  └────────────────┘  └───────────────┘  │
│  LangGraph.js StateGraph · Conditional edges · ~25% reach final stage   │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Trade Opportunities (PostgreSQL)                                        │
│  Stored with numeric(12,4) precision · Cross-validated against market    │
└────────────────┬─────────────────────────────────────┬───────────────────┘
                 │                                     │
                 ▼                                     ▼
┌────────────────────────────────┐  ┌──────────────────────────────────────┐
│  Notification Worker (BullMQ)  │  │  React Dashboard (Vite + React 19)   │
│  Matches subscriber prefs      │  │  News feed · Trade board · Charts    │
│  Formats MarkdownV2 alerts     │  │  Dark theme · Responsive layout      │
│  Sends via Telegram Bot API    │  │  Sidebar navigation · Filter bar     │
└────────────────────────────────┘  └──────────────────────────────────────┘
```

---

## Tech Stack

| Category | Technology | Version |
|---|---|---|
| **Runtime** | Node.js LTS | 24.x (Krypton) |
| **Language** | TypeScript | ~5.9.x (strict mode) |
| **Build System** | Turborepo + pnpm workspaces | v2.8.x |
| **Backend Framework** | Express | ^4.21.x |
| **Database** | PostgreSQL + Drizzle ORM | 16.x + ^0.45.x |
| **Job Queue** | BullMQ + Redis | ^5.71.x + 7.x |
| **AI Pipeline** | LangGraph.js + OpenRouter | ^1.2.x |
| **LLM Models** | DeepSeek V3.2 / Claude Haiku 4.5 / Claude Sonnet 4.6 | via OpenRouter |
| **Telegram Bot** | grammY | ^1.41.x |
| **Frontend** | React + Vite + Recharts | 19.x + 6.x + ^2.15.x |
| **Logging** | Pino | ^10.x |
| **Rate Limiting** | Bottleneck | ^2.19.x |
| **Validation** | Zod | ^3.24.x |
| **Queue Dashboard** | Bull Board | ^6.20.x |

### LLM Cost Strategy

| Pipeline Stage | Model | Cost (input / output per 1M tokens) | Rationale |
|---|---|---|---|
| Filtering | DeepSeek V3.2 | $0.25 / $0.38 | Binary classification, high volume |
| Sentiment | Claude Haiku 4.5 | $1.00 / $5.00 | Nuanced language understanding |
| Trade Detection | Claude Haiku 4.5 | $1.00 / $5.00 | Moderate analytical reasoning |
| Recommendation | Claude Sonnet 4.6 | $3.00 / $15.00 | Complex reasoning, precise output |

Only ~25% of articles reach the expensive recommendation stage, achieving approximately **75% LLM cost reduction** compared to routing all articles through the most capable model.

---

## Prerequisites

Before you begin, ensure the following are installed and available:

- **Node.js** 24.x LTS — [Download](https://nodejs.org/)
- **pnpm** 9.x — Install via `corepack enable && corepack prepare pnpm@latest --activate`
- **Docker** & **Docker Compose** — [Download](https://www.docker.com/) (for PostgreSQL and Redis)
- **API Keys** (required for full functionality):
  - [OpenRouter API Key](https://openrouter.ai/) — LLM inference gateway
  - [Finnhub API Key](https://finnhub.io/) — US stock news and quotes
  - [Telegram Bot Token](https://core.telegram.org/bots#botfather) — Bot creation via @BotFather
  - [CoinGecko API Key](https://www.coingecko.com/en/api) — Crypto market data (free tier)
  - [CryptoCompare API Key](https://min-api.cryptocompare.com/) — Crypto news (free tier)
  - [Alpha Vantage API Key](https://www.alphavantage.co/) — Historical data and sentiment (free tier)

---

## Getting Started

### 1. Clone the repository

```bash
git clone <repository-url>
cd trading-intelligence
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your API keys and configuration values. See the [Environment Variables](#environment-variables) section for details.

### 3. Start infrastructure services

```bash
docker compose up -d postgres redis
```

This starts PostgreSQL 16 and Redis 7 with persistent volumes and health checks.

### 4. Install dependencies

```bash
pnpm install
```

### 5. Run database migrations

```bash
pnpm --filter api db:migrate
```

### 6. Seed the database

```bash
pnpm --filter api db:seed
```

This populates the `api_sources` table with all configured data sources and creates a test user.

### 7. Start development servers

```bash
pnpm dev
```

This starts both the API server and the React dev server concurrently via Turborepo:

- **API**: http://localhost:3000
- **Web Dashboard**: http://localhost:5173
- **Queue Dashboard**: http://localhost:3000/admin/queues

---

## Project Structure

```
trading-intelligence/
├── apps/
│   ├── api/                          # Express backend application
│   │   ├── src/
│   │   │   ├── index.ts              # Application entry point
│   │   │   ├── config/
│   │   │   │   ├── env.ts            # Zod-validated environment config
│   │   │   │   └── constants.ts      # Application constants
│   │   │   ├── db/
│   │   │   │   ├── index.ts          # Drizzle ORM connection factory
│   │   │   │   ├── seed.ts           # Database seed script
│   │   │   │   ├── migrations/       # Auto-generated SQL migrations
│   │   │   │   └── schema/
│   │   │   │       ├── index.ts      # Schema barrel export
│   │   │   │       ├── enums.ts      # PostgreSQL enum definitions
│   │   │   │       ├── relations.ts  # Drizzle ORM table relations
│   │   │   │       ├── news-articles.ts
│   │   │   │       ├── trade-opportunities.ts
│   │   │   │       ├── trade-performance.ts
│   │   │   │       ├── user-settings.ts
│   │   │   │       ├── api-sources.ts
│   │   │   │       ├── analysis-logs.ts
│   │   │   │       └── notification-logs.ts
│   │   │   ├── services/
│   │   │   │   ├── news-fetcher/     # News ingestion from all sources
│   │   │   │   │   ├── index.ts      # Orchestrator
│   │   │   │   │   ├── finnhub.ts    # Finnhub API client
│   │   │   │   │   ├── rss-parser.ts # RSS feed parser
│   │   │   │   │   ├── reddit.ts     # Reddit RSS/API client
│   │   │   │   │   ├── coingecko.ts  # CoinGecko API client
│   │   │   │   │   ├── cryptocompare.ts
│   │   │   │   │   ├── binance.ts    # Binance REST client
│   │   │   │   │   ├── alpha-vantage.ts
│   │   │   │   │   └── nse-india.ts  # NSE India wrapper
│   │   │   │   ├── analyzer/         # LangGraph.js AI pipeline
│   │   │   │   │   ├── index.ts      # StateGraph assembly
│   │   │   │   │   ├── state.ts      # Annotation-based typed state
│   │   │   │   │   ├── schemas.ts    # Zod schemas for LLM output
│   │   │   │   │   ├── prompts.ts    # System prompts (DK-CoT)
│   │   │   │   │   ├── models.ts     # OpenRouter model config
│   │   │   │   │   └── nodes/
│   │   │   │   │       ├── filter.ts
│   │   │   │   │       ├── sentiment.ts
│   │   │   │   │       ├── trade-detect.ts
│   │   │   │   │       └── recommend.ts
│   │   │   │   └── notifier/         # Notification dispatch
│   │   │   │       ├── index.ts      # Subscriber matching
│   │   │   │       └── formatter.ts  # MarkdownV2 formatter
│   │   │   ├── queues/
│   │   │   │   ├── index.ts          # Queue registry + Redis connection
│   │   │   │   ├── news-polling.queue.ts
│   │   │   │   ├── analysis.queue.ts
│   │   │   │   ├── notifications.queue.ts
│   │   │   │   └── workers/
│   │   │   │       ├── news-polling.worker.ts
│   │   │   │       ├── analysis.worker.ts
│   │   │   │       └── notifications.worker.ts
│   │   │   ├── bot/
│   │   │   │   ├── index.ts          # grammY bot initialization
│   │   │   │   ├── keyboards.ts      # Inline keyboard builders
│   │   │   │   ├── callbacks.ts      # Callback query handlers
│   │   │   │   └── commands/
│   │   │   │       ├── start.ts      # /start — user registration
│   │   │   │       ├── settings.ts   # /settings — preference config
│   │   │   │       └── status.ts     # /status — system health
│   │   │   ├── routes/
│   │   │   │   ├── index.ts          # Router aggregator
│   │   │   │   ├── news.routes.ts
│   │   │   │   ├── opportunities.routes.ts
│   │   │   │   ├── performance.routes.ts
│   │   │   │   ├── settings.routes.ts
│   │   │   │   └── health.routes.ts
│   │   │   ├── middleware/
│   │   │   │   ├── error-handler.ts
│   │   │   │   ├── request-logger.ts
│   │   │   │   └── cors.ts
│   │   │   └── lib/
│   │   │       ├── logger.ts         # Pino logger factory
│   │   │       ├── rate-limiter.ts   # Bottleneck instances
│   │   │       └── openrouter.ts     # ChatOpenAI factory
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   └── integration/
│   │   ├── drizzle.config.ts
│   │   ├── ecosystem.config.js       # PM2 cluster config
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                          # React frontend application
│       ├── src/
│       │   ├── main.tsx              # React app bootstrap
│       │   ├── App.tsx               # Route definitions
│       │   ├── styles/
│       │   │   └── globals.css       # Dark theme CSS variables
│       │   ├── layouts/
│       │   │   └── DashboardLayout.tsx
│       │   ├── pages/
│       │   │   ├── NewsFeed.tsx
│       │   │   ├── TradeOpportunities.tsx
│       │   │   ├── Performance.tsx
│       │   │   └── Settings.tsx
│       │   ├── components/
│       │   │   ├── Sidebar.tsx
│       │   │   ├── NewsCard.tsx
│       │   │   ├── TradeCard.tsx
│       │   │   ├── FilterBar.tsx
│       │   │   ├── PerformanceChart.tsx
│       │   │   └── HealthIndicator.tsx
│       │   ├── hooks/
│       │   │   ├── useApi.ts
│       │   │   ├── useNews.ts
│       │   │   └── useOpportunities.ts
│       │   ├── lib/
│       │   │   └── api-client.ts
│       │   └── types/
│       │       └── index.ts
│       ├── index.html
│       ├── vite.config.ts
│       ├── vercel.json
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── types/                        # Shared TypeScript interfaces
│   │   └── src/
│   │       ├── index.ts
│   │       ├── news.ts
│   │       ├── trade.ts
│   │       ├── user.ts
│   │       ├── api.ts
│   │       └── queue.ts
│   ├── config/                       # Shared ESLint + TS config
│   │   └── eslint.js
│   └── utils/                        # Shared utilities
│       └── src/
│           ├── index.ts
│           ├── formatting.ts
│           └── validation.ts
├── docs/
│   ├── specification.md
│   └── implementation-plan.md
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── docker-compose.yml
├── .env.example
├── .eslintrc.js
├── .prettierrc
├── .gitignore
├── package.json
└── README.md
```

---

## API Endpoints

All endpoints are prefixed with `/api` and served by the Express backend.

### News Feed

```
GET /api/news
```

Returns a paginated list of news articles with optional filters.

| Parameter | Type | Description |
|---|---|---|
| `page` | `number` | Page number (default: 1) |
| `limit` | `number` | Items per page (default: 20, max: 100) |
| `market` | `string` | Filter by market: `us`, `india`, `crypto`, `social` |
| `source` | `string` | Filter by news source |
| `startDate` | `string` | ISO 8601 date — filter articles published after this date |
| `endDate` | `string` | ISO 8601 date — filter articles published before this date |

### Trade Opportunities

```
GET /api/opportunities
```

Returns filterable and sortable trade opportunities.

| Parameter | Type | Description |
|---|---|---|
| `page` | `number` | Page number (default: 1) |
| `limit` | `number` | Items per page (default: 20) |
| `market` | `string` | Filter by market: `us`, `india`, `crypto` |
| `status` | `string` | Filter by status: `active`, `closed`, `expired` |
| `direction` | `string` | Filter by direction: `long`, `short` |
| `minConfidence` | `number` | Minimum confidence score (0.00–1.00) |
| `sortBy` | `string` | Sort field: `created_at`, `confidence`, `symbol` |
| `sortOrder` | `string` | Sort order: `asc`, `desc` |

### Performance Tracking

```
GET /api/performance
```

Returns trade performance statistics and history.

| Parameter | Type | Description |
|---|---|---|
| `startDate` | `string` | ISO 8601 date — start of date range |
| `endDate` | `string` | ISO 8601 date — end of date range |
| `market` | `string` | Filter by market |
| `aggregate` | `string` | Aggregation: `daily`, `weekly`, `monthly` |

### User Settings

```
GET /api/settings/:chatId
PUT /api/settings/:chatId
```

Read and update user notification preferences by Telegram chat ID.

**PUT request body:**

```json
{
  "markets": ["us", "crypto"],
  "minConfidence": 0.75,
  "timeframes": ["1h", "4h", "1d"],
  "isActive": true
}
```

### Health Check

```
GET /api/health
```

Returns system health status with dependency checks.

**Response example:**

```json
{
  "status": "healthy",
  "timestamp": "2026-03-14T12:00:00.000Z",
  "dependencies": {
    "postgresql": { "status": "connected", "latency_ms": 2 },
    "redis": { "status": "connected", "latency_ms": 1 },
    "openrouter": { "status": "reachable" }
  },
  "queues": {
    "news-polling": { "waiting": 0, "active": 1, "completed": 142 },
    "analysis": { "waiting": 3, "active": 2, "completed": 89 },
    "notifications": { "waiting": 0, "active": 0, "completed": 34 }
  }
}
```

---

## Telegram Bot Commands

The Telegram bot is built with [grammY](https://grammy.dev/) and supports the following commands:

| Command | Description |
|---|---|
| `/start` | Register as a subscriber and receive a welcome message with default notification preferences |
| `/settings` | Open an interactive inline keyboard to configure notification preferences (markets, confidence threshold, timeframes) |
| `/status` | View current system health summary — queue sizes, last poll time, pipeline statistics, and API source status |

### Trade Alert Format

When a trade opportunity matches your preferences, you receive a formatted alert:

```
🟢 LONG Signal — AAPL

Direction: LONG
Confidence: 87%
Timeframe: 4h

Entry: `$185.50`
Stop Loss: `$182.00`
Take Profit: `$192.75`
Risk/Reward: 1:2.07

Source: Finnhub — Apple reports record Q1 earnings
```

- 🟢 indicates a **LONG** recommendation
- 🔴 indicates a **SHORT** recommendation
- Prices are displayed in monospace code blocks for clarity

---

## Environment Variables

Copy `.env.example` to `.env` and configure the following variables. See `.env.example` for the full documented list with descriptions.

### Critical Variables

| Variable | Description | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/trading_intel`) | Yes |
| `REDIS_URL` | Redis connection string (e.g., `redis://localhost:6379`) | Yes |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM inference | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | Yes |
| `FINNHUB_API_KEY` | Finnhub API key for US stock news and quotes | Yes |

### Optional Variables

| Variable | Description | Default |
|---|---|---|
| `COINGECKO_API_KEY` | CoinGecko API key (free tier) | — |
| `CRYPTOCOMPARE_API_KEY` | CryptoCompare API key (free tier) | — |
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage API key (free tier) | — |
| `NODE_ENV` | Application environment | `development` |
| `PORT` | Express server port | `3000` |
| `LOG_LEVEL` | Pino log level (`debug`, `info`, `warn`, `error`) | `info` |
| `POLLING_INTERVAL_MS` | News polling interval in milliseconds | `300000` (5 min) |
| `USE_SUPABASE` | Toggle Supabase connection mode (`true`/`false`) | `false` |
| `SUPABASE_URL` | Supabase project URL (when `USE_SUPABASE=true`) | — |

---

## Development

### Useful Commands

```bash
# Start all development servers (API + Web) via Turborepo
pnpm dev

# Build all packages and applications
pnpm build

# Run linting across all workspaces
pnpm lint

# Run all tests
pnpm test

# Run tests for a specific workspace
pnpm --filter api test
pnpm --filter web test

# Generate a new database migration
pnpm --filter api db:generate

# Push schema changes directly (development only)
pnpm --filter api db:push

# Run database seed script
pnpm --filter api db:seed

# Type-check all workspaces
pnpm typecheck
```

### Development Workflow

1. **Infrastructure**: Ensure PostgreSQL and Redis are running via `docker compose up -d postgres redis`
2. **Code changes**: Edit files — Turborepo watches and rebuilds affected packages automatically
3. **Database changes**: Modify Drizzle schema files, then run `pnpm --filter api db:generate` to create a migration
4. **Testing**: Run `pnpm test` to execute unit and integration tests across all workspaces

---

## Deployment

### Docker

Build and run the entire stack using Docker Compose:

```bash
# Build all services
docker compose build

# Start all services (PostgreSQL, Redis, API, Web)
docker compose up -d

# View logs
docker compose logs -f api
```

The multi-stage Dockerfile for `apps/api` produces a minimal production image:

1. **deps** stage — Installs production dependencies only
2. **build** stage — Compiles TypeScript to JavaScript
3. **production** stage — Runs with non-root user for security

### PM2 (Production Process Manager)

For non-Docker production deployments, use PM2 with cluster mode:

```bash
# Install PM2 globally
npm install -g pm2

# Start with ecosystem config
cd apps/api
pm2 start ecosystem.config.js

# Monitor processes
pm2 monit

# View logs
pm2 logs trading-intel-api
```

The `ecosystem.config.js` configures:

- Cluster mode with `max` instances (one per CPU core)
- Automatic restart on failure with exponential backoff
- Memory limit per process
- Log file rotation

### Vercel (Frontend)

The React frontend can be deployed to Vercel:

```bash
cd apps/web
vercel deploy --prod
```

The `vercel.json` configuration handles client-side routing rewrites and API proxy settings.

---

## Queue Dashboard

The application includes a built-in queue monitoring dashboard powered by [Bull Board](https://github.com/felixmosh/bull-board).

**URL**: http://localhost:3000/admin/queues

The dashboard provides real-time visibility into:

- **news-polling** queue — Scheduled every 5 minutes via cron, fetches articles from all configured sources
- **analysis** queue — Processes articles through the LangGraph AI pipeline with configurable concurrency
- **notifications** queue — Dispatches Telegram trade alerts with priority levels (breaking news = priority 1)

Each queue displays job counts (waiting, active, completed, failed), individual job details, retry status, and processing duration metrics.

---

## License

This project is licensed under the [MIT License](LICENSE).
