/**
 * The single time budget of one analysis, and the only `AbortSignal` a provider call is given.
 *
 * One deadline begins as soon as upload validation has succeeded, and every provider call of that
 * submission inherits what is left of it: up to six extraction calls and one synthesis call, plus
 * the one silent retry any of them may take. A per-call timeout cannot hold a total — seven calls
 * of thirty seconds each is three and a half minutes — so the bound is held here, once, and the
 * remainder is passed down.
 *
 * The budget is the `ANALYSIS_BUDGET_MS` constant from the shared package and is never read from
 * the environment, so no deployment can drift from the bound the suites assert. This module
 * reaches nothing beyond that constant: no network, no store, no configuration, and no clock other
 * than the reading its caller injects.
 *
 * What an expiry means is not decided here. `server/src/domain/analysis-service.ts` owns that
 * orchestration decision — `504 ANALYSIS_TIMEOUT` with nothing persisted — and consults
 * {@link Deadline.isExpired} between calls and the signals handed out by {@link Deadline.signal}
 * during them. The two never disagree: both derive from the same clock reading, and the timer
 * behind a signal carries a rounding slack so an abort never precedes the report of a spent budget.
 */

import { ANALYSIS_BUDGET_MS } from '@trade-read/shared';

/** Seams for {@link createDeadline}; both have a production default, and neither is read from the environment. */
export interface DeadlineOptions {
  /**
   * Total budget in milliseconds, defaulting to {@link ANALYSIS_BUDGET_MS}. The one caller that
   * overrides it is a test forcing an expiry deterministically with a budget of a few milliseconds;
   * there is deliberately no environment variable behind this value.
   */
  readonly budgetMs?: number;
  /**
   * Clock reading in epoch milliseconds, defaulting to `Date.now`. Injected only so a test can
   * advance time without waiting, which makes the arithmetic checkable exactly.
   */
  readonly now?: () => number;
}

/**
 * One running analysis budget, measured from creation.
 *
 * Every member reads the clock when it is called rather than sampling time once, so time spent
 * between provider calls is charged to the same budget as time spent inside them.
 */
export interface Deadline {
  /** The budget this deadline was created with, so a log line can name it without a second source. */
  readonly budgetMs: number;
  /** Epoch milliseconds at which the budget started; the anchor of {@link Deadline.elapsedMs}. */
  readonly startedAt: number;
  /** Milliseconds spent since {@link Deadline.startedAt}, floored at 0. */
  elapsedMs(): number;
  /**
   * Milliseconds left before the budget is spent, clamped to the range `0 … budgetMs`. Zero means
   * the budget is gone; a negative remainder never exists, so callers need no second guard.
   */
  remainingMs(): number;
  /** True exactly when {@link Deadline.remainingMs} is 0. */
  isExpired(): boolean;
  /**
   * A fresh signal for one provider call.
   *
   * The signal aborts when the remaining budget elapses, and is already aborted when it is called
   * on a spent deadline, so a call that begins too late fails immediately instead of waiting for a
   * timer that would fire at once. Each call takes its own signal, and the timer behind it is the
   * signal's only abort source: it is unref'd and released as it fires, so an analysis that
   * finishes early neither aborts a later call nor keeps the process alive for a budget nobody is
   * waiting on.
   */
  signal(): AbortSignal;
}

/** The abort reason carried by every signal this module hands out or has already aborted. */
function budgetSpentReason(budgetMs: number): Error {
  const reason = new Error(`The analysis budget of ${budgetMs} ms is spent.`);
  reason.name = 'TimeoutError';
  return reason;
}

/**
 * Extra millisecond added to every armed timer.
 *
 * `Date.now()` truncates to whole milliseconds, so a remainder measured from it can understate
 * the true remainder by almost a millisecond, and a timer armed for exactly that figure can fire
 * while the clock still reads one millisecond of budget left. The slack keeps the abort at or
 * after the reading {@link Deadline.isExpired} reports, so a call that begins just after an abort
 * is handed an already-aborted signal instead of a fresh, pointless wait.
 */
const TIMER_ROUNDING_SLACK_MS = 1;

/**
 * Validates the requested budget.
 *
 * A budget that is not a finite, non-negative number would silently disable the bound — `NaN`
 * compares false against everything, so every remainder would be 0 or `NaN` — hence the refusal
 * rather than a defaulting fallback. Zero is admitted and yields a deadline that is already spent.
 */
function resolveBudgetMs(budgetMs: number | undefined): number {
  if (budgetMs === undefined) {
    return ANALYSIS_BUDGET_MS;
  }
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new RangeError(
      `A deadline budget must be a finite, non-negative number of milliseconds; received ${String(budgetMs)}.`,
    );
  }
  return budgetMs;
}

/**
 * Starts one analysis budget.
 *
 * Call it once per submission, after upload validation and before the first provider call, and
 * pass that one deadline down to every call of the analysis.
 */
export function createDeadline(options: DeadlineOptions = {}): Deadline {
  const budgetMs = resolveBudgetMs(options.budgetMs);
  const now = options.now ?? Date.now;
  const startedAt = now();

  const elapsedMs = (): number => {
    const elapsed = now() - startedAt;
    // A clock that reads backwards cannot hand time back, and a reading that is not a number
    // cannot prove any budget remains: the first is floored at 0, the second counts as spent.
    if (!Number.isFinite(elapsed)) {
      return budgetMs;
    }
    return elapsed > 0 ? elapsed : 0;
  };

  const remainingMs = (): number => {
    const remaining = budgetMs - elapsedMs();
    return remaining > 0 ? remaining : 0;
  };

  const signal = (): AbortSignal => {
    const remaining = remainingMs();
    const reason = budgetSpentReason(budgetMs);
    if (remaining === 0) {
      return AbortSignal.abort(reason);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(reason);
    }, remaining + TIMER_ROUNDING_SLACK_MS);
    // Unref'd because the deadline outlives most of the calls it governs: an analysis that
    // finishes early must not keep the process alive until a budget nobody is waiting on expires.
    timer.unref();
    return controller.signal;
  };

  return {
    budgetMs,
    startedAt,
    elapsedMs,
    remainingMs,
    isExpired: () => remainingMs() === 0,
    signal,
  };
}
