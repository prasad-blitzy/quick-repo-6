/**
 * Trade Detection Node — LangGraph Analysis Pipeline Stage 3
 *
 * Performs **trade opportunity detection** using **Claude Haiku 4.5** via
 * OpenRouter ($1.00 input / $5.00 output per 1M tokens). Identifies
 * actionable trade signals — specific events that create short-term
 * trading opportunities with symbol, direction (LONG/SHORT), timeframe,
 * and signal strength.
 *
 * Pipeline position: filter → sentiment → **tradeDetect** → (conditional)
 *
 * A conditional edge after this node routes to the expensive recommendation
 * model (Claude Sonnet 4.6) ONLY when `tradeDetected === true` (~25% of
 * articles that reach this stage). When `tradeDetected === false`, the
 * pipeline terminates at END, avoiding the $3.00/$15.00 recommendation cost.
 *
 * CRITICAL — AAP Rule 0.7.3:
 *   - Temperature = 0 for deterministic financial analysis (enforced by models.ts)
 *   - Structured output via `withStructuredOutput(TradeDetectionResultSchema)`
 *   - DK-CoT prompting with trade signal detection domain knowledge
 *   - Anti-hallucination: no fabricated trading levels or support/resistance
 *
 * @module services/analyzer/nodes/trade-detect
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";

import type { AnalyzerState } from "../state.js";
import { TradeDetectionResultSchema } from "../schemas.js";
import {
  TRADE_DETECT_SYSTEM_PROMPT,
  buildArticlePrompt,
} from "../prompts.js";
import { getTradeDetectModel } from "../models.js";
import { createLogger } from "../../../lib/logger.js";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "analyzer:trade-detect" }` context for
 * structured logging of the trade detection lifecycle: pipeline start with
 * article ID and title, successful detection results (tradeDetected, symbol,
 * direction, signalStrength), and error handling.
 */
const logger = createLogger("analyzer:trade-detect");

// ---------------------------------------------------------------------------
// Trade Detection Node Function
// ---------------------------------------------------------------------------

/**
 * LangGraph node function for Stage 3 — Trade Opportunity Detection.
 *
 * Receives the full `AnalyzerState` (which includes the article data and
 * results from prior filter and sentiment stages) and returns a partial
 * state update with trade detection results.
 *
 * The function:
 *   1. Guards against null article input (fail-safe → `tradeDetected: false`)
 *   2. Creates a Claude Haiku 4.5 model instance via `getTradeDetectModel()`
 *   3. Attaches Zod-based structured output via `withStructuredOutput()`
 *   4. Constructs SystemMessage (DK-CoT trade signal prompt) and HumanMessage
 *   5. Invokes the model and returns the typed `TradeDetectionResult`
 *   6. On error, returns `tradeDetected: false` to prevent routing to the
 *      expensive recommendation model (fail-safe cost protection)
 *
 * @param state - Full LangGraph pipeline state containing the article and
 *                results from prior stages (filter, sentiment).
 * @returns Partial state update with `tradeDetected`, `tradeDetails`,
 *          `pipelineStep`, and optionally `errors`.
 */
export async function tradeDetectNode(
  state: AnalyzerState,
): Promise<Partial<AnalyzerState>> {
  const article = state.article;

  // ---------------------------------------------------------------------------
  // Null Article Guard — fail-safe: no article means no trade detection
  // ---------------------------------------------------------------------------
  if (!article) {
    logger.error("Trade detect node received null article");
    return {
      tradeDetected: false,
      tradeDetails: null,
      pipelineStep: "trade_detect",
      errors: ["Trade detect node received null article"],
    };
  }

  logger.info(
    { articleId: article.id, title: article.title },
    "Starting trade detection",
  );

  try {
    // -----------------------------------------------------------------------
    // Step 1 — Create Claude Haiku 4.5 model with structured output
    // -----------------------------------------------------------------------
    // getTradeDetectModel() returns a ChatOpenAI instance configured for
    // Claude Haiku 4.5 via OpenRouter with temperature: 0 (deterministic).
    const model = getTradeDetectModel();

    // withStructuredOutput binds the TradeDetectionResultSchema Zod schema,
    // ensuring the LLM response is validated and typed at runtime.
    const modelWithOutput = model.withStructuredOutput(
      TradeDetectionResultSchema,
    );

    // -----------------------------------------------------------------------
    // Step 2 — Construct chat messages
    // -----------------------------------------------------------------------
    // SystemMessage contains the TRADE_DETECT_SYSTEM_PROMPT with:
    //   - DK-CoT domain knowledge (earnings catalysts, technical triggers,
    //     event-driven opportunities, crypto-specific triggers)
    //   - Signal strength assessment criteria
    //   - Anti-hallucination instructions
    //   - 3 few-shot examples (NVDA long, general commentary no-trade, LUNA short)
    const systemMessage = new SystemMessage(TRADE_DETECT_SYSTEM_PROMPT);

    // HumanMessage contains the formatted article content with title,
    // source, market, symbols, and full article body text.
    const humanMessage = new HumanMessage(buildArticlePrompt(article));

    // -----------------------------------------------------------------------
    // Step 3 — Invoke model and receive typed structured output
    // -----------------------------------------------------------------------
    const result = await modelWithOutput.invoke([systemMessage, humanMessage]);

    logger.info(
      {
        articleId: article.id,
        tradeDetected: result.tradeDetected,
        symbol: result.symbol,
        direction: result.direction,
        signalStrength: result.signalStrength,
      },
      "Trade detection complete",
    );

    // -----------------------------------------------------------------------
    // Step 4 — Return partial state update
    // -----------------------------------------------------------------------
    // CRITICAL: `tradeDetected` is consumed by the conditional edge in
    // `../index.ts` to decide whether to route to the recommend node
    // (tradeDetected === true) or END (tradeDetected === false).
    return {
      tradeDetected: result.tradeDetected,
      tradeDetails: result,
      pipelineStep: "trade_detect",
    };
  } catch (error: unknown) {
    // -----------------------------------------------------------------------
    // Error Handling — fail-safe: tradeDetected = false prevents routing
    // to the expensive recommendation model (Claude Sonnet 4.6 at
    // $3.00/$15.00 per 1M tokens).
    // -----------------------------------------------------------------------
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Unknown trade detection error";

    logger.error(
      { articleId: article.id, error },
      "Trade detect node failed",
    );

    return {
      tradeDetected: false,
      tradeDetails: null,
      pipelineStep: "trade_detect",
      errors: [`Trade detect error: ${errorMessage}`],
    };
  }
}
