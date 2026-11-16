/**
 * The extracted levels of one analysis: one row per price the analysis reported, labelled with the
 * kind of level it is and the submitted image it was read from.
 *
 * Rows keep the document's own order — the server's extraction order — so the table is a faithful
 * rendering of `levels[]` rather than a view of it, and each row carries the analysis's identifiers
 * as data attributes so a recommendation's level reference can be traced to the row holding its
 * price without relying on the text around it.
 */

import { useMemo } from 'react';

import type { AnalysisImage, Level, LevelType } from '@trade-read/shared';

export interface LevelTableProps {
  /** Every level the analysis extracted, in the order the server recorded it. */
  levels: Level[];
  /** The submitted images, used to name the image each level came from. */
  images: AnalysisImage[];
}

/**
 * The readable name of every level kind. A total record rather than a partial map, so adding a
 * member to the taxonomy is a build error here instead of an empty cell on screen.
 */
const LEVEL_TYPE_LABEL: Record<LevelType, string> = {
  GEX_CALL_WALL: 'GEX call wall',
  GEX_PUT_WALL: 'GEX put wall',
  GEX_ZERO_GAMMA: 'GEX zero gamma',
  GEX_POSITIVE_GAMMA_STRIKE: 'GEX positive gamma strike',
  GEX_NEGATIVE_GAMMA_STRIKE: 'GEX negative gamma strike',
  FOOTPRINT_VALUE_AREA_HIGH: 'Footprint value area high',
  FOOTPRINT_VALUE_AREA_LOW: 'Footprint value area low',
  FOOTPRINT_POC: 'Footprint POC',
  FOOTPRINT_IMBALANCE: 'Footprint imbalance',
  ABSORPTION: 'Absorption',
  LIQUIDITY_VOID: 'Liquidity void',
  OTHER: 'Other',
};

export function LevelTable({ levels, images }: LevelTableProps) {
  const imageNameById = useMemo(
    () => new Map(images.map((image) => [image.imageId, image.fileName])),
    [images],
  );

  return (
    <section className="level-table">
      <h3 className="level-table__title">Levels</h3>
      {levels.length === 0 ? (
        <p className="empty-state">No levels were extracted from these images.</p>
      ) : (
        <div className="level-table__scroll">
          {/*
            The table carries the stylesheet's `.level-table` box rules as well as the
            `level-table__table` element hook: `client/src/styles.css` hangs its width and
            `border-collapse` declarations off `.level-table`, so without it the table would keep
            separated borders at content width.
          */}
          <table className="level-table__table level-table">
            <caption className="visually-hidden">
              Extracted price levels with their type and source image
            </caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Price</th>
                <th scope="col">Source image</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => (
                <tr
                  key={level.levelId}
                  data-level-id={level.levelId}
                  data-level-type={level.type}
                  data-image-id={level.imageId}
                >
                  <td>
                    {LEVEL_TYPE_LABEL[level.type]}
                    {level.note !== undefined && level.note !== '' ? (
                      <span className="level-table__note"> {level.note}</span>
                    ) : null}
                  </td>
                  <td className="level-table__price">{String(level.price)}</td>
                  <td className="level-table__image">
                    {imageNameById.get(level.imageId) ?? level.imageId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
