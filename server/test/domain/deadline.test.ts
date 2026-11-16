/**
 * The deadline: one budget per analysis, and the two guarantees a provider call reads off it.
 *
 * These cases pin the behaviour that is easy to get subtly wrong rather than the arithmetic that
 * is obvious. A caller's budget is clamped, never refused, so no submission fails on a seam value
 * that only a test reaches. And a signal never aborts a budget that `isExpired()` still reports as
 * running, whatever the figure: the runtime clamps a timer delay above `2 ** 31 - 1` ms to 1 ms,
 * which would otherwise abort a very long budget milliseconds after it started. Both properties
 * are observed on the real clock where a timer has to fire, because a signal that aborted early or
 * a timer that never armed is exactly the failure these cases exist to catch.
 */
import { ANALYSIS_BUDGET_MS } from '@trade-read/shared';
import { describe, expect, it, vi } from 'vitest';

import { createDeadline } from '../../src/domain/deadline.js';

/** The largest delay the runtime accepts; a larger one is clamped to 1 ms. */
const TIMER_CEILING_MS = 2 ** 31 - 1;

/** A budget far beyond that ceiling, which is the figure that used to abort the signal at once. */
const HUGE_BUDGET_MS = 3e9;

/** A budget short enough to elapse inside a test and long enough that the case is not a coin flip. */
const SHORT_BUDGET_MS = 25;

/** Long enough for a clamped timer to fire, short enough to keep the suite quick. */
const OBSERVATION_WINDOW_MS = 50;

/** How long a wait for an abort may last before the case reports a timer that never fired. */
const ABORT_WAIT_MS = 5_000;

/**
 * Budgets a caller may hand the seam, and the figure each resolves to: a value that cannot bound
 * anything is replaced by the shared constant, and a negative budget becomes an already spent one.
 */
const CLAMPED_BUDGETS = [
  { label: 'NaN', budgetMs: Number.NaN, resolvedMs: ANALYSIS_BUDGET_MS },
  { label: 'positive infinity', budgetMs: Number.POSITIVE_INFINITY, resolvedMs: ANALYSIS_BUDGET_MS },
  { label: 'negative infinity', budgetMs: Number.NEGATIVE_INFINITY, resolvedMs: ANALYSIS_BUDGET_MS },
  { label: 'a negative budget', budgetMs: -1, resolvedMs: 0 },
];

/** A real wait on the wall clock, used only where a case has to observe a timer fire or not fire. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Resolves true once the signal aborts, and false if the wait outlasts {@link ABORT_WAIT_MS}. */
function waitForAbort(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const guard = setTimeout(() => {
      resolve(false);
    }, ABORT_WAIT_MS);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(guard);
        resolve(true);
      },
      { once: true },
    );
  });
}

describe('createDeadline', () => {
  it('defaults to the shared analysis budget', () => {
    expect(createDeadline().budgetMs).toBe(ANALYSIS_BUDGET_MS);
    const deadline = createDeadline({ now: () => 1_000 });
    expect(deadline.remainingMs()).toBe(ANALYSIS_BUDGET_MS);
    expect(deadline.isExpired()).toBe(false);
  });

  it.each(CLAMPED_BUDGETS)(
    'clamps $label to $resolvedMs ms instead of refusing the deadline',
    ({ budgetMs, resolvedMs }) => {
      expect(() => createDeadline({ budgetMs })).not.toThrow();
      expect(createDeadline({ budgetMs }).budgetMs).toBe(resolvedMs);
    },
  );

  it('resolves a negative budget to a spent deadline that hands back an aborted signal', () => {
    const deadline = createDeadline({ budgetMs: -1 });
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.isExpired()).toBe(true);
    const signal = deadline.signal();
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('resolves a zero budget to the same spent deadline', () => {
    const deadline = createDeadline({ budgetMs: 0 });
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.isExpired()).toBe(true);
    expect(deadline.signal().aborted).toBe(true);
  });

  it('keeps a budget beyond the timer ceiling running instead of aborting it at once', async () => {
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const deadline = createDeadline({ budgetMs: HUGE_BUDGET_MS });
      const signal = deadline.signal();
      await delay(OBSERVATION_WINDOW_MS);
      expect(signal.aborted).toBe(false);
      expect(deadline.isExpired()).toBe(false);
      expect(deadline.remainingMs()).toBeGreaterThan(TIMER_CEILING_MS);
      // The runtime announces the clamp it would otherwise apply, so an unannounced run is the
      // proof that no armed delay went past the ceiling.
      expect(emitWarning).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
    }
  });

  it('aborts a short real budget through its timer with a TimeoutError reason', async () => {
    const deadline = createDeadline({ budgetMs: SHORT_BUDGET_MS });
    const signal = deadline.signal();
    expect(await waitForAbort(signal)).toBe(true);
    expect(deadline.isExpired()).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('reports a spent budget on the injected clock and pre-aborts a later signal', () => {
    let clock = 1_000;
    const deadline = createDeadline({ budgetMs: 500, now: () => clock });
    expect(deadline.remainingMs()).toBe(500);
    clock += 200;
    expect(deadline.remainingMs()).toBe(300);
    expect(deadline.isExpired()).toBe(false);
    clock += 400;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.isExpired()).toBe(true);
    expect(deadline.signal().aborted).toBe(true);
  });
});
