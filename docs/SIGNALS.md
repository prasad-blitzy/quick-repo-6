# Signal Scoring Engine

The GMGN.ai Memecoin Signal Bot employs a **7-factor weighted composite scoring system** to evaluate Solana memecoin trading opportunities in real time. Each token passing through the signal pipeline receives a composite score from **0 to 100**, computed as a weighted sum of seven independent factor sub-scores. This score drives automated BUY, SKIP, and EXIT signal decisions.

The engine supports two trading modes to accommodate different risk appetites:

- **Conservative Mode** — Requires a composite score **≥ 80** to generate a BUY signal. Designed for traders seeking only the highest-confidence setups with strong safety profiles.
- **Aggressive Mode** — Requires a composite score **≥ 45** to generate a BUY signal. Designed for traders willing to accept moderate risk in exchange for earlier entries and higher upside potential.

All scoring weights are fully user-configurable through the extension's Settings panel, and the scoring engine reads weight values from the Zustand `settings-store` at analysis time — weights are never hardcoded.

> **Source files:** [`src/signals/scoring-engine.ts`](../src/signals/scoring-engine.ts), [`src/signals/types.ts`](../src/signals/types.ts)

---

## Composite Scoring Formula

The composite score is a **weighted sum** of 7 independent factor sub-scores. Each factor module independently evaluates one dimension of a token's quality and returns a sub-score in the range **0–100**. The final composite score is computed as:

```
CompositeScore = Σ (factor_score_i × factor_weight_i)    for i = 1..7
```

where all weights must satisfy:

```
Σ factor_weight_i = 1.0
```

### Execution Model

All 7 factor modules execute **in parallel** via `Promise.allSettled` to maximize throughput and minimize latency. If any individual factor fails or times out, the engine uses a fallback score of `0` for that factor and proceeds with the remaining results — partial data is always better than no data in a fast-moving market.

### Return Type

The scoring engine returns a `CompositeSignal` object:

```typescript
interface CompositeSignal {
  tokenMint: string;
  composite: number;         // 0–100 composite score
  factors: FactorResult[];   // Individual factor sub-scores and metadata
  decision: 'BUY' | 'SKIP' | 'EXIT';
  confidence: 'high' | 'medium' | 'low';
  timestamp: number;
}

interface FactorResult {
  name: string;              // Factor identifier
  score: number;             // 0–100 sub-score
  weight: number;            // Applied weight at computation time
  metadata: Record<string, unknown>; // Factor-specific diagnostic data
}
```

### Decision Logic

After computing the composite score, the engine applies the following decision rules in order:

1. **Hard filters** are evaluated first — if any hard filter fails, the decision is `SKIP` regardless of composite score (see [Hard Filter Gates](#hard-filter-gates)).
2. If hard filters pass, the composite score is compared against the active trading mode threshold:
   - Score **≥ threshold** → `BUY`
   - Score **< threshold** → `SKIP`
3. For tokens already in an active position, exit trigger conditions may override to `EXIT` (see [Exit Strategy](#exit-strategy)).

> **Source:** [`src/signals/scoring-engine.ts`](../src/signals/scoring-engine.ts)

---

## The 7 Scoring Factors

Each factor module is an independent scorer that evaluates one dimension of token quality. Factors are designed to be composable — they can be individually weighted, replaced, or extended without affecting other factors.

### 1. Volume Spike Detection

Detects sudden surges in trading volume that often precede significant price movements.

| Property | Value |
|----------|-------|
| **Default Weight** | `0.20` (user-configurable) |
| **Source File** | [`src/signals/factors/volume-spike.ts`](../src/signals/factors/volume-spike.ts) |
| **Data Source** | Birdeye OHLCV API, GMGN intercepted data |

**Algorithm:**

The factor compares the current 5-minute trading volume against a rolling **5-minute moving average (MA)** to detect abnormal volume surges. The spike magnitude (current volume ÷ 5m MA) determines the sub-score.

**Minimum Thresholds (must pass both):**

- **$200** minimum 5-minute volume — filters out dust-level activity
- **$2,000** minimum 1-hour volume — ensures sustained interest, not a single large fill

If either minimum threshold is not met, the factor returns a score of `0`.

**Scoring Tiers:**

| Spike Magnitude | Sub-Score Range | Classification |
|----------------|-----------------|----------------|
| < 1.5× | 0–10 | No spike detected |
| 1.5×–3× | 10–30 | Mild increase |
| 3×–5× | 30–60 | Moderate spike |
| 5×–8× | 60–85 | Strong spike |
| > 8× | 85–100 | Extreme spike |

**Bonus Multiplier:**

If the volume-to-market-cap ratio exceeds **100%** (i.e., 5-minute volume > total market cap), a bonus multiplier of **1.15×** is applied to the sub-score (capped at 100). This signals extraordinary market interest relative to token size.

---

### 2. Smart Money Convergence

Detects when multiple qualified smart money wallets independently enter the same token within a short time window — a strong conviction signal.

| Property | Value |
|----------|-------|
| **Default Weight** | `0.20` (user-configurable) |
| **Source File** | [`src/signals/factors/smart-money-convergence.ts`](../src/signals/factors/smart-money-convergence.ts) |
| **Data Source** | GMGN intercepted wallet data, Helius Enhanced Transactions API |

**Algorithm:**

The factor queries the convergence detector (`src/tracking/convergence-detector.ts`) for active convergence events on the target token. A convergence event fires when **3 or more** qualified smart money wallets enter the same token within a configurable time window (default: **2 hours**).

**Base Scoring:**

| Wallet Count | Points Awarded |
|-------------|---------------|
| 0 wallets | 0 |
| 1 whale/smart money buy | +10 |
| 2 whale/smart money buys | +25 |
| 3+ wallets (convergence) | +50 base |
| Each additional wallet beyond 3 | +10 (up to cap of 100) |

**Conviction Multiplier:**

When a wallet's entry position size exceeds **80% of its historical average** position size for similar tokens, this indicates high conviction. Each high-conviction entry applies a **1.2× multiplier** to that wallet's contribution to the convergence score.

**Wallet Quality Weights:**

Not all wallets are equal. The convergence detector weights wallet contributions by classification:

| Wallet Type | Quality Weight | Criteria |
|-------------|---------------|----------|
| Smart Money | 1.0 | 70%+ win rate across tracked history |
| Insider | 0.9 | Connected to project team — very reliable but rare signals |
| Whale | 0.8 | Large position holder — significant market impact and conviction |
| KOL (Key Opinion Leader) | 0.7 | Known influential trader/analyst |
| Sniper | 0.5 | First-block buyer (often automated) |
| Developer | 0.3 | Token deployer wallet (lowest trust) |

> **References:** [`src/tracking/convergence-detector.ts`](../src/tracking/convergence-detector.ts), [`src/tracking/wallet-classifier.ts`](../src/tracking/wallet-classifier.ts)

---

### 3. Buy/Sell Ratio Analysis

Evaluates the directional pressure of trading activity — a high buy/sell ratio indicates accumulation, while a low ratio signals distribution.

| Property | Value |
|----------|-------|
| **Default Weight** | `0.15` (user-configurable) |
| **Source File** | [`src/signals/factors/buy-sell-ratio.ts`](../src/signals/factors/buy-sell-ratio.ts) |
| **Data Source** | GMGN intercepted transaction data |

**Algorithm:**

The factor computes the ratio of buy transactions to sell transactions over a recent time window (typically 5–15 minutes) using intercepted GMGN data.

**Scoring Curve:**

| Buy/Sell Ratio | Sub-Score Range | Interpretation |
|---------------|-----------------|----------------|
| < 0.8× | 0–5 | Heavy selling pressure |
| 0.8×–1.0× | 5–15 | Balanced / slight selling |
| 1.0×–1.3× | 15–30 | Balanced / slight buying |
| 1.3×–2.0× | 30–60 | Accumulation signal |
| 2.0×–3.0× | 60–80 | Strong accumulation |
| > 3.0× | 80–100 | Extreme buying pressure |

**Thresholds:**

- **≥ 1.3×** — Minimum ratio required for a base accumulation signal. Below this, the factor contributes minimal score.
- **≥ 2.0×** — When combined with an active volume spike (Factor 1 score > 50), the buy/sell ratio score is amplified by **1.25×** for day-trade mode entries.

---

### 4. Holder Growth Tracking

Analyzes the trajectory of unique token holders over time, distinguishing organic adoption from artificial (bot-driven) growth.

| Property | Value |
|----------|-------|
| **Default Weight** | `0.10` (user-configurable) |
| **Source File** | [`src/signals/factors/holder-growth.ts`](../src/signals/factors/holder-growth.ts) |
| **Data Source** | GMGN intercepted holder data, Birdeye top holders API |

**Algorithm:**

The factor tracks the holder count trajectory and evaluates the quality of growth:

**Positive Signals (increase score):**

- **Organic growth** — New holders who retain tokens for **≥ 24 hours** indicate genuine interest rather than speculative flipping.
- **Steady growth rate** — Consistent, non-parabolic holder growth over hours suggests sustainable demand.
- **Diverse holder sizes** — A wide distribution of position sizes indicates broad market participation.

**Negative Signals (decrease score):**

- **Bot-like creation patterns** — Many new wallets appearing in quick succession with identical or near-identical token amounts strongly suggests artificial holder inflation.
- **Rapid holder churn** — High turnover where new holders sell within minutes of buying.
- **Concentrated growth** — A small number of wallets fragmenting holdings across many sub-wallets.

**Scoring:**

| Pattern | Sub-Score Range |
|---------|-----------------|
| Bot-like holder inflation detected | 0–10 |
| High holder churn (< 1h average hold) | 10–25 |
| Neutral / insufficient data | 25–40 |
| Moderate organic growth | 40–65 |
| Strong organic growth + diverse holders | 65–85 |
| Exceptional organic growth + high retention | 85–100 |

---

### 5. Liquidity Validation

Validates that sufficient liquidity exists to enter and exit positions safely, and that the liquidity pool is secured (burned or locked).

| Property | Value |
|----------|-------|
| **Default Weight** | `0.15` (user-configurable) |
| **Source File** | [`src/signals/factors/liquidity.ts`](../src/signals/factors/liquidity.ts) |
| **Data Source** | Birdeye token overview, GMGN intercepted data, LP analyzer |

**Minimum Liquidity Thresholds:**

| Token Stage | Minimum Liquidity | Rationale |
|------------|-------------------|-----------|
| Early pump.fun tokens (< 1h old) | **$3,000** | Minimum viable liquidity for micro-positions |
| Established tokens (> 1h old) | **$30,000** | Standard liquidity floor for safe trading |

If the token's liquidity is below the applicable minimum, the factor returns a score of **0**.

**Position Safety Rule:**

The token's trading volume must be at least **10× the intended position size** to ensure safe exits without excessive slippage. For example, a $500 position requires at least $5,000 in recent volume.

**LP Analysis:**

The factor checks LP (Liquidity Pool) token status via `src/safety/lp-analyzer.ts`:

| LP Status | Score Impact |
|-----------|-------------|
| LP tokens burned (sent to burn address) | +30 bonus |
| LP tokens locked in a timelock contract | +20 bonus |
| LP tokens unlocked and held by deployer | -20 penalty |
| No LP information available | -10 penalty |

The burn address used for Solana LP verification is: `1nc1nerator11111111111111111111111111111111`

**Scoring:**

| Liquidity Level | LP Status | Sub-Score Range |
|----------------|-----------|-----------------|
| Below minimum | Any | 0 |
| At minimum | Not burned/locked | 10–25 |
| At minimum | Burned/Locked | 30–50 |
| 2×–5× minimum | Not burned/locked | 25–45 |
| 2×–5× minimum | Burned/Locked | 50–75 |
| > 5× minimum | Burned/Locked | 75–100 |

> **Reference:** [`src/safety/lp-analyzer.ts`](../src/safety/lp-analyzer.ts)

---

### 6. Token Age Filters

Filters tokens by their creation timestamp — the signal engine is optimized for early-stage memecoin discovery where timing is critical.

| Property | Value |
|----------|-------|
| **Default Weight** | `0.10` (user-configurable) |
| **Source File** | [`src/signals/factors/token-age.ts`](../src/signals/factors/token-age.ts) |
| **Data Source** | On-chain creation timestamp, GMGN intercepted metadata |

**Scoring Tiers:**

| Token Age | Mode | Sub-Score Range | Rationale |
|-----------|------|-----------------|-----------|
| ≤ 30 minutes | Ultra-early | 90–100 | Maximum alpha potential; highest risk/reward |
| 30 min – 3 hours | Early accumulation | 70–90 | Primary target zone for memecoin sniping |
| 3 – 6 hours | Mid discovery | 50–70 | Still viable for momentum plays |
| 6 – 12 hours | Gem scanning | 30–50 | Moderate opportunity; much alpha captured |
| 12 – 24 hours | Late entry | 10–30 | Most initial pump captured; lower upside |
| > 24 hours | Stale | 0–10 | Diminishing returns; rarely generates signals |

**Notes:**

- Token creation timestamps are sourced from on-chain data (Solana slot/block time) or GMGN's internal metadata.
- The score decreases approximately linearly within each tier, ensuring smooth transitions.
- The ≤ 3-hour window corresponds to the **early accumulation** phase referenced in the AAP where the highest alpha opportunities exist.
- The 12-hour maximum corresponds to the **gem scanning** cutoff — tokens older than 12 hours are unlikely to produce meaningful signals.

---

### 7. Safety Score

Integrates multi-source security analysis from RugCheck, GoPlus Security, and Jupiter honeypot simulation to assess token safety.

| Property | Value |
|----------|-------|
| **Default Weight** | `0.10` (user-configurable) |
| **Source File** | [`src/signals/factors/safety-score.ts`](../src/signals/factors/safety-score.ts) |
| **Data Source** | RugCheck API, GoPlus Security API, Jupiter swap simulation |

**Algorithm:**

The factor delegates to the multi-source safety orchestrator (`src/safety/checker.ts`), which calls **RugCheck and GoPlus concurrently** via `Promise.allSettled`. Results are merged with **worst-case-wins** logic — if either source flags a critical issue, the token is penalized even if the other source reports clean.

**RugCheck Integration:**

| RugCheck Score | Safety Assessment |
|---------------|-------------------|
| ≥ 300 | High safety — token passes structural checks |
| 200–299 | Moderate concerns — some risk factors present |
| 100–199 | Significant risks — multiple warning flags |
| < 100 | Critical risks — likely unsafe |

**GoPlus Security Checks:**

| Check | Clean Result | Flagged Result |
|-------|-------------|----------------|
| Mint Authority | Revoked (immutable supply) | **Active** — token supply can be inflated |
| Freeze Authority | Revoked (accounts unfrozen) | **Active** — holder accounts can be frozen |
| Holder Concentration | Top holder < 20% | **> 20%** — high concentration risk |
| LP Status | Locked or burned | Unlocked and held by deployer |

**Penalties:**

| Condition | Score Penalty |
|-----------|--------------|
| Active mint authority | -30 |
| Active freeze authority | -25 |
| Top holder concentration > 20% | -20 |
| Mutable metadata | -10 |
| RugCheck score < 200 | -20 |

**Honeypot Check (Prerequisite):**

Before any scoring, the token must pass a **Jupiter sell simulation** via `src/safety/honeypot-detector.ts`. The detector requests a quote for a small TOKEN → SOL swap. If the quote is valid, the token is sellable. If the quote fails or times out, the token is flagged as a potential honeypot and receives a safety score of **0**.

**Scoring:**

| Scenario | Sub-Score Range |
|----------|-----------------|
| Honeypot detected (sell simulation failed) | 0 |
| RugCheck < 200 + active authorities | 0–15 |
| RugCheck 200–299 + some concerns | 15–40 |
| RugCheck ≥ 300 + one active authority | 40–60 |
| RugCheck ≥ 300 + GoPlus clean + LP concerns | 60–80 |
| RugCheck ≥ 300 + GoPlus clean + LP burned | 80–100 |

> **References:** [`src/safety/checker.ts`](../src/safety/checker.ts), [`src/safety/honeypot-detector.ts`](../src/safety/honeypot-detector.ts)

---

## Default Weight Configuration

The following table shows the **default weights** for each scoring factor. All weights are user-configurable through the extension's Settings panel and are stored in the Zustand `settings-store`. The scoring engine reads these weights dynamically at analysis time.

| # | Factor | Default Weight | Description |
|---|--------|---------------|-------------|
| 1 | Volume Spike Detection | **0.20** | Trading volume surge analysis |
| 2 | Smart Money Convergence | **0.20** | Multi-wallet convergence detection |
| 3 | Buy/Sell Ratio Analysis | **0.15** | Directional pressure assessment |
| 4 | Holder Growth Tracking | **0.10** | Organic adoption trajectory |
| 5 | Liquidity Validation | **0.15** | Liquidity depth and LP security |
| 6 | Token Age Filters | **0.10** | Creation time relevance scoring |
| 7 | Safety Score | **0.10** | Multi-source security analysis |
| | **Total** | **1.00** | |

> **Constraint:** Weights must always sum to **1.0**. The Settings panel UI enforces this constraint when users adjust individual weights.

### Example: Conservative Weight Profile

For risk-averse traders who prioritize safety and verified smart money activity over speed:

| Factor | Conservative Weight | Rationale |
|--------|-------------------|-----------|
| Volume Spike | 0.10 | Lower weight — volume alone is unreliable |
| Smart Money Convergence | **0.25** | Highest signal — verified wallet convergence |
| Buy/Sell Ratio | 0.05 | Lower emphasis — easily manipulated |
| Holder Growth | 0.10 | Moderate — supports safety thesis |
| Liquidity | **0.15** | Important — ensures safe exits |
| Token Age | 0.05 | Lower emphasis — safety > speed |
| Safety Score | **0.30** | Maximum weight — safety is paramount |
| **Total** | **1.00** | |

### Example: Aggressive Weight Profile

For momentum traders willing to accept higher risk for earlier entries:

| Factor | Aggressive Weight | Rationale |
|--------|------------------|-----------|
| Volume Spike | **0.20** | Highest priority — momentum-driven entries |
| Smart Money Convergence | 0.15 | Still valuable but less decisive |
| Buy/Sell Ratio | **0.15** | Buy pressure is a key entry signal |
| Holder Growth | 0.10 | Moderate importance |
| Liquidity | 0.10 | Minimum viability check |
| Token Age | **0.15** | Freshness is critical for alpha |
| Safety Score | 0.15 | Reduced but not eliminated |
| **Total** | **1.00** | |

> **Source:** Weight configuration is stored in and retrieved from [`src/store/settings-store.ts`](../src/store/settings-store.ts)

---

## Hard Filter Gates

Hard filters are **absolute binary pass/fail safety gates** that run before the composite scoring calculation. If **any** hard filter fails, the token is immediately classified as **SKIP** regardless of how high the composite score would be.

> **Rule (AAP §0.7.3):** Hard filters cannot be overridden by high scores in other factors. They are non-negotiable safety checks.

**Source file:** [`src/signals/hard-filters.ts`](../src/signals/hard-filters.ts)

### Hard Filter Conditions

| # | Filter | Fail Condition | Rationale |
|---|--------|---------------|-----------|
| 1 | **Bundled Launch Detection** | > 10% of token supply acquired by sniper wallets in the launch bundle | Indicates insider/sniper manipulation at token creation |
| 2 | **Mint Authority** | Mint authority is active (not revoked) | Token supply can be inflated at any time, enabling rug pulls |
| 3 | **Freeze Authority** | Freeze authority is active (not revoked) | Holder accounts can be frozen, preventing sells |
| 4 | **LP Lock/Burn** | No LP lock or burn detected | Deployer can rug by removing liquidity at any time |
| 5 | **Minimum Liquidity** | Total liquidity < $3,000 | Insufficient liquidity for any meaningful position |
| 6 | **Top Holder Concentration** | Top 10 holders own > 50% of total supply | Extreme concentration risk — large holders can dump |

### Return Type

```typescript
interface HardFilterResult {
  passed: boolean;           // true if ALL filters pass
  failedFilters: string[];   // Names of filters that failed (empty if passed)
}
```

### Evaluation Order

Hard filters are evaluated **before** the 7 scoring factors execute. This is a deliberate optimization — if a token fails any hard filter, the engine skips the more expensive factor computations (API calls, convergence detection, AI analysis), saving both latency and API credits.

```
Token Input → Hard Filters → [FAIL: SKIP] or [PASS: Continue to Factor Scoring]
```

---

## Trading Modes

The extension supports two trading modes that control the minimum composite score required to generate a BUY signal. Users toggle between modes via the Settings panel or the extension Popup.

### Conservative Mode

| Property | Value |
|----------|-------|
| **Minimum Score** | ≥ 80 |
| **Target Trader** | Risk-averse; prefers fewer, higher-quality signals |
| **Signal Frequency** | Lower — only top-tier setups trigger |
| **Recommended Weights** | Higher safety, smart money, and liquidity weights |

### Aggressive Mode

| Property | Value |
|----------|-------|
| **Minimum Score** | ≥ 45 |
| **Target Trader** | Momentum-focused; accepts moderate risk for earlier entries |
| **Signal Frequency** | Higher — more signals with varying confidence levels |
| **Recommended Weights** | Higher volume spike, buy/sell ratio, and token age weights |

### Signal Decision Matrix

| Condition | Decision |
|-----------|----------|
| Hard filters pass **AND** composite score ≥ mode threshold | **BUY** |
| Hard filters fail **OR** composite score < mode threshold | **SKIP** |
| Active position meets exit criteria | **EXIT** |

The active trading mode is stored in `settings-store.tradingMode` and can be changed at any time. Changing the mode immediately affects how new signals are evaluated but does not retroactively change existing signal decisions.

> **Source:** [`src/store/settings-store.ts`](../src/store/settings-store.ts)

---

## Exit Strategy

The exit signal monitor continuously evaluates active positions against configurable take-profit (TP) ladders, stop-loss (SL) thresholds, and hard exit triggers. Exit signals are generated independently from entry signals — once a position is opened, the exit monitor tracks it until fully closed.

**Source file:** [`src/signals/exit-signals.ts`](../src/signals/exit-signals.ts)

### Ladder Take-Profit Strategy

The default exit strategy uses a **progressive ladder** that systematically reduces position size as profit targets are reached:

| Step | Action | Trigger Price | Rationale |
|------|--------|--------------|-----------|
| 1 | Sell **50%** of position | **2× entry price** (100% gain) | Lock in initial profit; recover capital |
| 2 | Sell **25%** of position | **5× entry price** (400% gain) | Take substantial profit on continued momentum |
| 3 | Sell **25%** of position | **10× entry price** (900% gain) | Capture outsized gains |
| 4 | Let remainder ride | **Trailing stop** | Maximize upside on exceptional runners |

The trailing stop for the remainder activates after the 10× target is reached and trails at a configurable percentage below the highest price achieved (default: 25% trailing distance).

### Day-Trade TP/SL Profile

Optimized for short-duration trades (minutes to hours):

| Parameter | Value |
|-----------|-------|
| Take Profit Level 1 | **+15%** |
| Take Profit Level 2 | **+30%** |
| Take Profit Level 3 | **+60%** |
| Stop Loss | **-12%** |
| Typical Hold Time | Minutes to a few hours |

### Swing-Trade TP/SL Profile

Optimized for medium-duration positions (hours to days):

| Parameter | Value |
|-----------|-------|
| Take Profit Level 1 | **+40%** |
| Take Profit Level 2 | **+100%** |
| Take Profit Level 3 | **+200%** |
| Take Profit Level 4 | **+500%** |
| Stop Loss | **-18%** |
| Typical Hold Time | Hours to multiple days |

### Hard Exit Triggers

Certain conditions trigger an **immediate full exit** regardless of current profit/loss, as they indicate imminent danger of significant loss:

| # | Trigger | Condition | Severity |
|---|---------|-----------|----------|
| 1 | **Dev Wallet Selling** | The token deployer's wallet begins selling tokens | 🔴 Critical — strongest rug signal |
| 2 | **Smart Money Exit** | Tracked smart money wallets reduce their position by **40–60%** | 🟠 High — informed money leaving |
| 3 | **Volume Decline** | Volume-to-market-cap ratio falls below **10%** | 🟡 Moderate — momentum exhaustion |
| 4 | **Price Target Reached** | Price hits the configured TP ladder level | 🟢 Planned — profitable exit |

When a hard exit trigger fires, the exit signal monitor emits an `EXIT` decision for the affected position. Multiple triggers may fire simultaneously — in that case, the highest-severity trigger is reported.

### Configuration

All exit strategy parameters (TP levels, SL thresholds, trailing stop distances) are user-configurable through the Settings panel. Custom profiles can be created for different trading styles.

> **Positions tracked in:** [`src/store/position-store.ts`](../src/store/position-store.ts)

---

## AI/LLM Enhanced Analysis

Tokens that pass hard filters and achieve a minimum composite score are forwarded to the **three-tier LLM analysis router** for AI-enhanced evaluation. The AI layer provides nuanced narrative analysis that pure quantitative scoring cannot capture.

> **Rule (AAP §0.7.3):** Never send a token to the LLM tier unless it has passed both hard filters and achieved a minimum composite score threshold. This prevents wasting LLM credits on tokens that would be filtered out regardless.

### Three-Tier Model Routing

The LLM router selects the appropriate model based on the initial composite score, balancing analysis depth against API cost:

| Tier | Model | Composite Score | % of Calls | Purpose | Cost |
|------|-------|----------------|------------|---------|------|
| 1 (Fast) | `llama-3.1-8b-instant` | < 45 | ~80% | Quick pass/fail screening | Lowest |
| 2 (Detailed) | `llama-3.3-70b-versatile` | 45–80 | ~15% | Detailed multi-dimension analysis | Moderate |
| 3 (Narrative) | Claude Sonnet | > 80 | ~5% | Deep narrative analysis for top signals | Highest |

This **80/15/5 distribution** reduces LLM costs by approximately **60%** compared to routing all tokens through the most capable model. Combined with Groq's prompt caching (50% discount on cached input tokens), the expected monthly LLM cost is **$5–$15**.

### 5 Analysis Dimensions

Each LLM analysis evaluates the token across 5 independent dimensions, with structured JSON output for consistent parsing:

| # | Dimension | What It Evaluates | Key Inputs |
|---|-----------|-------------------|------------|
| 1 | **On-Chain Momentum** | Buy/sell ratio acceleration in the first 5 minutes of trading | Transaction data, order flow direction |
| 2 | **Social Velocity** | Rate of change in social media mentions (tweet rate acceleration) | Token name/symbol social signal data |
| 3 | **Wallet Intelligence** | Whether known profitable wallets are accumulating | Smart money wallet activity, win rate history |
| 4 | **Liquidity Health** | LP structure, bundle detection, creator wallet behavior | LP burn/lock status, deployer activity |
| 5 | **Narrative Fit** | Alignment of token name/theme with current memecoin meta trends | Token metadata, trending narratives |

Each dimension receives a score from 0–100. The LLM also provides a human-readable **narrative summary** explaining its assessment and a confidence level (`high`, `medium`, `low`).

### Response Caching

All LLM responses are cached in `chrome.storage.local` with a **5-minute TTL**, keyed by `{token_mint}:{analysis_tier}`. Duplicate analysis requests within the TTL window return the cached result instantly, further reducing API costs and latency.

> **Source files:** [`src/ai/router.ts`](../src/ai/router.ts), [`src/ai/prompts.ts`](../src/ai/prompts.ts), [`src/ai/response-parser.ts`](../src/ai/response-parser.ts)

---

## Pump.fun Token Considerations

The signal engine includes special handling for tokens launched on **pump.fun**, Solana's primary memecoin launchpad.

### Graduation Rate

Only **0.4%–1.8%** of pump.fun tokens ever graduate to decentralized exchanges (DEXes). The vast majority of tokens fail to complete their bonding curve and become worthless. The signal engine accounts for this extreme failure rate by:

- **Filtering for bonding curve progress ≥ 30%** — Tokens below 30% completion are excluded from analysis, as they have a very low probability of graduating and reaching tradeable liquidity on DEXes.
- **Applying stricter safety thresholds** to pump.fun tokens compared to established DEX-listed tokens.
- **Monitoring migration events** via PumpPortal WebSocket's `subscribeMigration` subscription to detect tokens transitioning from pump.fun to Raydium or other DEXes.

### Token-2022 Extension Risks

Modern Solana tokens using the **Token-2022** program may include extension features that introduce novel rug pull vectors not caught by standard security checks:

| Extension | Risk |
|-----------|------|
| **PermanentDelegate** | Allows a designated authority to transfer or burn tokens from any holder's account at any time, without the holder's permission. Effectively an unrevocable backdoor. |
| **DefaultAccountState: frozen** | All new token accounts are created in a frozen state by default, requiring the freeze authority to explicitly unfreeze each account. Can be used to selectively prevent selling. |

The safety score factor and hard filters both check for these Token-2022 extensions. Tokens with `PermanentDelegate` active are treated as having an active and unrevocable authority, resulting in an automatic hard filter failure.

---

## Signal Pipeline Data Flow

The following diagram illustrates the complete signal processing pipeline from data ingestion through final signal output:

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA INGESTION LAYER                      │
├─────────────────┬──────────────────┬────────────────────────┤
│  GMGN.ai Page   │  PumpPortal WS   │    Birdeye REST API   │
│  (Intercepted)  │  (New Tokens)    │    (Token Analytics)   │
└────────┬────────┴────────┬─────────┴──────────┬─────────────┘
         │                 │                     │
         ▼                 ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│                     TOKEN DATA MERGE                         │
│         Normalize and deduplicate from all sources           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               STEP 1: HARD FILTER GATES                      │
│  Bundled Launch │ Mint Auth │ Freeze Auth │ LP Lock │ etc.  │
│                                                              │
│  FAIL → Immediately SKIP (no further processing)            │
│  PASS → Continue to factor scoring                          │
└──────────────────────────┬──────────────────────────────────┘
                           │ (Pass)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│          STEP 2: 7-FACTOR PARALLEL SCORING                   │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Volume   │ │ Smart $  │ │ Buy/Sell │ │ Holder   │       │
│  │ Spike    │ │ Converge │ │ Ratio    │ │ Growth   │       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘       │
│       │             │            │             │             │
│  ┌────┴─────┐ ┌────┴─────┐ ┌────┴─────┐                    │
│  │Liquidity │ │Token Age │ │ Safety   │                    │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                    │
│       │             │            │                           │
│       └─────────────┴────────────┘                           │
│                     │                                        │
│                     ▼                                        │
│         Weighted Sum → Composite Score (0–100)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│        STEP 3: TRADING MODE THRESHOLD CHECK                  │
│                                                              │
│  Conservative: Score ≥ 80 → Continue                        │
│  Aggressive:   Score ≥ 45 → Continue                        │
│  Below threshold → SKIP                                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ (Above threshold)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│           STEP 4: AI/LLM ENHANCED ANALYSIS                   │
│                                                              │
│  Score < 45  → llama-3.1-8b-instant (quick screen)         │
│  Score 45–80 → llama-3.3-70b-versatile (detailed)          │
│  Score > 80  → Claude Sonnet (narrative)                    │
│                                                              │
│  5 Dimensions: Momentum │ Social │ Wallets │ LP │ Narrative │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              STEP 5: SIGNAL OUTPUT                            │
│                                                              │
│  Decision: BUY │ SKIP │ EXIT                                │
│  → Written to signal-store (Zustand)                        │
│  → Propagated to UI via chrome.storage.onChanged            │
│  → Displayed in SignalPanel / TokenCard components           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│         STEP 6: EXIT SIGNAL MONITORING                       │
│                                                              │
│  Active positions tracked in position-store                 │
│  Monitored for: TP ladder │ SL threshold │ Hard exit        │
│  Triggers: Dev sell │ Smart $ exit │ Volume decline          │
│                                                              │
│  EXIT triggered → Alert displayed in ExitStrategy component │
└─────────────────────────────────────────────────────────────┘
```

### Pipeline Summary

1. **Token data arrives** from one or more sources: GMGN page interception, PumpPortal WebSocket (new token events), or Birdeye REST API (enrichment).
2. **Hard filters applied** — tokens failing any binary safety gate are immediately classified as SKIP with no further processing.
3. **7 factor modules execute in parallel** via `Promise.allSettled`, each producing a 0–100 sub-score.
4. **Weighted composite score computed** using the user's configured factor weights.
5. **Score compared against trading mode threshold** — Conservative (≥ 80) or Aggressive (≥ 45).
6. **If above threshold**, the token is forwarded to the **AI/LLM analysis** tier for enhanced evaluation.
7. **Final signal written** to the Zustand `signal-store`, which propagates to the Preact UI via `chrome.storage.onChanged` listeners.
8. **Active positions continuously monitored** for exit triggers — TP ladder, SL thresholds, and hard exit conditions (dev sell, smart money exit, volume decline).

---

## Appendix: Source File Reference

| Module | File | Description |
|--------|------|-------------|
| Scoring Engine | `src/signals/scoring-engine.ts` | Composite scoring orchestrator |
| Signal Types | `src/signals/types.ts` | `CompositeSignal`, `FactorResult`, `TradingMode` definitions |
| Volume Spike | `src/signals/factors/volume-spike.ts` | 5-minute MA spike detection |
| Smart Money | `src/signals/factors/smart-money-convergence.ts` | Multi-wallet convergence scoring |
| Buy/Sell Ratio | `src/signals/factors/buy-sell-ratio.ts` | Directional pressure analysis |
| Holder Growth | `src/signals/factors/holder-growth.ts` | Organic vs. bot growth tracking |
| Liquidity | `src/signals/factors/liquidity.ts` | Liquidity depth and LP validation |
| Token Age | `src/signals/factors/token-age.ts` | Creation time scoring |
| Safety Score | `src/signals/factors/safety-score.ts` | Multi-source safety aggregation |
| Hard Filters | `src/signals/hard-filters.ts` | Binary pass/fail safety gates |
| Exit Signals | `src/signals/exit-signals.ts` | Position exit trigger monitor |
| Safety Checker | `src/safety/checker.ts` | RugCheck + GoPlus orchestrator |
| Honeypot Detector | `src/safety/honeypot-detector.ts` | Jupiter sell simulation |
| LP Analyzer | `src/safety/lp-analyzer.ts` | LP burn/lock verification |
| Convergence Detector | `src/tracking/convergence-detector.ts` | Time-windowed wallet convergence |
| Wallet Classifier | `src/tracking/wallet-classifier.ts` | Wallet type classification |
| AI Router | `src/ai/router.ts` | Three-tier LLM dispatch |
| AI Prompts | `src/ai/prompts.ts` | Analysis dimension prompt templates |
| AI Response Parser | `src/ai/response-parser.ts` | Structured JSON response parsing |
| Signal Store | `src/store/signal-store.ts` | Active signals Zustand store |
| Settings Store | `src/store/settings-store.ts` | User preferences and weights |
| Position Store | `src/store/position-store.ts` | Tracked positions Zustand store |
