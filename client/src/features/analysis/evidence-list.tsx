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

  return (
    <section className="evidence-list">
      <h3 className="evidence-list__title">Evidence</h3>
      {rationale.length === 0 ? (
        <p className="empty-state">No evidence entries were recorded for this read.</p>
      ) : (
        <ul className="evidence-list__items evidence-list">
          {rationale.map((entry, entryIndex) => {
            const missingLevelIds = entry.levelIds.filter((levelId) => !levelById.has(levelId));

            return (
              <li
                key={entryIndex}
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
                  <p className="evidence-list__levels">{EM_DASH}</p>
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
                          {EM_DASH}
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
