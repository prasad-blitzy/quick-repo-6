import { useMemo } from 'react';

import type { AnalysisImage, Level, Rationale } from '@trade-read/shared';

/** The inputs of one stored analysis that the evidence section renders. */
export interface EvidenceListProps {
  /** The evidence behind the recommendation, in the order the analysis recorded it. */
  rationale: Rationale[];
  /** Every level of the analysis; the entries above cite these by id. */
  levels: Level[];
  /** Every submitted image, so a cited image id renders as its file name. */
  images: AnalysisImage[];
}

const EM_DASH = '\u2014';

/**
 * A cited price the analysis holds no level for, said rather than only drawn.
 *
 * The em dash is what the list shows and stays exactly as it was; the clipped sentence beside it
 * is what assistive technology announces in its place, so an absent or broken reference is read as
 * unavailable instead of as a dash. The dash is hidden from the accessibility tree and the
 * sentence is clipped by the stylesheet's `.visually-hidden` utility, so nothing the list renders
 * for a sighted reader changes.
 */
function NoValue() {
  return (
    <>
      <span aria-hidden="true">{EM_DASH}</span>
      <span className="visually-hidden">not available</span>
    </>
  );
}

/**
 * The evidence behind a recommendation: one entry per cited level, each naming the screenshot it
 * came from and the prices it cites.
 *
 * The entries are authored by the server, so this component only resolves their references and
 * renders them as given: a claim is never reworded, truncated, reordered or supplied when the
 * record carries none, and a cited price is shown exactly as the level stores it. No advice
 * framing, disclaimer or trading control belongs here.
 */
export function EvidenceList({ rationale, levels, images }: EvidenceListProps) {
  const levelById = useMemo(
    () => new Map(levels.map((level) => [level.levelId, level])),
    [levels],
  );
  const imageNameById = useMemo(
    () => new Map(images.map((image) => [image.imageId, image.fileName])),
    [images],
  );
  /* A rationale entry carries no id of its own, so its key comes from its own content: the image
   * it cites, the levels it cites and its claim, encoded as one string so that no two different
   * entries can encode alike. Identical entries are possible, so a repeated key takes the count of
   * the times it has already been seen in document order. React therefore matches an entry to its
   * own subtree even when the server reorders or inserts one, and rebuilding this only when
   * `rationale` changes keeps the keys stable across a re-render of the same evidence. */
  const keyedEntries = useMemo(() => {
    const seen = new Map<string, number>();
    return rationale.map((entry) => {
      const base = JSON.stringify([entry.imageId, entry.levelIds, entry.claim]);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { entry, entryKey: occurrence === 0 ? base : `${base}#${occurrence}` };
    });
  }, [rationale]);

  return (
    <section className="evidence-list">
      <h3 className="evidence-list__title">Evidence</h3>
      {rationale.length === 0 ? (
        <p className="empty-state">No evidence entries were recorded for this read.</p>
      ) : (
        <ul className="evidence-list__items evidence-list">
          {keyedEntries.map(({ entry, entryKey }) => {
            const missingLevelIds = entry.levelIds.filter((levelId) => !levelById.has(levelId));

            return (
              <li
                key={entryKey}
                className="evidence-list__item"
                data-image-id={entry.imageId}
                data-level-ids={entry.levelIds.join(' ')}
                data-missing-level-ids={
                  missingLevelIds.length > 0 ? missingLevelIds.join(' ') : undefined
                }
              >
                <p className="evidence-list__claim">{entry.claim}</p>
                <p className="evidence-list__source evidence-list__refs">
                  From{' '}
                  <span className="evidence-list__image">
                    {imageNameById.get(entry.imageId) ?? entry.imageId}
                  </span>
                </p>
                {entry.levelIds.length === 0 ? (
                  <p className="evidence-list__levels">
                    <NoValue />
                  </p>
                ) : (
                  <ul className="evidence-list__levels">
                    {entry.levelIds.map((levelId, levelIndex) => {
                      const level = levelById.get(levelId);

                      return level === undefined ? (
                        <li
                          key={`${levelId}#${levelIndex}`}
                          className="evidence-list__level evidence-list__level--missing"
                          data-level-id={levelId}
                        >
                          <NoValue />
                        </li>
                      ) : (
                        <li
                          key={`${levelId}#${levelIndex}`}
                          className="evidence-list__level"
                          data-level-id={levelId}
                        >
                          {String(level.price)}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
