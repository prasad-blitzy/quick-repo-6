/**
 * src/components/App.tsx — Root Preact Component (Shadow DOM Sidebar)
 *
 * The root component for the GMGN Signal Bot Chrome Extension overlay.
 * Mounted inside a Shadow DOM container by `entrypoints/content.ts`, this
 * component orchestrates the entire overlay UI including:
 *
 * - Collapsible sidebar panel (350px width, fixed positioning at right edge)
 * - Three-tab navigation: Signals, Feed, Settings
 * - Global error boundary catching child component render errors
 * - Panel visibility synchronized with the Zustand settings store
 * - Keyboard shortcut (Escape) to collapse the sidebar panel
 *
 * Per AAP Section 0.5.1 Group 11:
 *   "Root component; renders sidebar panel container with visibility
 *    toggle button; manages global error boundary; loads styles into
 *    Shadow DOM"
 *
 * Per AAP Section 0.7.5:
 *   "Shadow DOM for all extension UI: Every DOM element created by the
 *    extension must live inside the Shadow DOM container"
 *
 * Per AAP Section 0.1.2:
 *   "Use Shadow DOM for complete style isolation from GMGN's CSS;
 *    render with Preact (3KB); position as a fixed sidebar panel
 *    (position: fixed; right: 0; width: 350px; z-index: 2147483647)"
 *
 * Per AAP Section 0.5.3:
 *   "A toggle button (visible at all times, positioned at the panel edge)
 *    allows users to collapse/expand the sidebar to reclaim screen space
 *    for GMGN's charts and data"
 *
 * CSS classes referenced from styles.css (loaded into Shadow DOM):
 *   .gmgn-bot-container, .gmgn-bot-container.collapsed, .panel-toggle,
 *   .panel-header, .tab-bar, .panel-content, .error-boundary
 *
 * @module components/App
 */

import { h } from 'preact';
import type { FunctionComponent } from 'preact';
import {
  useState,
  useCallback,
  useEffect,
  useErrorBoundary,
} from 'preact/hooks';

// Child components — mounted inside the tab content area
import { SignalPanel } from './SignalPanel';
import { SettingsPanel } from './SettingsPanel';
import { NewTokenFeed } from './NewTokenFeed';

// Zustand store hook — reactive Preact-compatible settings store access
import { useSettingsStoreHook } from '../store/index';

// Application UI constants — sidebar dimensions and z-index
import { UI_CONFIG } from '../utils/config';

// =============================================================================
// Types
// =============================================================================

/**
 * Discriminated union for the active tab in the sidebar panel.
 * Controls which child component is rendered in the main content area.
 *
 * - `'signals'`: Shows the SignalPanel with active trading signals
 * - `'feed'`: Shows the NewTokenFeed with real-time PumpPortal tokens
 * - `'settings'`: Shows the SettingsPanel for configuration
 */
type ActiveTab = 'signals' | 'feed' | 'settings';

// =============================================================================
// Constants
// =============================================================================

/**
 * Tab metadata for rendering the tab bar navigation buttons.
 * Order: Signals (primary view), Feed (real-time), Settings (configuration).
 */
const TAB_CONFIG: ReadonlyArray<{ key: ActiveTab; label: string }> = [
  { key: 'signals', label: 'Signals' },
  { key: 'feed', label: 'Feed' },
  { key: 'settings', label: 'Settings' },
] as const;

/**
 * Unicode characters for the panel toggle button chevrons.
 * These are CSS-only indicators with no image dependencies.
 *
 * When panel is expanded: right-pointing triangle (collapse action)
 * When panel is collapsed: left-pointing triangle (expand action)
 */
const CHEVRON_COLLAPSE = '\u25B8'; // ▸
const CHEVRON_EXPAND = '\u25C2';   // ◂

// =============================================================================
// Sub-Component: ErrorFallback
// =============================================================================

/**
 * Error fallback display shown when a child component throws during render.
 *
 * Provides a human-readable error message and a retry button that resets
 * the error boundary, allowing the component tree to attempt re-render.
 * Uses inline styles derived from `UI_CONFIG` constants to maintain proper
 * sidebar positioning even in the error state.
 *
 * Styled with the `.error-boundary` CSS class from styles.css for
 * dark-theme visual consistency with the rest of the overlay.
 *
 * @param error - The caught Error object from the failed render
 * @param onReset - Callback to reset the error boundary and retry rendering
 */
const ErrorFallback: FunctionComponent<{
  error: Error;
  onReset: () => void;
}> = ({ error, onReset }) => (
  <div
    class="gmgn-bot-container"
    style={{
      width: `${UI_CONFIG.SIDEBAR_WIDTH_PX}px`,
      zIndex: UI_CONFIG.Z_INDEX,
    }}
    role="alert"
    aria-live="assertive"
  >
    <div class="error-boundary">
      <h3>Extension Error</h3>
      <p>{error.message || 'An unexpected error occurred'}</p>
      <button type="button" onClick={onReset}>
        Retry
      </button>
    </div>
  </div>
);

// =============================================================================
// App Component
// =============================================================================

/**
 * Root Preact component for the GMGN Signal Bot Chrome Extension overlay.
 *
 * Renders inside a Shadow DOM container (created by `entrypoints/content.ts`).
 * Manages three core responsibilities:
 *
 * 1. **Panel visibility** — Synced with the Zustand settings store's
 *    `panelVisible` state via `useSettingsStoreHook`. Persisted to
 *    `chrome.storage.sync`, ensuring collapse/expand state survives
 *    page navigation and browser restarts.
 *
 * 2. **Tab navigation** — Three-tab interface (Signals, Feed, Settings)
 *    controlled by local `activeTab` state. Default tab is 'signals'.
 *
 * 3. **Error boundary** — Preact's `useErrorBoundary` hook catches
 *    rendering errors from all child components and displays a
 *    retry-able fallback UI.
 *
 * Layout (per AAP Section 0.1.2 and 0.7.5):
 * - Fixed sidebar: `position: fixed; right: 0; top: 0; height: 100vh`
 * - Width: 350px when expanded, 0px (collapsed) with toggle button visible
 * - z-index: 2147483647 (maximum 32-bit signed integer)
 * - Dark theme matching GMGN's trading interface aesthetics
 *
 * Keyboard interaction:
 * - `Escape` key collapses the sidebar when it is expanded
 *
 * @example
 * ```tsx
 * // In entrypoints/content.ts (mounted inside Shadow DOM):
 * import { render, h } from 'preact';
 * import { App } from '../src/components/App';
 * render(<App />, shadowRoot);
 * ```
 */
const App: FunctionComponent = () => {
  // ---------------------------------------------------------------------------
  // Store Subscriptions — Reactive State from Zustand
  // ---------------------------------------------------------------------------

  /**
   * Panel visibility from the settings store.
   * Persisted to chrome.storage.sync — survives page navigation and
   * browser restarts. Updated via the store's `togglePanel()` action.
   */
  const panelVisible = useSettingsStoreHook(
    (state) => state.panelVisible,
  );

  /**
   * `togglePanel` action from the settings store.
   * Flips `panelVisible` between true and false, triggering a debounced
   * write to `chrome.storage.sync` via the persistence middleware.
   */
  const togglePanel = useSettingsStoreHook(
    (state) => state.togglePanel,
  );

  // ---------------------------------------------------------------------------
  // Local State
  // ---------------------------------------------------------------------------

  /**
   * Currently active tab controlling which sub-panel is displayed.
   * Default: `'signals'` — the primary view showing active trading signals
   * sorted by composite score descending.
   */
  const [activeTab, setActiveTab] = useState<ActiveTab>('signals');

  // ---------------------------------------------------------------------------
  // Error Boundary
  // ---------------------------------------------------------------------------

  /**
   * Preact error boundary hook.
   * Catches rendering errors thrown by ANY child component in the tree.
   * When an error is caught, the ErrorFallback UI replaces the normal
   * component tree, with a retry button to reset and re-render.
   */
  const [error, resetError] = useErrorBoundary();

  // ---------------------------------------------------------------------------
  // Callbacks — Memoized Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Memoized panel toggle handler.
   * Delegates to the settings store's `togglePanel` action, which
   * persists the new visibility state to `chrome.storage.sync`.
   */
  const handleToggle = useCallback(() => {
    togglePanel();
  }, [togglePanel]);

  /**
   * Memoized tab change handler.
   * Updates the active tab when a tab navigation button is clicked.
   *
   * @param tab - The tab key to activate
   */
  const handleTabChange = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
  }, []);

  // ---------------------------------------------------------------------------
  // Side Effects — Keyboard Shortcuts
  // ---------------------------------------------------------------------------

  /**
   * Registers a keyboard event listener on the Shadow DOM host for the
   * Escape key shortcut. When the sidebar is expanded and the user presses
   * Escape, the sidebar collapses to reclaim screen space.
   *
   * The listener is scoped to the component's lifecycle — it is added on
   * mount and cleaned up on unmount to prevent memory leaks.
   *
   * Uses `useEffect` for settings store sync on mount: the keyboard
   * shortcut behavior depends on the current `panelVisible` state from
   * the settings store, ensuring the shortcut respects persisted state.
   */
  useEffect(() => {
    /**
     * Keydown handler that collapses the sidebar on Escape press.
     * Only fires when the panel is currently visible to avoid no-op calls.
     */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && panelVisible) {
        event.preventDefault();
        togglePanel();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [panelVisible, togglePanel]);

  // ---------------------------------------------------------------------------
  // Render: Error Boundary Fallback
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <ErrorFallback
        error={error instanceof Error ? error : new Error(String(error))}
        onReset={resetError}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Main Component Tree
  // ---------------------------------------------------------------------------

  return (
    <div
      class={`gmgn-bot-container${panelVisible ? '' : ' collapsed'}`}
      role="complementary"
      aria-label="GMGN Signal Bot sidebar"
    >
      {/* Toggle button — ALWAYS visible per AAP Section 0.5.3.
          Positioned at the left edge of the sidebar via CSS (.panel-toggle).
          Uses aria-expanded to communicate panel state to screen readers. */}
      <button
        type="button"
        class="panel-toggle"
        onClick={handleToggle}
        aria-expanded={panelVisible}
        aria-label={panelVisible ? 'Collapse sidebar' : 'Expand sidebar'}
        title={panelVisible ? 'Collapse' : 'Expand'}
      >
        {panelVisible ? CHEVRON_COLLAPSE : CHEVRON_EXPAND}
      </button>

      {panelVisible && (
        <>
          {/* Panel Header — Title and Tab Navigation Bar */}
          <header class="panel-header">
            <h2>GMGN Signal Bot</h2>
            <nav class="tab-bar" aria-label="Sidebar navigation">
              {TAB_CONFIG.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  class={activeTab === key ? 'active' : ''}
                  onClick={() => handleTabChange(key)}
                  aria-selected={activeTab === key}
                  role="tab"
                >
                  {label}
                </button>
              ))}
            </nav>
          </header>

          {/* Panel Content — Renders the Active Tab's Child Component */}
          <main
            class="panel-content"
            role="tabpanel"
            aria-label={`${activeTab} panel`}
          >
            {activeTab === 'signals' && <SignalPanel />}
            {activeTab === 'feed' && <NewTokenFeed />}
            {activeTab === 'settings' && <SettingsPanel />}
          </main>
        </>
      )}
    </div>
  );
};

// =============================================================================
// Exports
// =============================================================================

export { App };
