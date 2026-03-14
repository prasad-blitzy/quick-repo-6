# GMGN.ai Memecoin Signal Bot

![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-3178C6?logo=typescript&logoColor=white)
![Preact](https://img.shields.io/badge/Preact-10.29.0-673AB8?logo=preact&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

A Chrome Extension overlay for [GMGN.ai](https://gmgn.ai) that provides automated, real-time trading signal generation for Solana memecoin trading.

> **⚠️ Signal & Analytics Only** — This extension generates trading signals and monitors positions. It does **not** execute buy/sell transactions. It is an analytical overlay, not a trading bot with execution capability.

---

## Overview

GMGN.ai Memecoin Signal Bot is a Manifest V3 Chrome Extension that injects a fixed sidebar panel into the GMGN.ai trading platform. It passively intercepts the data GMGN already fetches, enriches it with external API sources, and produces actionable trading signals through a multi-factor scoring engine and AI-powered analysis.

### Core Capabilities

- **7-Factor Composite Scoring Engine** — Produces a 0–100 signal score weighted across volume spike detection, smart money convergence, buy/sell ratio, holder growth, liquidity thresholds, token age, and safety score validation
- **Smart Money Convergence Detection** — Fires when 3+ qualified smart money wallets enter the same token within a 2-hour window, with position-size conviction analysis (entries above 80% of historical average)
- **Three-Tier AI/LLM Analysis** — Routes token analysis through Groq-powered LLM tiers: `llama-3.1-8b-instant` for routine screening (80% of calls), `llama-3.3-70b-versatile` for detailed analysis (15%), and Claude Sonnet for narrative analysis of high-confidence signals (5%)
- **Real-Time WebSocket Streaming** — Persistent connections to PumpPortal (`wss://pumpportal.fun/api/data`) for new token events and Birdeye for price streams, with Chrome 116+ WebSocket keepalive behavior
- **Multi-Source Safety Analysis** — Concurrent checks via RugCheck + GoPlus Security + Jupiter honeypot simulation (sell quote verification) with worst-case-wins aggregation
- **Tiered Exit Strategy Engine** — Ladder take-profit strategy: sell 50% at 2×, 25% at 5×, 25% at 10× with configurable day-trade and swing-trade profiles, plus hard exit triggers for dev wallet selling, smart money position reduction, and volume decline

---

## Features

- **GMGN.ai Data Interception** — Captures internal API data by monkey-patching `window.fetch` and `XMLHttpRequest` within the page context, relaying intercepted responses through `window.postMessage` to the content script and then to the service worker — bypassing Cloudflare restrictions entirely
- **Shadow DOM UI Isolation** — All extension UI renders inside a Shadow DOM container for complete CSS isolation from GMGN's page styles, using Preact (3KB) for lightweight rendering
- **7-Factor Weighted Scoring** — Volume spike, smart money convergence, buy/sell ratio, holder growth, liquidity, token age, and safety score — each independently configurable
- **Configurable Trading Modes** — Conservative mode (≥80 composite score) and Aggressive mode (≥45 composite score) with user-adjustable factor weights
- **Hard Filter Safety Gates** — Binary pass/fail gates that override any composite score: bundled launch with >10% sniper supply, active mint authority, active freeze authority, no LP lock/burn, liquidity <$3K, top 10 holders >50% of supply
- **Encrypted API Key Storage** — All API keys encrypted with AES-GCM via the Web Crypto API before storage in `chrome.storage.local`; keys never exposed to content scripts
- **WebSocket Keepalive** — 20-second keepalive pings for all WebSocket connections with exponential backoff reconnection and Chrome 116+ service worker lifecycle management via `chrome.alarms`
- **Real-Time New Token Feed** — Live stream of newly created pump.fun tokens via PumpPortal WebSocket with initial safety screening and bonding curve progress tracking
- **Smart Money Wallet Tracking** — Monitors categorized wallets (Smart Money, KOL, Whale, Sniper, Insider, Developer) with convergence detection and position-size context
- **LLM Response Caching** — Groq/Claude responses cached in `chrome.storage.local` with 5-minute TTL to reduce API costs by ~60%

---

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Build Framework** | WXT (WebExtension Toolkit) | 0.20.17 | Manifest V3 build framework with HMR and auto-manifest generation |
| **UI Rendering** | Preact | 10.29.0 | Lightweight 3KB React alternative with Shadow DOM rendering |
| **State Management** | Zustand | 5.0.11 | `zustand/vanilla` for service worker, hooks for UI via `preact/compat` |
| **Language** | TypeScript | 5.9.3 | Strict mode with Preact JSX pragma |
| **Testing** | Vitest | 4.1.0 | Vite-native test runner with happy-dom and @testing-library/preact |
| **LLM Client** | groq-sdk | 0.18.0 | Official Groq API client with structured JSON output |
| **Target** | Chrome 116+ | Manifest V3 | Minimum version for WebSocket service worker keepalive |

---

## Prerequisites

- **Node.js** ≥ 20.19
- **Chrome** browser version 116 or higher
- **API Keys** (configured post-installation via the extension's Settings panel):

| Provider | Plan | Cost | Required |
|----------|------|------|----------|
| [Birdeye](https://birdeye.so) | Starter | $99/mo | Yes — primary token analytics |
| [Helius](https://helius.dev) | Developer | $49/mo | Yes — enhanced transaction parsing |
| [Groq](https://groq.com) | Free tier | Free | Yes — LLM inference |
| [RugCheck](https://rugcheck.xyz) | Free | Free | Yes — token safety reports |
| [GoPlus Security](https://gopluslabs.io) | Free | Free | Included — contract security checks |
| [Jupiter](https://jup.ag) | Free tier (1 RPS) | Free | Included — honeypot detection |
| [DexScreener](https://dexscreener.com) | Free | Free | Included — fallback data source |
| [PumpPortal](https://pumpportal.fun) | Free | Free | Included — new token WebSocket events |
| [Anthropic Claude](https://anthropic.com) | Pay-per-use | Variable | Optional — narrative analysis for top 5% signals |

**Estimated monthly cost**: ~$150–250 (Birdeye $99 + Helius $49 + LLM $5–15)

---

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd gmgn-signal-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment (Optional for Development)

```bash
cp .env.example .env
```

Edit `.env` and add your API keys:

```env
BIRDEYE_API_KEY=your_birdeye_key_here
HELIUS_API_KEY=your_helius_key_here
RUGCHECK_API_KEY=your_rugcheck_key_here
GROQ_API_KEY=your_groq_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
```

> **Note**: API keys can also be configured at runtime through the extension's built-in Settings panel, where they are encrypted before storage.

### 4. Start Development Mode

```bash
npm run dev
```

This starts WXT in development mode with hot module replacement (HMR).

### 5. Load the Extension in Chrome

1. Open `chrome://extensions` in your Chrome browser
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `.output/chrome-mv3-dev/` directory from the project root
5. Navigate to [gmgn.ai](https://gmgn.ai) — the signal bot sidebar panel will appear on the right edge of the page

---

## Build & Production

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development mode with HMR |
| `npm run build` | Production build to `.output/chrome-mv3/` |
| `npm run zip` | Create distributable `.zip` for Chrome Web Store |
| `npm run test` | Run all unit and integration tests |
| `npm run typecheck` | TypeScript type checking via `tsc --noEmit` |

### Production Build

```bash
npm run build
```

The production-ready extension is output to `.output/chrome-mv3/`. Load this directory as an unpacked extension or package it for distribution.

### Create Distribution Package

```bash
npm run zip
```

Creates a `.zip` file suitable for Chrome Web Store submission.

---

## API Key Configuration

API keys are managed through the extension's **Settings panel** accessible from the sidebar overlay. All keys are encrypted using **AES-GCM** via the Web Crypto API before being stored in `chrome.storage.local`. A unique encryption key is generated per extension installation.

### Configurable API Keys

| Key | Provider | Purpose |
|-----|----------|---------|
| `BIRDEYE_API_KEY` | Birdeye | Token analytics — price, OHLCV, transactions, top holders, WebSocket streams |
| `HELIUS_API_KEY` | Helius | Enhanced Solana RPC — parsed transactions, token metadata |
| `RUGCHECK_API_KEY` | RugCheck | Token safety reports, insider detection graphs |
| `GROQ_API_KEY` | Groq | LLM inference — llama-3.1-8b-instant, llama-3.3-70b-versatile |
| `ANTHROPIC_API_KEY` | Anthropic | Claude Sonnet — narrative analysis for top 5% signals (optional) |

### Security Model

- API keys are **never** exposed to content scripts — they are accessed only from the service worker context
- Keys are encrypted with **AES-GCM** (256-bit) using the Web Crypto API
- The per-installation encryption key is stored separately in `chrome.storage.local`
- All external API calls are made exclusively from the service worker via `host_permissions`

### Cost Optimization

- **Three-tier LLM routing** reduces LLM costs by ~60%: 80% use `llama-3.1-8b-instant` (cheapest), 15% use `llama-3.3-70b-versatile`, only 5% escalate to Claude Sonnet
- **LLM response caching** with 5-minute TTL prevents duplicate analyses for the same token
- **DexScreener as fallback only** — free tier used only when Birdeye rate limits are exceeded
- **Target monthly budget**: ~$150–250 total (Birdeye Starter $99 + Helius Developer $49 + LLM $5–15)

---

## Project Structure

```
├── entrypoints/              # Chrome Extension entry points (WXT convention)
│   ├── background.ts         # Service worker — API calls, signal engine, WebSocket mgmt
│   ├── content.ts            # Content script — Shadow DOM mounting, message bridging
│   ├── injected.ts           # Page-context script — fetch/XHR monkey-patching
│   └── popup/                # Extension toolbar popup
│       ├── index.html        # Popup HTML shell
│       ├── App.tsx           # Popup Preact component
│       └── main.tsx          # Popup render bootstrap
├── src/
│   ├── signals/              # 7-factor scoring engine
│   │   ├── scoring-engine.ts # Composite score orchestrator (0–100)
│   │   ├── factors/          # Individual factor modules
│   │   │   ├── volume-spike.ts
│   │   │   ├── smart-money-convergence.ts
│   │   │   ├── buy-sell-ratio.ts
│   │   │   ├── holder-growth.ts
│   │   │   ├── liquidity.ts
│   │   │   ├── token-age.ts
│   │   │   └── safety-score.ts
│   │   ├── hard-filters.ts   # Binary pass/fail safety gates
│   │   ├── exit-signals.ts   # TP/SL ladder and exit trigger monitor
│   │   └── types.ts          # Signal type definitions
│   ├── api/                  # External API clients
│   │   ├── base-client.ts    # Abstract HTTP client with retry/cache
│   │   ├── rate-limiter.ts   # Per-API token bucket rate limiter
│   │   ├── birdeye.ts        # Birdeye REST client
│   │   ├── pump-portal.ts    # PumpPortal WebSocket client
│   │   ├── jupiter.ts        # Jupiter price and quote API
│   │   ├── helius.ts         # Helius Enhanced RPC client
│   │   ├── dexscreener.ts    # DexScreener REST client (fallback)
│   │   ├── rugcheck.ts       # RugCheck safety reports
│   │   ├── goplus.ts         # GoPlus Security checks
│   │   ├── groq.ts           # Groq LLM client (three-tier)
│   │   └── types.ts          # Shared API response types
│   ├── gmgn/                 # GMGN data interception
│   │   ├── interceptor.ts    # fetch/XHR monkey-patch logic
│   │   ├── url-patterns.ts   # GMGN internal API URL pattern registry
│   │   ├── parsers.ts        # GMGN response-to-model transformers
│   │   └── types.ts          # GMGN data type definitions
│   ├── tracking/             # Smart money tracking
│   │   ├── wallet-tracker.ts # Wallet watchlist management
│   │   ├── convergence-detector.ts  # Multi-wallet convergence detection
│   │   ├── wallet-classifier.ts     # Wallet type classification
│   │   └── types.ts          # Tracking type definitions
│   ├── safety/               # Token safety analysis
│   │   ├── checker.ts        # Multi-source safety orchestrator
│   │   ├── honeypot-detector.ts     # Jupiter-based sell simulation
│   │   ├── lp-analyzer.ts    # LP lock/burn verification
│   │   └── types.ts          # Safety type definitions
│   ├── ai/                   # AI/LLM integration
│   │   ├── router.ts         # Three-tier LLM dispatch
│   │   ├── prompts.ts        # Prompt templates (5 analysis dimensions)
│   │   ├── response-parser.ts # Structured JSON response parser
│   │   └── types.ts          # AI type definitions
│   ├── streaming/            # WebSocket streaming
│   │   ├── manager.ts        # WebSocket lifecycle manager
│   │   ├── pump-portal-stream.ts  # PumpPortal event handler
│   │   ├── birdeye-stream.ts # Birdeye WebSocket handler
│   │   └── types.ts          # Stream type definitions
│   ├── store/                # Zustand state management
│   │   ├── signal-store.ts   # Active signals store
│   │   ├── token-store.ts    # Token data store
│   │   ├── settings-store.ts # User preferences store
│   │   ├── position-store.ts # Tracked positions store
│   │   ├── chrome-storage-adapter.ts  # Zustand ↔ chrome.storage middleware
│   │   └── index.ts          # Store exports and initialization
│   ├── components/           # Preact UI components (Shadow DOM)
│   │   ├── App.tsx           # Root component with visibility toggle
│   │   ├── SignalPanel.tsx    # Main signal list with filters
│   │   ├── TokenCard.tsx     # Individual token signal card
│   │   ├── SafetyBadge.tsx   # Color-coded safety indicator
│   │   ├── ScoreGauge.tsx    # Circular composite score gauge
│   │   ├── AIInsight.tsx     # LLM-generated analysis display
│   │   ├── ExitStrategy.tsx  # TP/SL ladder visualization
│   │   ├── SmartMoneyIndicator.tsx  # Smart money activity display
│   │   ├── SettingsPanel.tsx # User configuration form
│   │   ├── NewTokenFeed.tsx  # Real-time new token feed
│   │   └── styles.css        # Shadow DOM scoped stylesheet
│   └── utils/                # Shared utilities
│       ├── crypto.ts         # AES-GCM encryption for API keys
│       ├── messaging.ts      # Type-safe Chrome runtime messaging
│       ├── cache.ts          # TTL-based chrome.storage cache
│       ├── logger.ts         # Structured logging utility
│       ├── config.ts         # Application constants and URLs
│       └── formatting.ts     # Number/price display formatters
├── tests/                    # Unit, integration, and component tests
│   ├── unit/
│   │   ├── signals/          # Scoring engine and factor tests
│   │   ├── api/              # API client tests
│   │   ├── safety/           # Safety analysis tests
│   │   ├── ai/               # LLM router and parser tests
│   │   ├── gmgn/             # Interceptor and parser tests
│   │   ├── tracking/         # Convergence detector tests
│   │   ├── store/            # Chrome storage adapter tests
│   │   └── utils/            # Utility function tests
│   └── integration/          # End-to-end pipeline tests
├── docs/                     # Documentation
│   ├── ARCHITECTURE.md       # System architecture and data flow
│   ├── API-INTEGRATION.md    # External API reference and setup
│   └── SIGNALS.md            # Signal scoring methodology
├── assets/                   # Extension icons
│   ├── icon-16.png           # Toolbar icon (16×16)
│   ├── icon-48.png           # Management page icon (48×48)
│   └── icon-128.png          # Chrome Web Store icon (128×128)
├── package.json              # Dependencies and scripts
├── wxt.config.ts             # WXT framework configuration
├── tsconfig.json             # TypeScript compiler options
├── vitest.config.ts          # Test runner configuration
├── .env.example              # API key template
└── .gitignore                # Git ignore patterns
```

---

## Architecture Overview

The extension operates across three isolated execution contexts within Chrome's Manifest V3 architecture:

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  GMGN.ai Page Context (Injected Script)                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Monkey-patches window.fetch and XMLHttpRequest          │    │
│  │  Captures GMGN internal API responses                    │    │
│  │  Posts data via window.postMessage                       │    │
│  └───────────────────────┬─────────────────────────────────┘    │
│                          │ window.postMessage                    │
├──────────────────────────┼──────────────────────────────────────┤
│  Content Script (Isolated World)                                │
│  ┌───────────────────────▼─────────────────────────────────┐    │
│  │  Validates message origin (https://gmgn.ai)              │    │
│  │  Bridges to service worker via chrome.runtime            │    │
│  │  Mounts Shadow DOM container (z-index: 2147483647)       │    │
│  │  Renders Preact UI overlay (350px sidebar)               │    │
│  └───────────────────────┬─────────────────────────────────┘    │
│                          │ chrome.runtime.sendMessage            │
├──────────────────────────┼──────────────────────────────────────┤
│  Service Worker (Background)                                    │
│  ┌───────────────────────▼─────────────────────────────────┐    │
│  │  Signal scoring engine (7-factor composite)              │    │
│  │  External API clients (Birdeye, Helius, RugCheck, etc.)  │    │
│  │  WebSocket streams (PumpPortal, Birdeye)                 │    │
│  │  AI/LLM three-tier router (Groq + Claude)                │    │
│  │  Rate limiter (per-API token buckets)                    │    │
│  │  State persistence via chrome.storage                    │    │
│  │  chrome.alarms for keepalive and periodic polling        │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Interception** — The injected script captures GMGN's internal fetch/XHR responses (trending tokens, token details, wallet activity, smart money signals) and relays them to the content script
2. **Enrichment** — The service worker enriches intercepted data with external API calls (Birdeye analytics, RugCheck safety, GoPlus security, Jupiter honeypot simulation)
3. **Scoring** — The 7-factor scoring engine produces a composite 0–100 score; hard filters gate unsafe tokens
4. **AI Analysis** — Tokens passing initial screening are routed through the three-tier LLM system for deeper analysis
5. **Display** — Results flow to Zustand stores, triggering Preact re-renders in the Shadow DOM sidebar panel

### Service Worker Lifecycle

The service worker follows Manifest V3 lifecycle requirements:

- All event listeners (`chrome.runtime.onMessage`, `chrome.alarms.onAlarm`, `chrome.storage.onChanged`) are registered **synchronously** at the top level
- No `setTimeout` or `setInterval` — all periodic operations use `chrome.alarms` (30-second minimum interval)
- State persists via `chrome.storage.session` (10MB in-memory) and `chrome.storage.local` (persistent)
- WebSocket connections reset the 30-second idle timer on Chrome 116+ with 20-second keepalive pings

For detailed architecture diagrams and component descriptions, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Signal Scoring

The scoring engine evaluates each token across 7 weighted factors, producing a composite score from 0 to 100:

| Factor | Default Weight | Description |
|--------|---------------|-------------|
| **Volume Spike** | 20% | Detects 3–8× volume increase over 5-minute moving average; minimum $200/5m and $2,000/1h |
| **Smart Money Convergence** | 20% | 3+ qualified smart wallets entering same token within 2-hour window with position-size conviction |
| **Buy/Sell Ratio** | 15% | Buy/sell pressure ratio ≥1.3× for accumulation signal; ≥2.0× amplifies day-trade signals |
| **Holder Growth** | 10% | Organic wallet growth (holders retaining tokens ≥24h); penalizes bot-like patterns |
| **Liquidity** | 15% | Minimum $3K (pump.fun early) to $30K (established); volume must be 10× intended position |
| **Token Age** | 10% | ≤3h for early accumulation (highest score); ≤12h for gem scanning; >12h diminished |
| **Safety Score** | 10% | RugCheck score ≥300, GoPlus clean bill, top holder concentration ≤20%, authorities revoked |

### Trading Modes

| Mode | Minimum Score | Use Case |
|------|--------------|----------|
| **Conservative** | ≥80 | High-confidence signals only — lower frequency, higher accuracy |
| **Aggressive** | ≥45 | Moderate signals included — higher frequency, requires active monitoring |

### Hard Filters (Absolute Overrides)

The following conditions **always** result in a SKIP decision, regardless of composite score:

- Bundled launch with >10% sniper supply
- Active mint authority (tokens can be infinitely minted)
- Active freeze authority (accounts can be frozen)
- No LP lock or burn (liquidity can be pulled)
- Total liquidity <$3,000
- Top 10 holders control >50% of supply

### Exit Strategy

The default ladder take-profit strategy:

| Level | Action | Trigger |
|-------|--------|---------|
| TP1 | Sell 50% | 2× entry price |
| TP2 | Sell 25% | 5× entry price |
| TP3 | Sell 25% | 10× entry price |
| Remainder | Trailing stop | Let ride with trailing stop-loss |

**Day-trade profile**: +15% / +30% / +60% TP, -12% SL  
**Swing-trade profile**: +40% / +100% / +200% / +500% TP, -18% SL

Hard exit triggers: dev wallet selling, smart money position reduction (40–60%), volume-to-market-cap decline below 10%.

All weights, thresholds, and profiles are **user-configurable** via the Settings panel. For the full scoring methodology, see [docs/SIGNALS.md](docs/SIGNALS.md).

---

## External API Integration

The extension integrates with 9 external data sources. All API calls are made exclusively from the service worker, routed through a centralized rate limiter.

| API | Base URL | Rate Limit | Auth |
|-----|----------|------------|------|
| Birdeye | `https://public-api.birdeye.so` | 15 RPS (Starter) | `X-API-KEY` header |
| PumpPortal | `wss://pumpportal.fun/api/data` | Single WebSocket | None |
| Jupiter | `https://price.jup.ag` | 1 RPS (free) | None |
| Helius | `https://api.helius.xyz` | 10 RPS (Developer) | API key in URL |
| DexScreener | `https://api.dexscreener.com` | 5 RPS (300/min) | None |
| RugCheck | `https://api.rugcheck.xyz` | Best-effort | `X-API-KEY` header |
| GoPlus | `https://api.gopluslabs.io` | Best-effort | None |
| Groq | `https://api.groq.com` | Per-model RPM | `Authorization: Bearer` |
| Anthropic | `https://api.anthropic.com` | Per-model RPM | `x-api-key` header |

For detailed endpoint documentation, authentication setup, and response schemas, see [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md).

---

## Development

### Running Tests

```bash
# Run all tests
npm run test

# Run tests with coverage
npx vitest run --coverage --no-watch

# Run a specific test file
npx vitest run tests/unit/signals/scoring-engine.test.ts --no-watch
```

### Type Checking

```bash
npm run typecheck
```

### Project Conventions

- **Preact JSX** — All components use Preact's JSX pragma (`jsxImportSource: 'preact'`)
- **Path Aliases** — `@/*` resolves to `./src/*` (e.g., `import { config } from '@/utils/config'`)
- **Zustand Vanilla** — Service worker stores use `zustand/vanilla`; UI stores use hooks via `preact/compat`
- **Chrome APIs** — Accessed globally via `chrome.storage`, `chrome.runtime`, `chrome.alarms` (types from `@types/chrome`)
- **No Direct GMGN API Calls** — Data is obtained only by intercepting GMGN's own fetch/XHR requests

---

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork** the repository and create a feature branch
2. **Install** dependencies with `npm install`
3. **Follow** existing code style and TypeScript strict mode conventions
4. **Write tests** for new functionality using Vitest
5. **Run** the full test suite and type checker before submitting:
   ```bash
   npm run test
   npm run typecheck
   ```
6. **Submit** a pull request with a clear description of changes

### Key Development Rules

- All UI must render inside the Shadow DOM — never append elements directly to GMGN's DOM
- API keys must never appear in content scripts — service worker context only
- Use `chrome.alarms` instead of `setTimeout`/`setInterval` in the service worker
- Register all Chrome event listeners synchronously at the top level of `background.ts`
- Target Chrome 116+ minimum — do not use APIs unavailable in that version

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System architecture, data flow diagrams, and component descriptions |
| [API Integration](docs/API-INTEGRATION.md) | External API reference — endpoints, authentication, rate limits, and response schemas |
| [Signal Engine](docs/SIGNALS.md) | Signal scoring algorithm details — factor weights, thresholds, and calibration methodology |
