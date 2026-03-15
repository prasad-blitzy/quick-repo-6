# Trading Intelligence Application — Master Specification

> **Version:** 1.0.0 | **Date:** March 2026

---

## Executive Summary

The Trading Intelligence Application is a production-ready, multi-market financial news analysis platform that aggregates news and social sentiment from over 30 sources spanning US stocks, Indian equities (NSE/BSE), and cryptocurrency markets. It leverages a curated stack of free APIs — including Finnhub, CoinGecko, CryptoCompare, Binance, Alpha Vantage, and RSS feeds from Economic Times, Financial Express, Business Standard, and Reddit — to build a comprehensive real-time picture of market-moving events across global financial markets.

At its core, the platform implements an AI-powered four-stage analysis pipeline built on LangGraph.js. This directed graph routes articles through Filter, Sentiment Analysis, Trade Detection, and Recommendation stages with conditional short-circuiting that terminates early for irrelevant or non-actionable content. By deploying a tiered OpenRouter model strategy — DeepSeek V3.2 for high-volume filtering, Claude Haiku 4.5 for sentiment and trade detection, and Claude Sonnet 4.6 only for the ~25% of articles that reach the recommendation stage — the system achieves approximately 75% reduction in LLM inference costs compared to a single-model approach.

Actionable trade recommendations are delivered to subscribers via a grammY-powered Telegram bot with inline keyboard preference management and MarkdownV2-formatted alerts. A React web dashboard provides a dark-themed, responsive interface for browsing the live news feed, reviewing trade opportunities with filter controls, analyzing historical performance through Recharts visualizations, and managing notification settings. The entire system is architected as a Turborepo + pnpm workspaces monorepo with `apps/api` (Express backend), `apps/web` (React + Vite frontend), and shared `packages/` (types, config, utils), backed by PostgreSQL 16 with Drizzle ORM and BullMQ job queues on Redis 7.

---

## Table of Contents

- [System Architecture](#system-architecture)
  - [Data Flow Diagram](#data-flow-diagram)
  - [Monorepo Structure](#monorepo-structure)
  - [Technology Stack](#technology-stack)
- [Database Schema](#database-schema)
  - [Table: news_articles](#table-news_articles)
  - [Table: trade_opportunities](#table-trade_opportunities)
  - [Table: trade_performance](#table-trade_performance)
  - [Table: user_settings](#table-user_settings)
  - [Table: api_sources](#table-api_sources)
  - [Table: analysis_logs](#table-analysis_logs)
  - [Table: notification_logs](#table-notification_logs)
  - [Foreign Key Relationships](#foreign-key-relationships)
  - [Entity-Relationship Diagram](#entity-relationship-diagram)
- [AI Analysis Pipeline](#ai-analysis-pipeline)
  - [Pipeline Architecture](#pipeline-architecture)
  - [Pipeline Flow Diagram](#pipeline-flow-diagram)
  - [Conditional Short-Circuiting](#conditional-short-circuiting)
  - [Tiered Model Strategy](#tiered-model-strategy)
  - [Critical LLM Rules](#critical-llm-rules)
  - [Zod Schemas for Structured Output](#zod-schemas-for-structured-output)
- [News Ingestion](#news-ingestion)
  - [Data Source Stack](#data-source-stack)
  - [Fetcher Modules](#fetcher-modules)
  - [Rate Limiting Strategy](#rate-limiting-strategy)
  - [URL-Based Deduplication](#url-based-deduplication)
  - [Graceful Degradation](#graceful-degradation)
- [Job Queue Infrastructure](#job-queue-infrastructure)
  - [Queue: news-polling](#queue-news-polling)
  - [Queue: analysis](#queue-analysis)
  - [Queue: notifications](#queue-notifications)
  - [Shared Queue Configuration](#shared-queue-configuration)
- [Telegram Bot](#telegram-bot)
  - [Bot Commands](#bot-commands)
  - [Inline Keyboard Interaction](#inline-keyboard-interaction)
  - [Trade Alert Message Format](#trade-alert-message-format)
- [REST API](#rest-api)
  - [Endpoints](#endpoints)
  - [Middleware Stack](#middleware-stack)
  - [Bull Board Dashboard](#bull-board-dashboard)
- [Web Dashboard](#web-dashboard)
  - [Frontend Stack](#frontend-stack)
  - [Dark Theme Design](#dark-theme-design)
  - [Pages](#pages)
  - [Component Architecture](#component-architecture)
  - [Custom Hooks](#custom-hooks)
  - [API Client](#api-client)
- [Observability](#observability)
  - [Structured Logging](#structured-logging)
  - [Queue Dashboard](#queue-dashboard)
  - [Rate Limiters](#rate-limiters)
  - [Health Check](#health-check)
- [Deployment](#deployment)
  - [Docker](#docker)
  - [PM2 Production Mode](#pm2-production-mode)
  - [Vercel Frontend Deployment](#vercel-frontend-deployment)
  - [Environment Configuration](#environment-configuration)
- [Appendix: Development Rules](#appendix-development-rules)

---

## System Architecture

### Data Flow Diagram

The following Mermaid diagram illustrates the complete data flow through the Trading Intelligence Application, from external API ingestion through AI analysis to end-user delivery:

```mermaid
graph TD
    subgraph "External Data Sources"
        FH[Finnhub API<br/>US Stock News + Quotes]
        AV[Alpha Vantage API<br/>Historical + Sentiment]
        CG[CoinGecko API<br/>Crypto Trending + Data]
        CC[CryptoCompare API<br/>Crypto News + Data]
        BN[Binance API<br/>Crypto Price Data]
        NSE[stock-nse-india<br/>Indian Equity Quotes]
        RSS[RSS Feeds<br/>ET / FE / BS / CNBC / MarketWatch]
        RD[Reddit RSS/API<br/>WSB / ISB Sentiment]
    end

    subgraph "External Services"
        OR[OpenRouter LLM API<br/>DeepSeek / Haiku / Sonnet]
        TG[Telegram Bot API<br/>Message Delivery]
    end

    subgraph "apps/api — Express Backend"
        NF[News Fetcher Services<br/>Bottleneck Rate Limited]

        subgraph "BullMQ Queues + Workers"
            Q1[news-polling Queue<br/>Cron: every 5 min]
            W1[Polling Worker<br/>Fetch + Deduplicate]
            Q2[analysis Queue<br/>Per-article processing]
            W2[Analysis Worker<br/>LangGraph Pipeline]
            Q3[notifications Queue<br/>Priority-based]
            W3[Notification Worker<br/>Subscriber Matching]
        end

        LG[LangGraph Pipeline<br/>Filter → Sentiment → Trade → Recommend]
        BOT[grammY Bot<br/>Commands + Inline Keyboards]
        API[Express REST API<br/>Routes + Middleware]
        DB[(PostgreSQL 16<br/>Drizzle ORM<br/>7 Tables)]
        RDS[(Redis 7<br/>Queue Backing Store)]
    end

    subgraph "apps/web — React Frontend"
        DASH[React Dashboard<br/>Dark Theme / Recharts]
    end

    FH --> NF
    AV --> NF
    CG --> NF
    CC --> NF
    BN --> NF
    NSE --> NF
    RSS --> NF
    RD --> NF

    NF --> W1
    Q1 --> W1
    W1 -->|Deduplicated Articles| DB
    W1 -->|New Articles| Q2

    Q2 --> W2
    W2 --> LG
    LG -->|LLM Inference| OR
    LG -->|Results| DB

    LG -->|Trade Detected| Q3
    Q3 --> W3
    W3 -->|Match Preferences| DB
    W3 -->|Send Alerts| BOT
    BOT --> TG

    API --> DB
    DASH -->|HTTP Requests| API

    Q1 -.- RDS
    Q2 -.- RDS
    Q3 -.- RDS
```

### Monorepo Structure

The project is organized as a Turborepo + pnpm workspaces monorepo with the following directory layout:

```
trading-intelligence/
├── apps/
│   ├── api/                          # Express backend (TypeScript)
│   │   ├── src/
│   │   │   ├── config/               # Environment validation, constants
│   │   │   ├── db/                   # Drizzle ORM schema, connection, seed
│   │   │   │   ├── schema/           # Table definitions, enums, relations
│   │   │   │   └── migrations/       # Auto-generated SQL migrations
│   │   │   ├── services/
│   │   │   │   ├── news-fetcher/     # API-specific fetcher modules
│   │   │   │   ├── analyzer/         # LangGraph.js pipeline nodes
│   │   │   │   └── notifier/         # Notification matching + formatting
│   │   │   ├── queues/
│   │   │   │   └── workers/          # BullMQ worker implementations
│   │   │   ├── bot/
│   │   │   │   └── commands/         # grammY command handlers
│   │   │   ├── routes/               # Express route handlers
│   │   │   ├── middleware/           # Error handler, logger, CORS
│   │   │   ├── lib/                  # Logger, rate limiter, OpenRouter client
│   │   │   └── index.ts             # Application entry point
│   │   ├── tests/
│   │   │   ├── unit/                 # Unit tests (services, queues, bot)
│   │   │   └── integration/          # Integration tests (pipeline, API)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   ├── Dockerfile
│   │   └── ecosystem.config.js       # PM2 cluster mode config
│   └── web/                          # React + Vite frontend (TypeScript)
│       ├── src/
│       │   ├── components/           # Reusable UI components
│       │   ├── pages/                # Route page components
│       │   ├── layouts/              # Layout shells (DashboardLayout)
│       │   ├── hooks/                # Custom data-fetching hooks
│       │   ├── lib/                  # API client configuration
│       │   ├── styles/               # Global CSS, dark theme variables
│       │   ├── types/                # Frontend-specific type re-exports
│       │   ├── __tests__/            # Component and page tests
│       │   ├── main.tsx              # React app bootstrap
│       │   └── App.tsx               # Root component with routing
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       └── vercel.json
├── packages/
│   ├── types/                        # Shared TypeScript interfaces
│   │   └── src/
│   │       ├── index.ts              # Barrel export
│   │       ├── news.ts              # NewsArticle, Market enum
│   │       ├── trade.ts             # TradeOpportunity, Direction, Timeframe
│   │       ├── user.ts              # UserSettings, NotificationPreference
│   │       ├── api.ts               # API request/response envelopes
│   │       └── queue.ts             # Queue job payload types
│   ├── config/                       # Shared ESLint and TypeScript config
│   │   ├── eslint.js
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── utils/                        # Shared formatting and validation
│       └── src/
│           ├── index.ts              # Barrel export
│           ├── formatting.ts         # Currency, percentage, date helpers
│           └── validation.ts         # Shared Zod validation schemas
├── docs/
│   ├── specification.md              # This document
│   └── implementation-plan.md        # 10-phase implementation plan
├── docker-compose.yml                # PostgreSQL 16 + Redis 7
├── turbo.json                        # Turborepo task pipeline
├── pnpm-workspace.yaml               # Workspace package paths
├── tsconfig.base.json                # Shared TypeScript base config
├── package.json                      # Root workspace scripts
├── .eslintrc.js                      # Root ESLint config
├── .prettierrc                       # Formatting rules
├── .gitignore                        # Ignore patterns
├── .env.example                      # Environment variable documentation
└── README.md                         # Project overview
```

### Technology Stack

| Component | Technology | Version | Purpose |
|---|---|---|---|
| Runtime | Node.js LTS (Krypton) | 24.x | Server-side JavaScript execution |
| Language | TypeScript | ~5.9.x | Type-safe development across all packages |
| Build System | Turborepo + pnpm | v2.8.x / v9.x | Monorepo orchestration with content-aware caching |
| Backend Framework | Express | ^4.21.x | HTTP server, REST API, middleware pipeline |
| Database | PostgreSQL + Drizzle ORM | 16.x / ^0.45.x | Relational data with type-safe ORM queries |
| Queue System | BullMQ + Redis | ^5.71.x / 7.x | Job queue for polling, analysis, notifications |
| AI Pipeline | LangGraph.js | ^1.2.2 | Directed graph for multi-stage article analysis |
| LLM Gateway | OpenRouter (via ChatOpenAI) | — | Unified multi-model LLM access |
| Telegram Bot | grammY | ^1.41.x | Bot framework with inline keyboards |
| Frontend Framework | React + Vite | 19.x / 6.x | Component-based UI with fast HMR |
| Charts | Recharts | ^2.15.x | SVG-based performance visualizations |
| Logging | Pino | ^10.3.x | Structured JSON logging (5x faster than Winston) |
| HTTP Logging | pino-http | ^10.x | Express request/response logging middleware |
| Validation | Zod | ^3.24.x | Runtime schema validation and LLM structured output |
| Rate Limiting | Bottleneck | ^2.19.5 | Per-API rate limiter with configurable reservoirs |
| RSS Parsing | rss-parser | ^3.13.x | RSS/Atom feed parsing for Indian market news |
| Queue Dashboard | @bull-board/express | ^6.20.3 | Web-based BullMQ monitoring UI |
| Security | Helmet | ^8.0.x | Express security headers |
| HTTP Client | Axios | ^1.8.x | Frontend API communication |
| Routing | react-router-dom | ^7.x | Client-side page routing |
| Date Utils | date-fns | ^4.x | Date formatting and manipulation |
| CSS Utils | clsx | ^2.1.x | Conditional className utility |
| Indian Equities | stock-nse-india | ^1.3.0 | NSE India equity data scraper |
| PostgreSQL Driver | pg | ^8.13.x | Node.js PostgreSQL client |
| Supabase Driver | postgres | ^3.4.x | Alternative driver for Supabase connections |
| Redis Client | ioredis | ^5.6.x | Redis client for BullMQ backing store |
| CORS | cors | ^2.8.x | Cross-origin resource sharing middleware |
| Env Loading | dotenv | ^16.4.x | Environment variable loader from .env files |
| Process Manager | PM2 | ^5.x | Production cluster mode |

---

## Database Schema

The application uses PostgreSQL 16 with Drizzle ORM v0.45.x for type-safe schema definitions and query building. All 7 core tables are defined using `drizzle-orm/pg-core` with proper indexing, foreign key constraints, and PostgreSQL enum types. Decimal precision is enforced for all financial values using `numeric` types — never JavaScript floating-point.

### Table: news\_articles

Stores all ingested news articles from all sources. The `url` column has a unique constraint for deduplication.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique article identifier |
| `title` | `text` | NOT NULL | Article headline |
| `url` | `text` | NOT NULL, UNIQUE | Source URL (deduplication key) |
| `source` | `text` | NOT NULL | Source identifier (e.g., "finnhub", "economic-times-rss") |
| `content` | `text` | NOT NULL | Full article text or description |
| `summary` | `text` | NULLABLE | AI-generated or source-provided summary |
| `published_at` | `timestamp with time zone` | NOT NULL | Original publication timestamp |
| `symbols` | `text[]` | NOT NULL, DEFAULT `'{}'` | Array of related ticker symbols (e.g., `['AAPL', 'MSFT']`) |
| `market` | `market_enum` | NOT NULL | Market category: `us_stock`, `indian_equity`, `crypto`, `social` |
| `is_analyzed` | `boolean` | NOT NULL, DEFAULT `false` | Whether article has been processed by the analysis pipeline |
| `raw_data` | `jsonb` | NULLABLE | Raw API response data for debugging and reprocessing |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Record creation timestamp |
| `updated_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Last update timestamp |

**Indexes:**

| Index Name | Columns | Type | Purpose |
|---|---|---|---|
| `idx_news_articles_published_source` | `(published_at, source)` | B-tree | Efficient time-range queries filtered by source |
| `idx_news_articles_url` | `(url)` | Unique | URL-based deduplication on insert |
| `idx_news_articles_is_analyzed` | `(is_analyzed)` | B-tree | Quickly find unanalyzed articles for queue processing |

### Table: trade\_opportunities

Stores detected trade opportunities with precise price targets. **CRITICAL:** All price fields use `numeric(12,4)` for financial decimal precision — never floating-point (Rule 0.7.2).

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique opportunity identifier |
| `article_id` | `uuid` | NOT NULL, FK → `news_articles.id` | Source article that generated this opportunity |
| `symbol` | `text` | NOT NULL | Ticker symbol (e.g., `AAPL`, `RELIANCE.NS`, `BTC`) |
| `market` | `market_enum` | NOT NULL | Market category |
| `direction` | `direction_enum` | NOT NULL | Trade direction: `long` or `short` |
| `confidence` | `numeric(3,2)` | NOT NULL | Confidence score: 0.00 to 1.00 |
| `entry_price` | `numeric(12,4)` | NOT NULL | Recommended entry price |
| `stop_loss` | `numeric(12,4)` | NOT NULL | Stop loss price level |
| `take_profit` | `numeric(12,4)` | NOT NULL | Take profit target price |
| `risk_reward_ratio` | `numeric(5,2)` | NOT NULL | Calculated risk-to-reward ratio |
| `timeframe` | `timeframe_enum` | NOT NULL | Trade timeframe: `intraday`, `swing`, `position` |
| `reasoning` | `text` | NOT NULL | AI-generated reasoning for the recommendation |
| `status` | `status_enum` | NOT NULL, DEFAULT `'active'` | Opportunity status: `active`, `closed`, `expired`, `cancelled` |
| `expires_at` | `timestamp with time zone` | NULLABLE | Expiration timestamp for the opportunity |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Record creation timestamp |

**Indexes:**

| Index Name | Columns | Type | Purpose |
|---|---|---|---|
| `idx_opportunities_created_market_status` | `(created_at, market, status)` | B-tree | Dashboard filtering and sorting |
| `idx_opportunities_symbol_status` | `(symbol, status)` | B-tree | Per-symbol active opportunity lookup |

### Table: trade\_performance

Tracks actual outcomes of trade opportunities for accuracy measurement and P&L reporting.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique performance record identifier |
| `opportunity_id` | `uuid` | NOT NULL, FK → `trade_opportunities.id` | The opportunity being tracked |
| `actual_entry_price` | `numeric(12,4)` | NULLABLE | Actual entry price observed in the market |
| `actual_exit_price` | `numeric(12,4)` | NULLABLE | Actual exit price observed |
| `pnl_amount` | `numeric(12,4)` | NULLABLE | Profit/loss in absolute terms |
| `pnl_percentage` | `numeric(8,4)` | NULLABLE | Profit/loss as a percentage |
| `hit_target` | `boolean` | NULLABLE | Whether the take profit level was reached |
| `hit_stop` | `boolean` | NULLABLE | Whether the stop loss level was triggered |
| `closed_at` | `timestamp with time zone` | NULLABLE | Timestamp when the trade was closed |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Record creation timestamp |

### Table: user\_settings

Stores Telegram bot subscriber preferences for notification filtering and delivery.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique user identifier |
| `telegram_chat_id` | `text` | NOT NULL, UNIQUE | Telegram chat ID for message delivery |
| `telegram_username` | `text` | NULLABLE | Telegram display username |
| `markets` | `text[]` | NOT NULL, DEFAULT `'{us_stock,indian_equity,crypto,social}'` | Subscribed market categories |
| `min_confidence` | `numeric(3,2)` | NOT NULL, DEFAULT `0.70` | Minimum confidence threshold for alerts |
| `timeframes` | `text[]` | NOT NULL, DEFAULT `'{intraday,swing,position}'` | Subscribed trade timeframes |
| `is_active` | `boolean` | NOT NULL, DEFAULT `true` | Whether the user is actively receiving notifications |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | User registration timestamp |
| `updated_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Last preference update timestamp |

**Indexes:**

| Index Name | Columns | Type | Purpose |
|---|---|---|---|
| `idx_user_settings_chat_id` | `(telegram_chat_id)` | Unique | Fast subscriber lookup by Telegram chat ID |

### Table: api\_sources

Registry of all external data sources with health tracking for monitoring and graceful degradation.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique source identifier |
| `name` | `text` | NOT NULL | Human-readable source name (e.g., "Finnhub", "CoinGecko") |
| `type` | `text` | NOT NULL | Source type: `api`, `rss`, `scraper` |
| `base_url` | `text` | NOT NULL | Base URL for the API or feed |
| `is_active` | `boolean` | NOT NULL, DEFAULT `true` | Whether this source is enabled for polling |
| `rate_limit` | `integer` | NOT NULL | Configured rate limit (calls per time window) |
| `error_count` | `integer` | NOT NULL, DEFAULT `0` | Cumulative error count since last reset |
| `last_fetched_at` | `timestamp with time zone` | NULLABLE | Timestamp of last successful fetch |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Record creation timestamp |

### Table: analysis\_logs

Detailed logging of each pipeline step execution for cost tracking, debugging, and performance analysis.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique log entry identifier |
| `article_id` | `uuid` | NOT NULL, FK → `news_articles.id` | The article being analyzed |
| `pipeline_step` | `pipeline_step_enum` | NOT NULL | Pipeline stage: `filter`, `sentiment`, `trade_detect`, `recommend` |
| `model_used` | `text` | NOT NULL | Model identifier (e.g., "deepseek/deepseek-v3-0324", "anthropic/claude-haiku-4-5-20241022") |
| `input_tokens` | `integer` | NOT NULL | Number of input tokens consumed |
| `output_tokens` | `integer` | NOT NULL | Number of output tokens generated |
| `cost_usd` | `numeric(8,6)` | NOT NULL | Estimated cost in USD for this inference call |
| `result` | `jsonb` | NOT NULL | Structured result from the pipeline step |
| `duration_ms` | `integer` | NOT NULL | Execution time in milliseconds |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Log entry timestamp |

**Indexes:**

| Index Name | Columns | Type | Purpose |
|---|---|---|---|
| `idx_analysis_logs_article_step` | `(article_id, pipeline_step)` | B-tree | Per-article pipeline step lookup |

### Table: notification\_logs

Tracks notification delivery status for each subscriber and opportunity combination, preventing duplicate sends.

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `uuid` | PRIMARY KEY, DEFAULT `gen_random_uuid()` | Unique notification record identifier |
| `opportunity_id` | `uuid` | NOT NULL, FK → `trade_opportunities.id` | The trade opportunity being notified |
| `user_id` | `uuid` | NOT NULL, FK → `user_settings.id` | The subscriber receiving the notification |
| `telegram_message_id` | `integer` | NULLABLE | Telegram API response message ID |
| `status` | `text` | NOT NULL, DEFAULT `'pending'` | Delivery status: `pending`, `sent`, `failed`, `skipped` |
| `error` | `text` | NULLABLE | Error details if delivery failed |
| `sent_at` | `timestamp with time zone` | NULLABLE | Timestamp when notification was actually sent |
| `created_at` | `timestamp with time zone` | NOT NULL, DEFAULT `now()` | Notification attempt timestamp |

**Indexes:**

| Index Name | Columns | Type | Purpose |
|---|---|---|---|
| `idx_notification_logs_opportunity_user` | `(opportunity_id, user_id)` | B-tree | Prevent duplicate notifications per user per opportunity |

### PostgreSQL Enum Types

The following custom PostgreSQL enum types are shared across multiple tables:

| Enum Name | Values | Used By |
|---|---|---|
| `market_enum` | `us_stock`, `indian_equity`, `crypto`, `social` | `news_articles.market`, `trade_opportunities.market` |
| `direction_enum` | `long`, `short` | `trade_opportunities.direction` |
| `timeframe_enum` | `intraday`, `swing`, `position` | `trade_opportunities.timeframe` |
| `status_enum` | `active`, `closed`, `expired`, `cancelled` | `trade_opportunities.status` |
| `pipeline_step_enum` | `filter`, `sentiment`, `trade_detect`, `recommend` | `analysis_logs.pipeline_step` |
| `notification_status_enum` | `sent`, `failed`, `pending` | `notification_logs.status` |

### Foreign Key Relationships

| Source Table.Column | Target Table.Column | Relationship | Description |
|---|---|---|---|
| `trade_opportunities.article_id` | `news_articles.id` | Many-to-One | One article can generate multiple opportunities across timeframes |
| `trade_performance.opportunity_id` | `trade_opportunities.id` | One-to-One | Each opportunity has at most one performance tracking record |
| `analysis_logs.article_id` | `news_articles.id` | Many-to-One | One article generates multiple log entries (one per pipeline step) |
| `notification_logs.opportunity_id` | `trade_opportunities.id` | Many-to-One | One opportunity triggers notifications to multiple subscribers |
| `notification_logs.user_id` | `user_settings.id` | Many-to-One | Each user may receive multiple notifications over time |

### Entity-Relationship Diagram

```mermaid
erDiagram
    news_articles ||--o{ trade_opportunities : "generates"
    news_articles ||--o{ analysis_logs : "analyzed_by"
    trade_opportunities ||--o| trade_performance : "tracked_by"
    trade_opportunities ||--o{ notification_logs : "notifies"
    user_settings ||--o{ notification_logs : "receives"

    news_articles {
        uuid id PK
        text title
        text url UK
        text source
        text content
        text summary
        timestamptz published_at
        text_array symbols
        market_enum market
        boolean is_analyzed
        jsonb raw_data
        timestamptz created_at
        timestamptz updated_at
    }

    trade_opportunities {
        uuid id PK
        uuid article_id FK
        text symbol
        market_enum market
        direction_enum direction
        numeric_3_2 confidence
        numeric_12_4 entry_price
        numeric_12_4 stop_loss
        numeric_12_4 take_profit
        numeric_5_2 risk_reward_ratio
        timeframe_enum timeframe
        text reasoning
        status_enum status
        timestamptz expires_at
        timestamptz created_at
    }

    trade_performance {
        uuid id PK
        uuid opportunity_id FK
        numeric_12_4 actual_entry_price
        numeric_12_4 actual_exit_price
        numeric_12_4 pnl_amount
        numeric_8_4 pnl_percentage
        boolean hit_target
        boolean hit_stop
        timestamptz closed_at
        timestamptz created_at
    }

    user_settings {
        uuid id PK
        text telegram_chat_id UK
        text telegram_username
        text_array markets
        numeric_3_2 min_confidence
        text_array timeframes
        boolean is_active
        timestamptz created_at
        timestamptz updated_at
    }

    api_sources {
        uuid id PK
        text name
        text type
        text base_url
        boolean is_active
        integer rate_limit
        integer error_count
        timestamptz last_fetched_at
        timestamptz created_at
    }

    analysis_logs {
        uuid id PK
        uuid article_id FK
        pipeline_step_enum pipeline_step
        text model_used
        integer input_tokens
        integer output_tokens
        numeric_8_6 cost_usd
        jsonb result
        integer duration_ms
        timestamptz created_at
    }

    notification_logs {
        uuid id PK
        uuid opportunity_id FK
        uuid user_id FK
        integer telegram_message_id
        text status
        text error
        timestamptz sent_at
        timestamptz created_at
    }
```

---

## AI Analysis Pipeline

The analysis pipeline is implemented as a four-node LangGraph.js `StateGraph` with `Annotation`-based typed state. It uses conditional edges for early termination, routing only actionable articles to expensive LLM stages. The pipeline processes each article through Filter → Sentiment → Trade Detection → Recommendation, with two conditional exit points that achieve approximately 75% reduction in LLM inference costs.

### Pipeline Architecture

The pipeline consists of four sequential processing stages, each backed by a specific OpenRouter model tier:

**1. Filter Node — Binary Relevance Classifier**

- **Model:** DeepSeek V3.2 via OpenRouter (`deepseek/deepseek-v3-0324`)
- **Cost:** $0.25 / $0.38 per 1M tokens (input/output)
- **Purpose:** Determines whether an article contains actionable financial information worth further analysis. Performs a simple binary classification: relevant or not relevant.
- **Behavior:** Approximately 75% of ingested articles are filtered out at this stage (general market commentary, opinion pieces, duplicate coverage). Only articles classified as relevant proceed to the Sentiment node.
- **Output:** `FilterResult` Zod schema — `{ isRelevant: boolean, relevanceScore: number, reasoning: string }`

**2. Sentiment Node — Nuanced Sentiment Analysis**

- **Model:** Claude Haiku 4.5 via OpenRouter (`anthropic/claude-haiku-4-5-20241022`)
- **Cost:** $1.00 / $5.00 per 1M tokens (input/output)
- **Purpose:** Performs nuanced financial sentiment analysis with a score ranging from -1.000 (extremely bearish) to +1.000 (extremely bullish).
- **Behavior:** Applies DK-CoT (Domain Knowledge Chain-of-Thought) prompting with financial domain expertise. **Critically, negative news is weighted 2–3x higher than positive news** to reflect empirical research showing that negative financial events have disproportionate market impact (Rule 0.7.3).
- **Output:** `SentimentResult` Zod schema — `{ sentimentScore: number, sentimentLabel: string, reasoning: string, keyFactors: string[] }`

**3. Trade Detection Node — Opportunity Identification**

- **Model:** Claude Haiku 4.5 via OpenRouter (`anthropic/claude-haiku-4-5-20241022`)
- **Cost:** $1.00 / $5.00 per 1M tokens (input/output)
- **Purpose:** Identifies whether the article implies a specific, actionable trade opportunity — including the symbol, direction (long/short), and suggested timeframe.
- **Behavior:** Evaluates the article content combined with the sentiment score to determine if there is a concrete trading signal. Articles with only general sentiment (no specific trade setup) are terminated here.
- **Output:** `TradeDetectionResult` Zod schema — `{ tradeDetected: boolean, symbol?: string, direction?: "long"|"short", timeframe?: string, reasoning: string, signalStrength: number }`

**4. Recommendation Node — Structured Trade Recommendation**

- **Model:** Claude Sonnet 4.6 via OpenRouter (`anthropic/claude-sonnet-4-6-20250514`)
- **Cost:** $3.00 / $15.00 per 1M tokens (input/output)
- **Purpose:** Generates a complete, structured trade recommendation with precise price targets (entry, stop loss, take profit), confidence score, risk-reward ratio, and detailed reasoning.
- **Behavior:** Only approximately 25% of original articles reach this stage. Uses `withStructuredOutput()` with a comprehensive Zod schema to produce machine-parseable recommendations. All generated price targets are cross-validated against actual market data from API sources — any price more than 10% away from current market price is flagged for review.
- **Output:** `TradeRecommendation` Zod schema — `{ symbol, market, direction, confidence, entryPrice, stopLoss, takeProfit, riskRewardRatio, timeframe, reasoning, catalystExpiry?: string }`

### Pipeline Flow Diagram

```mermaid
graph LR
    START([Article Input]) --> FILTER[Filter Node<br/>DeepSeek V3.2]
    FILTER --> FILTER_CHECK{is_relevant?}
    FILTER_CHECK -->|true| SENTIMENT[Sentiment Node<br/>Claude Haiku 4.5]
    FILTER_CHECK -->|false| END_FILTERED([END<br/>Article Filtered])
    SENTIMENT --> TRADE[Trade Detection<br/>Claude Haiku 4.5]
    TRADE --> TRADE_CHECK{has_opportunity?}
    TRADE_CHECK -->|true| RECOMMEND[Recommendation<br/>Claude Sonnet 4.6]
    TRADE_CHECK -->|false| END_NO_TRADE([END<br/>No Trade Signal])
    RECOMMEND --> END_COMPLETE([END<br/>Recommendation Stored])

    style FILTER fill:#1a5276,color:#fff
    style SENTIMENT fill:#1a5276,color:#fff
    style TRADE fill:#1a5276,color:#fff
    style RECOMMEND fill:#7d3c98,color:#fff
    style END_FILTERED fill:#922b21,color:#fff
    style END_NO_TRADE fill:#922b21,color:#fff
    style END_COMPLETE fill:#1e8449,color:#fff
```

### Conditional Short-Circuiting

The pipeline uses LangGraph.js conditional edges to implement early termination, which is the primary mechanism for cost optimization:

| Exit Point | Condition | Effect | Estimated Exit Rate |
|---|---|---|---|
| After Filter | `isRelevant === false` | Skip Sentiment, Trade Detection, and Recommendation | ~75% of articles |
| After Trade Detection | `tradeDetected === false` | Skip Recommendation only | ~50% of remaining articles |
| After Recommendation | Pipeline complete | Full recommendation stored | ~25% of original articles |

**Cost Impact Example (1,000 articles/day):**

| Scenario | Articles Processed | Estimated Daily Cost |
|---|---|---|
| Without short-circuiting (all 4 stages) | 1,000 × 4 stages | ~$12.50 |
| With short-circuiting | 1,000 filter + 250 sentiment + 250 trade + 125 recommend | ~$3.25 |
| **Savings** | — | **~74% reduction** |

### Tiered Model Strategy

| Stage | Model | OpenRouter ID | Cost (Input / Output per 1M tokens) | Rationale |
|---|---|---|---|---|
| Filter | DeepSeek V3.2 | `deepseek/deepseek-v3-0324` | $0.25 / $0.38 | Binary classification at high volume — cheapest model sufficient |
| Sentiment | Claude Haiku 4.5 | `anthropic/claude-haiku-4-5-20241022` | $1.00 / $5.00 | Nuanced language understanding for financial sentiment |
| Trade Detection | Claude Haiku 4.5 | `anthropic/claude-haiku-4-5-20241022` | $1.00 / $5.00 | Moderate analytical reasoning for opportunity identification |
| Recommendation | Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6-20250514` | $3.00 / $15.00 | Complex reasoning for precise price targets and structured output |

All models are accessed through OpenRouter's unified API gateway using `ChatOpenAI` from `@langchain/openai` with custom `baseURL: "https://openrouter.ai/api/v1"` and the `OPENROUTER_API_KEY` environment variable.

### Critical LLM Rules

These rules apply to every LLM call in the analysis pipeline (derived from AAP Rule 0.7.3):

1. **Temperature = 0** — All financial analysis calls MUST use `temperature: 0` for deterministic, reproducible outputs. No creative generation is permitted in financial analysis contexts.

2. **Structured Output with Zod Schemas** — Every LLM response MUST use `withStructuredOutput()` with explicitly defined Zod schemas. No free-form text parsing is permitted — all outputs are machine-parseable structured objects.

3. **DK-CoT Prompting Pattern** — All system prompts incorporate Domain Knowledge Chain-of-Thought (DK-CoT) prompting that weaves financial domain expertise into reasoning chains, rather than generic chain-of-thought approaches.

4. **Anti-Hallucination Instructions** — Every system prompt MUST include the directive: *"Do NOT fabricate price targets, earnings numbers, or analyst ratings not present in the source material."* All LLM-generated price targets are cross-validated against actual market data — any price more than 10% away from the current market price is flagged.

5. **Negative News Weighting** — The sentiment analysis stage MUST weight negative financial news 2–3x higher than positive news, reflecting empirical market impact research showing that downside events have disproportionate effects on asset prices.

6. **Few-Shot Examples** — Prompts include 2–3 few-shot examples for each pipeline stage to improve accuracy by up to 9% over zero-shot prompting.

7. **OpenRouter Integration** — All models are accessed via `ChatOpenAI` with `baseURL: "https://openrouter.ai/api/v1"`, authenticated with the `OPENROUTER_API_KEY` header.

### Zod Schemas for Structured Output

Each pipeline stage produces output conforming to a strict Zod schema:

**FilterResult**

```typescript
const FilterResultSchema = z.object({
  isRelevant: z.boolean().describe("Whether the article is financially relevant"),
  relevanceScore: z.number().min(0).max(1).describe("Relevance score from 0.0 to 1.0"),
  reasoning: z.string().describe("Brief explanation of relevance determination"),
});
```

**SentimentResult**

```typescript
const SentimentResultSchema = z.object({
  sentimentScore: z.number().min(-1).max(1).describe("Sentiment score from -1.0 (most negative) to 1.0 (most positive)"),
  sentimentLabel: z.enum(["strongly_negative", "moderately_negative", "slightly_negative", "neutral", "slightly_positive", "moderately_positive", "strongly_positive"]).describe("Human-readable sentiment label"),
  reasoning: z.string().describe("Detailed sentiment analysis incorporating financial domain knowledge"),
  keyFactors: z.array(z.string()).describe("Array of key factors driving the sentiment determination"),
});
```

**TradeDetectionResult**

```typescript
const TradeDetectionResultSchema = z.object({
  tradeDetected: z.boolean().describe("Whether an actionable trade opportunity was detected"),
  symbol: z.string().optional().describe("Ticker symbol (e.g., AAPL, RELIANCE.NS, BTC)"),
  direction: z.enum(["long", "short"]).optional().describe("Recommended trade direction"),
  timeframe: z.enum(["intraday", "swing", "position"]).optional().describe("Suggested holding period"),
  reasoning: z.string().describe("Explanation of the trade detection determination"),
  signalStrength: z.number().min(0).max(1).describe("Strength of the detected trade signal from 0.0 to 1.0"),
});
```

**TradeRecommendation**

```typescript
const TradeRecommendationSchema = z.object({
  symbol: z.string().describe("Stock/crypto ticker symbol"),
  market: z.enum(["us_stock", "indian_equity", "crypto"]).describe("Market category"),
  direction: z.enum(["long", "short"]).describe("Trade direction"),
  confidence: z.number().min(0).max(1).describe("Confidence score from 0.00 to 1.00"),
  entryPrice: z.string().regex(/^\d+(\.\d{1,4})?$/).describe("Recommended entry price as decimal string"),
  stopLoss: z.string().regex(/^\d+(\.\d{1,4})?$/).describe("Stop loss price level as decimal string"),
  takeProfit: z.string().regex(/^\d+(\.\d{1,4})?$/).describe("Take profit target price as decimal string"),
  riskRewardRatio: z.string().regex(/^\d+(\.\d{1,4})?$/).describe("Risk-to-reward ratio as decimal string"),
  timeframe: z.enum(["intraday", "swing", "position"]).describe("Trade timeframe"),
  reasoning: z.string().describe("Detailed reasoning incorporating domain knowledge"),
  catalystExpiry: z.string().optional().describe("ISO 8601 date when catalyst relevance expires"),
});
```

---

## News Ingestion

The news ingestion layer aggregates financial news and social sentiment from over 30 sources across four market categories. Each source-specific fetcher module is independently rate-limited using dedicated Bottleneck instances and follows a graceful degradation pattern where individual API failures do not halt the overall polling cycle.

### Data Source Stack

| Market | News Sources | Price Data | Polling Approach |
|---|---|---|---|
| US Stocks | Finnhub news API (free, 60/min) + CNBC RSS + MarketWatch RSS | Finnhub quotes + Alpha Vantage historical | REST API + RSS parsing |
| Indian Equities | Economic Times RSS + Financial Express RSS + Business Standard RSS | stock-nse-india npm package (free) | RSS parsing + scraper |
| Crypto | CryptoCompare news API + CoinGecko trending API | Binance public API (free) + CoinGecko market data | REST API |
| Social | Reddit RSS (free, r/wallstreetbets, r/IndianStreetBets) + Reddit API (100 QPM) | N/A | RSS + REST API |

### Fetcher Modules

Each fetcher module resides under `apps/api/src/services/news-fetcher/` and implements a common interface that returns normalized `NewsArticle` objects:

**`finnhub.ts` — Finnhub API Client**

- **Endpoints:** `GET /api/v1/news?category=general` (market news), `GET /api/v1/quote?symbol=X` (real-time quotes)
- **Authentication:** API key via query parameter (`token=FINNHUB_API_KEY`)
- **Rate Limit:** 60 calls/minute (Bottleneck: `maxConcurrent: 1, minTime: 1000`)
- **Data:** US stock news articles with headline, summary, URL, related symbols, datetime

**`rss-parser.ts` — Generic RSS/Atom Feed Parser**

- **Library:** `rss-parser` npm package (v3.13.x)
- **Configured Feeds:**
  - Economic Times Markets: `https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms`
  - Financial Express Market: `https://www.financialexpress.com/market/feed/`
  - Business Standard Markets: `https://www.business-standard.com/rss/markets-106.rss`
  - CNBC Markets: `https://www.cnbc.com/id/20910258/device/rss/rss.html`
  - MarketWatch Top Stories: `https://feeds.marketwatch.com/marketwatch/topstories/`
- **Rate Limit:** Self-managed (Bottleneck: `maxConcurrent: 2, minTime: 2000` per feed)
- **Data:** Headline, link, description, pubDate — parsed into `NewsArticle` format

**`reddit.ts` — Reddit RSS/API Client**

- **RSS Feeds:** `https://www.reddit.com/r/wallstreetbets/.rss`, `https://www.reddit.com/r/IndianStreetBets/.rss`
- **Optional API:** Reddit JSON API at `https://oauth.reddit.com/r/{subreddit}/hot.json` with OAuth
- **Rate Limit:** 100 queries/minute for API; RSS has no hard limit (Bottleneck: `maxConcurrent: 1, minTime: 1000`)
- **Data:** Post title, selftext, URL, score, created_utc — normalized with `market: "social"`

**`coingecko.ts` — CoinGecko API Client**

- **Endpoints:** `GET /api/v3/search/trending` (trending coins), `GET /api/v3/coins/markets` (market data)
- **Authentication:** API key via `x-cg-demo-api-key` header
- **Rate Limit:** 30 calls/minute (Bottleneck: `maxConcurrent: 1, minTime: 2000`)
- **Data:** Trending cryptocurrency data with price, market cap, 24h change, and related news mentions

**`cryptocompare.ts` — CryptoCompare API Client**

- **Endpoints:** `GET /data/v2/news/?lang=EN` (crypto news), `GET /data/v2/histoday` (historical data)
- **Authentication:** API key via `Apikey` header
- **Rate Limit:** 100,000 calls/month (~2.3 calls/minute; Bottleneck: `reservoir: 100000, reservoirRefreshInterval: 2592000000`)
- **Data:** Crypto news articles with title, body, URL, source, categories, published timestamp

**`binance.ts` — Binance Public REST API**

- **Endpoints:** `GET /api/v3/klines` (candlestick data), `GET /api/v3/ticker/price` (current prices)
- **Authentication:** None (public endpoints)
- **Rate Limit:** 6,000 weight/minute (Bottleneck: `reservoir: 6000, reservoirRefreshInterval: 60000`)
- **Data:** Real-time and historical crypto price data (OHLCV candles, ticker prices)

**`alpha-vantage.ts` — Alpha Vantage API Client**

- **Endpoints:** `GET /query?function=NEWS_SENTIMENT` (market sentiment), `GET /query?function=TIME_SERIES_DAILY` (historical)
- **Authentication:** API key via `apikey` query parameter
- **Rate Limit:** 25 calls/day (Bottleneck: `reservoir: 25, reservoirRefreshInterval: 86400000`)
- **Data:** Market news sentiment with relevance scores, ticker mentions, and overall sentiment labels

**`nse-india.ts` — stock-nse-india Wrapper**

- **Library:** `stock-nse-india` npm package (v1.3.x)
- **Methods:** `getEquityDetails(symbol)`, `getEquityTradeInfo(symbol)`, `getIndexStocks(indexName)`
- **Rate Limit:** Self-managed (Bottleneck: `maxConcurrent: 1, minTime: 3000` to avoid blocking)
- **Data:** NSE India equity quotes, trade info, and index constituent data

**`index.ts` — News Fetcher Orchestrator**

- Imports and invokes all source-specific fetcher modules in parallel (within rate limits)
- Normalizes all fetched articles into a common `NewsArticle` interface
- Returns a combined array of articles from all sources for deduplication and storage
- Handles per-source error isolation (one failing source does not block others)

### Rate Limiting Strategy

Each external API source has its own dedicated Bottleneck instance, configured to its specific free-tier limits (Rule 0.7.4). Rate limiters are **never shared** across different APIs.

| API Source | Bottleneck Configuration | Effective Rate |
|---|---|---|
| Finnhub | `maxConcurrent: 1, minTime: 1000` | 60 calls/min |
| CoinGecko | `maxConcurrent: 1, minTime: 2000` | 30 calls/min |
| CryptoCompare | `reservoir: 100000, reservoirRefreshInterval: 2592000000` | ~100K calls/month |
| Binance | `reservoir: 6000, reservoirRefreshInterval: 60000` | 6,000 weight/min |
| Alpha Vantage | `reservoir: 25, reservoirRefreshInterval: 86400000` | 25 calls/day |
| RSS Feeds | `maxConcurrent: 2, minTime: 2000` per feed | Self-managed |
| Reddit RSS | `maxConcurrent: 1, minTime: 1000` | ~60 calls/min |
| Reddit API | `maxConcurrent: 1, minTime: 600` | 100 queries/min |
| stock-nse-india | `maxConcurrent: 1, minTime: 3000` | ~20 calls/min |

Rate limiter instances are created as singletons in `apps/api/src/lib/rate-limiter.ts` and injected into each fetcher module.

### URL-Based Deduplication

News articles are deduplicated by URL using a unique database constraint on the `news_articles.url` column (Rule 0.7.4):

1. The polling worker collects articles from all sources into a batch
2. Each article is inserted with an `ON CONFLICT (url) DO NOTHING` clause
3. Duplicate URLs from different polling cycles are silently skipped — no error is thrown
4. Only newly inserted articles (those not already in the database) are enqueued for analysis
5. This prevents redundant LLM analysis and duplicate notifications for the same story

### Graceful Degradation

Individual API source failures do not halt the entire polling cycle (Rule 0.7.4):

1. Each fetcher module wraps its API calls in a try-catch block
2. On failure, the error is logged using Pino with the source name as context
3. The corresponding `api_sources.error_count` is incremented
4. The orchestrator continues invoking remaining fetcher modules
5. If all sources for a market category fail, the polling cycle still completes with articles from other markets
6. Sources with excessive error counts can be automatically disabled for investigation

---

## Job Queue Infrastructure

The application uses BullMQ v5.71.x with Redis 7 for all background job processing. Three separate, independent queues handle distinct workloads with configurable concurrency, priority levels, and retry policies (Rule 0.7.6).

### Queue: news-polling

| Property | Configuration |
|---|---|
| **Queue Name** | `news-polling` |
| **Trigger** | Repeatable cron job: `*/5 * * * *` (every 5 minutes) |
| **Worker Concurrency** | 1 (single polling cycle at a time to prevent overlap) |
| **Job Timeout** | 120,000 ms (2 minutes) |
| **Retry Policy** | 3 attempts with exponential backoff (delay: 5000, factor: 2) |
| **File** | `apps/api/src/queues/news-polling.queue.ts` |
| **Worker File** | `apps/api/src/queues/workers/news-polling.worker.ts` |

**Worker Behavior:**

1. Invokes the News Fetcher orchestrator to collect articles from all active API sources
2. Normalizes all articles into the common `NewsArticle` format
3. Performs batch insert into `news_articles` table with `ON CONFLICT (url) DO NOTHING`
4. Identifies newly inserted articles (not previously in the database)
5. For each new article, creates a job in the `analysis` queue with the article ID as payload
6. Updates `api_sources.last_fetched_at` for each successfully polled source
7. Logs polling statistics: total fetched, new articles, duplicates skipped, errors by source

### Queue: analysis

| Property | Configuration |
|---|---|
| **Queue Name** | `analysis` |
| **Trigger** | Enqueued by news-polling worker for each new article |
| **Worker Concurrency** | 3 (configurable; limited by OpenRouter rate limits) |
| **Job Timeout** | 60,000 ms (1 minute per article) |
| **Retry Policy** | 5 attempts with exponential backoff (delay: 10000, factor: 2) |
| **Priority** | Standard (no priority differentiation) |
| **File** | `apps/api/src/queues/analysis.queue.ts` |
| **Worker File** | `apps/api/src/queues/workers/analysis.worker.ts` |

**Worker Behavior:**

1. Receives a job with the article ID as payload
2. Fetches the full article from the `news_articles` table
3. Invokes the compiled LangGraph pipeline with the article as input
4. For each completed pipeline step, logs an entry to the `analysis_logs` table (model, tokens, cost, duration, result)
5. If the pipeline produces a trade recommendation, creates a record in the `trade_opportunities` table
6. Updates `news_articles.is_analyzed = true`
7. If a trade opportunity was created, enqueues a job in the `notifications` queue with the opportunity ID

### Queue: notifications

| Property | Configuration |
|---|---|
| **Queue Name** | `notifications` |
| **Trigger** | Enqueued by analysis worker when a trade opportunity is detected |
| **Worker Concurrency** | 5 (configurable) |
| **Job Timeout** | 30,000 ms (30 seconds) |
| **Retry Policy** | 3 attempts with exponential backoff (delay: 3000, factor: 2) |
| **Priority** | Supports priority levels — breaking news alerts use priority 1 (highest) |
| **File** | `apps/api/src/queues/notifications.queue.ts` |
| **Worker File** | `apps/api/src/queues/workers/notifications.worker.ts` |

**Worker Behavior:**

1. Receives a job with the trade opportunity ID as payload
2. Fetches the opportunity details from the `trade_opportunities` table
3. Queries `user_settings` for all active subscribers whose preferences match:
   - `markets` array includes the opportunity's market
   - `min_confidence` is less than or equal to the opportunity's confidence
   - `timeframes` array includes the opportunity's timeframe
4. For each matching subscriber, calls the message formatter to build a MarkdownV2-formatted alert
5. Sends the formatted message via `bot.api.sendMessage()` with `parse_mode: "MarkdownV2"`
6. Logs each delivery attempt to the `notification_logs` table with status (`sent`, `failed`, `pending`)
7. On failure, the error message is recorded in `notification_logs.error` for debugging

### Shared Queue Configuration

All three queues share common infrastructure settings:

- **Redis Connection:** ioredis v5.6.x client connected to Redis 7 with `maxRetriesPerRequest: null` (required by BullMQ)
- **Connection URL:** Configured via `REDIS_URL` environment variable (default: `redis://localhost:6379`)
- **Retry Policy:** All workers use BullMQ's built-in exponential backoff retry with configurable attempts and delay (Rule 0.7.6)
- **Stalled Job Recovery:** BullMQ's default stalled job check interval (30 seconds) is used to recover jobs that crash mid-processing
- **Event Listeners:** Workers emit events for `completed`, `failed`, and `stalled` that are logged via Pino
- **Graceful Shutdown:** On `SIGTERM`/`SIGINT`, all workers are drained (complete active jobs, stop accepting new ones) before process exit

---

## Telegram Bot

The Telegram bot provides the primary mobile interface for trade alert delivery and user preference management. Built with grammY v1.41.x (TypeScript-native, 1.2M+ weekly downloads), it supports command handlers, inline keyboards for interactive settings, and MarkdownV2-formatted alert messages.

### Bot Commands

**`/start` — User Registration**

- Creates a new record in the `user_settings` table with default preferences
- Default markets: `['us_stock', 'indian_equity', 'crypto', 'social']` (all markets)
- Default min\_confidence: `0.70`
- Default timeframes: `['intraday', 'swing', 'position']` (all timeframes)
- If the user already exists (duplicate `telegram_chat_id`), responds with a welcome-back message and current settings summary
- Stores the user's Telegram chat ID and username for future message delivery

**`/settings` — Preference Configuration**

- Retrieves the user's current settings from the `user_settings` table
- Displays settings with inline keyboard buttons for each configurable preference:
  - **Market Selection:** Toggle buttons for US Stocks, Indian Equities, Crypto, and Social — selected markets shown with ✅, unselected with ⬜
  - **Confidence Threshold:** Adjustment buttons for minimum confidence level (0.50, 0.60, 0.70, 0.80, 0.90) — current selection highlighted
  - **Timeframe Selection:** Toggle buttons for Intraday, Swing, and Position — selected timeframes shown with ✅
  - **Active/Pause:** Toggle button to pause or resume notifications
- Each button press triggers a callback query that updates the database and refreshes the inline keyboard in-place

**`/status` — System Health Summary**

- Queries real-time system metrics and presents a formatted status message:
  - **Queue Depths:** Current job counts for news-polling, analysis, and notifications queues
  - **Last Poll:** Timestamp of the most recent successful news polling cycle
  - **Active Opportunities:** Count of trade opportunities with `status = 'active'`
  - **Pipeline Statistics:** Total articles processed today, percentage passing each pipeline stage
  - **API Source Health:** Status of each data source (healthy/degraded/error) based on `api_sources.error_count`

### Inline Keyboard Interaction

The settings interaction flow uses grammY's `InlineKeyboard` builder for stateful preference management:

```
User sends: /settings
    ↓
Bot responds with current settings + inline keyboard:
┌─────────────────────────────────────┐
│ 📊 Your Notification Settings       │
│                                     │
│ Markets:                            │
│ [✅ US Stocks] [✅ India] [✅ Crypto] │
│ [✅ Social]                          │
│                                     │
│ Min Confidence: 0.70                │
│ [0.50] [0.60] [●0.70] [0.80] [0.90]│
│                                     │
│ Timeframes:                         │
│ [✅ Intraday] [✅ Swing] [✅ Position]│
│                                     │
│ [🔔 Active — Tap to Pause]          │
└─────────────────────────────────────┘
    ↓
User taps "US Stocks" toggle
    ↓
Callback handler:
  1. Reads callback_data (e.g., "toggle_market:us_stock")
  2. Queries current user_settings from DB
  3. Toggles "us_stock" in the markets array
  4. Updates user_settings in DB
  5. Rebuilds inline keyboard with updated state
  6. Calls ctx.editMessageReplyMarkup() to refresh in-place
```

Callback data format: `{action}:{value}` — e.g., `toggle_market:crypto`, `set_confidence:0.80`, `toggle_timeframe:swing`, `toggle_active`.

### Trade Alert Message Format

Trade alert messages use MarkdownV2 formatting with emoji indicators for instant visual comprehension (Rule 0.7.5):

**LONG Signal Example:**

```
🟢 *LONG Signal* — `AAPL` \(US Stock\)

*Confidence:* `0\.85`
*Entry:* `$182\.5000`
*Stop Loss:* `$178\.0000`
*Take Profit:* `$195\.0000`
*Risk/Reward:* `1:2\.78`
*Timeframe:* Swing

📊 *Key Catalysts:*
• Strong Q1 earnings beat
• New product launch momentum

📰 *Source:* Finnhub — "Apple reports record revenue\.\.\."
```

**SHORT Signal Example:**

```
🔴 *SHORT Signal* — `NIFTY` \(Indian Equity\)

*Confidence:* `0\.78`
*Entry:* `₹22450\.0000`
*Stop Loss:* `₹22700\.0000`
*Take Profit:* `₹21900\.0000`
*Risk/Reward:* `1:2\.20`
*Timeframe:* Intraday

📊 *Key Catalysts:*
• FII selling pressure continues
• Global risk\-off sentiment

📰 *Source:* Economic Times RSS — "Markets tumble on global cues\.\.\."
```

**MarkdownV2 Escaping Rules:**

All special characters in Telegram messages MUST be escaped with `\` per the Telegram Bot API MarkdownV2 specification. Characters requiring escaping:

```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

The message formatter in `apps/api/src/services/notifier/formatter.ts` implements a dedicated `escapeMarkdownV2()` function that handles all 20 special characters.

**Subscriber Preference Matching:**

Notifications are ONLY sent to users whose preferences match the trade opportunity:

1. User's `markets` array must include the opportunity's `market` value
2. User's `min_confidence` must be ≤ the opportunity's `confidence` score
3. User's `timeframes` array must include the opportunity's `timeframe` value
4. User's `is_active` must be `true`

---

## REST API

The Express REST API serves the React web dashboard with paginated, filterable data endpoints. It also provides system health monitoring and user settings management.

### Endpoints

#### GET /api/news

Retrieves a paginated list of news articles with optional filtering.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | integer | `1` | Page number (1-indexed) |
| `limit` | integer | `20` | Items per page (max 100) |
| `market` | string | — | Filter by market: `us_stock`, `indian_equity`, `crypto`, `social` |
| `source` | string | — | Filter by source name (e.g., "finnhub", "economic-times-rss") |
| `from` | ISO 8601 datetime | — | Filter articles published after this datetime (e.g., `2026-03-01T00:00:00Z`) |
| `to` | ISO 8601 datetime | — | Filter articles published before this datetime |
| `isAnalyzed` | boolean | — | Filter by analysis status (`true` or `false`) |
| `sortOrder` | string | `desc` | Sort direction: `asc` or `desc` |

**Response:**

```json
{
  "success": true,
  "data": {
    "data": [
      {
        "id": "uuid",
        "title": "Article headline",
        "url": "https://...",
        "source": "finnhub",
        "summary": "Brief summary...",
        "publishedAt": "2026-03-14T10:30:00Z",
        "symbols": ["AAPL", "MSFT"],
        "market": "us_stock",
        "isAnalyzed": true
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 450,
      "totalPages": 23
    }
  }
}
```

Default sort: `published_at` descending (newest first).

#### GET /api/opportunities

Retrieves a paginated, filterable, sortable list of trade opportunities.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `page` | integer | `1` | Page number |
| `limit` | integer | `20` | Items per page (max 100) |
| `market` | string | — | Filter by market category |
| `status` | string | — | Filter by status: `active`, `closed`, `expired`, `cancelled` |
| `direction` | string | — | Filter by direction: `long`, `short` |
| `minConfidence` | number | — | Minimum confidence threshold (0.00–1.00) |
| `timeframe` | string | — | Filter by timeframe: `intraday`, `swing`, `position` |
| `symbol` | string | — | Filter by trading symbol (e.g., `AAPL`, `BTC`) |
| `sortBy` | string | `createdAt` | Sort field: `createdAt`, `confidence` |
| `sortOrder` | string | `desc` | Sort direction: `asc`, `desc` |

**Response:**

```json
{
  "success": true,
  "data": {
    "data": [
      {
        "id": "uuid",
        "articleId": "uuid",
        "symbol": "AAPL",
        "market": "us_stock",
        "direction": "long",
        "confidence": 0.85,
        "entryPrice": "182.5000",
        "stopLoss": "178.0000",
        "takeProfit": "195.0000",
        "riskRewardRatio": "2.78",
        "timeframe": "swing",
        "reasoning": "Strong Q1 earnings...",
        "status": "active",
        "expiresAt": "2026-03-21T00:00:00Z",
        "createdAt": "2026-03-14T10:35:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 35,
      "totalPages": 2
    }
  }
}
```

Default sort: `created_at` descending.

#### GET /api/performance

Retrieves performance tracking data with aggregation options.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `startDate` | ISO 8601 datetime | 30 days ago | Start of reporting period (e.g., `2026-01-01T00:00:00Z`) |
| `endDate` | ISO 8601 datetime | now | End of reporting period |
| `market` | string | — | Filter by market category |

**Response:**

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalTrades": 120,
      "wins": 74,
      "losses": 46,
      "winRate": 0.6167,
      "totalPnl": "15.8000",
      "averagePnl": "0.1317",
      "bestTrade": "8.5000",
      "worstTrade": "-3.2000",
      "averageHoldTime": "N/A"
    },
    "chartData": [],
    "marketBreakdown": [],
    "recentTrades": []
  }
}
```

#### GET /api/settings/:chatId

Retrieves user settings for the given Telegram chat ID.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "telegramChatId": "123456789",
    "telegramUsername": "trader_john",
    "markets": ["us_stock", "crypto"],
    "minConfidence": "0.70",
    "timeframes": ["swing", "position"],
    "isActive": true,
    "createdAt": "2026-03-01T00:00:00Z",
    "updatedAt": "2026-03-14T10:00:00Z"
  }
}
```

Returns `404` if no user exists with the given chat ID.

#### PUT /api/settings/:chatId

Updates user preference fields for the given Telegram chat ID.

**Request Body:**

```json
{
  "markets": ["us_stock", "crypto"],
  "minConfidence": 0.80,
  "timeframes": ["swing"],
  "isActive": true
}
```

All fields are optional — only provided fields are updated. Returns the updated user settings object wrapped in the standard success envelope.

#### GET /api/health

Reports system health status including dependency connectivity and API source status.

**Response:**

```json
{
  "success": true,
  "status": "healthy",
  "data": {
    "status": "healthy",
    "postgres": true,
    "redis": true,
    "lastChecked": "2026-03-14T10:30:00Z"
  },
  "checks": {
    "database": { "status": "up", "latencyMs": 2 },
    "redis": { "status": "up", "latencyMs": 1 },
    "apiSources": { "total": 8, "enabled": 8, "errored": 1 }
  },
  "uptime": 86400.42,
  "timestamp": "2026-03-14T10:30:00Z"
}
```

Overall status logic:
- `healthy` — All dependencies connected (postgres and redis both `true`)
- `degraded` — One or more checks report errors or elevated latency
- `unhealthy` — Core dependencies (PostgreSQL or Redis) are disconnected

### Middleware Stack

The Express middleware pipeline is applied in the following order:

| Order | Middleware | File | Purpose |
|---|---|---|---|
| 1 | Helmet | built-in | Security headers (X-Frame-Options, CSP, etc.) |
| 2 | CORS | `apps/api/src/middleware/cors.ts` | Allow requests from frontend origin (`FRONTEND_URL` env var) |
| 3 | JSON Parser | built-in `express.json()` | Parse JSON request bodies (limit: 1MB) |
| 4 | Request Logger | `apps/api/src/middleware/request-logger.ts` | pino-http request/response logging with request ID |
| 5 | API Routes | `apps/api/src/routes/index.ts` | All `/api/*` route handlers |
| 6 | Bull Board | `@bull-board/express` | Queue monitoring dashboard at `/admin/queues` |
| 7 | Error Handler | `apps/api/src/middleware/error-handler.ts` | Global error handler with structured Pino error logging |

### Bull Board Dashboard

The Bull Board v6.20.x queue monitoring dashboard is mounted at `/admin/queues` as Express middleware. It provides:

- Real-time visibility into all three queues (news-polling, analysis, notifications)
- Job status breakdown: waiting, active, completed, failed, delayed
- Individual job inspection with payload data and error details
- Manual retry and clean operations for failed jobs
- No authentication in development; production deployments should add basic auth or IP restriction

---

## Web Dashboard

The web dashboard provides a dark-themed, responsive React application for browsing news, reviewing trade opportunities, analyzing performance, and managing notification settings. It communicates with the Express backend via REST API endpoints.

### Frontend Stack

| Component | Technology | Version | Purpose |
|---|---|---|---|
| UI Framework | React | 19.x | Component-based reactive UI |
| Build Tool | Vite | 6.x | Fast HMR development server and production bundler |
| Language | TypeScript | ~5.9.x | Type-safe component development |
| Routing | react-router-dom | ^7.x | Client-side page routing with nested layouts |
| Charts | Recharts | ^2.15.x | SVG-based responsive charts for performance data |
| HTTP Client | Axios | ^1.8.x | API communication with interceptors |
| Date Formatting | date-fns | ^4.x | Lightweight date formatting and manipulation |
| CSS Utilities | clsx | ^2.1.x | Conditional className composition |

### Dark Theme Design

The dashboard uses CSS custom properties for a dark theme optimized for financial data readability:

```css
:root {
  /* Backgrounds */
  --bg-primary: #0f1117;        /* Main background */
  --bg-secondary: #1a1d27;      /* Card and surface background */
  --bg-tertiary: #242836;       /* Hover and elevated surfaces */

  /* Text */
  --text-primary: #e4e6ef;      /* Primary text */
  --text-secondary: #9ca3b4;    /* Secondary/muted text */
  --text-accent: #6366f1;       /* Accent text and links */

  /* Borders */
  --border-primary: #2d3148;    /* Card and section borders */
  --border-hover: #4a4f6a;      /* Hover state borders */

  /* Semantic Colors */
  --color-long: #22c55e;        /* Green for LONG / bullish / positive */
  --color-short: #ef4444;       /* Red for SHORT / bearish / negative */
  --color-neutral: #eab308;     /* Yellow for neutral signals */
  --color-info: #3b82f6;        /* Blue for informational elements */

  /* Confidence gradient */
  --confidence-high: #22c55e;   /* ≥0.80 */
  --confidence-medium: #eab308; /* 0.60–0.79 */
  --confidence-low: #ef4444;    /* <0.60 */

  /* Spacing scale */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;

  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}
```

The layout is responsive with the following breakpoints:
- **Desktop** (≥1024px): Full sidebar navigation with expanded labels
- **Tablet** (768px–1023px): Collapsed sidebar with icon-only navigation
- **Mobile** (<768px): Sidebar collapses to a hamburger menu; cards reflow from grid to stack layout

### Pages

#### News Feed (`/news`)

The primary news browsing page with market-categorized articles and sentiment indicators:

- **Market Tabs:** Horizontal tab bar for filtering by market (All, US Stocks, India, Crypto, Social)
- **News Cards:** Each article rendered as a `NewsCard` component displaying:
  - Article headline with source badge (Finnhub, RSS, Reddit, etc.)
  - Sentiment indicator (color-coded dot: green for bullish, red for bearish, yellow for neutral)
  - Published date relative to now (e.g., "2 hours ago") via date-fns
  - Related symbols as clickable chips
  - "Analyzed" badge if the article has been processed by the pipeline
- **Infinite Scroll:** Automatically loads the next page of results when the user scrolls near the bottom
- **Data Source:** `GET /api/news` with pagination, market filter, and date range parameters

#### Trade Opportunities (`/opportunities`)

A filterable card grid displaying active and historical trade opportunities:

- **Filter Bar:** `FilterBar` component with controls for:
  - Status filter (Active, Expired, Closed)
  - Market filter (US Stocks, India, Crypto)
  - Direction filter (Long, Short, All)
  - Minimum confidence slider (0.50–1.00)
  - Sort by: Created date, Confidence, Risk/Reward ratio
  - Sort order: Ascending, Descending
- **Trade Cards:** Each opportunity rendered as a `TradeCard` component displaying:
  - Direction indicator: 🟢 LONG or 🔴 SHORT with color-coded background
  - Symbol and market badge
  - Confidence score with color gradient (green ≥0.80, yellow 0.60–0.79, red <0.60)
  - Entry price, stop loss, and take profit in monospace font
  - Risk-reward ratio
  - Timeframe badge (Intraday, Swing, Position)
  - Truncated reasoning with expandable "Read more"
  - Created date and expiration countdown
- **Responsive Grid:** 3 columns on desktop, 2 on tablet, 1 on mobile
- **Data Source:** `GET /api/opportunities` with all filter and sort parameters

#### Performance (`/performance`)

Historical performance dashboard with interactive charts:

- **Summary Cards:** Top-level metrics displayed as stat cards:
  - Total trade opportunities generated
  - Win rate percentage
  - Cumulative P&L percentage
  - Average risk-reward ratio
  - Best and worst trade P&L
- **Charts (Recharts):**
  - **Cumulative P&L Line Chart:** Time-series line chart showing cumulative profit/loss over the selected period
  - **Win/Loss Bar Chart:** Stacked bar chart showing wins (green) and losses (red) per aggregation period
  - **Performance by Market Pie Chart:** Breakdown of P&L contribution by market category
  - **Accuracy Trend Area Chart:** Rolling accuracy (hit rate) over time
- **Date Range Selector:** Pick start and end dates for the reporting period
- **Aggregation Toggle:** Daily, Weekly, Monthly grouping
- **Market Filter:** Filter performance data by specific market category
- **Data Source:** `GET /api/performance` with date range, market, and aggregation parameters

#### Settings (`/settings`)

User notification preference configuration page:

- **Telegram Chat ID Input:** Text field to enter or display the user's Telegram chat ID
- **Market Selection:** Checkbox group for US Stocks, Indian Equities, Crypto, Social
- **Confidence Threshold:** Slider or select input for minimum confidence (0.50–1.00, step 0.05)
- **Timeframe Selection:** Checkbox group for Intraday, Swing, Position
- **Active Toggle:** Switch to pause/resume notifications
- **Save Button:** Submits updates via `PUT /api/settings/:chatId`
- **Success/Error Feedback:** Toast notification on save result
- **Data Source:** `GET /api/settings/:chatId` for loading, `PUT /api/settings/:chatId` for saving

### Component Architecture

| Component | File | Purpose |
|---|---|---|
| `DashboardLayout` | `apps/web/src/layouts/DashboardLayout.tsx` | Shell layout with sidebar navigation and content area. Handles responsive sidebar collapse. |
| `Sidebar` | `apps/web/src/components/Sidebar.tsx` | Left navigation panel with route links (News, Opportunities, Performance, Settings). Highlights active route. Collapses to icon-only on tablet and hamburger on mobile. |
| `NewsCard` | `apps/web/src/components/NewsCard.tsx` | Individual news article card. Displays headline, source badge, sentiment indicator, published date, and related symbols. |
| `TradeCard` | `apps/web/src/components/TradeCard.tsx` | Trade opportunity card. Shows direction (LONG/SHORT), symbol, confidence gauge, price targets, risk-reward ratio, timeframe, and reasoning excerpt. |
| `FilterBar` | `apps/web/src/components/FilterBar.tsx` | Reusable filter and sort control bar. Accepts filter configuration props and emits filter change events. Used on Trade Opportunities and News Feed pages. |
| `PerformanceChart` | `apps/web/src/components/PerformanceChart.tsx` | Recharts wrapper that renders line, bar, pie, and area charts based on performance data. Handles responsive resizing. |
| `HealthIndicator` | `apps/web/src/components/HealthIndicator.tsx` | Small status dot (green/yellow/red) in the header bar with a tooltip showing dependency health details from `/api/health`. |

### Custom Hooks

| Hook | File | Purpose |
|---|---|---|
| `useApi` | `apps/web/src/hooks/useApi.ts` | Generic SWR-pattern data fetching hook. Manages `loading`, `error`, and `data` states. Supports polling interval, manual refetch, and cache invalidation. |
| `useNews` | `apps/web/src/hooks/useNews.ts` | News feed data hook. Wraps `useApi` for the `/api/news` endpoint with pagination state (page, limit) and market filter parameter. Supports infinite scroll by appending new pages. |
| `useOpportunities` | `apps/web/src/hooks/useOpportunities.ts` | Trade opportunities data hook. Wraps `useApi` for `/api/opportunities` with filter state (market, status, direction, minConfidence) and sort state (sortBy, sortOrder). |

### API Client

The HTTP client is configured in `apps/web/src/lib/api-client.ts`:

- **Axios Instance:** Pre-configured with `baseURL` pointing to the Express backend
- **Development Proxy:** Vite dev server proxies `/api` requests to `http://localhost:3000` (Express backend), avoiding CORS issues during development
- **Vercel Deployment:** `vercel.json` includes rewrite rules to proxy `/api/**` to the backend URL in production
- **Error Interceptor:** Axios response interceptor catches HTTP errors and transforms them into user-friendly error objects
- **Type Safety:** All API responses are typed using shared types from `@trading-intelligence/types`

---

## Observability

The application implements structured logging, queue monitoring, rate limit tracking, and health check endpoints for operational visibility.

### Structured Logging

The logging system uses Pino v10.3.x for high-performance structured JSON logging:

- **Logger Factory:** `apps/api/src/lib/logger.ts` exports a configured Pino logger instance
- **JSON Format in Production:** Logs are emitted as JSON objects with `level`, `time`, `msg`, `service`, and contextual fields for machine-parseable ingestion
- **Pretty Printing in Development:** Uses `pino-pretty` (v13.1.x) transport in development for human-readable, colorized terminal output
- **Child Loggers:** Each service module creates a child logger with contextual bindings:
  - `logger.child({ service: 'news-fetcher', source: 'finnhub' })` — News fetcher context
  - `logger.child({ service: 'analyzer', step: 'filter' })` — Pipeline step context
  - `logger.child({ service: 'bot', command: 'settings' })` — Bot command context
- **Log Levels:** `debug` (development only), `info` (operational events), `warn` (recoverable issues), `error` (failures requiring attention), `fatal` (unrecoverable crashes)
- **Request Logging:** `pino-http` middleware logs every HTTP request with method, URL, status code, response time, and request ID for correlation

### Queue Dashboard

Bull Board v6.20.3 provides a web-based monitoring dashboard at `/admin/queues`:

- **Visual Queue Status:** Real-time view of all three queues with job counts by status (waiting, active, completed, failed, delayed)
- **Job Inspection:** Click into any job to view its payload, progress, return value, or error stack trace
- **Manual Operations:** Retry failed jobs, remove completed jobs, clean old job data
- **Metrics:** Processing throughput and latency statistics per queue
- **Access:** Mounted as Express middleware at `/admin/queues`; no authentication in development mode

### Rate Limiters

Bottleneck v2.19.5 instances are created per external API source in `apps/api/src/lib/rate-limiter.ts`:

- Each API source has a dedicated, isolated Bottleneck instance (Rule 0.7.4)
- Configurations match the specific free-tier limits of each API (see [Rate Limiting Strategy](#rate-limiting-strategy))
- Bottleneck provides automatic queuing, retry scheduling, and reservoir-based token bucket rate limiting
- Rate limiter statistics (total calls, queued calls, running calls) are exposed via the health check endpoint

### Health Check

The `GET /api/health` endpoint (documented in [REST API > Endpoints](#endpoints)) provides comprehensive dependency status reporting:

- **PostgreSQL:** Connection health verified via a lightweight `SELECT 1` query with latency measurement
- **Redis:** Connection health verified via `PING` command with latency measurement
- **Queue Depths:** Current job counts across all three BullMQ queues
- **API Source Status:** Last fetch timestamp and error count for each registered data source
- **Overall Status:** Computed as `healthy` (all green), `degraded` (some warnings), or `unhealthy` (critical failures)

---

## Deployment

### Docker

The application is containerized for local development and production deployment using Docker and Docker Compose.

**Docker Compose (Local Development):**

The `docker-compose.yml` at the project root defines two infrastructure services. The API and web applications are run directly via `pnpm dev` during development:

| Service | Image | Port | Purpose |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 | PostgreSQL 16 database with healthcheck (`pg_isready`) |
| `redis` | `redis:7-alpine` | 6379 | Redis 7 with `appendonly yes` persistence and healthcheck (`redis-cli ping`) |

The API server (`apps/api`) and web dashboard (`apps/web`) are started via `pnpm dev` which uses Turborepo to run both development servers concurrently.

**Multi-Stage Dockerfile (Backend — `apps/api/Dockerfile`):**

```
Stage 1 — deps:
  FROM node:24-alpine
  Install pnpm, copy workspace files, run pnpm install --frozen-lockfile

Stage 2 — build:
  FROM deps
  Copy source files, run pnpm build (TypeScript compilation)

Stage 3 — production:
  FROM node:24-alpine
  Create non-root user (node), copy built artifacts and node_modules
  EXPOSE 3000
  CMD ["node", "dist/index.js"]
```

Key aspects:
- Uses `node:24-alpine` for minimal image size
- Non-root user in production stage for security
- Only production dependencies in the final image
- Health check via `HEALTHCHECK CMD curl -f http://localhost:3000/api/health || exit 1`

### PM2 Production Mode

The backend uses PM2 v5.x for production process management:

- **Config File:** `apps/api/ecosystem.config.js`
- **Cluster Mode:** `instances: "max"` — spawns one worker per CPU core
- **Auto-Restart:** Restarts crashed workers automatically
- **Environment Variables:** Production env vars passed via PM2 config
- **Log Management:** PM2 manages stdout/stderr log files with rotation
- **Graceful Reload:** `pm2 reload` for zero-downtime deployments

### Vercel Frontend Deployment

The React frontend is configured for Vercel deployment:

- **Config File:** `apps/web/vercel.json`
- **Build Command:** `cd apps/web && pnpm build`
- **Output Directory:** `apps/web/dist`
- **API Rewrites:** `/api/**` requests are proxied to the backend URL via Vercel rewrite rules
- **SPA Routing:** All non-API, non-asset routes are rewritten to `/index.html` for client-side routing

### Environment Configuration

All environment variables are documented in `.env.example` at the project root:

**Required Variables:**

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/trading_intelligence` |
| `DATABASE_PROVIDER` | Database provider toggle | `local` or `supabase` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM access | `sk-or-v1-...` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token | `123456:ABC-DEF...` |
| `FINNHUB_API_KEY` | Finnhub API key | `c...` |
| `COINGECKO_API_KEY` | CoinGecko demo API key | `CG-...` |
| `CRYPTOCOMPARE_API_KEY` | CryptoCompare API key | `...` |
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage API key | `...` |

**Optional Variables:**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express server port |
| `NODE_ENV` | `development` | Environment mode |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed CORS origin for the frontend |
| `LOG_LEVEL` | `info` | Pino log level (debug, info, warn, error) |
| `NEWS_POLL_INTERVAL` | `*/5 * * * *` | News polling cron schedule |
| `ANALYSIS_CONCURRENCY` | `3` | Analysis worker concurrency |
| `NOTIFICATION_CONCURRENCY` | `5` | Notification worker concurrency |

**Supabase Compatibility (Rule 0.7.4):**

When `DATABASE_PROVIDER=supabase`, the Drizzle ORM connection module:
1. Uses the `postgres` driver (instead of `pg`) for the connection
2. Sets `prepare: false` in the Drizzle configuration to work with Supabase's pgBouncer transaction pooler
3. Uses the Supabase connection string from `DATABASE_URL` (which includes the transaction pooler endpoint)

No code changes are required to switch between local PostgreSQL and Supabase — only the environment variables need to be updated.

---

## Appendix: Development Rules

This appendix consolidates all critical development rules derived from the Agent Action Plan (AAP) Section 0.7. These rules are mandatory for all contributors and code generation agents.

### Rule 0.7.1 — Architecture and Code Organization

1. **Feature-based organization over layer-based** — Code is organized by feature vertical (data → service → route → UI), not by technical layer. Each feature is a self-contained vertical slice to prevent mismatched interfaces between frontend and backend.

2. **Turborepo + pnpm workspaces monorepo** — All code resides within the Turborepo monorepo structure with `apps/api`, `apps/web`, and `packages/` workspaces. Shared types, config, and utilities go in `packages/`; application code goes in `apps/`.

3. **TypeScript strict mode everywhere** — All TypeScript files compile under `strict: true` with the following additional options enabled:
   - `noUncheckedIndexedAccess: true`
   - `exactOptionalPropertyTypes: true`
   - `noImplicitReturns: true`
   - No `any` types permitted; use `unknown` with type guards instead.

4. **ESM-first module system** — All packages use `"type": "module"` in package.json with ESNext module target. Import paths must include file extensions for Node.js ESM compatibility.

### Rule 0.7.2 — Financial Data Precision

1. **Decimal precision for all price fields** — All monetary values use PostgreSQL `numeric(12, 4)` type in the database schema. JavaScript floating-point (`number`) must never be used for price calculations — use string-based decimal representation or Drizzle's numeric type mapping.

2. **Sentiment score precision** — Sentiment scores use `numeric(5, 3)` for range -1.000 to 1.000, providing millisentiment precision.

3. **Confidence score precision** — Confidence values use `numeric(3, 2)` for range 0.00 to 1.00.

4. **Anti-hallucination validation** — All LLM-generated price targets (entry, stop loss, take profit) are cross-validated against actual market data from API sources before storage or notification delivery. Any price more than 10% away from the current market price is flagged for review.

### Rule 0.7.3 — LLM Integration

1. **Temperature = 0 for all financial analysis** — Every LLM call in the pipeline uses `temperature: 0` for deterministic, reproducible outputs. No creative generation is permitted in financial analysis contexts.

2. **Structured output with Zod schemas** — All LLM responses use `withStructuredOutput()` with explicitly defined Zod schemas. No free-form text parsing is permitted.

3. **Tiered model routing** — Each pipeline stage uses its designated model tier via OpenRouter. Cheap models handle high-volume filtering; expensive models are reserved for the ~25% of articles that reach the recommendation stage.

4. **DK-CoT prompting pattern** — All system prompts incorporate financial domain knowledge into reasoning chains (Domain Knowledge Chain-of-Thought), not generic chain-of-thought approaches.

5. **Negative news weighting** — The sentiment analysis stage weights negative financial news 2–3x higher than positive news, reflecting empirical market impact research.

6. **Explicit anti-hallucination instructions** — Every system prompt includes: "Do NOT fabricate price targets, earnings numbers, or analyst ratings not present in the source material."

7. **Few-shot examples** — Prompts include 2–3 few-shot examples for each pipeline stage to improve accuracy by up to 9% over zero-shot prompting.

### Rule 0.7.4 — Rate Limiting and API

1. **Per-API Bottleneck isolation** — Each external API source has its own dedicated Bottleneck instance configured to its specific free-tier limits. No shared rate limiter across different APIs.

2. **URL-based deduplication** — News articles are deduplicated by URL using a unique database constraint on the `url` column. Duplicate URLs from different polling cycles are silently skipped, not errored.

3. **Graceful degradation on API failure** — Individual API source failures do not halt the entire polling cycle. Each fetcher catches its own errors, logs them, and increments the `error_count` on the corresponding `api_sources` record.

4. **Supabase compatibility** — When connecting to Supabase, the Drizzle ORM connection sets `prepare: false` to work with Supabase's pgBouncer transaction pooler.

### Rule 0.7.5 — Telegram Bot

1. **MarkdownV2 escaping** — All special characters in Telegram messages are properly escaped with `\` per the Telegram Bot API MarkdownV2 specification. Characters requiring escaping: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`

2. **Emoji directional indicators** — Trade alerts use 🟢 for LONG recommendations and 🔴 for SHORT recommendations for instant visual comprehension.

3. **Inline code blocks for prices** — All price values in trade alerts are wrapped in inline code blocks for monospace formatting and visual distinction.

4. **Subscriber preference matching** — Notifications are only sent to users whose preference filters (market, min\_confidence, timeframes) match the trade opportunity attributes.

### Rule 0.7.6 — Queue and Worker

1. **Three separate queues** — `news-polling`, `analysis`, and `notifications` are independent BullMQ queues with separate worker instances. No shared queue for different job types.

2. **Breaking news priority** — The notification queue supports priority levels, with breaking news alerts at priority 1 (highest).

3. **Exponential backoff retry** — All workers use BullMQ's built-in retry with exponential backoff for transient failures (network errors, API rate limits).

4. **Concurrency controls** — Worker concurrency is configurable per queue. The analysis worker limits concurrency to respect OpenRouter rate limits.

### Rule 0.7.7 — Implementation Phase

1. **Validation test per phase** — Each of the 10 implementation phases has a concrete validation test. A phase is not complete until its validation passes.

2. **Context clearing between phases** — After completing each phase's validation, context is cleared before beginning the next phase to prevent context pollution that degrades code quality.

3. **Foundation first** — Phase 1 is always project scaffolding and Phase 2 is always database/ORM setup. No business logic until the foundation compiles and passes validation.

4. **Phased complexity** — Simpler infrastructure phases (scaffold, DB, ingestion) precede complex AI phases (LangGraph pipeline, model routing) which precede UI phases (dashboard).

---

*This document is the single source of truth for the Trading Intelligence Application. All implementation decisions should reference this specification. For the phased implementation plan with validation tests, see `docs/implementation-plan.md`.*
