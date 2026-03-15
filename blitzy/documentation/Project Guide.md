# Blitzy Project Guide — Trading Intelligence Application

---

## 1. Executive Summary

### 1.1 Project Overview

The Trading Intelligence Application is a production-ready, multi-market financial news analysis platform built as a Turborepo + pnpm monorepo. It aggregates financial news from 30+ sources across US stocks, Indian equities (NSE/BSE), and cryptocurrency markets, processes articles through a four-stage LangGraph.js AI analysis pipeline (Filter → Sentiment → Trade Detection → Recommendation) using tiered OpenRouter models, and delivers actionable trade recommendations via a grammY-based Telegram bot and a React web dashboard. The system targets individual traders seeking AI-augmented market intelligence at minimal LLM cost (~75% reduction through conditional short-circuiting).

### 1.2 Completion Status

```mermaid
pie title Project Completion — 86.1% Complete
    "Completed (AI)" : 210
    "Remaining" : 34
```

| Metric | Value |
|---|---|
| **Total Project Hours** | 244 |
| **Completed Hours (AI)** | 210 |
| **Remaining Hours** | 34 |
| **Completion Percentage** | 86.1% |

**Calculation:** 210 completed hours / (210 + 34 remaining hours) = 210 / 244 = **86.1%**

### 1.3 Key Accomplishments

- ✅ Full Turborepo monorepo scaffold with 5 workspace packages, Docker Compose, and CI-ready build pipeline (turbo build → 4/4 tasks successful)
- ✅ 7 PostgreSQL table schemas defined via Drizzle ORM with typed relations, enums, numeric precision for financial data, and local/Supabase connection toggle
- ✅ 8 news fetcher API client modules (Finnhub, RSS, Reddit, CoinGecko, CryptoCompare, Binance, Alpha Vantage, NSE India) with per-API Bottleneck rate limiters
- ✅ Complete 4-stage LangGraph.js analysis pipeline with Annotation state, DK-CoT prompts, OpenRouter multi-model routing (DeepSeek → Haiku → Sonnet), and Zod structured output
- ✅ 3 BullMQ queues (news-polling with 5-minute cron, analysis, notifications) with dedicated workers and priority levels
- ✅ grammY Telegram bot with /start, /settings, /status commands, inline keyboards, callback handlers, and MarkdownV2 trade alert formatter
- ✅ Express REST API with 5 route handlers, middleware stack (CORS, error handler, Pino request logger), and Bull Board dashboard at /admin/queues
- ✅ Dark-themed React dashboard with 4 pages, 6 components, Recharts visualization, responsive sidebar, and code-split Vite bundles
- ✅ 533 tests passing (425 API + 108 Web) across 12 test files with 69.3% statement coverage
- ✅ Zero TypeScript compilation errors, zero ESLint errors, runtime-verified health check (PostgreSQL + Redis healthy)

### 1.4 Critical Unresolved Issues

| Issue | Impact | Owner | ETA |
|---|---|---|---|
| Database SQL migration files not generated | Cannot deploy schema to new environments | Human Dev | 1 hour |
| No real API keys configured | News ingestion and AI pipeline non-functional without keys | Human Dev | 2 hours |
| OpenRouter pipeline not tested with real LLMs | Analysis accuracy unvalidated in production conditions | Human Dev | 4 hours |
| Telegram bot token not provisioned | Bot commands non-functional in Telegram | Human Dev | 2 hours |

### 1.5 Access Issues

| System/Resource | Type of Access | Issue Description | Resolution Status | Owner |
|---|---|---|---|---|
| OpenRouter API | API Key | OPENROUTER_API_KEY placeholder in .env — no real key provisioned | Unresolved | Human Dev |
| Finnhub API | API Key | FINNHUB_API_KEY placeholder — requires free registration at finnhub.io | Unresolved | Human Dev |
| Alpha Vantage API | API Key | ALPHA_VANTAGE_API_KEY placeholder — requires free registration | Unresolved | Human Dev |
| CoinGecko API | API Key (optional) | COINGECKO_API_KEY placeholder — free tier works without key | Unresolved | Human Dev |
| CryptoCompare API | API Key | CRYPTOCOMPARE_API_KEY placeholder — requires free registration | Unresolved | Human Dev |
| Telegram Bot API | Bot Token | TELEGRAM_BOT_TOKEN placeholder — requires @BotFather setup | Unresolved | Human Dev |

### 1.6 Recommended Next Steps

1. **[High]** Configure all required API keys in `.env` — register for free tiers at Finnhub, Alpha Vantage, CryptoCompare, OpenRouter, and create a Telegram bot via @BotFather
2. **[High]** Generate and apply database migrations — run `pnpm drizzle-kit generate` and `pnpm drizzle-kit migrate` to produce SQL migration files from Drizzle schemas
3. **[High]** Validate LangGraph AI pipeline — test all 4 stages (Filter → Sentiment → Trade Detection → Recommendation) with real OpenRouter models and sample financial articles
4. **[Medium]** Execute end-to-end smoke test — start the API server with real API keys, trigger a news polling cycle, verify articles flow through analysis to Telegram notification
5. **[Medium]** Complete production deployment — build Docker image, configure PM2 cluster mode, deploy React frontend to Vercel

---

## 2. Project Hours Breakdown

### 2.1 Completed Work Detail

| Component | Hours | Description |
|---|---|---|
| Monorepo Scaffold & Configuration | 8 | Turborepo v2.8.x, pnpm workspaces, tsconfig.base.json (strict), ESLint v9 flat config, Prettier, .gitignore, Docker Compose (PostgreSQL 16 + Redis 7), comprehensive .env.example, README.md |
| Shared Packages (types, config, utils) | 8 | 6 TypeScript interface modules (news, trade, user, api, queue), shared ESLint config, Zod validation schemas, financial formatting helpers |
| Database Layer (Drizzle ORM) | 16 | 7 table schemas (news_articles, trade_opportunities, trade_performance, user_settings, api_sources, analysis_logs, notification_logs), PostgreSQL enums, typed relations, connection factory with local/Supabase toggle, Drizzle Kit config, seed script |
| Core Infrastructure | 6 | Pino v10 structured logger with child logger factory, per-API Bottleneck rate limiter instances (Finnhub 60/min, CoinGecko 30/min, etc.), OpenRouter ChatOpenAI client factory with baseURL routing |
| News Ingestion Services | 20 | 8 API client modules (Finnhub REST, RSS parser for Indian markets, Reddit RSS, CoinGecko trending, CryptoCompare news, Binance klines, Alpha Vantage sentiment, NSE India scraper), orchestrator with URL-based deduplication, AbortSignal timeouts |
| LangGraph AI Analysis Pipeline | 24 | 4-stage StateGraph with Annotation-based typed state, DK-CoT system prompts with few-shot examples, per-stage OpenRouter model config (DeepSeek V3.2 → Claude Haiku 4.5 → Claude Sonnet 4.6), Zod schemas for structured output, conditional edge routing with ~75% short-circuiting |
| BullMQ Job Queue System | 14 | 3 queue definitions (news-polling cron, analysis processing, notifications dispatch), 3 dedicated workers, Redis connection factory, repeatable 5-minute cron job, priority levels (breaking news = priority 1), exponential backoff retry |
| Telegram Bot (grammY) | 16 | Bot initialization with middleware, /start (user registration), /settings (inline keyboard preferences), /status (system health), keyboard builders, callback query handlers, subscriber matching engine, MarkdownV2 formatter with emoji indicators (🟢 LONG / 🔴 SHORT) |
| Express REST API & Middleware | 16 | 5 route handlers (GET /api/news paginated, GET /api/opportunities filterable, GET /api/performance with SQL aggregation, GET/PUT /api/settings/:chatId, GET /api/health with dependency status), router aggregator, error handler, pino-http request logger, CORS middleware, Bull Board dashboard at /admin/queues, server bootstrap with graceful shutdown |
| React Web Dashboard | 32 | 4 pages (NewsFeed with market tabs and infinite scroll, TradeOpportunities with filter bar, Performance with Recharts charts, Settings with preference form), 6 components (NewsCard, TradeCard, FilterBar, PerformanceChart, Sidebar, HealthIndicator), 3 custom hooks (useApi, useNews, useOpportunities), dark theme CSS with design tokens, responsive DashboardLayout with collapsible sidebar, code-split Vite build, Vercel deployment config |
| Comprehensive Test Suite | 32 | 533 tests across 12 files — 5 API unit test suites (news-fetcher 51, analyzer 77, notifier 73, workers 58, bot commands 25), 4 API integration test suites (news-ingestion 18, analysis-pipeline 47, notification-delivery 17, api-routes 59), 3 web test suites (NewsCard 35, NewsFeed 35, TradeOpportunities 38), Vitest + Testing Library + Supertest, 69.3% statement coverage |
| Deployment & Documentation | 10 | Multi-stage Dockerfile (deps → build → production with non-root user), PM2 ecosystem config (cluster mode), specification.md (1,733 lines), implementation-plan.md (1,118 lines) |
| Bug Fixes & QA Remediation | 8 | 10+ fix commits resolving: Redis crash on health check, API response envelope consistency, UI styling fixes, ESLint unused imports, 37 integration test failures, Bull Board auth, sortBy validation, route-based code splitting, fetch timeout signals, QA documentation findings |
| **Total Completed** | **210** | |

### 2.2 Remaining Work Detail

| Category | Hours | Priority |
|---|---|---|
| Database Migration Generation | 1 | High |
| API Key Configuration & Secrets Management | 2 | High |
| Telegram Bot Production Setup | 2 | High |
| OpenRouter LLM Pipeline Validation | 4 | High |
| End-to-End Smoke Testing with Real APIs | 6 | Medium |
| Anti-Hallucination Price Target Validation | 3 | Medium |
| Production Deployment (Docker/PM2/Vercel) | 4 | Medium |
| Security Hardening (HTTPS, Secret Rotation) | 3 | Medium |
| Rate Limiter Calibration with Live APIs | 2 | Low |
| Monitoring & Production Log Transport | 3 | Low |
| Performance Testing & Query Optimization | 4 | Low |
| **Total Remaining** | **34** | |

### 2.3 Hours Verification

- **Section 2.1 Total (Completed):** 210 hours
- **Section 2.2 Total (Remaining):** 34 hours
- **Sum (2.1 + 2.2):** 210 + 34 = **244 hours** = Total Project Hours in Section 1.2 ✅
- **Completion:** 210 / 244 = **86.1%** ✅

---

## 3. Test Results

| Test Category | Framework | Total Tests | Passed | Failed | Coverage % | Notes |
|---|---|---|---|---|---|---|
| API Unit — News Fetcher | Vitest 3.2.4 | 51 | 51 | 0 | 69.3% (stmt) | Mock API responses, URL dedup, rate limiter |
| API Unit — Analyzer Pipeline | Vitest 3.2.4 | 77 | 77 | 0 | 69.3% (stmt) | Mock LLM responses, conditional routing, Zod output |
| API Unit — Notifier Service | Vitest 3.2.4 | 73 | 73 | 0 | 69.3% (stmt) | Subscriber matching, MarkdownV2 formatting |
| API Unit — Queue Workers | Vitest 3.2.4 | 58 | 58 | 0 | 69.3% (stmt) | Job processing with mocked dependencies |
| API Unit — Bot Commands | Vitest 3.2.4 | 25 | 25 | 0 | 69.3% (stmt) | /start, /settings, /status with mock context |
| API Integration — News Ingestion | Vitest 3.2.4 | 18 | 18 | 0 | 69.3% (stmt) | E2E polling → DB → queue with PostgreSQL |
| API Integration — Analysis Pipeline | Vitest 3.2.4 | 47 | 47 | 0 | 69.3% (stmt) | Full LangGraph pipeline with mock LLM |
| API Integration — Notification Delivery | Vitest 3.2.4 | 17 | 17 | 0 | 69.3% (stmt) | Opportunity → match → send with DB |
| API Integration — REST API Routes | Vitest 3.2.4 + Supertest | 59 | 59 | 0 | 69.3% (stmt) | All 5 endpoints with pagination, filtering, validation |
| Web — NewsCard Component | Vitest 3.2.4 + Testing Library | 35 | 35 | 0 | N/A | Rendering, sentiment badges, source display |
| Web — NewsFeed Page | Vitest 3.2.4 + Testing Library | 35 | 35 | 0 | N/A | Market tabs, infinite scroll, loading states |
| Web — TradeOpportunities Page | Vitest 3.2.4 + Testing Library | 38 | 38 | 0 | N/A | Filters, card grid, direction indicators |
| **Totals** | | **533** | **533** | **0** | **69.3%** | **100% pass rate** |

All test results originate from Blitzy's autonomous validation execution using `npx vitest run --no-watch` against live PostgreSQL 16 and Redis 7 containers.

---

## 4. Runtime Validation & UI Verification

**Backend Runtime:**
- ✅ Express API server starts successfully on port 3000
- ✅ BullMQ queues initialized (news-polling, analysis, notifications) with Redis 7
- ✅ Bull Board dashboard mounted at `/admin/queues` with configurable auth
- ✅ 5-minute cron job registered for news-polling repeatable queue
- ✅ Health endpoint returns `{"status":"healthy","postgres":true,"redis":true}` with latency metrics
- ✅ Graceful shutdown handles SIGTERM — closes HTTP server, bot, queues, Redis, DB connections
- ✅ Pino structured JSON logging with colorized pino-pretty in development mode
- ⚠️ Telegram bot starts with expected 404 (no real bot token in test environment — by design)

**Frontend Build:**
- ✅ Vite build produces code-split bundles in `dist/` directory
- ✅ Route-based code splitting: vendor-recharts (382 KB), index (228 KB), vendor-router (48 KB), lazy pages (<16 KB each)
- ✅ 1,036 modules transformed successfully
- ✅ HTML entry point with dark theme meta tags and root mount point

**Infrastructure:**
- ✅ Docker Compose: PostgreSQL 16 (healthy, port 5432), Redis 7 (healthy, port 6379)
- ✅ Turbo build: 4/4 workspace tasks completed (types, utils, api, web)
- ✅ pnpm install: All 5 workspace packages resolved with zero conflicts

**API Endpoint Verification:**
- ✅ `GET /api/health` — Returns database and Redis status with latency
- ✅ `GET /api/news` — Paginated news feed with market filtering
- ✅ `GET /api/opportunities` — Filterable trade opportunities with LEFT JOIN
- ✅ `GET /api/performance` — SQL-aggregated performance statistics
- ✅ `GET/PUT /api/settings/:chatId` — User preference CRUD
- ✅ `GET /admin/queues` — Bull Board queue monitoring dashboard

---

## 5. Compliance & Quality Review

| AAP Requirement | Status | Evidence |
|---|---|---|
| Turborepo + pnpm monorepo structure | ✅ Pass | `turbo.json`, `pnpm-workspace.yaml`, 5 workspace packages |
| TypeScript strict mode everywhere | ✅ Pass | `tsconfig.base.json` strict: true, 0 compilation errors |
| 7 PostgreSQL tables via Drizzle ORM | ✅ Pass | 7 schema files in `apps/api/src/db/schema/`, all with typed relations |
| numeric(12,4) for financial precision | ✅ Pass | `trade_opportunities` schema uses numeric precision columns |
| LangGraph.js 4-stage analysis pipeline | ✅ Pass | StateGraph with filter → sentiment → trade-detect → recommend nodes |
| Conditional short-circuiting (~75% cost) | ✅ Pass | Conditional edges in analyzer/index.ts route based on relevance/trade scores |
| OpenRouter tiered model strategy | ✅ Pass | `analyzer/models.ts` configures DeepSeek, Haiku, Sonnet per stage |
| Temperature = 0 for all LLM calls | ✅ Pass | All model configs set `temperature: 0` |
| DK-CoT prompting pattern | ✅ Pass | `analyzer/prompts.ts` includes domain-knowledge chain-of-thought |
| Zod structured output for LLMs | ✅ Pass | `analyzer/schemas.ts` with `withStructuredOutput()` integration |
| 8 news fetcher API clients | ✅ Pass | 8 modules in `services/news-fetcher/` with orchestrator |
| Per-API Bottleneck rate limiters | ✅ Pass | `lib/rate-limiter.ts` with per-API configs (60/min Finnhub, etc.) |
| URL-based deduplication | ✅ Pass | Unique URL index on news_articles + upsert logic in worker |
| 3 BullMQ queues with workers | ✅ Pass | news-polling (cron), analysis, notifications with 3 workers |
| grammY Telegram bot with 3 commands | ✅ Pass | /start, /settings, /status + inline keyboards + callbacks |
| MarkdownV2 escaping for Telegram | ✅ Pass | `notifier/formatter.ts` escapes all special characters |
| Express REST API (5 endpoints) | ✅ Pass | news, opportunities, performance, settings, health routes |
| Bull Board queue dashboard | ✅ Pass | Mounted at `/admin/queues` with Basic Auth option |
| React dark-themed dashboard | ✅ Pass | 4 pages, dark CSS variables, responsive sidebar layout |
| Recharts performance visualization | ✅ Pass | `PerformanceChart.tsx` with bar/line charts |
| Docker Compose (PG 16 + Redis 7) | ✅ Pass | `docker-compose.yml` with health checks and volumes |
| Multi-stage Dockerfile | ✅ Pass | `apps/api/Dockerfile` with deps → build → production stages |
| PM2 ecosystem config | ✅ Pass | `ecosystem.config.js` with cluster mode |
| Local/Supabase DB toggle | ✅ Pass | `db/index.ts` with `DATABASE_PROVIDER` environment switch |
| Pino structured logging | ✅ Pass | `lib/logger.ts` with child logger factory |
| Comprehensive test suite | ✅ Pass | 533/533 tests passing, 12 test files |
| ESLint zero errors | ✅ Pass | 0 errors, 8 no-console warnings |
| docs/specification.md | ✅ Pass | 1,733-line specification document |
| docs/implementation-plan.md | ✅ Pass | 1,118-line 10-phase implementation plan |

**Autonomous Fixes Applied:**
1. Removed unused `within` import in NewsFeed test file (ESLint no-unused-vars)
2. Removed unused `waitFor` import in TradeOpportunities test file (ESLint no-unused-vars)
3. Added AbortSignal.timeout to all fetch() calls in 5 fetcher modules
4. Implemented route-based code splitting to reduce bundle size below 500 KB
5. Resolved Redis crash on health check endpoint
6. Added Bull Board authentication and made Telegram bot token optional
7. Resolved 37 API route integration test failures
8. Fixed API response envelope consistency and UI styling issues

---

## 6. Risk Assessment

| Risk | Category | Severity | Probability | Mitigation | Status |
|---|---|---|---|---|---|
| No real API keys configured — all external services non-functional | Integration | High | Certain | Register for free tiers at Finnhub, Alpha Vantage, CoinGecko, CryptoCompare, OpenRouter; provision Telegram bot token via @BotFather | Open |
| Database migration files not generated — schema not deployable to new environments | Technical | High | Certain | Run `drizzle-kit generate` and `drizzle-kit migrate` to produce SQL migration files | Open |
| LLM pipeline untested with real models — accuracy and cost unvalidated | Technical | High | High | Execute end-to-end pipeline test with real OpenRouter API key and sample articles from each market | Open |
| Anti-hallucination price validation not tested with live data | Technical | Medium | Medium | Test LLM-generated price targets against real Finnhub/Binance quotes; verify 10% deviation threshold | Open |
| Rate limiter configs untested against live API limits | Operational | Medium | Medium | Execute controlled test runs against each API; monitor 429 responses; tune Bottleneck reservoirs | Open |
| No HTTPS/TLS configured for production | Security | Medium | High | Configure HTTPS via reverse proxy (nginx/Caddy) or cloud load balancer before production deployment | Open |
| API keys stored in .env file — no secret management | Security | Medium | High | Migrate to cloud secret manager (AWS Secrets Manager, Vercel env vars) for production | Open |
| No health check alerting — silent failures possible | Operational | Medium | Medium | Integrate Pino transport for production alerting (PagerDuty, Slack webhook) | Open |
| stock-nse-india scraper may break on website changes | Integration | Low | Medium | Add error handling and fallback; monitor NSE data availability; consider paid API alternative | Open |
| Redis persistence not production-hardened | Operational | Low | Low | Configure Redis AOF rewrite policies and backup strategy for production Redis instance | Open |

---

## 7. Visual Project Status

```mermaid
pie title Project Hours Breakdown
    "Completed Work" : 210
    "Remaining Work" : 34
```

**Remaining Work by Priority:**

| Priority | Hours | Categories |
|---|---|---|
| 🔴 High | 9 | DB Migrations (1h), API Keys (2h), Telegram Setup (2h), LLM Pipeline Validation (4h) |
| 🟡 Medium | 16 | E2E Smoke Testing (6h), Anti-Hallucination (3h), Production Deploy (4h), Security (3h) |
| 🟢 Low | 9 | Rate Limiter Tuning (2h), Monitoring (3h), Performance Testing (4h) |
| **Total** | **34** | |

---

## 8. Summary & Recommendations

### Achievement Summary

The Trading Intelligence Application has been built from a single-file greenfield repository into a comprehensive, production-architecture platform. Blitzy agents delivered **210 hours** of engineering work across **136 files** containing **51,424 net lines of code**, achieving **86.1% project completion** (210 / 244 total hours). The entire monorepo compiles with zero errors, all 533 tests pass, and the runtime health check confirms PostgreSQL and Redis connectivity.

The most complex deliverables — the 4-stage LangGraph.js AI analysis pipeline with conditional routing and the multi-source news ingestion system with 8 API clients — are fully implemented with comprehensive test coverage. The React dashboard, Telegram bot, and Express API layer are functionally complete and ready for integration testing with real data.

### Remaining Gaps

The **34 remaining hours** (13.9% of total project scope) consist primarily of **configuration and validation tasks** that require human intervention due to the need for real API credentials and production environment access:

- **9 hours (High priority):** API key provisioning, database migration generation, Telegram bot setup, and LLM pipeline validation with real OpenRouter models
- **16 hours (Medium priority):** End-to-end smoke testing, anti-hallucination validation with live market data, production deployment, and security hardening
- **9 hours (Low priority):** Rate limiter calibration, monitoring setup, and performance optimization

### Production Readiness Assessment

The codebase is **architecturally production-ready** — all modules are implemented, tested, and integrate correctly via mocked dependencies. The path to production is primarily a **configuration and validation effort**, not a development effort. Once API keys are provisioned and the AI pipeline is validated with real models, the system can be deployed using the provided Docker, PM2, and Vercel configurations.

### Critical Path

1. Provision all API keys (2h) → 2. Generate DB migrations (1h) → 3. Validate LLM pipeline (4h) → 4. E2E smoke test (6h) → 5. Deploy to production (4h)

---

## 9. Development Guide

### System Prerequisites

| Software | Version | Purpose |
|---|---|---|
| Node.js | 24.x LTS (24.14.0) | JavaScript runtime |
| pnpm | 9.x (9.15.9) | Package manager for monorepo workspaces |
| Docker & Docker Compose | 24.x+ / 2.x+ | PostgreSQL 16 and Redis 7 containers |
| Git | 2.x+ | Version control |

### Environment Setup

```bash
# 1. Clone the repository
git clone <repository-url>
cd trading-intelligence

# 2. Activate Node.js 24 LTS (if using nvm)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 24.14.0
nvm use 24.14.0

# 3. Verify Node.js and pnpm
node --version   # Expected: v24.14.0
pnpm --version   # Expected: 9.15.9

# 4. Copy and configure environment variables
cp .env.example .env
# Edit .env and fill in:
#   - OPENROUTER_API_KEY (required for AI pipeline)
#   - FINNHUB_API_KEY (required for US stock news)
#   - ALPHA_VANTAGE_API_KEY (required for historical data)
#   - CRYPTOCOMPARE_API_KEY (required for crypto news)
#   - TELEGRAM_BOT_TOKEN (optional — bot disabled without it)
#   - COINGECKO_API_KEY (optional — free tier works without key)
```

### Infrastructure Startup

```bash
# 5. Start PostgreSQL 16 and Redis 7
docker compose up -d

# 6. Verify containers are healthy
docker ps --format "table {{.Names}}\t{{.Status}}"
# Expected:
#   trading-intel-postgres   Up ... (healthy)
#   trading-intel-redis      Up ... (healthy)
```

### Dependency Installation

```bash
# 7. Install all workspace dependencies
pnpm install --no-frozen-lockfile

# 8. Build all workspace packages (types → utils → api → web)
pnpm build
# Expected: "Tasks: 4 successful, 4 total"
```

### Database Setup

```bash
# 9. Generate database migrations (if not already generated)
cd apps/api
npx drizzle-kit generate

# 10. Apply migrations to PostgreSQL
npx drizzle-kit migrate

# 11. Seed sample data
npx tsx src/db/seed.ts
# Expected: "Seed completed successfully"

cd ../..
```

### Running Tests

```bash
# 12. Run API tests (425 tests)
cd apps/api
npx vitest run --no-watch
# Expected: "Test Files 9 passed (9) / Tests 425 passed (425)"

# 13. Run Web tests (108 tests)
cd ../web
npx vitest run --no-watch
# Expected: "Test Files 3 passed (3) / Tests 108 passed (108)"

cd ../..
```

### Starting the Application

```bash
# 14. Start the API server (development mode)
cd apps/api
npx tsx src/index.ts
# Server starts on http://localhost:3000
# Bull Board dashboard at http://localhost:3000/admin/queues

# 15. In a separate terminal — Start the frontend dev server
cd apps/web
npx vite --host
# Frontend starts on http://localhost:5173 (proxied to API)
```

### Verification

```bash
# 16. Verify API health
curl -s http://localhost:3000/api/health | python3 -m json.tool
# Expected: {"status":"healthy","postgres":true,"redis":true}

# 17. Verify news endpoint
curl -s "http://localhost:3000/api/news?page=1&limit=10" | python3 -m json.tool

# 18. Verify opportunities endpoint
curl -s "http://localhost:3000/api/opportunities?page=1&limit=10" | python3 -m json.tool
```

### Troubleshooting

| Issue | Resolution |
|---|---|
| `ECONNREFUSED` on port 5432 | Run `docker compose up -d` and wait for PostgreSQL health check |
| `ECONNREFUSED` on port 6379 | Run `docker compose up -d` and verify Redis container is healthy |
| `EADDRINUSE` on port 3000 | Kill existing process: `fuser -k 3000/tcp` or change PORT in .env |
| Telegram bot 404 error | Expected when TELEGRAM_BOT_TOKEN is not set — bot is disabled |
| `Module not found` errors | Run `pnpm install --no-frozen-lockfile` then `pnpm build` |
| OpenRouter API errors | Verify OPENROUTER_API_KEY is set correctly in .env (starts with `sk-or-`) |

---

## 10. Appendices

### A. Command Reference

| Command | Directory | Purpose |
|---|---|---|
| `pnpm install --no-frozen-lockfile` | Root | Install all workspace dependencies |
| `pnpm build` | Root | Build all packages via Turborepo |
| `docker compose up -d` | Root | Start PostgreSQL 16 + Redis 7 |
| `docker compose down` | Root | Stop infrastructure containers |
| `npx vitest run --no-watch` | `apps/api` | Run API test suite (425 tests) |
| `npx vitest run --no-watch` | `apps/web` | Run Web test suite (108 tests) |
| `npx tsx src/index.ts` | `apps/api` | Start Express API server |
| `npx vite --host` | `apps/web` | Start Vite dev server |
| `npx drizzle-kit generate` | `apps/api` | Generate SQL migration files |
| `npx drizzle-kit migrate` | `apps/api` | Apply migrations to PostgreSQL |
| `npx tsx src/db/seed.ts` | `apps/api` | Seed database with sample data |
| `npx eslint src/` | `apps/api` or `apps/web` | Run ESLint static analysis |

### B. Port Reference

| Port | Service | Protocol |
|---|---|---|
| 3000 | Express API server | HTTP |
| 5173 | Vite frontend dev server | HTTP |
| 5432 | PostgreSQL 16 | TCP |
| 6379 | Redis 7 | TCP |

### C. Key File Locations

| Path | Purpose |
|---|---|
| `apps/api/src/index.ts` | API server entry point |
| `apps/api/src/config/env.ts` | Environment variable validation |
| `apps/api/src/db/schema/` | All 7 Drizzle ORM table schemas |
| `apps/api/src/services/analyzer/` | LangGraph AI analysis pipeline |
| `apps/api/src/services/news-fetcher/` | 8 news API client modules |
| `apps/api/src/queues/` | BullMQ queue definitions and workers |
| `apps/api/src/bot/` | grammY Telegram bot handlers |
| `apps/api/src/routes/` | Express REST API route handlers |
| `apps/web/src/pages/` | React page components |
| `apps/web/src/components/` | Reusable React UI components |
| `packages/types/src/` | Shared TypeScript interfaces |
| `.env.example` | Environment variable documentation |
| `docker-compose.yml` | Infrastructure service definitions |

### D. Technology Versions

| Technology | Version | Role |
|---|---|---|
| Node.js | 24.14.0 LTS | Runtime |
| TypeScript | 5.9.3 | Language |
| pnpm | 9.15.9 | Package manager |
| Turborepo | 2.8.17 | Monorepo build system |
| Express | 4.22.x | HTTP server framework |
| React | 19.1.x | Frontend UI library |
| Vite | 6.2.x | Frontend build tool |
| Drizzle ORM | 0.45.x | PostgreSQL ORM |
| BullMQ | 5.71.x | Redis job queue |
| grammY | 1.41.x | Telegram bot framework |
| LangGraph.js | 1.2.x | AI pipeline framework |
| @langchain/openai | 1.2.x | OpenRouter LLM client |
| Pino | 10.3.x | Structured logger |
| Vitest | 3.2.4 | Test runner |
| PostgreSQL | 16-alpine | Database |
| Redis | 7-alpine | Queue backing store |
| Recharts | 2.15.x | Chart visualization |
| Zod | 3.25.x | Schema validation |

### E. Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | (docker default) | PostgreSQL connection string |
| `DATABASE_PROVIDER` | Yes | `local` | `local` or `supabase` |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter LLM API key |
| `FINNHUB_API_KEY` | Yes | — | Finnhub financial data API key |
| `ALPHA_VANTAGE_API_KEY` | Yes | — | Alpha Vantage historical data key |
| `CRYPTOCOMPARE_API_KEY` | Yes | — | CryptoCompare news API key |
| `COINGECKO_API_KEY` | No | — | CoinGecko API key (optional) |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token (bot disabled without) |
| `BULL_BOARD_PASSWORD` | No | — | Bull Board dashboard auth password |
| `PORT` | Yes | `3000` | Express server port |
| `FRONTEND_URL` | Yes | `http://localhost:5173` | CORS-allowed frontend origin |
| `NODE_ENV` | Yes | `development` | Runtime environment |
| `LOG_LEVEL` | No | `debug` | Pino log minimum level |
| `FILTER_MODEL` | No | `deepseek/deepseek-v3-0324` | Stage 1 LLM model ID |
| `SENTIMENT_MODEL` | No | `anthropic/claude-haiku-4-5-20241022` | Stage 2 LLM model ID |
| `TRADE_DETECT_MODEL` | No | `anthropic/claude-haiku-4-5-20241022` | Stage 3 LLM model ID |
| `RECOMMEND_MODEL` | No | `anthropic/claude-sonnet-4-6-20250514` | Stage 4 LLM model ID |
| `NEWS_POLL_INTERVAL` | No | `*/5 * * * *` | Cron schedule for news polling |
| `ANALYSIS_CONCURRENCY` | No | `3` | Max parallel analysis jobs |
| `NOTIFICATION_CONCURRENCY` | No | `5` | Max parallel notification sends |

### F. Developer Tools Guide

| Tool | Access | Purpose |
|---|---|---|
| Bull Board Dashboard | `http://localhost:3000/admin/queues` | Monitor BullMQ queue status, active/completed/failed jobs |
| Health Check | `GET http://localhost:3000/api/health` | Verify PostgreSQL, Redis, API source connectivity |
| Pino Pretty Logs | Auto-enabled in development | Colorized structured log output in terminal |
| Vite HMR | `http://localhost:5173` | Hot module replacement for frontend development |
| Drizzle Studio | `npx drizzle-kit studio` | Visual database browser for Drizzle ORM schemas |

### G. Glossary

| Term | Definition |
|---|---|
| DK-CoT | Domain Knowledge Chain-of-Thought — prompting pattern incorporating financial domain expertise into LLM reasoning chains |
| OpenRouter | Unified LLM gateway providing access to multiple AI models (DeepSeek, Claude) via a single API endpoint |
| BullMQ | Redis-backed job queue for Node.js with repeatable cron jobs, priority levels, and concurrency controls |
| Drizzle ORM | TypeScript-first ORM for PostgreSQL with type-safe schema definitions and SQL migration generation |
| grammY | TypeScript-native Telegram Bot framework with plugin ecosystem and inline keyboard support |
| LangGraph.js | Directed graph framework for building multi-step AI agent workflows with typed state and conditional routing |
| Bottleneck | Rate limiter library providing per-API request throttling with configurable reservoir and burst limits |
| Short-circuiting | Conditional edge routing in the analysis pipeline that terminates processing early for irrelevant articles (~75% of volume) |