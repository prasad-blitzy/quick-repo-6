/**
 * The application shell: which of the three surfaces is on screen, and the two destinations every
 * surface can leave for.
 *
 * Exactly one surface renders at a time, because each one owns the whole page's meaning — an upload
 * in progress, a stored trade read, or the list of stored reads — and two of them on screen at once
 * would put two recommendations, or a recommendation beside a pending upload, in front of the same
 * reader. The selection is component state rather than a router: the product is a single operator's
 * local tool with three screens, and no address a person could type has a meaning here.
 *
 * A created analysis is handed to the analysis surface together with the document the create call
 * returned, so opening a read that was just produced costs no second request; only an analysis
 * opened from the history list, where no document is held, is read back by id. This file derives no
 * field of the document, resolves no price and reaches no API: it decides what to show and where to
 * go next.
 */

import { useCallback, useState } from 'react';

import type { AnalysisDocument } from '@trade-read/shared';

import AnalysisSurface from './features/analysis/analysis-surface';
import HistorySurface from './features/history/history-surface';
import UploadSurface from './features/upload/upload-surface';

/**
 * The screen the shell is showing.
 *
 * The analysis case names the analysis to display and, when the caller still holds it, the document
 * the create call returned — the one shape both entry paths into that surface use, so neither path
 * invents its own way of naming a read.
 */
type View =
  | { readonly name: 'upload' }
  | { readonly name: 'history' }
  | {
      readonly name: 'analysis';
      readonly analysisId: string;
      readonly initialDocument?: AnalysisDocument;
    };

/**
 * The shell.
 *
 * Every transition is a callback taking only the identifiers it needs, which keeps the surfaces
 * independent of this component: they report what happened — this analysis was created, this row
 * was opened, go back — and the shell decides where that leads.
 */
export default function App() {
  const [view, setView] = useState<View>({ name: 'upload' });

  /** Starts a new upload: the destination of every surface's own "new analysis" control. */
  const showUpload = useCallback(() => {
    setView({ name: 'upload' });
  }, []);

  /** Shows the stored analyses, newest first. */
  const showHistory = useCallback(() => {
    setView({ name: 'history' });
  }, []);

  /**
   * Opens the analysis a submission just produced, with the document already in hand. The document
   * travels with the selection, so the surface renders it without reading it back.
   */
  const showCreatedAnalysis = useCallback((document: AnalysisDocument) => {
    setView({
      name: 'analysis',
      analysisId: document.analysisId,
      initialDocument: document,
    });
  }, []);

  /** Opens one stored analysis by id, which the surface reads from the API. */
  const showStoredAnalysis = useCallback((analysisId: string) => {
    setView({ name: 'analysis', analysisId });
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Screenshot Trade Read</h1>
        {/* Buttons rather than links: the surface selection is state, and a link would promise an
            address that does not exist, so the two destinations are secondary buttons and the
            current one is marked with `aria-current="page"` — the destination within a set rather
            than a pressed toggle, and the attribute the stylesheet's `[aria-current='page']` rule
            highlights. One attribute therefore both announces and shows which surface is on
            screen; a pressed state instead would leave that rule dead and the active surface
            visually unmarked. */}
        <nav className="app__nav" aria-label="Surfaces">
          <button
            type="button"
            className="button button--secondary"
            aria-current={view.name === 'upload' ? 'page' : undefined}
            onClick={showUpload}
          >
            New analysis
          </button>
          <button
            type="button"
            className="button button--secondary"
            aria-current={view.name === 'history' ? 'page' : undefined}
            onClick={showHistory}
          >
            History
          </button>
        </nav>
      </header>

      {/* The surface on screen is named here as well as marked in the nav, so which of the three is
          mounted is readable from the shell alone, without depending on any surface's internals. */}
      <main className="app__main" data-surface={view.name}>
        {view.name === 'upload' ? <UploadSurface onCreated={showCreatedAnalysis} /> : null}
        {view.name === 'history' ? (
          <HistorySurface onOpenAnalysis={showStoredAnalysis} onNewAnalysis={showUpload} />
        ) : null}
        {/* The analysis case always carries the id it was opened with, so there is no id-less
            analysis state to fall back from. */}
        {view.name === 'analysis' ? (
          <AnalysisSurface
            analysisId={view.analysisId}
            initialDocument={view.initialDocument}
            onBackToHistory={showHistory}
            onNewAnalysis={showUpload}
          />
        ) : null}
      </main>
    </div>
  );
}
