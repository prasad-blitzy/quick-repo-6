/**
 * Analysis Pipeline Worker — Trading Intelligence API
 *
 * BullMQ Worker that processes jobs from the `analysis` queue, running each
 * news article through the four-stage LangGraph AI analysis pipeline:
 *
 *   Filter (DeepSeek V3.2) → Sentiment (Claude Haiku 4.5) →
 *   Trade Detection (Claude Haiku 4.5) → Recommendation (Claude Sonnet 4.6)
 *
 * The pipeline uses conditional short-circuiting — approximately 75% of
 * articles are filtered out at the first stage, and only ~25% reach the
 * expensive recommendation model. This tiered architecture achieves ~75%
 * LLM cost reduction compared to running every article through all stages.
 *
 * Data flow per job:
 * ```
 * analysis queue job { articleId, isBreakingNews }
 *   → fetch article from news_articles table
 *   → analyzeArticle(articleInput)
 *     → LangGraph: filter → (sentiment → tradeDetect → recommend)
 *     → returns AnalyzerState
 *   → insert analysis_logs record
 *   → if recommendation:
 *       → insert trade_opportunities record
 *       → enqueueNotification(opportunityId, isBreakingNews)
 *   → update news_articles.is_analyzed = true
 * ```
 *
 * Worker configuration:
 *   - **Concurrency**: Controlled via `ANALYSIS_CONCURRENCY` env var (default: 3)
 *     to respect OpenRouter API rate limits (AAP Rule 0.7.6).
 *   - **Retry**: Exponential backoff is configured on the queue's
 *     `defaultJobOptions` (3 attempts, 5s base delay) and inherited by this
 *     worker. The processor re-throws pipeline errors for BullMQ retry handling.
 *   - **Idempotency**: Articles already marked as `is_analyzed = true` are
 *     skipped to prevent duplicate processing across retries.
 *
 * AAP compliance:
 *   - Three SEPARATE worker instances (Rule 0.7.6): This file defines ONLY
 *     the analysis worker with its own dedicated Worker instance.
 *   - TypeScript strict mode (Rule 0.7.1): Compiles under strict, noUncheckedIndexedAccess,
 *     exactOptionalPropertyTypes, noImplicitReturns.
 *   - Financial decimal precision (Rule 0.7.2): All price fields stored as
 *     strings mapped to PostgreSQL numeric(12,4).
 *   - ESM-first (Rule 0.7.1): All local import paths use `.js` extension.
 *   - Pino structured logging: Dedicated child logger with `"worker:analysis"` context.
 *
 * @module queues/workers/analysis.worker
 * @see {@link https://docs.bullmq.io/guide/workers} BullMQ Worker Documentation
 */

import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { eq } from "drizzle-orm";

import { connection } from "../connection.js";
import type { AnalysisJobData } from "../analysis.queue.js";
import { enqueueNotification } from "../notifications.queue.js";
import { QUEUE_NAMES } from "../../config/constants.js";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { newsArticles } from "../../db/schema/news-articles.js";
import { tradeOpportunities } from "../../db/schema/trade-opportunities.js";
import { analysisLogs } from "../../db/schema/analysis-logs.js";
import { analyzeArticle } from "../../services/analyzer/index.js";
import type { AnalyzerState } from "../../services/analyzer/state.js";
import { createLogger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Logger — Dedicated child logger for analysis worker events
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "worker:analysis" }` context.
 * All log entries from this worker include the module field for structured
 * filtering in log aggregation tools (ELK, Datadog, CloudWatch).
 *
 * This is a DEDICATED logger for the analysis worker — NOT shared with
 * other workers (news-polling, notifications).
 */
const logger = createLogger("worker:analysis");

// ---------------------------------------------------------------------------
// Pipeline Step Database Mapping
// ---------------------------------------------------------------------------

/**
 * Valid PostgreSQL `pipeline_step` enum values accepted by the `analysis_logs`
 * table. The LangGraph pipeline state's `pipelineStep` field may contain
 * `"complete"` as a terminal marker, but the database enum only accepts
 * these four values.
 */
type ValidDbPipelineStep = "filter" | "sentiment" | "trade_detect" | "recommend";

/** Set of valid database pipeline step values for O(1) membership testing. */
const VALID_DB_PIPELINE_STEPS = new Set<string>([
  "filter",
  "sentiment",
  "trade_detect",
  "recommend",
]);

/**
 * Maps a pipeline state step string to a valid database enum value.
 *
 * The LangGraph `AnalyzerState.pipelineStep` may include `"complete"`
 * (terminal state marker) which is NOT a valid PostgreSQL `pipeline_step`
 * enum value. This function maps:
 *   - Valid enum values → returned as-is
 *   - `"complete"` or any invalid value → `"recommend"` (the last valid step,
 *     since "complete" implies all 4 stages finished)
 *
 * @param step - The pipeline step string from the LangGraph state.
 * @returns A valid PostgreSQL `pipeline_step` enum value.
 */
function toDbPipelineStep(step: string): ValidDbPipelineStep {
  if (VALID_DB_PIPELINE_STEPS.has(step)) {
    return step as ValidDbPipelineStep;
  }
  // "complete" or any unexpected value maps to "recommend" — the last
  // valid pipeline step, since terminal states imply full pipeline execution.
  return "recommend";
}

// ---------------------------------------------------------------------------
// Job Processor Function
// ---------------------------------------------------------------------------

/**
 * Processes a single analysis queue job by running the article through
 * the four-stage LangGraph AI pipeline.
 *
 * Processing steps:
 * 1. **Fetch** — Retrieve the article from `news_articles` by UUID.
 * 2. **Guard** — Skip if article not found or already analyzed (idempotency).
 * 3. **Analyze** — Invoke the compiled LangGraph pipeline via `analyzeArticle()`.
 * 4. **Log** — Insert pipeline execution results into `analysis_logs`.
 * 5. **Store** — If a trade recommendation was produced, insert into
 *    `trade_opportunities` and enqueue a notification job.
 * 6. **Mark** — Update `news_articles.is_analyzed = true` to prevent
 *    re-processing on subsequent polling cycles.
 *
 * Error handling strategy:
 * - **Pipeline failure**: Logged to `analysis_logs` with the error message,
 *   then re-thrown for BullMQ exponential backoff retry (3 attempts).
 * - **Storage failure**: Logged but NOT re-thrown — the analysis itself
 *   succeeded, only the database write failed.
 * - **Mark-as-analyzed failure**: Logged but NOT re-thrown — best-effort
 *   update that will be retried on the next polling cycle.
 *
 * @param job - BullMQ Job containing `{ articleId, isBreakingNews }` payload.
 * @throws Re-throws pipeline errors for BullMQ retry handling.
 */
async function processAnalysisJob(
  job: Job<AnalysisJobData>,
): Promise<void> {
  const { articleId, isBreakingNews } = job.data;
  const startTime = Date.now();

  logger.info(
    { jobId: job.id, articleId, isBreakingNews },
    "Processing analysis job",
  );

  // -------------------------------------------------------------------------
  // Step 1: Fetch the article from the database
  // -------------------------------------------------------------------------

  const articles = await db
    .select()
    .from(newsArticles)
    .where(eq(newsArticles.id, articleId))
    .limit(1);

  // noUncheckedIndexedAccess: articles[0] is T | undefined
  const article = articles[0];

  if (!article) {
    logger.warn(
      { articleId },
      "Article not found in database — skipping analysis",
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Step 2: Idempotency guard — skip already-analyzed articles
  // -------------------------------------------------------------------------

  if (article.isAnalyzed) {
    logger.info(
      { articleId },
      "Article already analyzed — skipping",
    );
    return;
  }

  // -------------------------------------------------------------------------
  // Step 3: Invoke the LangGraph analysis pipeline
  // -------------------------------------------------------------------------

  // Build the content string with a fallback chain:
  //   content (full body) → summary (extracted/generated) → title (always present)
  // This ensures the pipeline always receives meaningful text even when the
  // article's full body was not available from the source API.
  const analysisContent = article.content ?? article.summary ?? article.title;

  let pipelineResult: AnalyzerState;
  try {
    pipelineResult = await analyzeArticle({
      id: article.id,
      title: article.title,
      content: analysisContent,
      url: article.url,
      source: article.source,
      market: article.market,
      symbols: article.symbols ?? [],
      publishedAt: article.publishedAt.toISOString(),
    });
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown pipeline error";

    logger.error(
      { articleId, error: errorMessage },
      "Analysis pipeline failed",
    );

    // Log the failure to analysis_logs for auditing and debugging.
    // Uses "filter" as the pipeline step since the pipeline failed during
    // or before the first stage could complete.
    await db
      .insert(analysisLogs)
      .values({
        articleId,
        pipelineStep: "filter",
        modelUsed: "unknown",
        inputTokens: 0,
        outputTokens: 0,
        cost: "0",
        durationMs: Date.now() - startTime,
        result: { error: errorMessage },
        error: errorMessage,
      })
      .catch((logErr: unknown) => {
        logger.error({ logErr }, "Failed to log analysis failure");
      });

    // Re-throw for BullMQ exponential backoff retry (3 attempts, 5s base delay)
    throw error;
  }

  // -------------------------------------------------------------------------
  // Step 4: Log pipeline results to analysis_logs table
  // -------------------------------------------------------------------------

  const pipelineDuration = Date.now() - startTime;
  const dbPipelineStep = toDbPipelineStep(pipelineResult.pipelineStep);

  // Build the error field value: joined error messages or null if no errors.
  const errorField =
    pipelineResult.errors.length > 0
      ? pipelineResult.errors.join("; ")
      : null;

  // Insert a summary log entry for the overall pipeline execution.
  // Individual per-node logs may also be inserted by the node functions
  // themselves, but this entry captures the holistic pipeline outcome.
  await db
    .insert(analysisLogs)
    .values({
      articleId,
      pipelineStep: dbPipelineStep,
      modelUsed: "pipeline",
      inputTokens: 0,
      outputTokens: 0,
      cost: "0",
      durationMs: pipelineDuration,
      result: {
        isRelevant: pipelineResult.isRelevant,
        relevanceScore: pipelineResult.relevanceScore,
        tradeDetected: pipelineResult.tradeDetected,
        sentimentScore:
          pipelineResult.sentimentAnalysis?.sentimentScore ?? null,
        sentimentLabel:
          pipelineResult.sentimentAnalysis?.sentimentLabel ?? null,
        errors: pipelineResult.errors,
      },
      error: errorField,
    })
    .catch((logErr: unknown) => {
      logger.error(
        { logErr, articleId },
        "Failed to insert analysis log",
      );
    });

  // -------------------------------------------------------------------------
  // Step 5: Store trade recommendation and enqueue notification
  // -------------------------------------------------------------------------

  if (pipelineResult.recommendation && pipelineResult.tradeDetected) {
    const rec = pipelineResult.recommendation;

    try {
      // Insert the trade opportunity with all financial fields as strings
      // to preserve PostgreSQL numeric(12,4) decimal precision.
      // The TradeRecommendation Zod schema already constrains enum values
      // (market, direction, timeframe) to lowercase — matching PG enums.
      const insertedRows = await db
        .insert(tradeOpportunities)
        .values({
          articleId,
          symbol: rec.symbol,
          market: rec.market,
          direction: rec.direction,
          confidence: rec.confidence.toString(),
          entryPrice: rec.entryPrice,
          stopLoss: rec.stopLoss,
          takeProfit: rec.takeProfit,
          timeframe: rec.timeframe,
          reasoning: rec.reasoning,
          riskRewardRatio: rec.riskRewardRatio,
          status: "active",
        })
        .returning();

      // noUncheckedIndexedAccess: insertedRows[0] is TradeOpportunity | undefined
      const insertedOpportunity = insertedRows[0];

      if (insertedOpportunity) {
        logger.info(
          {
            articleId,
            opportunityId: insertedOpportunity.id,
            symbol: rec.symbol,
            direction: rec.direction,
          },
          "Trade opportunity stored",
        );

        // Enqueue notification job for subscriber matching and Telegram delivery.
        // The isBreakingNews flag propagates priority from the analysis queue
        // to the notification queue: breaking news → priority 1 (highest).
        const breakingNewsFlag = isBreakingNews ?? false;
        await enqueueNotification(insertedOpportunity.id, breakingNewsFlag);

        logger.info(
          {
            opportunityId: insertedOpportunity.id,
            isBreakingNews: breakingNewsFlag,
          },
          "Notification enqueued for trade opportunity",
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown storage error";
      logger.error(
        { articleId, error: errorMessage },
        "Failed to store trade opportunity",
      );
      // Do NOT re-throw — the analysis pipeline itself succeeded.
      // The storage failure will be visible in logs and can be manually
      // reconciled. Re-throwing would cause BullMQ to retry the entire
      // pipeline (including the expensive LLM calls) unnecessarily.
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Mark the article as analyzed
  // -------------------------------------------------------------------------

  // Always update is_analyzed = true after processing, regardless of whether
  // the article passed the filter, generated a recommendation, or accumulated
  // non-fatal errors. This prevents re-processing on subsequent polling cycles.
  await db
    .update(newsArticles)
    .set({ isAnalyzed: true })
    .where(eq(newsArticles.id, articleId))
    .catch((err: unknown) => {
      logger.error(
        { err, articleId },
        "Failed to mark article as analyzed",
      );
    });

  // -------------------------------------------------------------------------
  // Step 7: Log completion summary
  // -------------------------------------------------------------------------

  logger.info(
    {
      articleId,
      isRelevant: pipelineResult.isRelevant,
      tradeDetected: pipelineResult.tradeDetected,
      hasRecommendation: !!pipelineResult.recommendation,
      durationMs: pipelineDuration,
      finalStep: pipelineResult.pipelineStep,
    },
    "Analysis job completed",
  );
}

// ---------------------------------------------------------------------------
// BullMQ Worker Instance
// ---------------------------------------------------------------------------

/**
 * BullMQ Worker instance for the analysis queue.
 *
 * Configuration:
 *   - **Queue name**: `QUEUE_NAMES.ANALYSIS` → `"analysis"` — must match the
 *     queue name in `analysis.queue.ts` exactly.
 *   - **Processor**: `processAnalysisJob` async function defined above.
 *   - **Connection**: Shared ioredis connection from `connection.ts` with
 *     `maxRetriesPerRequest: null` (mandatory for BullMQ blocking commands).
 *     Type assertion resolves ioredis version mismatch between project ioredis
 *     and BullMQ's internal ioredis dependency under exactOptionalPropertyTypes.
 *   - **Concurrency**: `env.ANALYSIS_CONCURRENCY` (default: 3) — kept low to
 *     respect OpenRouter API rate limits per AAP Rule 0.7.6. Each concurrent
 *     job makes LLM API calls, so concurrency directly maps to parallel
 *     OpenRouter requests.
 *
 * BullMQ internally creates additional Redis connections for blocking commands
 * (BRPOPLPUSH / XREADGROUP) used to wait for new jobs. The shared `connection`
 * is used for non-blocking metadata operations.
 *
 * Exposed lifecycle methods:
 *   - `on(event, handler)` — Attach event listeners (completed, failed, error)
 *   - `close()` — Graceful shutdown: stops processing new jobs, waits for
 *     current jobs to finish, then disconnects
 *   - `pause()` — Temporarily pause job processing (can be resumed)
 *   - `resume()` — Resume a paused worker
 */
export const analysisWorker = new Worker<AnalysisJobData>(
  QUEUE_NAMES.ANALYSIS,
  processAnalysisJob,
  {
    // Type assertion resolves ioredis version mismatch between project ioredis
    // and BullMQ's internal ioredis dependency under exactOptionalPropertyTypes.
    // Both versions are wire-compatible at runtime.
    connection: connection as unknown as ConnectionOptions,
    concurrency: env.ANALYSIS_CONCURRENCY ?? 3,
  },
);

// ---------------------------------------------------------------------------
// Worker Event Handlers — Observability
// ---------------------------------------------------------------------------

/**
 * Log successful job completion with article context.
 * Fires after `processAnalysisJob` returns without throwing.
 * The processor function already logs a detailed completion summary,
 * so this handler provides a lightweight confirmation for event-based monitoring.
 */
analysisWorker.on("completed", (job: Job<AnalysisJobData>) => {
  logger.info(
    { jobId: job.id, articleId: job.data.articleId },
    "Analysis job completed successfully",
  );
});

/**
 * Log job failure with error context.
 * Fires when `processAnalysisJob` throws an error (e.g., pipeline failure)
 * and BullMQ has either exhausted all retry attempts or the job was not
 * configured for retries.
 *
 * The `job` parameter may be `undefined` if BullMQ cannot retrieve the job
 * data (e.g., Redis connection loss during failure handling).
 */
analysisWorker.on(
  "failed",
  (job: Job<AnalysisJobData> | undefined, error: Error) => {
    logger.error(
      {
        jobId: job?.id,
        articleId: job?.data?.articleId,
        error: error.message,
      },
      "Analysis job failed",
    );
  },
);

/**
 * Log worker-level errors.
 * Fires on infrastructure issues that affect the worker itself rather than
 * individual jobs: Redis connection failures, internal BullMQ errors,
 * serialization failures, etc. These errors do NOT correspond to specific
 * jobs and may indicate systemic infrastructure problems.
 */
analysisWorker.on("error", (error: Error) => {
  logger.error(
    { error: error.message },
    "Analysis worker error",
  );
});
