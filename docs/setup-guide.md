# Developer Setup Guide

GMGN.ai Memecoin Signal Bot — Chrome Extension (Manifest V3)

This guide covers everything you need to set up a local development environment, configure API keys, build the extension, and sideload it into Chrome for testing.

---

## Prerequisites

Before you begin, ensure you have the following installed:

| Requirement | Version | Verification |
|-------------|---------|-------------|
| **Node.js** | ≥ 20.19 | `node --version` |
| **npm** | ≥ 10.x | `npm --version` |
| **Chrome** | ≥ 116 | `chrome://version` |
| **Git** | Any recent | `git --version` |

> **Why Chrome 116+?** The extension relies on WebSocket activity extending service worker lifetime, a behavior introduced in Chrome 116. Older versions will not maintain persistent WebSocket connections in the Manifest V3 service worker.

---

## Quick Start

```bash
# 1. Clone the repository
git clone <repository-url>
cd gmgn-signal-bot

# 2. Install dependencies
npm install

# 3. (Optional) Configure environment variables for development
cp .env.example .env
# Edit .env with your API keys

# 4. Start development mode with hot module replacement
npm run dev

# 5. Load the extension in Chrome (see "Sideloading into Chrome" below)
```

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

This installs all production and development dependencies, then runs `wxt prepare` (via the `postinstall` script) to generate WXT's internal TypeScript types in the `.wxt/` directory.

### 3. Verify Installation

```bash
# TypeScript type-checking should pass with zero errors
npm run typecheck

# Tests should pass
npm run test
```

---

## API Key Configuration

The extension integrates with 9 external APIs. API keys can be configured in two ways:

### Option A: Environment Variables (Development)

Copy the example environment file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```env
BIRDEYE_API_KEY=your_birdeye_key_here
HELIUS_API_KEY=your_helius_key_here
RUGCHECK_API_KEY=your_rugcheck_key_here
GROQ_API_KEY=your_groq_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
```

### Option B: Settings Panel (Runtime)

After loading the extension, open the sidebar panel on any `gmgn.ai` page and navigate to the **Settings** tab. Enter your API keys in the provided fields — they are encrypted with AES-GCM via the Web Crypto API before storage in `chrome.storage.local`.

> **Security Note:** API keys are only accessible from the service worker context. Content scripts never hold or transmit API keys (per AAP §0.7.2).

### API Key Sources

| Provider | Where to Get Key | Plan | Monthly Cost |
|----------|-----------------|------|-------------|
| [Birdeye](https://birdeye.so) | Birdeye Dashboard → API Keys | Starter | $99 |
| [Helius](https://helius.dev) | Helius Dashboard → API Keys | Developer | $49 |
| [Groq](https://groq.com) | GroqCloud Console → API Keys | Free tier | Free |
| [RugCheck](https://rugcheck.xyz) | RugCheck account settings | Free | Free |
| [Anthropic](https://anthropic.com) | Anthropic Console → API Keys | Pay-per-use | Optional (~$0–5) |

The following APIs require **no API key**:

| Provider | Purpose |
|----------|---------|
| [GoPlus Security](https://gopluslabs.io) | Contract security checks (free beta) |
| [Jupiter](https://jup.ag) | Price quotes and honeypot detection (free tier, 1 RPS) |
| [DexScreener](https://dexscreener.com) | Fallback token data (free) |
| [PumpPortal](https://pumpportal.fun) | New token WebSocket events (free) |

**Estimated total monthly cost:** ~$150–250 (Birdeye $99 + Helius $49 + LLM $5–15)

---

## Development Workflow

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start WXT in development mode with hot module replacement (HMR) |
| `npm run build` | Production build to `.output/chrome-mv3/` |
| `npm run zip` | Create distributable `.zip` for Chrome Web Store submission |
| `npm run test` | Run all unit and integration tests via Vitest |
| `npm run typecheck` | TypeScript type checking via `tsc --noEmit` |

### Development Mode

```bash
npm run dev
```

This starts WXT's development server with:

- **Hot Module Replacement (HMR)** — Changes to source files are reflected immediately in the loaded extension
- **Auto-reload** — The extension reloads automatically when entrypoint files change
- **Dev output** — The development build is output to `.output/chrome-mv3-dev/`

### Production Build

```bash
npm run build
```

The production-optimized extension is output to `.output/chrome-mv3/`. This directory can be loaded as an unpacked extension or packaged for distribution.

### Create Distribution Package

```bash
npm run zip
```

Creates a `.zip` file suitable for Chrome Web Store submission.

---

## Sideloading into Chrome

Follow these steps to load the extension into Chrome for development and testing:

### Step 1: Build or Start Dev Mode

```bash
# For development (with HMR):
npm run dev

# Or for production testing:
npm run build
```

### Step 2: Open Chrome Extensions Page

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** by toggling the switch in the top-right corner

### Step 3: Load the Extension

1. Click **Load unpacked**
2. Select the appropriate output directory:
   - **Development mode:** `.output/chrome-mv3-dev/`
   - **Production build:** `.output/chrome-mv3/`
3. The extension icon will appear in the Chrome toolbar

### Step 4: Verify Installation

1. Navigate to [gmgn.ai](https://gmgn.ai) in Chrome
2. The signal bot sidebar panel should appear on the right edge of the page
3. Click the extension icon in the toolbar to see the popup with connection status

### Troubleshooting Sideloading

| Issue | Solution |
|-------|----------|
| Extension does not appear | Ensure Developer mode is enabled; check for errors on `chrome://extensions` |
| Sidebar does not render on gmgn.ai | Refresh the page; check the Chrome DevTools console for errors |
| "Manifest file is missing or unreadable" | Ensure you selected the correct output directory (`.output/chrome-mv3-dev/` or `.output/chrome-mv3/`) |
| Service worker errors | Check `chrome://extensions` → click "Inspect views: service worker" to view service worker logs |
| Content script errors | Open DevTools on the gmgn.ai page (F12) and check the Console tab |

---

## Project Structure

```
gmgn-signal-bot/
├── entrypoints/                 # Chrome Extension entry points (WXT convention)
│   ├── background.ts           # Service worker — orchestration hub
│   ├── content.ts              # Content script — Shadow DOM + message bridge
│   ├── injected.ts             # Page-context — fetch/XHR interception
│   └── popup/                  # Extension popup UI
│       ├── index.html
│       ├── App.tsx
│       └── main.tsx
├── src/
│   ├── signals/                # Signal scoring engine (7 factors + hard filters)
│   ├── api/                    # External API clients with rate limiting
│   ├── gmgn/                   # GMGN data interception (fetch/XHR monkey-patch)
│   ├── tracking/               # Smart money wallet tracking
│   ├── safety/                 # Token safety analysis
│   ├── ai/                     # AI/LLM three-tier integration
│   ├── streaming/              # WebSocket streaming (PumpPortal, Birdeye)
│   ├── store/                  # Zustand state management with chrome.storage
│   ├── components/             # Preact UI components (Shadow DOM)
│   └── utils/                  # Shared utilities (crypto, messaging, cache, etc.)
├── tests/                      # Unit and integration tests
├── docs/                       # Documentation
├── assets/                     # Extension icons
├── package.json                # Dependencies and scripts
├── wxt.config.ts               # WXT/Manifest V3 configuration
├── tsconfig.json               # TypeScript compiler options
├── vitest.config.ts            # Test runner configuration
├── .env.example                # API key template
└── .gitignore                  # Git ignore patterns
```

---

## Configuration Files

### `wxt.config.ts`

The WXT configuration defines:

- **Manifest V3 fields** — Extension name, version, permissions, host permissions
- **Preact JSX** — Via `@preact/preset-vite` plugin
- **Content script matching** — `https://gmgn.ai/*` at `document_idle`
- **Host permissions** — All external API domains
- **Minimum Chrome version** — `116` (required for WebSocket keepalive in service worker)

### `tsconfig.json`

TypeScript configuration with:

- **Strict mode** — `strict: true`
- **Preact JSX pragma** — `jsx: 'react-jsx'`, `jsxImportSource: 'preact'`
- **Path aliases** — `@/*` maps to `./src/*`

### `vitest.config.ts`

Test runner configuration with:

- **Environment** — `happy-dom` for DOM testing
- **Globals** — `true` (no explicit imports needed for `describe`, `it`, `expect`)
- **Coverage** — V8 coverage provider

---

## Running Tests

```bash
# Run all tests
npm run test

# Run tests with coverage report
npx vitest run --coverage --no-watch

# Run a specific test file
npx vitest run tests/unit/signals/scoring-engine.test.ts --no-watch

# Run tests matching a pattern
npx vitest run --no-watch -t "volume spike"
```

---

## Further Reading

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | System architecture, data flow diagrams, and component descriptions |
| [API Integration](API-INTEGRATION.md) | External API reference — endpoints, authentication, rate limits, and response schemas |
| [Signal Engine](SIGNALS.md) | Signal scoring algorithm details — factor weights, thresholds, and calibration methodology |
