/*
 * The trade read as one card: the side, the timing, the level prices the read uses, the
 * confidence and the analysis's one sentence.
 *
 * Two rules shape this file. A price exists only on a level, so every price here is read out
 * of `levels` by level id and printed with `String(price)`: never computed, rounded, averaged
 * or formatted, because the stored number is the number a submitted screenshot reported and a
 * different rendering of it would be a different claim. And a NO_TRADE/WAIT read is a
 * complete result, so it renders through exactly this markup — only the accent modifier and
 * the labels change. No alert role, notice or disabled state belongs to it.
 *
 * The component is presentational: it performs no request, reads no configuration and draws
 * no conclusion. The side, timing, confidence, summary and level references are all server
 * output, and this file only resolves the references against the levels it was given.
 */

import { useMemo } from 'react';

import type { Confidence, Level, Recommendation, Side, Timing } from '@trade-read/shared';

export interface RecommendationCardProps {
  recommendation: Recommendation;
  levels: Level[];
}

/* Exhaustive records rather than lookups with fallbacks: a new union member then fails this
 * file's compilation instead of rendering a blank cell at runtime. */
const SIDE_LABEL: Record<Side, string> = {
  LONG: 'Long',
  SHORT: 'Short',
  NO_TRADE: 'No trade',
};

const TIMING_LABEL: Record<Timing, string> = {
  NOW: 'Now',
  ON_RETEST: 'On retest',
  ON_BREAK: 'On break',
  WAIT: 'Wait',
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/* `.recommendation--no-trade` deliberately reuses the plain card accent: no trade is an answer,
 * not a degraded one. */
const SIDE_MODIFIER: Record<Side, string> = {
  LONG: 'recommendation--long',
  SHORT: 'recommendation--short',
  NO_TRADE: 'recommendation--no-trade',
};

/** What a reference with no resolvable level renders as. */
const NO_VALUE = '\u2014';

/**
 * The only price formatting in the client: the stored number, verbatim.
 *
 * Fixed-decimal, locale-aware, thousands-separated, currency-suffixed and rounded renderings are
 * all forbidden here: each would change the digits relative to the level the analysis reported.
 */
function priceText(level: Level | undefined): string {
  return level === undefined ? NO_VALUE : String(level.price);
}

/**
 * A reference the read holds no level for, said rather than only drawn.
 *
 * The em dash is what the card shows and stays exactly as it was; the clipped sentence beside it
 * is what assistive technology announces in its place, so a `NO_TRADE`/`WAIT` read reports three
 * absent references instead of three dashes. The dash is hidden from the accessibility tree and
 * the sentence is clipped by the stylesheet's `.visually-hidden` utility, so nothing the card
 * renders for a sighted reader changes.
 */
function NoValue() {
  return (
    <>
      <span aria-hidden="true">{NO_VALUE}</span>
      <span className="visually-hidden">not available</span>
    </>
  );
}

interface PriceCellProps {
  label: string;
  /** The reference the recommendation holds, or null where it holds none. */
  levelId: string | null;
  /** The level the reference resolved to, or undefined when nothing in `levels` matched. */
  level: Level | undefined;
}

/**
 * One label/value pair of the card's grid.
 *
 * `data-level-id` names the reference so the price shown here can be traced to the level table's
 * row. An id that resolved to no level is marked `data-missing-level-id` so a broken reference is
 * diagnosable from the DOM instead of looking like an ordinary empty cell; it is never filled in
 * with 0, null or the nearest level.
 */
function PriceCell({ label, levelId, level }: PriceCellProps) {
  return (
    <div className="recommendation__cell">
      <dt className="recommendation__label">{label}</dt>
      <dd className="recommendation__value" data-level-id={levelId ?? undefined}>
        {level === undefined ? (
          <span
            className="recommendation__value recommendation__value--none"
            data-missing-level-id={levelId ?? undefined}
          >
            <NoValue />
          </span>
        ) : (
          priceText(level)
        )}
      </dd>
    </div>
  );
}

export function RecommendationCard({ recommendation, levels }: RecommendationCardProps) {
  const {
    side,
    timing,
    confidence,
    triggerLevelId,
    entryLevelId,
    invalidationLevelId,
    targetLevelIds,
    summary,
  } = recommendation;

  /* One index, built from the levels exactly as received: the array is neither sorted nor mutated,
   * so the sequence the analysis reported survives for any consumer that renders it. */
  const levelsById = useMemo(() => {
    const index = new Map<string, Level>();
    for (const level of levels) {
      index.set(level.levelId, level);
    }
    return index;
  }, [levels]);

  const resolve = (levelId: string | null): Level | undefined =>
    levelId === null ? undefined : levelsById.get(levelId);

  return (
    <section
      className={`recommendation ${SIDE_MODIFIER[side]}`}
      data-side={side}
      data-timing={timing}
      data-trigger-level-id={triggerLevelId ?? undefined}
    >
      {/* `recommendation__title` is the card's heading hook; `recommendation__side` is the
       * side's own type scale and accent, which the stylesheet applies to this heading. */}
      <h3 className="recommendation__title recommendation__side">{SIDE_LABEL[side]}</h3>
      <span className="recommendation__timing">{TIMING_LABEL[timing]}</span>

      <dl className="recommendation__grid">
        <PriceCell label="Entry" levelId={entryLevelId} level={resolve(entryLevelId)} />
        <PriceCell
          label="Invalidation"
          levelId={invalidationLevelId}
          level={resolve(invalidationLevelId)}
        />
        <div className="recommendation__cell">
          <dt className="recommendation__label">Targets</dt>
          <dd className="recommendation__value">
            {targetLevelIds.length === 0 ? (
              <span className="recommendation__value recommendation__value--none">
                <NoValue />
              </span>
            ) : (
              <ul className="recommendation__targets">
                {targetLevelIds.map((targetLevelId, index) => {
                  const target = levelsById.get(targetLevelId);

                  return (
                    <li
                      key={`${index}:${targetLevelId}`}
                      className="recommendation__target"
                      data-level-id={targetLevelId}
                    >
                      {target === undefined ? (
                        <span
                          className="recommendation__value recommendation__value--none"
                          data-missing-level-id={targetLevelId}
                        >
                          <NoValue />
                        </span>
                      ) : (
                        priceText(target)
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
        </div>
        <div className="recommendation__cell">
          <dt className="recommendation__label">Confidence</dt>
          <dd className="recommendation__value">
            <span className="recommendation__confidence" data-confidence={confidence}>
              {CONFIDENCE_LABEL[confidence]}
            </span>
          </dd>
        </div>
      </dl>

      <p className="recommendation__summary">{summary === '' ? <NoValue /> : summary}</p>
    </section>
  );
}
