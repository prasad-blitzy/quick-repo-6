# External API Integration Guide

The GMGN.ai Memecoin Signal Bot Chrome Extension uses a **multi-source data pipeline** that aggregates real-time token analytics, safety reports, smart money activity, and AI-powered analysis from 9 external API providers. This document serves as the comprehensive reference for every external integration — covering endpoints, authentication, rate limits, response schemas, and cost considerations.

> **Important:** All outbound API calls are made **exclusively from the Chrome Extension service worker** (`entrypoints/background.ts`). Content scripts and injected page-context scripts never hold API keys or make direct external requests. GMGN.ai data is obtained through fetch/XHR interception — not direct API calls.

## Architecture Overview

### Monthly Cost Summary (Quick Reference)

| Service | Plan | Monthly Cost | Purpose |
|---------|------|-------------|---------|
| Birdeye | Starter | $99 | Token analytics, OHLCV, holders, WebSocket streams |
| Helius | Developer | $49 | Enhanced Solana RPC, parsed transactions, webhooks |
| Groq | Free + usage | $5–15 | LLM inference (80/15/5 tier split) |
| RugCheck | Free | $0 | Token safety reports |
| GoPlus | Free Beta | $0 | Contract security checks |
| Jupiter | Free (1 RPS) | $0 | Price quotes, honeypot simulation |
| DexScreener | Free | $0 | Fallback token data |
| PumpPortal | Free | $0 | New token WebSocket events |
| Anthropic | Pay-per-use | $0–5 | Claude Sonnet (top 5% signals only) |
| **Total** | | **~$150–250** | **Target budget per AAP** |

### Core Infrastructure

All REST API calls flow through a shared infrastructure layer:

- **Rate Limiter** — `src/api/rate-limiter.ts` — Per-provider token bucket rate limiting with request queuing and priority support
- **Base HTTP Client** — `src/api/base-client.ts` — Abstract `fetch()` wrapper with configurable timeout, retry with exponential backoff, response caching, and error classification
- **Shared Type Definitions** — `src/api/types.ts` — TypeScript interfaces for all API response shapes (`BirdeyeTokenData`, `PumpPortalEvent`, `JupiterQuote`, `RugCheckReport`, `GoPlusResult`, etc.)
- **TTL Cache** — `src/utils/cache.ts` — Responses are cached in `chrome.storage.local` with configurable time-to-live per API
- **Native `fetch()`** — No external HTTP client library (e.g., Axios) is used; the service worker's built-in `fetch()` API handles all REST communication

---

## 1. Birdeye — Token Analytics

| Property | Value |
|----------|-------|
| **Source File** | `src/api/birdeye.ts` |
| **Base URL** | `https://public-api.birdeye.so` |
| **Authentication** | `X-API-KEY` header with Birdeye API key |
| **Plan** | Starter ($99/month) |
| **Rate Limit** | 15 RPS (requests per second) — managed by `rate-limiter.ts` token bucket |
| **Response Types** | `BirdeyeTokenData`, `BirdeyeOHLCV` (defined in `src/api/types.ts`) |
| **Used By** | `src/signals/scoring-engine.ts`, `src/store/token-store.ts` |

Birdeye is the **primary token analytics provider**, supplying price data, OHLCV candlesticks, transaction history, token overviews, and holder distribution. All requests include the `chain=solana` query parameter.

### Endpoints

#### `GET /defi/price` — `getTokenPrice(mint)`

Returns the current price for a Solana token.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `address` | `string` | Yes | Token mint address |
| `chain` | `string` | Yes | Always `solana` |

**Response Shape:**

```json
{
  "data": {
    "value": 0.00001234,
    "updateUnixTime": 1710345678
  },
  "success": true
}
```

#### `GET /defi/ohlcv` — `getOHLCV(mint, interval)`

Returns OHLCV (Open, High, Low, Close, Volume) candlestick data for charting and volume analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `address` | `string` | Yes | Token mint address |
| `type` | `string` | Yes | Candle interval: `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |
| `time_from` | `number` | Yes | Start Unix timestamp (seconds) |
| `time_to` | `number` | Yes | End Unix timestamp (seconds) |
| `chain` | `string` | Yes | Always `solana` |

**Response Shape:**

```json
{
  "data": {
    "items": [
      {
        "o": 0.00001200,
        "h": 0.00001500,
        "l": 0.00001100,
        "c": 0.00001350,
        "v": 50000,
        "unixTime": 1710345600
      }
    ]
  },
  "success": true
}
```

#### `GET /defi/txs/token` — `getTokenTransactions(mint)`

Returns recent swap transactions for a token. Used by the volume spike and buy/sell ratio scoring factors.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `address` | `string` | Yes | Token mint address |
| `tx_type` | `string` | No | Transaction type filter (e.g., `swap`) |
| `limit` | `number` | No | Maximum results (default 50) |
| `offset` | `number` | No | Pagination offset |
| `chain` | `string` | Yes | Always `solana` |

#### `GET /defi/token_overview` — `getTokenOverview(mint)`

Returns a comprehensive token overview including price, market cap, 24-hour volume, holder count, and more.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `address` | `string` | Yes | Token mint address |
| `chain` | `string` | Yes | Always `solana` |

**Response Shape:**

```json
{
  "data": {
    "address": "So11111111111111111111111111111111111111112",
    "symbol": "SOL",
    "name": "Wrapped SOL",
    "price": 175.50,
    "mc": 75000000000,
    "v24hUSD": 2500000000,
    "holder": 5000000,
    "liquidity": 1000000000
  },
  "success": true
}
```

#### `GET /defi/token/top-holders` — `getTopHolders(mint)`

Returns the top holder distribution for a token. Used by the safety score factor to assess holder concentration.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `address` | `string` | Yes | Token mint address |
| `chain` | `string` | Yes | Always `solana` |

### WebSocket Streaming

Birdeye also provides WebSocket streaming for real-time price updates and transaction events. See the [WebSocket Streaming](#websocket-streaming) section for details on the Birdeye WebSocket integration (`src/streaming/birdeye-stream.ts`).

---

## 2. PumpPortal — New Token Events (WebSocket)

| Property | Value |
|----------|-------|
| **Source Files** | `src/api/pump-portal.ts`, `src/streaming/pump-portal-stream.ts` |
| **WebSocket URL** | `wss://pumpportal.fun/api/data` |
| **Authentication** | None (free, no API key required) |
| **Cost** | Free |
| **Connection Model** | Single WebSocket, multiplexed subscriptions |
| **Response Types** | `PumpPortalEvent`, `PumpPortalNewToken` (defined in `src/api/types.ts`) |
| **Used By** | `src/signals/scoring-engine.ts` (new token screening) |

PumpPortal provides a **free WebSocket feed** for real-time pump.fun token events — new token creations, trades, and graduation/migration events. Per project rules, exactly **one WebSocket connection** is maintained with multiple subscriptions multiplexed on that single connection.

### Subscription Payloads

Subscribe by sending JSON messages after the WebSocket connection is established:

#### Subscribe to New Token Events

```json
{ "method": "subscribeNewToken" }
```

Emits an event each time a new pump.fun token is created. Contains mint address, token name, symbol, metadata URI, and creator wallet.

#### Subscribe to Token Trade Events

```json
{ "method": "subscribeTokenTrade", "keys": ["<mint_address>"] }
```

Emits trade events for specific tokens. Used to monitor active signals for volume changes.

#### Subscribe to Migration Events

```json
{ "method": "subscribeMigration" }
```

Emits events when pump.fun tokens graduate to DEXes (Raydium). Critical for tracking the ~0.4–1.8% of tokens that successfully migrate.

### Event Format

All events are JSON objects with token details:

```json
{
  "mint": "AbC123...",
  "name": "ExampleToken",
  "symbol": "EXT",
  "uri": "https://arweave.net/metadata...",
  "creator": "WalletAddress...",
  "txType": "create",
  "signature": "TxSignature...",
  "timestamp": 1710345678
}
```

### Connection Management

| Setting | Value | Notes |
|---------|-------|-------|
| **Keepalive Ping** | Every 20 seconds | Prevents Chrome service worker idle termination |
| **Reconnection** | Exponential backoff: 1s → 2s → 4s → 8s → 16s | Maximum 5 retry attempts |
| **Fallback** | `chrome.alarms` polling at 30–60s | If WebSocket fails persistently |
| **Max Connections** | 1 | Single connection, multiple subscriptions |

---

## 3. Jupiter — Price Quotes & Honeypot Detection

| Property | Value |
|----------|-------|
| **Source File** | `src/api/jupiter.ts` |
| **Price API Base URL** | `https://price.jup.ag` |
| **Quote API Base URL** | `https://quote-api.jup.ag` |
| **Authentication** | None (free tier) |
| **Cost** | Free |
| **Rate Limit** | 1 RPS (free tier) — managed by `rate-limiter.ts` |
| **Response Types** | `JupiterQuote`, `JupiterPrice` (defined in `src/api/types.ts`) |
| **Used By** | `src/safety/honeypot-detector.ts`, `src/api/jupiter.ts` |

Jupiter serves two critical functions: **price data retrieval** and **honeypot detection** via swap simulation. Every new token must undergo a Jupiter sell simulation before scoring — this is mandatory per project rules.

### Endpoints

#### `GET /price/v3/` — `getPrice(mint)`

Returns current price data for one or more tokens.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | `string` | Yes | Comma-separated list of token mint addresses |

**Response Shape:**

```json
{
  "data": {
    "So11111111111111111111111111111111111111112": {
      "id": "So11111111111111111111111111111111111111112",
      "price": "175.50",
      "type": "derivedPrice"
    }
  },
  "timeTaken": 0.002
}
```

#### `GET /quote` — `getQuote(inputMint, outputMint, amount)`

Returns a swap quote. Used for **honeypot detection** by simulating a sell (TOKEN → SOL):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputMint` | `string` | Yes | Token mint address (the token to sell) |
| `outputMint` | `string` | Yes | SOL mint address (`So11111111111111111111111111111111111111112`) |
| `amount` | `string` | Yes | Amount in smallest denomination (lamports) |
| `swapMode` | `string` | No | `ExactIn` for sell simulation |

**Honeypot Detection Logic:**

- **Quote returns successfully** → Token is sellable (NOT a honeypot) ✅
- **Quote returns error or times out** → Potential honeypot ⚠️
- **Quote returns with extreme slippage (>50%)** → Likely honeypot or dangerously illiquid ❌

**Response Shape:**

```json
{
  "inputMint": "TokenMintAddress...",
  "outputMint": "So11111111111111111111111111111111111111112",
  "inAmount": "1000000",
  "outAmount": "500000",
  "otherAmountThreshold": "495000",
  "swapMode": "ExactIn",
  "slippageBps": 50,
  "priceImpactPct": "0.5",
  "routePlan": [...]
}
```

> **Mandatory Rule:** Jupiter honeypot simulation is required for every new token before it enters the scoring pipeline. Tokens that cannot be sold are classified as honeypots and filtered out immediately.

---

## 4. Helius — Enhanced Solana RPC

| Property | Value |
|----------|-------|
| **Source File** | `src/api/helius.ts` |
| **Base URL** | `https://api.helius.xyz` |
| **Authentication** | API key in URL path: `/v0/transactions/?api-key=<HELIUS_API_KEY>` |
| **Plan** | Developer ($49/month) |
| **Rate Limit** | 10 RPS — managed by `rate-limiter.ts` |
| **Response Types** | `HeliusParsedTx` (defined in `src/api/types.ts`) |
| **Used By** | `src/tracking/wallet-tracker.ts`, `src/tracking/convergence-detector.ts` |

Helius provides **enhanced Solana RPC** with program-aware transaction parsing. Unlike standard Solana RPC, Helius automatically decodes and labels DeFi interactions (Raydium swaps, Jupiter routes, Pump.fun trades), making it essential for smart money wallet tracking and convergence detection.

### Endpoints

#### `GET /v0/transactions/?api-key=<key>` — `getEnhancedTransaction(signature)`

Returns parsed, human-readable transaction details with program-level decoding.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `api-key` | `string` | Yes | Helius API key (in URL path) |

**Response includes:**
- Transaction type (SWAP, TRANSFER, NFT_MINT, etc.)
- Source and destination wallets
- Token amounts and mints
- Program interactions (Raydium, Jupiter, Pump.fun)
- Timestamp and slot number

#### Token Metadata — `getTokenMetadata(mint)`

Returns enriched token metadata including name, symbol, image, and on-chain attributes.

#### Transaction Parsing — `parseTransaction(signature)`

Program-aware parsing that identifies:
- **Raydium** — AMM swaps, LP additions/removals
- **Jupiter** — Multi-hop route swaps
- **Pump.fun** — Bonding curve buys/sells, token creation, migration

---

## 5. DexScreener — Fallback Token Data

| Property | Value |
|----------|-------|
| **Source File** | `src/api/dexscreener.ts` |
| **Base URL** | `https://api.dexscreener.com` |
| **Authentication** | None (free, no API key required) |
| **Cost** | Free |
| **Rate Limit** | 5 RPS (300 requests/minute) — managed by `rate-limiter.ts` |
| **Response Types** | `DexScreenerPair` (defined in `src/api/types.ts`) |
| **Used By** | `src/store/token-store.ts` (fallback enrichment) |

> **Fallback Only:** DexScreener must NOT be used as a primary data source for tokens already covered by Birdeye. It should only be queried when Birdeye rate limits are hit or Birdeye returns errors.

### Endpoints

#### `GET /dex/tokens/{tokenAddress}` — `getTokenPairs(tokenAddress)`

Returns all trading pairs for a given token address.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tokenAddress` | `string` | Yes | Token mint address (URL path parameter) |

**Response Shape:**

```json
{
  "pairs": [
    {
      "chainId": "solana",
      "dexId": "raydium",
      "pairAddress": "PairAddress...",
      "baseToken": { "address": "...", "name": "...", "symbol": "..." },
      "quoteToken": { "address": "...", "name": "SOL", "symbol": "SOL" },
      "priceNative": "0.00001234",
      "priceUsd": "0.00216",
      "volume": { "h24": 150000, "h6": 45000, "h1": 8000, "m5": 1200 },
      "liquidity": { "usd": 50000, "base": 100000000, "quote": 285.5 },
      "fdv": 1234567,
      "marketCap": 1000000,
      "pairCreatedAt": 1710340000000
    }
  ]
}
```

#### `GET /dex/pairs/{chainId}/{pairAddress}` — `getPairByAddress(chainId, pairAddress)`

Returns data for a specific trading pair.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chainId` | `string` | Yes | Chain identifier (e.g., `solana`) |
| `pairAddress` | `string` | Yes | DEX pair address |

---

## 6. RugCheck — Token Safety Reports

| Property | Value |
|----------|-------|
| **Source File** | `src/api/rugcheck.ts` |
| **Base URL** | `https://api.rugcheck.xyz` |
| **Authentication** | `X-API-KEY` header with RugCheck API key |
| **Cost** | Free tier available |
| **Rate Limit** | Best-effort (no documented strict limit) |
| **Swagger Docs** | `https://api.rugcheck.xyz/swagger/index.html` |
| **Response Types** | `RugCheckReport` (defined in `src/api/types.ts`) |
| **Used By** | `src/safety/checker.ts` → `src/signals/factors/safety-score.ts` |

RugCheck provides comprehensive token safety reports including risk scoring, authority status, holder distribution, and insider wallet detection. It is called **concurrently with GoPlus** via `Promise.allSettled` — results are merged with worst-case-wins logic.

### Endpoints

#### `GET /tokens/{id}/report` — `getTokenReport(mint)`

Returns a comprehensive safety report for a Solana token.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Token mint address (URL path parameter) |

**Key Safety Fields:**

| Field | Significance | Threshold |
|-------|-------------|-----------|
| Risk Score | Overall safety rating | ≥300 = high safety |
| Mint Authority | Can new tokens be minted? | Must be revoked |
| Freeze Authority | Can accounts be frozen? | Must be revoked |
| Top Holder % | Concentration risk | Top 10 holders ≤50% |
| LP Status | Liquidity pool lock/burn | Burned or locked preferred |

#### `GET /tokens/{id}/insiders/graph` — `getInsiderGraph(mint)`

Returns a graph of insider wallet connections, revealing coordinated wallets that may indicate bundled launches or insider trading.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | Token mint address (URL path parameter) |

---

## 7. GoPlus Security — Contract Security Checks

| Property | Value |
|----------|-------|
| **Source File** | `src/api/goplus.ts` |
| **Base URL** | `https://api.gopluslabs.io` |
| **Authentication** | None (free beta) |
| **Cost** | Free |
| **Rate Limit** | Best-effort (free tier) |
| **Response Types** | `GoPlusResult` (defined in `src/api/types.ts`) |
| **Used By** | `src/safety/checker.ts` → `src/signals/factors/safety-score.ts` |

GoPlus provides automated contract security analysis for Solana tokens. It is called **concurrently with RugCheck** — both results are merged, and the worst-case assessment wins for each safety dimension.

### Endpoint

#### `GET /api/v1/solana/token_security` — `getTokenSecurity(address)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contract_addresses` | `string` | Yes | Token mint address (query parameter) |

**Response Shape:**

```json
{
  "code": 1,
  "message": "OK",
  "result": {
    "<token_address>": {
      "is_mintable": "0",
      "is_freezable": "0",
      "is_open_source": "1",
      "holder_count": "5000",
      "lp_holder_count": "10",
      "total_supply": "1000000000",
      "holders": [
        { "address": "...", "percent": "5.2", "is_locked": 1 }
      ]
    }
  }
}
```

**Key Fields:**

| Field | Type | Meaning |
|-------|------|---------|
| `is_mintable` | `"0"` / `"1"` | `"0"` = mint authority revoked (safe) |
| `is_freezable` | `"0"` / `"1"` | `"0"` = freeze authority revoked (safe) |
| `holder_count` | `string` | Total number of token holders |
| `lp_holder_count` | `string` | Number of LP token holders |
| `holders` | `array` | Top holders with percentage and lock status |

> **Note:** GoPlus returns string values `"0"` and `"1"` rather than booleans. The `src/api/goplus.ts` client normalizes these to proper boolean values in the `GoPlusResult` type.

---

## 8. Groq — LLM Inference

| Property | Value |
|----------|-------|
| **Source File** | `src/api/groq.ts` |
| **Base URL** | `https://api.groq.com` |
| **Authentication** | `Authorization: Bearer <GROQ_API_KEY>` header |
| **SDK** | `groq-sdk` npm package (v0.18.0) |
| **Cost** | Free tier with daily token limits; production ~$5–15/month |
| **Rate Limit** | Per-model RPM limits — managed by `rate-limiter.ts` |
| **Used By** | `src/ai/router.ts` |
| **Response Parsed By** | `src/ai/response-parser.ts` |

Groq provides ultra-fast LLM inference used for AI-powered token analysis. The extension uses a **three-tier model routing** strategy to optimize cost and quality.

### Model Tiers

| Tier | Model | Usage Share | Use Case | Relative Cost |
|------|-------|-------------|----------|---------------|
| **Tier 1** (Fast) | `llama-3.1-8b-instant` | 80% of calls | Quick pass/fail screening | Lowest |
| **Tier 2** (Detailed) | `llama-3.3-70b-versatile` | 15% of calls | Detailed multi-dimension analysis | Moderate |
| **Tier 3** (Premium) | Claude Sonnet (via Anthropic) | 5% of calls | Narrative analysis of top signals | Highest |

### Structured Output

All Groq requests use `response_format: { type: 'json_object' }` to ensure consistent, parseable responses:

```json
{
  "model": "llama-3.1-8b-instant",
  "messages": [
    { "role": "system", "content": "You are a memecoin analyst. Respond in JSON format." },
    { "role": "user", "content": "<analysis_prompt>" }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.3,
  "max_tokens": 512
}
```

### Cost Optimization Strategies

1. **Response Caching** — LLM responses are cached in `chrome.storage.local` with a **5-minute TTL** keyed by `{mint_address}:{analysis_tier}`. Duplicate analyses within the TTL window return cached results.
2. **Groq Prompt Caching** — Groq offers a 50% discount on cached input tokens when prompts share common prefixes across requests.
3. **80/15/5 Tier Split** — Routing 80% of analyses through the cheapest model reduces overall LLM costs by approximately 60% compared to using a single high-quality model.
4. **Score-Based Routing** — Only tokens that pass hard filters AND achieve a minimum composite score threshold are sent to LLM analysis, preventing wasted credits on unsafe or low-potential tokens.

---

## 9. Anthropic Claude — Premium AI Analysis

| Property | Value |
|----------|-------|
| **Base URL** | `https://api.anthropic.com` |
| **Authentication** | `x-api-key` header with Anthropic API key |
| **Cost** | Pay-per-use (estimated $0–5/month) |
| **Model** | Claude Sonnet |
| **Used By** | `src/ai/router.ts` (top 5% signals only) |
| **Response Parsed By** | `src/ai/response-parser.ts` |

Anthropic Claude Sonnet is the **premium tier** of the three-tier LLM routing system. It is reserved exclusively for the top 5% of highest-confidence signals (composite score >80) where rich narrative analysis provides the most value.

### Usage Guidelines

- **Trigger:** Only invoked when a token's composite score exceeds 80 (high-confidence signal)
- **Purpose:** Generates a detailed narrative analysis covering market context, risk assessment, and trading thesis
- **Optional:** The extension functions fully without an Anthropic API key — Groq handles 95% of all analyses
- **Budget Impact:** At ~5% of total analyses with modest token usage, expected cost is $0–5/month

### Request Format

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "<detailed_analysis_prompt_with_token_data>"
    }
  ]
}
```

---

## Rate Limiting Architecture

**Source:** `src/api/rate-limiter.ts`

The extension implements a **token bucket rate limiter** with dedicated buckets per API provider. This ensures compliance with each provider's rate limits while maximizing throughput.

### How Token Bucket Works

Each provider has a bucket that holds a fixed number of tokens (equal to its RPS limit). Tokens are consumed when a request is made and replenished at a constant rate. When the bucket is empty, requests are queued until tokens become available.

### Provider Configuration

| Provider | Tokens/Second | Bucket Size | Priority | Notes |
|----------|---------------|-------------|----------|-------|
| Birdeye | 15 | 15 | Yes | Primary analytics source |
| Jupiter | 1 | 1 | Yes | Honeypot detection (safety-critical) |
| DexScreener | 5 | 5 | No | Fallback only |
| Helius | 10 | 10 | Yes | Smart money wallet tracking |
| Groq | Per-model RPM | Variable | No | LLM inference |
| RugCheck | Unlimited* | N/A | Yes | Safety-critical (*best-effort) |
| GoPlus | Unlimited* | N/A | Yes | Safety-critical (*best-effort) |

### Request Queue Behavior

1. **FIFO Ordering** — Requests are processed in first-in, first-out order within each provider's queue.
2. **Priority Access** — Safety-critical requests (RugCheck, GoPlus, Jupiter honeypot checks) receive priority access and can jump ahead of non-critical requests in the shared queue.
3. **Backpressure** — If any provider's queue exceeds its maximum depth, non-priority requests are dropped to prevent resource exhaustion. Safety-critical requests are never dropped.
4. **Burst Handling** — The token bucket allows short bursts up to the bucket size, then throttles to the sustained rate.

---

## Authentication & Security

All API key management follows strict security protocols to prevent key exposure in the browser environment.

### Security Model

| Principle | Implementation |
|-----------|---------------|
| **Key Isolation** | API keys are accessed **only** from the service worker context — never in content scripts or injected page-context scripts |
| **Encryption at Rest** | All API keys are encrypted using **AES-GCM** via the Web Crypto API before storage |
| **Per-Installation Keys** | Each extension installation generates a unique AES-GCM encryption key, stored separately in `chrome.storage.local` |
| **User Configuration** | Keys are entered by the user through the Settings panel (`src/components/SettingsPanel.tsx`) |
| **Encryption Utility** | `src/utils/crypto.ts` — provides `encrypt(plaintext)` and `decrypt(ciphertext)` functions |

### API Key Storage Flow

```
User enters key in Settings panel
  → Key encrypted with AES-GCM (Web Crypto API)
    → Encrypted blob stored in chrome.storage.local
      → Service worker decrypts key on demand for API calls
```

### Required API Keys

Configure these keys in the extension Settings panel (or via `.env.example` during development):

| Environment Variable | Provider | Required | Notes |
|---------------------|----------|----------|-------|
| `BIRDEYE_API_KEY` | Birdeye | Yes (for full analytics) | Starter plan recommended |
| `HELIUS_API_KEY` | Helius | Yes (for wallet tracking) | Developer plan recommended |
| `RUGCHECK_API_KEY` | RugCheck | Recommended | Free tier available |
| `GROQ_API_KEY` | Groq | Yes (for AI analysis) | Free tier with daily limits |
| `ANTHROPIC_API_KEY` | Anthropic | Optional | Only for premium Tier 3 analysis |

> **Note:** The extension degrades gracefully when optional API keys are not configured. Core signal scoring works with GMGN intercepted data alone; external APIs enrich the analysis.

---

## HTTP Client & Error Handling

**Source:** `src/api/base-client.ts`

All REST API calls use an abstract HTTP client that wraps the native `fetch()` API with production-grade reliability features.

### Features

| Feature | Configuration | Description |
|---------|--------------|-------------|
| **Timeout** | 10 seconds (default) | Prevents hanging requests from blocking the pipeline |
| **Retry** | 3 attempts with exponential backoff | Intervals: 1s → 2s → 4s |
| **Response Caching** | Per-API configurable TTL | Via `src/utils/cache.ts` backed by `chrome.storage.local` |
| **Error Classification** | Automatic | Categorizes errors for appropriate handling |

### Error Classification

| HTTP Status | Classification | Retry? | Action |
|-------------|---------------|--------|--------|
| `429` | Rate Limited | Yes | Back off and retry; token bucket absorbs future requests |
| `401` / `403` | Auth Failed | No | Log error; prompt user to check API key configuration |
| `5xx` | Server Error | Yes | Retry with exponential backoff |
| `4xx` (other) | Client Error | No | Log error; do not retry (request is malformed) |
| Timeout | Timeout | Yes | Retry; classify as potential honeypot if Jupiter `/quote` |

### Retry Strategy

```
Attempt 1: Immediate request
  ↓ (failure on 429 or 5xx)
Attempt 2: Wait 1 second → retry
  ↓ (failure)
Attempt 3: Wait 2 seconds → retry
  ↓ (failure)
Attempt 4: Wait 4 seconds → retry
  ↓ (failure)
Give up → return error to caller
```

---

## GMGN.ai Data Interception

> **GMGN.ai is NOT accessed via standard API calls.** All GMGN data is obtained by intercepting the fetch/XHR requests that the GMGN frontend already makes. Direct calls to GMGN's internal API endpoints are **strictly prohibited** — they are protected by Cloudflare and will be blocked.

### Interception Method

The extension uses a **page-context injected script** (`entrypoints/injected.ts`) that monkey-patches `window.fetch` and `XMLHttpRequest.prototype.open`/`send` to intercept responses matching GMGN's internal API URL patterns.

**Data Relay Chain:**

```
GMGN Frontend makes fetch() call
  → Injected script intercepts response (clones it)
    → Posts data via window.postMessage({ source: 'gmgn-signal-bot', ... })
      → Content script receives message (validates event.origin === 'https://gmgn.ai')
        → Forwards to service worker via chrome.runtime.sendMessage()
          → Service worker processes data through signal pipeline
```

### Intercepted URL Patterns

**Source:** `src/gmgn/url-patterns.ts`

| URL Pattern | Data Type | Description |
|-------------|-----------|-------------|
| `/defi/quotation/v1/rank/{chain}/swaps/` | Trending Tokens | Top trending tokens by swap volume |
| `/api/v1/token/` | Token Detail | Comprehensive token data (price, MC, volume, holders) |
| `/api/v1/wallet_activity/` | Wallet Activity | Individual wallet transaction history |
| `/api/v1/smartmoney/` | Smart Money Signals | Smart money wallet movements and classifications |
| `/api/v1/token_holders/` | Token Holders | Holder list with balances and concentration data |

### Security Validation

- **Origin Check:** The content script validates `event.origin === 'https://gmgn.ai'` on all `window.postMessage` events to prevent spoofing from other scripts.
- **Sender Validation:** The service worker validates `sender.id === chrome.runtime.id` on all `chrome.runtime.onMessage` events.
- **Transparent Passthrough:** The original `fetch()` and `XMLHttpRequest` behavior is preserved — the interception only reads (clones) responses and never modifies requests or responses.

### Reference Files

| File | Purpose |
|------|---------|
| `src/gmgn/interceptor.ts` | Core fetch/XHR monkey-patch logic |
| `src/gmgn/url-patterns.ts` | URL pattern matching registry |
| `src/gmgn/parsers.ts` | Response-to-model transformers |
| `src/gmgn/types.ts` | TypeScript type definitions for GMGN data structures |

---

## WebSocket Streaming

**Source:** `src/streaming/manager.ts`

The extension maintains persistent WebSocket connections for real-time data streaming. Chrome 116+ extends the service worker lifetime when WebSocket messages are sent or received, enabling persistent connections.

### Active WebSocket Connections

| Connection | Source File | URL | Auth Required |
|-----------|-------------|-----|---------------|
| PumpPortal | `src/streaming/pump-portal-stream.ts` | `wss://pumpportal.fun/api/data` | No |
| Birdeye | `src/streaming/birdeye-stream.ts` | Birdeye WebSocket endpoint | Yes (API key) |

### PumpPortal WebSocket

See [Section 2: PumpPortal](#2-pumpportal--new-token-events-websocket) for full subscription details and event formats.

### Birdeye WebSocket

The Birdeye WebSocket provides real-time streams authenticated with the Birdeye API key:

| Subscription Type | Event | Description |
|-------------------|-------|-------------|
| `SUBSCRIBE_PRICE` | Price updates | Real-time price changes for subscribed tokens |
| `SUBSCRIBE_TXS` | Transaction events | Live swap transactions for subscribed tokens |
| `SUBSCRIBE_TOKEN_NEW_LISTING` | New listings | Newly listed tokens on Solana DEXes |

### Connection Management (All WebSockets)

| Setting | Value | Rationale |
|---------|-------|-----------|
| **Keepalive Ping** | Every 20 seconds | Resets Chrome service worker idle timer; detects dead connections |
| **Reconnection** | Exponential backoff (1s → 2s → 4s → 8s → 16s) | Maximum 5 retry attempts per connection |
| **Fallback** | `chrome.alarms` polling (30–60s intervals) | Ensures functionality even if all WebSockets fail |
| **Minimum Chrome** | 116+ | Required for WebSocket activity to extend service worker lifetime |

### Type Definitions

**Source:** `src/streaming/types.ts`

| Type | Description |
|------|-------------|
| `StreamEvent` | Typed union of all possible stream events |
| `StreamSubscription` | Subscription configuration (channel, parameters) |
| `ConnectionState` | `'connecting'` \| `'open'` \| `'closing'` \| `'closed'` \| `'reconnecting'` |
| `ReconnectionConfig` | `{ maxRetries: number, backoffMs: number[] }` |

---

## Monthly Cost Summary

The extension is designed to operate within a **$150–250/month** budget for a production-grade data pipeline.

### Detailed Cost Breakdown

| Service | Plan | Monthly Cost | What You Get |
|---------|------|-------------|--------------|
| Birdeye | Starter | **$99** | Token price, OHLCV, transactions, top holders, WebSocket streams, 15 RPS |
| Helius | Developer | **$49** | Enhanced transaction parsing, token metadata, webhooks, 10 RPS |
| Groq | Free + usage | **$5–15** | LLM inference via `llama-3.1-8b-instant` (80%) and `llama-3.3-70b-versatile` (15%) |
| Anthropic | Pay-per-use | **$0–5** | Claude Sonnet narrative analysis (top 5% signals only) |
| RugCheck | Free | **$0** | Token safety reports, insider detection |
| GoPlus | Free Beta | **$0** | Solana contract security checks |
| Jupiter | Free (1 RPS) | **$0** | Price quotes, swap simulation for honeypot detection |
| DexScreener | Free | **$0** | Fallback token/pair data |
| PumpPortal | Free | **$0** | Real-time new token, trade, and migration events via WebSocket |
| **Total** | | **~$153–168** | **Core pipeline (excluding optional Anthropic)** |
| **Total (with Claude)** | | **~$153–173** | **Full pipeline including premium AI** |

### Cost Optimization Summary

1. **Free tier maximization** — 5 of 9 APIs are completely free (PumpPortal, Jupiter, DexScreener, RugCheck, GoPlus)
2. **LLM tier routing** — 80/15/5 split routes most analyses through the cheapest model
3. **Response caching** — 5-minute TTL on LLM responses and configurable TTL on API responses prevent duplicate calls
4. **Fallback architecture** — DexScreener as a free fallback reduces Birdeye rate limit pressure
5. **Score-gated AI** — Only tokens passing hard filters and minimum composite score reach the LLM tier

> **Minimum Viable Cost:** The extension can operate with **$0/month** using only free APIs (PumpPortal, Jupiter, DexScreener, RugCheck, GoPlus) and GMGN intercepted data — though analytics depth and smart money tracking will be limited without Birdeye and Helius.
