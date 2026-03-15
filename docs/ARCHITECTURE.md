# System Architecture

## GMGN.ai Memecoin Signal Bot — Chrome Extension (Manifest V3)

The GMGN.ai Memecoin Signal Bot is a self-contained Chrome Extension that overlays the [GMGN.ai](https://gmgn.ai) trading platform as a fixed sidebar panel, providing automated, real-time trading signal generation for Solana memecoin trading. The extension intercepts GMGN's own internal API data, enriches it with multi-source on-chain analytics, runs a 7-factor composite scoring engine, and surfaces actionable BUY/SKIP/EXIT signals augmented by three-tier AI/LLM analysis.

**Technology Stack:**

| Layer | Technology | Version |
|-------|-----------|---------|
| Build Framework | WXT (WebExtension Toolkit) | 0.20.17 |
| UI Rendering | Preact | 10.29.0 |
| State Management | Zustand | 5.0.11 |
| Language | TypeScript (strict mode) | 5.9.3 |
| Test Framework | Vitest + happy-dom | 4.1.0 |
| Target Browser | Chrome (Manifest V3) | 116+ |

**Key Design Principles:**

- **Purely client-side** — no backend server, no databases, no cloud deployment. The extension runs entirely within the Chrome browser process model.
- **Passive data capture** — intercepts GMGN's own fetch/XHR calls instead of making direct API requests to GMGN (which are Cloudflare-protected).
- **Shadow DOM isolation** — all extension UI lives inside a Shadow DOM container, preventing style collisions with GMGN's Next.js/React stylesheets.
- **Lightweight footprint** — Preact (3KB) instead of React (40KB+); content script bundle targets < 100KB gzipped.
- **Service worker resilience** — all state persisted to `chrome.storage`; event listeners registered synchronously; `chrome.alarms` replaces `setTimeout`/`setInterval`.

---

## Three-Layer Architecture

Chrome Manifest V3 extensions operate across three distinct execution contexts, each with different capabilities and constraints. The signal bot leverages all three layers in a strict data-flow pipeline.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GMGN.ai Web Page                             │
│                                                                     │
│  ┌───────────────────────────────────┐                              │
│  │  Layer 1: Injected Script         │                              │
│  │  (entrypoints/injected.ts)        │                              │
│  │                                   │                              │
│  │  • Runs in page's JS context      │                              │
│  │  • Monkey-patches window.fetch    │                              │
│  │  • Monkey-patches XMLHttpRequest  │                              │
│  │  • Captures GMGN API responses    │                              │
│  └──────────────┬────────────────────┘                              │
│                 │ window.postMessage                                 │
│                 │ {source: 'gmgn-signal-bot', type, payload}        │
│  ┌──────────────▼────────────────────┐    ┌──────────────────────┐  │
│  │  Layer 2: Content Script          │    │  Shadow DOM Overlay  │  │
│  │  (entrypoints/content.ts)         │───>│  (Preact <App />)    │  │
│  │                                   │    │  Fixed sidebar panel │  │
│  │  • Chrome isolated world          │    │  350px × 100vh       │  │
│  │  • DOM access + chrome.runtime    │    │  z-index: 2^31 - 1   │  │
│  │  • Message bridge (page↔worker)   │    └──────────────────────┘  │
│  │  • MutationObserver (250ms)       │                              │
│  └──────────────┬────────────────────┘                              │
└─────────────────│───────────────────────────────────────────────────┘
                  │ chrome.runtime.sendMessage
                  │ chrome.tabs.sendMessage (reverse)
┌─────────────────▼───────────────────────────────────────────────────┐
│  Layer 3: Service Worker (Background)                               │
│  (entrypoints/background.ts)                                        │
│                                                                     │
│  • No DOM access; terminates after ~30s idle                        │
│  • Signal scoring engine orchestration                              │
│  • External API calls (Birdeye, RugCheck, GoPlus, Jupiter, etc.)   │
│  • WebSocket streaming (PumpPortal, Birdeye)                        │
│  • AI/LLM three-tier analysis routing (Groq, Claude)               │
│  • Smart money tracking & convergence detection                     │
│  • State persistence via chrome.storage                             │
│  • chrome.alarms for periodic operations                            │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer 1: Injected Script (Page Context)

| Property | Detail |
|----------|--------|
| **File** | `entrypoints/injected.ts` |
| **Execution Context** | GMGN.ai page's own JavaScript context (same origin, same `window` object) |
| **Chrome APIs** | None — cannot access `chrome.runtime`, `chrome.storage`, or any extension APIs |

**Purpose:** Monkey-patches `window.fetch` and `XMLHttpRequest.prototype.open/send` to intercept GMGN's internal API responses as they are received by the GMGN frontend. Intercepted data is matched against known GMGN API URL patterns (defined in `src/gmgn/url-patterns.ts`) and forwarded to the content script.

**Communication (outbound only):**

```javascript
window.postMessage({
  source: 'gmgn-signal-bot',
  type: 'GMGN_API_RESPONSE',
  payload: { url, data, patternType }
}, '*');
```

**Constraints:**

- Must preserve original `fetch()` and `XMLHttpRequest` behavior transparently — GMGN's frontend must continue to function normally.
- Never attempts to directly call GMGN's API endpoints. All data is passively captured from the frontend's own requests. This is mandated by **AAP Rule 0.7.2**: GMGN's endpoints are Cloudflare-protected and direct calls from the extension will be blocked.

### Layer 2: Content Script (Isolated World)

| Property | Detail |
|----------|--------|
| **File** | `entrypoints/content.ts` |
| **Execution Context** | Chrome's isolated world — full DOM access but separate JavaScript context from the page |
| **Chrome APIs** | `chrome.runtime.sendMessage`, `chrome.runtime.onMessage`, `chrome.storage` (read) |

**Responsibilities:**

1. **Script injection** — Injects `injected.ts` into the GMGN page via a dynamically created `<script>` element, enabling the page-context interception.
2. **Shadow DOM creation** — Creates a host element `<div id="gmgn-signal-bot">` and attaches a Shadow DOM root for the extension's UI overlay.
3. **Preact mounting** — Renders the `<App />` component tree inside the Shadow DOM, providing the signal panel sidebar.
4. **Message bridging** — Listens for `window.postMessage` events from the injected script, validates origin (`event.origin === 'https://gmgn.ai'`), and forwards data to the service worker via `chrome.runtime.sendMessage`.
5. **DOM observation** — Sets up a `MutationObserver` on GMGN's token list container (narrowest subtree) with a 250ms debounce callback to detect new token cards appearing on the page.

**Shadow DOM Container Styling:**

```css
#gmgn-signal-bot {
  position: fixed;
  right: 0;
  top: 0;
  width: 350px;
  height: 100vh;
  z-index: 2147483647; /* Maximum 32-bit integer — always on top */
}
```

The `z-index: 2147483647` value ensures the overlay renders above all GMGN UI elements, per **AAP Rule 0.7.5**.

### Layer 3: Service Worker (Background)

| Property | Detail |
|----------|--------|
| **File** | `entrypoints/background.ts` |
| **Execution Context** | Manifest V3 service worker — no DOM, terminates after ~30 seconds of inactivity |
| **Chrome APIs** | Full access — `chrome.runtime`, `chrome.storage`, `chrome.alarms`, `chrome.tabs`, `chrome.offscreen` |

**Responsibilities:**

1. **Signal scoring engine** — Orchestrates the 7-factor composite scoring pipeline (`src/signals/scoring-engine.ts`)
2. **External API integration** — Makes all outbound HTTP requests to Birdeye, RugCheck, GoPlus, Jupiter, Helius, DexScreener, Groq, and Anthropic via `host_permissions`
3. **WebSocket streaming** — Maintains persistent connections to PumpPortal and Birdeye for real-time data
4. **Smart money tracking** — Tracks wallet activity and detects convergence events
5. **AI/LLM routing** — Dispatches token analysis to the three-tier Groq/Claude router
6. **State persistence** — Reads/writes Zustand stores to `chrome.storage.local` and `chrome.storage.session`

**Lifecycle Rules (AAP Rule 0.7.1):**

- **Synchronous listener registration** — All `chrome.runtime.onMessage.addListener`, `chrome.alarms.onAlarm.addListener`, and `chrome.storage.onChanged.addListener` calls MUST be registered at the top level of the service worker file, never inside `async` callbacks, conditionals, or `setTimeout`. Chrome requires synchronous registration to correctly wake the service worker for events.
- **No `setTimeout`/`setInterval`** — These are unreliable in a Manifest V3 service worker because the worker can terminate at any time. Use `chrome.alarms` with a minimum 30-second interval for all periodic operations.
- **State survival** — Global variables are lost when the service worker terminates. All runtime state must be persisted to `chrome.storage.session` (10MB in-memory, cleared on browser restart) or `chrome.storage.local` (persistent across restarts).
- **WebSocket keepalive** — Since Chrome 116+, WebSocket message activity (sending or receiving) resets the 30-second idle timer, keeping the service worker alive. A 20-second keepalive ping ensures the timer never expires during active streaming.

---

## Message Bus Architecture

All inter-layer communication follows a strict, typed message protocol. Messages flow upward from the page context to the service worker for processing, and downward from the service worker to the content script for UI updates.

### Message Flow Diagram

```
Injected Script              Content Script               Service Worker
(page context)              (isolated world)              (background)
      │                           │                            │
      │                           │                            │
      │──window.postMessage──────>│                            │
      │  {                        │                            │
      │    source: 'gmgn-signal-  │                            │
      │            bot',          │                            │
      │    type: 'GMGN_API_       │                            │
      │           RESPONSE',      │                            │
      │    payload: {...}         │                            │
      │  }                        │                            │
      │                           │──chrome.runtime           │
      │                           │  .sendMessage()──────────>│
      │                           │  {type: 'TOKEN_DATA',     │
      │                           │   payload: {...}}         │
      │                           │                            │
      │                           │                            │── Process:
      │                           │                            │   • Score token
      │                           │                            │   • Safety check
      │                           │                            │   • AI analysis
      │                           │                            │
      │                           │<──chrome.tabs             │
      │                           │   .sendMessage()──────────│
      │                           │   {type: 'SIGNAL_UPDATE', │
      │                           │    payload: {...}}        │
      │                           │                            │
      │                           │── Update Zustand stores    │
      │                           │── Preact re-renders        │
      │                           │   in Shadow DOM            │
      │                           │                            │
      │                           │                            │── Persist to
      │                           │                            │   chrome.storage
```

### Message Types

All messages use a discriminated union pattern defined in `src/utils/messaging.ts` for type-safe handling:

| Message Type | Direction | Payload | Purpose |
|-------------|-----------|---------|---------|
| `TokenDataMessage` | Content → Service Worker | Intercepted GMGN token data (trending, detail, wallet activity) | Forward captured GMGN API responses for processing |
| `SignalUpdateMessage` | Service Worker → Content | Composite signal with score, factors, decision | Push new/updated signal results to the UI |
| `SafetyCheckResultMessage` | Service Worker → Content | Safety report (RugCheck + GoPlus + honeypot) | Push safety analysis results for token cards |
| `AIAnalysisResultMessage` | Service Worker → Content | AI narrative, dimension scores, confidence level | Push LLM analysis results for display |
| `ExitSignalMessage` | Service Worker → Content | Exit trigger type, affected position, action | Alert user to triggered exit conditions |
| `SettingsChangeMessage` | Content → Service Worker | Updated settings (mode, weights, API keys) | Propagate user configuration changes |

### Security Validation

Every message boundary enforces origin and sender validation:

- **Content script** validates `event.origin === 'https://gmgn.ai'` on all `window.postMessage` events from the injected script — prevents malicious pages from injecting fake data.
- **Service worker** validates `sender.id === chrome.runtime.id` on all `chrome.runtime.onMessage` events — ensures messages originate from the extension's own content script, not from other extensions or injected code.

---

## Signal Pipeline

The signal scoring engine is the analytical core of the extension. It consumes token data from multiple sources, applies safety gates, scores across 7 weighted factors, and optionally routes high-scoring tokens through AI analysis.

### End-to-End Data Flow

```
Data Sources                    Signal Engine                    Output
──────────────                  ─────────────                    ──────

┌──────────────────┐
│ GMGN Intercepted │──┐
│ Data             │  │     ┌─────────────────────────┐
└──────────────────┘  │     │                         │
                      ├────>│   Hard Filter Gates     │     ┌────────────┐
┌──────────────────┐  │     │   (binary pass/fail)    │──X──│   SKIP     │
│ PumpPortal WS    │──┤     │                         │     │  (unsafe)  │
│ (new tokens)     │  │     │   • Bundled launch      │     └────────────┘
└──────────────────┘  │     │     >10% sniper supply  │
                      │     │   • Active mint auth    │
┌──────────────────┐  │     │   • Active freeze auth  │
│ Birdeye API      │──┘     │   • No LP lock/burn     │
│ (enrichment)     │        │   • Liquidity <$3K      │
└──────────────────┘        │   • Top 10 holders >50% │
                            └────────────┬────────────┘
                                         │ Pass
                            ┌────────────▼────────────┐
                            │  7-Factor Scoring        │
                            │  (parallel execution)    │
                            │                          │
                            │  ┌─ Volume Spike (20%)   │
                            │  ├─ Smart Money (20%)    │
                            │  ├─ Buy/Sell Ratio (15%) │
                            │  ├─ Holder Growth (10%)  │
                            │  ├─ Liquidity (15%)      │
                            │  ├─ Token Age (10%)      │
                            │  └─ Safety Score (10%)   │
                            └────────────┬────────────┘
                                         │
                            ┌────────────▼────────────┐
                            │  Composite Score         │
                            │  (weighted sum: 0–100)   │
                            └────────────┬────────────┘
                                         │
                       ┌─────────────────┼─────────────────┐
                       │                 │                  │
                  Score ≥ 80        45 ≤ Score < 80   Score < 45
                  (conservative)    (aggressive)      (below threshold)
                       │                 │                  │
              ┌────────▼─────────┐  ┌───▼──────┐   ┌──────▼──────┐
              │ AI/LLM Tier 3   │  │ AI/LLM   │   │    SKIP     │
              │ Claude Sonnet   │  │ Tier 1-2  │   │ (low score) │
              │ (narrative)     │  │ Groq LLMs │   └─────────────┘
              └────────┬────────┘  └───┬───────┘
                       │               │
              ┌────────▼───────────────▼──────┐
              │  Signal Store (Zustand)        │
              │  ──────────────────────────    │
              │  • Composite score + factors   │
              │  • AI narrative + confidence   │
              │  • BUY / SKIP / EXIT decision  │
              └────────────────┬───────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Preact UI Update    │
                    │  (Shadow DOM)        │
                    │  TokenCard, Gauges,  │
                    │  SafetyBadge, etc.   │
                    └─────────────────────┘
```

### Hard Filters (Binary Pass/Fail)

Hard filters are absolute safety gates that cannot be overridden by high scores in other factors (**AAP Rule 0.7.3**). If any single hard filter fails, the token is immediately classified as **SKIP**:

| Hard Filter | Condition | Rationale |
|-------------|-----------|-----------|
| Bundled Launch | >10% of supply acquired by snipers in first block | Indicates coordinated insider accumulation |
| Mint Authority | Mint authority not revoked | Token supply can be inflated at any time |
| Freeze Authority | Freeze authority not revoked | Holder accounts can be frozen (Token-2022 risk) |
| LP Lock/Burn | No LP tokens burned or locked | Developer can pull liquidity (rug pull) |
| Minimum Liquidity | Liquidity < $3,000 | Insufficient liquidity for safe exits |
| Holder Concentration | Top 10 holders own > 50% of supply | Extreme centralization risk |

**Implementation:** `src/signals/hard-filters.ts`

### 7-Factor Scoring Modules

Each factor is an independent module producing a sub-score (0–100) that is multiplied by its configurable weight. All 7 factors execute in parallel via `Promise.allSettled` for maximum throughput.

| Factor | File | Default Weight | Scoring Logic |
|--------|------|---------------|--------------|
| Volume Spike | `src/signals/factors/volume-spike.ts` | 20% | Compares current 5-min volume against 5-min MA; 3–8× spike = high score; minimum $200/5m and $2,000/1h |
| Smart Money Convergence | `src/signals/factors/smart-money-convergence.ts` | 20% | 3+ qualified wallets entering same token within 2h window; position size ≥80% of historical average = conviction |
| Buy/Sell Ratio | `src/signals/factors/buy-sell-ratio.ts` | 15% | Buy/sell transaction ratio from GMGN data; ≥1.3× = accumulation; ≥2.0× with volume spike = amplified |
| Holder Growth | `src/signals/factors/holder-growth.ts` | 10% | Organic wallet growth (holders retaining ≥24h); penalizes bot-like patterns (identical amounts, rapid creation) |
| Liquidity | `src/signals/factors/liquidity.ts` | 15% | Minimum $3K (pump.fun) to $30K (established); volume must be 10× intended position size; LP burn/lock status |
| Token Age | `src/signals/factors/token-age.ts` | 10% | ≤3h = early accumulation (highest); ≤12h = gem scanning; >12h = diminished |
| Safety Score | `src/signals/factors/safety-score.ts` | 10% | RugCheck score ≥300 + GoPlus clean bill; penalizes active authorities, high concentration (>20%), mutable metadata |

**Scoring Thresholds:**

- **≥ 80 composite score** — High-confidence signal (conservative trading mode)
- **≥ 45 composite score** — Moderate signal (aggressive trading mode)
- **< 45** — Below threshold, classified as SKIP

Factor weights are user-configurable via the Settings panel. The scoring engine reads weights from the Zustand `settings-store` at analysis time, per **AAP Rule 0.7.3**.

**Implementation:** `src/signals/scoring-engine.ts`, `src/signals/factors/`

### Exit Signal Monitoring

Active positions are continuously monitored by `src/signals/exit-signals.ts` for exit triggers:

**Ladder Take-Profit Strategy (default):**

| Exit Level | Action | Trigger |
|-----------|--------|---------|
| TP1 | Sell 50% | Price reaches 2× entry |
| TP2 | Sell 25% | Price reaches 5× entry |
| TP3 | Sell 25% | Price reaches 10× entry |
| Trailing Stop | Sell remainder | Trailing stop triggered |

**Hard Exit Triggers:**

- Developer wallet sells any portion of holdings
- Smart money wallets reduce position by 40–60%
- Volume-to-market-cap ratio drops below 10%
- Price hits stop-loss threshold (default: -12% day-trade, -18% swing)

---

## Module Architecture

The source code is organized into 10 independent modules under `src/`, each with a single responsibility and clearly defined dependencies.

### Module Dependency Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                    entrypoints/background.ts                     │
│                   (Service Worker Orchestrator)                   │
└──────┬──────────┬──────────┬──────────┬──────────┬──────────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│ signals/ ││   ai/    ││streaming/││ tracking/││  safety/ │
│          ││          ││          ││          ││          │
│ scoring  ││ router   ││ manager  ││ wallet   ││ checker  │
│ engine   ││ prompts  ││ pump-    ││ tracker  ││ honeypot │
│ factors  ││ parser   ││ portal   ││ conver-  ││ lp-      │
│ hard-    ││          ││ birdeye  ││ gence    ││ analyzer │
│ filters  ││          ││          ││ class-   ││          │
│ exit     ││          ││          ││ ifier    ││          │
└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘
     │           │           │           │           │
     └─────┬─────┘───────────┘───────────┘───────────┘
           │
           ▼
    ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
    │    api/      │     │   store/     │     │   utils/     │
    │              │     │              │     │              │
    │ base-client  │     │ signal-store │     │ crypto       │
    │ rate-limiter │     │ token-store  │     │ messaging    │
    │ birdeye      │     │ settings     │     │ cache        │
    │ pump-portal  │     │ position     │     │ logger       │
    │ jupiter      │     │ adapter      │     │ config       │
    │ helius       │     │ index        │     │ formatting   │
    │ dexscreener  │     │              │     │              │
    │ rugcheck     │     └──────────────┘     └──────────────┘
    │ goplus       │
    │ groq         │
    └──────────────┘
```

### Module Details

| Module | Path | Dependencies | Purpose |
|--------|------|-------------|---------|
| **Signal Engine** | `src/signals/` | `src/api/`, `src/safety/`, `src/tracking/`, `src/ai/`, `src/store/` | 7-factor composite scoring, hard filter gates, exit signal monitoring |
| **API Clients** | `src/api/` | `src/utils/cache.ts`, `src/utils/crypto.ts`, `src/utils/config.ts` | External API integration with token bucket rate limiting, retry, and caching |
| **GMGN Interception** | `src/gmgn/` | None (standalone page-context module) | Fetch/XHR monkey-patching, URL pattern matching, response parsing |
| **Smart Money Tracking** | `src/tracking/` | `src/api/helius.ts`, `src/gmgn/parsers.ts`, `src/store/` | Wallet activity monitoring, time-windowed convergence detection, wallet classification |
| **Token Safety** | `src/safety/` | `src/api/rugcheck.ts`, `src/api/goplus.ts`, `src/api/jupiter.ts` | Concurrent multi-source safety analysis, honeypot detection, LP lock verification |
| **AI/LLM Integration** | `src/ai/` | `src/api/groq.ts`, `src/utils/cache.ts` | Three-tier LLM routing (Groq 8B → Groq 70B → Claude), structured prompt templates |
| **WebSocket Streaming** | `src/streaming/` | `src/api/pump-portal.ts`, `src/api/birdeye.ts` | Real-time WebSocket connections with keepalive, reconnection, and graceful degradation |
| **State Management** | `src/store/` | Chrome `storage` API | Zustand stores (vanilla + hooks) with chrome.storage persistence middleware |
| **UI Components** | `src/components/` | `src/store/`, `preact`, `preact/hooks` | Preact sidebar overlay rendered in Shadow DOM — signal cards, gauges, settings |
| **Utilities** | `src/utils/` | Chrome APIs, Web Crypto API | AES-GCM encryption, typed messaging, TTL cache, structured logging, constants, formatters |

### External API Integration Map

Each external API client routes through the centralized rate limiter (`src/api/rate-limiter.ts`):

| API Provider | Client File | Rate Limit | Auth Method | Consuming Modules | Cost |
|-------------|-------------|-----------|-------------|-------------------|------|
| Birdeye | `birdeye.ts` | 15 RPS (Starter) | `X-API-KEY` header | `scoring-engine`, `token-store` | $99/mo |
| PumpPortal | `pump-portal.ts` | Single WS connection | None (free) | `scoring-engine`, `token-store` | Free |
| Jupiter | `jupiter.ts` | 1 RPS (free tier) | None (free) | `honeypot-detector` | Free |
| Helius | `helius.ts` | 10 RPS (Developer) | API key in URL | `wallet-tracker`, `convergence-detector` | $49/mo |
| DexScreener | `dexscreener.ts` | 5 RPS (300/min) | None (free) | `token-store` (fallback only) | Free |
| RugCheck | `rugcheck.ts` | Best-effort | `X-API-KEY` header | `safety/checker.ts` | Free |
| GoPlus Security | `goplus.ts` | Best-effort | None (free) | `safety/checker.ts` | Free |
| Groq | `groq.ts` | Per-model RPM | `Authorization: Bearer` | `ai/router.ts` | ~$5–15/mo |
| Anthropic (Claude) | `groq.ts` | Per-model RPM | `x-api-key` header | `ai/router.ts` (top 5% only) | Pay-per-use |

**Target monthly API cost: ≤ $250** (Birdeye $99 + Helius $49 + LLM $5–15 ≈ $148–163/mo)

DexScreener is used as a fallback only — it is not queried when Birdeye data is available (**AAP Rule 0.7.4**).

---

## State Management

State management bridges the gap between the service worker (where analysis runs) and the content script (where the UI renders). Zustand provides a unified store API across both contexts.

### Dual-Context Store Pattern

```
Service Worker Context                Content Script / UI Context
──────────────────────                ────────────────────────────

  zustand/vanilla                       zustand (via preact/compat)
  createStore()                         useStore() hooks
       │                                       │
       │── Write state ──>  chrome.storage  <── Read state ──│
       │                    .local / .sync                    │
       │                         │                            │
       │                  chrome.storage                      │
       │                  .onChanged ──────────> Re-render    │
       │                                        Preact UI    │
```

- **Service Worker** — Creates stores using `zustand/vanilla` (`createStore()`) which has no React/Preact dependency. The service worker is the primary state producer.
- **Content Script UI** — Creates Preact-compatible Zustand hooks using `preact/compat` (which provides `useSyncExternalStore`). The UI is the primary state consumer.
- **Synchronization** — The `chrome-storage-adapter.ts` middleware serializes Zustand state to `chrome.storage.local` (or `.sync` for settings). The content script listens for `chrome.storage.onChanged` events, updates its local stores, and triggers Preact re-renders.

### Store Inventory

| Store | File | Producer(s) | Consumer(s) | Persistence | Description |
|-------|------|------------|-------------|-------------|-------------|
| **Signal Store** | `src/store/signal-store.ts` | `scoring-engine.ts`, `exit-signals.ts` | `SignalPanel.tsx`, `TokenCard.tsx`, `ScoreGauge.tsx` | `chrome.storage.local` | Active signals (Map of mint → CompositeSignal), signal history, top-N retrieval |
| **Token Store** | `src/store/token-store.ts` | `gmgn/parsers.ts`, `birdeye.ts`, `pump-portal-stream.ts` | `TokenCard.tsx`, `SafetyBadge.tsx`, `NewTokenFeed.tsx` | `chrome.storage.local` | Token metadata, price, safety report, smart money activity per token |
| **Settings Store** | `src/store/settings-store.ts` | `SettingsPanel.tsx` (user input) | `scoring-engine.ts`, `ai/router.ts` | `chrome.storage.sync` | Trading mode, scoring weights, TP/SL profiles, encrypted API keys, notification prefs |
| **Position Store** | `src/store/position-store.ts` | `scoring-engine.ts` (entry), `exit-signals.ts` (exit) | `ExitStrategy.tsx`, `SignalPanel.tsx` | `chrome.storage.local` | Active positions — entry price/time, TP/SL levels, partial exit history |

### Persistence Adapter

`src/store/chrome-storage-adapter.ts` — Zustand middleware that:

1. Serializes store state to JSON on every state change
2. Writes serialized state to `chrome.storage.local` (or `.sync` for cross-device settings)
3. Deserializes persisted state on service worker startup (cold boot recovery)
4. Listens to `chrome.storage.onChanged` for cross-context synchronization (service worker writes → content script reads → Preact re-renders)

---

## UI Architecture

The overlay UI renders as a fixed sidebar panel on the right edge of the GMGN.ai page, inside a Shadow DOM container for complete style isolation from GMGN's CSS.

### Technology Choices

- **Preact 10.29.0** (3KB) — NOT React. Preact provides the same modern API (hooks, functional components) at a fraction of React's bundle size. This is mandated by **AAP Rule 0.7.5**.
- **Shadow DOM** — All extension DOM elements live inside a `ShadowRoot`, preventing GMGN's Next.js/React stylesheets from affecting extension styles and vice versa.
- **Zustand hooks** — State reads use Zustand hooks via `preact/compat` aliasing, enabling reactive re-renders on store changes.

### Shadow DOM Container

The content script creates the overlay container:

```html
<div id="gmgn-signal-bot"
     style="position: fixed; right: 0; top: 0;
            width: 350px; height: 100vh;
            z-index: 2147483647;">
  #shadow-root (open)
    <style>/* src/components/styles.css — dark theme */</style>
    <App />  <!-- Preact component tree -->
</div>
```

### Component Tree

```
App.tsx
│   Root component — error boundary, global panel visibility toggle
│
├── SignalPanel.tsx
│   │   Main signal list — active signals sorted by composite score (descending)
│   │   Filter controls: minimum score, trading mode, token age
│   │   Auto-scrolls to new high-confidence signals
│   │
│   ├── TokenCard.tsx
│   │   │   Individual token signal card — compact, scannable format
│   │   │
│   │   ├── ScoreGauge.tsx
│   │   │       Circular gauge: 0–100, color gradient (red → yellow → green)
│   │   │       Hover/tap shows factor-by-factor breakdown
│   │   │
│   │   ├── SafetyBadge.tsx
│   │   │       Color-coded: green (≥300, authorities revoked),
│   │   │       yellow (partial concerns), red (critical risks)
│   │   │       Tooltip: RugCheck + GoPlus detail breakdown
│   │   │
│   │   ├── SmartMoneyIndicator.tsx
│   │   │       Wallet count entering token, convergence status,
│   │   │       average position size context
│   │   │
│   │   └── AIInsight.tsx
│   │           LLM narrative with confidence badge (high/medium/low)
│   │           5 dimension scores as compact bar chart
│   │           Indicates which LLM tier produced the analysis
│   │
│   └── ...additional TokenCard instances
│
├── NewTokenFeed.tsx
│       Real-time feed from PumpPortal WebSocket
│       Shows: token name, creation time, initial safety screening,
│       bonding curve progress percentage
│
├── ExitStrategy.tsx
│       Active TP/SL ladder for tracked positions
│       Current price position relative to entry and targets
│       Highlighted triggered alerts
│
└── SettingsPanel.tsx
        API key input fields (stored encrypted via AES-GCM)
        Trading mode toggle (conservative / aggressive)
        Scoring weight sliders (7 factors)
        TP/SL profile editor (day-trade / swing-trade)
        Notification preferences
```

### Styles

`src/components/styles.css` — Shadow DOM scoped stylesheet:

- All styles scoped within the Shadow Root (no leakage to/from GMGN)
- Dark theme matching GMGN's trading interface aesthetics (dark backgrounds, high-contrast text)
- CSS custom properties for theming consistency
- Responsive within the 350px sidebar width

### Performance Constraints

- **Bundle size** — Content script + Preact + components should be < 100KB gzipped (**AAP Rule 0.7.5**)
- **MutationObserver** — Targets the narrowest possible subtree of GMGN's DOM; debounces at 250ms minimum; disconnects when the panel is collapsed to eliminate unnecessary processing
- **Selective re-rendering** — Zustand selectors ensure components only re-render when their specific state slice changes, not on every store update

---

## WebSocket Streaming Architecture

Real-time data is streamed into the signal pipeline via persistent WebSocket connections maintained in the service worker.

### Active Connections

| Connection | Endpoint | Auth | Subscriptions |
|-----------|----------|------|---------------|
| **PumpPortal** | `wss://pumpportal.fun/api/data` | None (free) | `subscribeNewToken`, `subscribeTokenTrade`, `subscribeMigration` |
| **Birdeye** | Birdeye WebSocket endpoint | `X-API-KEY` | `SUBSCRIBE_PRICE`, `SUBSCRIBE_TXS`, `SUBSCRIBE_TOKEN_NEW_LISTING` |

**PumpPortal Rules (AAP Rule 0.7.6):**

- Exactly **one WebSocket connection** — multiple subscriptions are multiplexed on a single connection per PumpPortal's documented guidelines.
- Subscription payloads: `{ method: 'subscribeNewToken' }`, `{ method: 'subscribeTokenTrade', keys: [mint] }`, `{ method: 'subscribeMigration' }`

### Connection Manager

`src/streaming/manager.ts` manages the full WebSocket lifecycle:

```
Connection State Machine:

  ┌──────────┐    connect()    ┌────────────┐     open      ┌──────┐
  │  CLOSED  │───────────────>│ CONNECTING  │─────────────>│ OPEN │
  └──────────┘                └────────────┘               └──┬───┘
       ▲                           ▲                          │
       │         max retries       │        error/close       │
       │         exceeded          │                          │
       │                    ┌──────┴───────┐                  │
       └────────────────────│ RECONNECTING │<─────────────────┘
                            │  (backoff)   │
                            └──────────────┘
```

**Keepalive:** 20-second ping interval on all connections. This serves two purposes:
1. Detects dead connections (no pong response = connection lost)
2. Resets the Chrome 116+ service worker idle timer (WebSocket activity = worker stays alive)

**Reconnection:** Exponential backoff — 1s → 2s → 4s → 8s → 16s — maximum 5 retry attempts per reconnection cycle.

**Graceful Degradation (AAP Rule 0.7.6):** If WebSocket connections fail persistently after exhausting all retries, the system falls back to `chrome.alarms`-based polling at 30–60 second intervals. The extension remains fully functional with slightly higher latency.

### Data Flow from Streams

```
PumpPortal WS ──> pump-portal-stream.ts ──> background.ts ──> scoring-engine.ts
                                                           ──> token-store
                                                           ──> NewTokenFeed.tsx

Birdeye WS    ──> birdeye-stream.ts     ──> background.ts ──> token-store (prices)
                                                           ──> volume-spike factor
                                                           ──> smart-money factor
```

---

## Security

### API Key Encryption

All external API keys (Birdeye, Helius, RugCheck, Groq, Anthropic) are encrypted at rest using AES-GCM via the Web Crypto API (**AAP Rule 0.7.2**):

```
User enters API key          Service Worker
in SettingsPanel.tsx  ──────> encrypts with AES-GCM
                              (src/utils/crypto.ts)
                                     │
                                     ▼
                              chrome.storage.local
                              {
                                "encrypted_keys": {
                                  "birdeye": "<iv>:<ciphertext>",
                                  "helius": "<iv>:<ciphertext>",
                                  ...
                                }
                              }
                                     │
                              On API call:
                              decrypt key ──> attach to request header
                              key never leaves service worker context
```

**Key security rules:**

- A unique AES-256 encryption key is generated per-installation using `crypto.subtle.generateKey()` and stored separately in `chrome.storage.local`.
- API keys are encrypted before storage and decrypted only in the service worker context immediately before use.
- Content scripts **never** hold or transmit API keys — all API calls are made from the service worker.
- The injected page-context script has zero access to any stored credentials.

### Message Origin Validation

| Boundary | Validation | Implementation |
|----------|-----------|----------------|
| Page → Content Script | `event.origin === 'https://gmgn.ai'` | Rejects `window.postMessage` events from non-GMGN origins |
| Content Script → Service Worker | `sender.id === chrome.runtime.id` | Ensures only the extension's own scripts send messages |

### Extension Permissions

The manifest (auto-generated by WXT from `wxt.config.ts`) requests the minimum required permissions:

| Permission | Type | Purpose |
|-----------|------|---------|
| `storage` | Permission | Access to `chrome.storage.local`, `chrome.storage.sync`, `chrome.storage.session` |
| `alarms` | Permission | Periodic operations replacing `setTimeout`/`setInterval` |
| `offscreen` | Permission | Offscreen document support for background processing |
| `activeTab` | Permission | Tab-specific messaging for `chrome.tabs.sendMessage` |
| `https://gmgn.ai/*` | Host Permission | Content script injection target |
| `https://public-api.birdeye.so/*` | Host Permission | Birdeye API access |
| `https://price.jup.ag/*` | Host Permission | Jupiter Price API access |
| `https://quote-api.jup.ag/*` | Host Permission | Jupiter swap quote API — honeypot detection via sell simulation |
| `https://api.helius.xyz/*` | Host Permission | Helius API access |
| `https://api.dexscreener.com/*` | Host Permission | DexScreener API access |
| `https://api.rugcheck.xyz/*` | Host Permission | RugCheck API access |
| `https://api.gopluslabs.io/*` | Host Permission | GoPlus Security API access |
| `https://api.groq.com/*` | Host Permission | Groq LLM API access |
| `https://api.anthropic.com/*` | Host Permission | Anthropic Claude API access |
| `wss://pumpportal.fun/*` | Host Permission | PumpPortal WebSocket access |

---

## Build System

### Build Framework

**WXT 0.20.17** (WebExtension Toolkit) manages the entire build pipeline. WXT internally manages its own Vite version — no direct Vite dependency is required.

### Configuration Files

| File | Purpose |
|------|---------|
| `wxt.config.ts` | WXT framework configuration — Manifest V3 fields, Preact JSX via `@preact/preset-vite`, path aliases, host permissions, content script matching |
| `tsconfig.json` | TypeScript strict mode, `jsx: 'react-jsx'`, `jsxImportSource: 'preact'`, path aliases (`@/*` → `./src/*`) |
| `vitest.config.ts` | Vitest test runner — `environment: 'happy-dom'`, `globals: true`, V8 coverage provider |
| `.env.example` | API key template — `BIRDEYE_API_KEY`, `HELIUS_API_KEY`, `RUGCHECK_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY` |

### Build Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Development build with HMR → `.output/chrome-mv3-dev/` |
| `npm run build` | Production build (optimized) → `.output/chrome-mv3/` |
| `npm run zip` | Package production build into `.zip` for distribution |
| `npm run test` | Run Vitest test suite |
| `npm run typecheck` | TypeScript type-checking (`tsc --noEmit`) |

### Build Output

```
.output/
├── chrome-mv3/          # Production build (sideload or distribute)
│   ├── manifest.json    # Auto-generated by WXT from wxt.config.ts
│   ├── background.js    # Service worker bundle
│   ├── content-scripts/
│   │   └── content.js   # Content script bundle
│   ├── injected.js      # Page-context script
│   ├── popup.html        # Popup page
│   └── icons/           # Extension icons
└── chrome-mv3-dev/      # Development build (with HMR support)
```

### Testing

- **Unit tests** — Vitest 4.1.0 with `happy-dom` environment for DOM testing
- **Component tests** — `@testing-library/preact` for Preact component rendering and interaction
- **Test location** — `tests/unit/`, `tests/integration/`, `tests/components/`
- **Chrome API mocks** — `@types/chrome` provides type definitions; tests mock `chrome.storage`, `chrome.runtime`, `chrome.alarms` as needed

---

## Directory Structure

```
gmgn-signal-bot/
├── entrypoints/                    # Chrome Extension entry points (WXT convention)
│   ├── background.ts              # Service worker — orchestration hub
│   ├── content.ts                 # Content script — Shadow DOM + message bridge
│   ├── injected.ts                # Page-context — fetch/XHR interception
│   └── popup/                     # Extension popup UI
│       ├── index.html             # Popup HTML shell
│       ├── App.tsx                # Popup Preact component
│       └── main.tsx               # Popup render bootstrap
│
├── src/                           # Shared application logic
│   ├── signals/                   # Signal scoring engine
│   │   ├── scoring-engine.ts      # Composite 7-factor orchestrator
│   │   ├── factors/               # Independent factor modules
│   │   │   ├── volume-spike.ts    # 3–8× volume detection
│   │   │   ├── smart-money-convergence.ts  # Multi-wallet convergence
│   │   │   ├── buy-sell-ratio.ts  # Accumulation pressure
│   │   │   ├── holder-growth.ts   # Organic growth tracking
│   │   │   ├── liquidity.ts       # Liquidity validation
│   │   │   ├── token-age.ts       # Age-based filtering
│   │   │   └── safety-score.ts    # RugCheck + GoPlus aggregation
│   │   ├── hard-filters.ts        # Binary pass/fail safety gates
│   │   ├── exit-signals.ts        # TP/SL ladder + exit triggers
│   │   └── types.ts               # Signal type definitions
│   │
│   ├── api/                       # External API clients
│   │   ├── base-client.ts         # Abstract HTTP client (retry, backoff, cache)
│   │   ├── rate-limiter.ts        # Token bucket per-API rate limiter
│   │   ├── birdeye.ts             # Birdeye token analytics
│   │   ├── pump-portal.ts         # PumpPortal WebSocket client
│   │   ├── jupiter.ts             # Jupiter price + swap simulation
│   │   ├── helius.ts              # Helius enhanced transactions
│   │   ├── dexscreener.ts         # DexScreener fallback data
│   │   ├── rugcheck.ts            # RugCheck safety reports
│   │   ├── goplus.ts              # GoPlus security checks
│   │   ├── groq.ts                # Groq LLM inference
│   │   └── types.ts               # Shared API response types
│   │
│   ├── gmgn/                      # GMGN data interception
│   │   ├── interceptor.ts         # Fetch/XHR monkey-patch core
│   │   ├── url-patterns.ts        # GMGN API URL pattern registry
│   │   ├── parsers.ts             # Response-to-model transformers
│   │   └── types.ts               # GMGN data type definitions
│   │
│   ├── tracking/                  # Smart money tracking
│   │   ├── wallet-tracker.ts      # Wallet watchlist management
│   │   ├── convergence-detector.ts # Time-windowed convergence
│   │   ├── wallet-classifier.ts   # Wallet type classification
│   │   └── types.ts               # Tracking type definitions
│   │
│   ├── safety/                    # Token safety analysis
│   │   ├── checker.ts             # Multi-source orchestrator
│   │   ├── honeypot-detector.ts   # Jupiter sell simulation
│   │   ├── lp-analyzer.ts         # LP lock/burn verification
│   │   └── types.ts               # Safety type definitions
│   │
│   ├── ai/                        # AI/LLM integration
│   │   ├── router.ts              # Three-tier dispatch (8B → 70B → Claude)
│   │   ├── prompts.ts             # 5-dimension prompt templates
│   │   ├── response-parser.ts     # Structured JSON response parser
│   │   └── types.ts               # AI type definitions
│   │
│   ├── streaming/                 # WebSocket streaming
│   │   ├── manager.ts             # Connection lifecycle manager
│   │   ├── pump-portal-stream.ts  # PumpPortal event handler
│   │   ├── birdeye-stream.ts      # Birdeye stream handler
│   │   └── types.ts               # Streaming type definitions
│   │
│   ├── store/                     # Zustand state management
│   │   ├── signal-store.ts        # Active signals store
│   │   ├── token-store.ts         # Token data store
│   │   ├── settings-store.ts      # User settings store
│   │   ├── position-store.ts      # Tracked positions store
│   │   ├── chrome-storage-adapter.ts  # chrome.storage persistence middleware
│   │   └── index.ts               # Barrel exports + initialization
│   │
│   ├── components/                # Preact UI components (Shadow DOM)
│   │   ├── App.tsx                # Root — error boundary, visibility toggle
│   │   ├── SignalPanel.tsx        # Signal list (sorted by score)
│   │   ├── TokenCard.tsx          # Per-token signal card
│   │   ├── SafetyBadge.tsx        # Green/yellow/red safety indicator
│   │   ├── ScoreGauge.tsx         # Circular 0–100 score gauge
│   │   ├── AIInsight.tsx          # LLM narrative + confidence display
│   │   ├── ExitStrategy.tsx       # TP/SL ladder visualization
│   │   ├── SmartMoneyIndicator.tsx # Wallet convergence indicator
│   │   ├── SettingsPanel.tsx      # Configuration form
│   │   ├── NewTokenFeed.tsx       # Real-time PumpPortal token feed
│   │   └── styles.css             # Shadow DOM scoped stylesheet
│   │
│   └── utils/                     # Shared utilities
│       ├── crypto.ts              # AES-GCM API key encryption
│       ├── messaging.ts           # Typed Chrome messaging helpers
│       ├── cache.ts               # TTL-based chrome.storage cache
│       ├── logger.ts              # Structured logging utility
│       ├── config.ts              # Constants, URLs, defaults
│       └── formatting.ts          # Number/price/time formatters
│
├── tests/                         # Test suites
│   ├── unit/                      # Unit tests per module
│   │   ├── signals/               # Scoring engine + factor tests
│   │   ├── api/                   # API client tests
│   │   ├── safety/                # Safety analysis tests
│   │   ├── ai/                    # LLM routing tests
│   │   ├── gmgn/                  # Interceptor + parser tests
│   │   ├── tracking/              # Convergence detection tests
│   │   ├── store/                 # Storage adapter tests
│   │   └── utils/                 # Utility tests
│   ├── integration/               # End-to-end pipeline tests
│   └── components/                # Preact component tests
│
├── docs/                          # Project documentation
│   ├── ARCHITECTURE.md            # System architecture (this file)
│   ├── API-INTEGRATION.md         # External API reference
│   └── SIGNALS.md                 # Signal scoring methodology
│
├── assets/                        # Extension icons
│   ├── icon-16.png                # Toolbar icon (16×16)
│   ├── icon-48.png                # Management page icon (48×48)
│   └── icon-128.png               # Web Store icon (128×128)
│
├── package.json                   # NPM dependencies and scripts
├── wxt.config.ts                  # WXT/Manifest V3 configuration
├── tsconfig.json                  # TypeScript compiler options
├── vitest.config.ts               # Vitest test runner configuration
├── .env.example                   # API key template
├── .gitignore                     # Git ignore patterns
└── README.md                      # Project overview and setup guide
```

---

## Appendix: Architectural Rules Reference

The following rules from the Agent Action Plan (AAP) govern the architecture:

| Rule | Section | Summary |
|------|---------|---------|
| **Chrome Extension Architecture** | AAP 0.7.1 | Manifest V3 compliance; synchronous listener registration; no setTimeout/setInterval in service worker; state must survive termination; minimum Chrome 116 |
| **Data Access and Security** | AAP 0.7.2 | GMGN data interception only (no direct API calls); API keys never in content scripts; AES-GCM encryption; origin validation on all messages |
| **Signal Engine** | AAP 0.7.3 | Hard filters are absolute; safety checks before AI; concurrent RugCheck + GoPlus; Jupiter honeypot simulation mandatory; configurable scoring weights |
| **Rate Limiting and Cost** | AAP 0.7.4 | Per-API rate limiting mandatory; 5-minute LLM response caching; 80/15/5 three-tier LLM split; DexScreener as fallback only; monthly cost ≤ $250 |
| **UI and Performance** | AAP 0.7.5 | Shadow DOM for all UI; Preact only (no React); < 100KB gzipped content script; MutationObserver on narrowest subtree with 250ms debounce; z-index 2147483647 |
| **WebSocket Connections** | AAP 0.7.6 | Single PumpPortal connection; 20-second keepalive ping; exponential backoff reconnection; graceful degradation to chrome.alarms polling |
