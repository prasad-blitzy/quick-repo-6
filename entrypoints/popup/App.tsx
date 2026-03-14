/**
 * entrypoints/popup/App.tsx — Popup Preact Component
 *
 * Root Preact component for the Chrome Extension toolbar popup that appears
 * when clicking the extension icon. Provides a quick status overview and
 * key controls in a compact popup window (~300×400px).
 *
 * Features:
 *   - WebSocket connection status for PumpPortal and Birdeye
 *   - Active signal count display
 *   - Trading mode toggle (conservative ≥80 / aggressive ≥45)
 *   - "Open Full Settings" button to navigate to GMGN tab with sidebar overlay
 *   - 5-second auto-refresh polling for live status
 *   - Dark theme matching GMGN aesthetics
 *
 * Communication:
 *   - Sends `{ type: 'GET_STATUS' }` to the service worker on mount and every 5s
 *   - Sends `{ type: 'UPDATE_SETTINGS', payload }` to toggle trading mode
 *   - Sends `{ type: 'OPEN_SETTINGS_PANEL' }` to the content script via chrome.tabs
 *
 * Per AAP Section 0.5.1 Group 2 and Section 0.7.5: Preact only, no React imports.
 * Per AAP Section 0.7.2: No API keys handled here — all key management is in the service worker.
 */

import { h, FunctionComponent } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { EXTENSION_INFO } from '@/utils/config';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Represents the possible states of a WebSocket connection.
 * Aligns with the GET_STATUS response from the background service worker.
 */
type ConnectionState = 'connected' | 'disconnected' | 'reconnecting' | 'connecting';

/**
 * Trading mode determines the minimum composite score threshold for signal generation.
 * - conservative: ≥80 composite score (high-confidence signals only)
 * - aggressive: ≥45 composite score (moderate signals accepted)
 */
type TradingMode = 'conservative' | 'aggressive';

/**
 * Extension status response received from the background service worker
 * via chrome.runtime.sendMessage({ type: 'GET_STATUS' }).
 */
interface ExtensionStatus {
  /** WebSocket connection states for real-time data streams */
  websockets: {
    /** PumpPortal WebSocket state (new token events, trade events) */
    pumpPortal: ConnectionState;
    /** Birdeye WebSocket state (price streams, transaction events) */
    birdeye: ConnectionState;
  };
  /** Number of currently active trading signals */
  activeSignalCount: number;
  /** Current trading mode (conservative or aggressive) */
  tradingMode: TradingMode;
  /** Optional rate limiter status per API provider */
  rateLimiterStatus?: {
    [provider: string]: { available: number; total: number };
  };
}

// =============================================================================
// Constants
// =============================================================================

/** Polling interval for status refresh while popup is open (milliseconds) */
const STATUS_POLL_INTERVAL_MS = 5000;

// =============================================================================
// Popup CSS Styles
// =============================================================================

/**
 * All popup-specific styles as a template literal.
 * The popup has its own isolated document context (no Shadow DOM needed).
 * Dark theme matching GMGN aesthetics with system fonts.
 */
const popupStyles = `
  *,
  *::before,
  *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  body {
    margin: 0;
    padding: 0;
    background: #0f1419;
  }

  .popup-container {
    width: 300px;
    min-height: 350px;
    background: #0f1419;
    color: #e8eaed;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
    font-size: 0.8125rem;
    line-height: 1.4;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-block: 0.75rem;
    padding-inline: 1rem;
    background: #1a2332;
    border-block-end: 1px solid #2a3a4a;
  }

  .popup-header h1 {
    font-size: 0.9375rem;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: 0.025em;
  }

  .popup-header .version {
    font-size: 0.6875rem;
    color: #8899aa;
    background: #0f1419;
    padding-block: 0.125rem;
    padding-inline: 0.375rem;
    border-radius: 0.25rem;
    font-weight: 500;
  }

  .popup-section {
    padding-block: 0.75rem;
    padding-inline: 1rem;
    border-block-end: 1px solid #1a2332;
  }

  .popup-section h2 {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #8899aa;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-block-end: 0.5rem;
  }

  .connection-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-block: 0.375rem;
  }

  .connection-label {
    font-size: 0.8125rem;
    color: #c8d0d8;
    font-weight: 500;
  }

  .connection-status {
    font-size: 0.75rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    text-transform: capitalize;
  }

  .status-connected {
    color: #00c853;
  }

  .status-disconnected {
    color: #ff5252;
  }

  .status-reconnecting {
    color: #ffd740;
  }

  .status-connecting {
    color: #ffd740;
  }

  .signal-count {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding-block: 0.25rem;
  }

  .count-number {
    font-size: 2rem;
    font-weight: 700;
    color: #ffffff;
    line-height: 1;
  }

  .count-label {
    font-size: 0.8125rem;
    color: #8899aa;
  }

  .mode-toggle {
    display: flex;
    gap: 0.5rem;
  }

  .mode-toggle button {
    flex: 1 1 0;
    padding-block: 0.5rem;
    padding-inline: 0.5rem;
    border: 1px solid #2a3a4a;
    border-radius: 0.375rem;
    background: #1a2332;
    color: #8899aa;
    font-size: 0.75rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 200ms ease-out, color 200ms ease-out, border-color 200ms ease-out;
    min-block-size: 2.75rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .mode-toggle button {
      transition: none;
    }
  }

  .mode-toggle button:focus-visible {
    outline: 2px solid #448aff;
    outline-offset: 2px;
  }

  @media (hover: hover) {
    .mode-toggle button:hover:not(.active) {
      background: #223344;
      border-color: #3a4a5a;
    }
  }

  .mode-toggle button.active {
    background: #1a3a2a;
    color: #00c853;
    border-color: #00c853;
    cursor: default;
  }

  .popup-footer {
    padding-block: 0.75rem;
    padding-inline: 1rem;
    margin-block-start: auto;
  }

  .open-settings-btn {
    inline-size: 100%;
    padding-block: 0.625rem;
    padding-inline: 1rem;
    background: #1565c0;
    color: #ffffff;
    border: none;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background 200ms ease-out;
    min-block-size: 2.75rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .open-settings-btn {
      transition: none;
    }
  }

  .open-settings-btn:focus-visible {
    outline: 2px solid #448aff;
    outline-offset: 2px;
  }

  @media (hover: hover) {
    .open-settings-btn:hover {
      background: #1976d2;
    }
  }

  .popup-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding-block: 3rem;
    padding-inline: 1rem;
    flex: 1 1 0;
  }

  .loading-spinner {
    inline-size: 2rem;
    block-size: 2rem;
    border: 3px solid #2a3a4a;
    border-block-start-color: #448aff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-block-end: 0.75rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-spinner {
      animation: none;
      border-block-start-color: #448aff;
      opacity: 0.7;
    }
  }

  .loading-text {
    color: #8899aa;
    font-size: 0.8125rem;
  }

  .popup-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding-block: 2rem;
    padding-inline: 1.5rem;
    flex: 1 1 0;
    text-align: center;
  }

  .error-icon {
    font-size: 2rem;
    margin-block-end: 0.75rem;
  }

  .error-message {
    color: #ff5252;
    font-size: 0.8125rem;
    margin-block-end: 1rem;
    line-height: 1.5;
  }

  .retry-btn {
    padding-block: 0.5rem;
    padding-inline: 1.5rem;
    background: #2a3a4a;
    color: #e8eaed;
    border: 1px solid #3a4a5a;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 200ms ease-out;
    min-block-size: 2.75rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .retry-btn {
      transition: none;
    }
  }

  .retry-btn:focus-visible {
    outline: 2px solid #448aff;
    outline-offset: 2px;
  }

  @media (hover: hover) {
    .retry-btn:hover {
      background: #3a4a5a;
    }
  }
`;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Returns a status indicator emoji for the given WebSocket connection state.
 * Used in the connection status rows to provide a visual color-coded indicator.
 *
 * @param state - The current WebSocket connection state
 * @returns Unicode circle emoji: green (connected), red (disconnected), yellow (connecting/reconnecting)
 */
function getStatusIcon(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return '\u{1F7E2}'; // 🟢
    case 'disconnected':
      return '\u{1F534}'; // 🔴
    case 'reconnecting':
      return '\u{1F7E1}'; // 🟡
    case 'connecting':
      return '\u{1F7E1}'; // 🟡
    default:
      return '\u26AA'; // ⚪
  }
}

// =============================================================================
// App Component
// =============================================================================

/**
 * Root Preact component for the Chrome Extension toolbar popup.
 *
 * Renders a compact status dashboard (~300×400px) with:
 *   1. Extension name and version header
 *   2. WebSocket connection status for PumpPortal and Birdeye
 *   3. Active trading signal count
 *   4. Trading mode toggle (conservative ≥80 / aggressive ≥45)
 *   5. "Open Full Settings" button to navigate to sidebar overlay
 *
 * Communicates with the background service worker via chrome.runtime.sendMessage
 * and with the content script via chrome.tabs.sendMessage.
 *
 * State is fetched on mount and refreshed every 5 seconds via setInterval
 * (permitted in popup document context — AAP Section 0.7.1 restrictions
 * apply only to the service worker).
 */
const App: FunctionComponent = () => {
  // ---------------------------------------------------------------------------
  // Component State
  // ---------------------------------------------------------------------------

  /** Current extension status fetched from the service worker */
  const [status, setStatus] = useState<ExtensionStatus | null>(null);

  /** True while the initial status fetch is in progress */
  const [loading, setLoading] = useState<boolean>(true);

  /** Error message if service worker communication fails */
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Service Worker Communication
  // ---------------------------------------------------------------------------

  /**
   * Fetches current extension status from the background service worker.
   * Sends a GET_STATUS message and updates component state with the response.
   *
   * Handles cases where:
   * - The service worker is dormant (MV3 may need wake-up)
   * - The service worker responds with null/undefined
   * - Communication fails entirely (network error, extension unloaded)
   */
  const fetchStatus = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

      if (response && typeof response === 'object') {
        setStatus(response as ExtensionStatus);
      } else {
        setError('Received empty response from service worker');
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown error';
      setError(`Unable to connect to extension service worker: ${message}`);
      console.error('[popup] Failed to fetch status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Toggles the trading mode between conservative and aggressive.
   * Sends an UPDATE_SETTINGS message to the background service worker and
   * optimistically updates the local state for immediate UI feedback.
   *
   * Conservative mode: signals require ≥80 composite score
   * Aggressive mode: signals require ≥45 composite score
   */
  const toggleTradingMode = useCallback(async (): Promise<void> => {
    if (!status) return;

    const newMode: TradingMode =
      status.tradingMode === 'conservative' ? 'aggressive' : 'conservative';

    try {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        payload: { key: 'tradingMode', value: newMode },
      });

      // Optimistic update — apply the new mode immediately for responsive UI
      setStatus((prev) =>
        prev ? { ...prev, tradingMode: newMode } : prev
      );
    } catch (err: unknown) {
      console.error('[popup] Failed to toggle trading mode:', err);
    }
  }, [status]);

  /**
   * Opens the GMGN page and activates the extension sidebar's settings panel.
   * If a GMGN tab already exists, it is brought to focus and a message is sent
   * to the content script to open the settings panel. Otherwise, a new GMGN tab
   * is created. The popup is closed after navigation.
   */
  const openSettingsInOverlay = useCallback(async (): Promise<void> => {
    try {
      // Query for existing GMGN tabs
      const tabs = await chrome.tabs.query({ url: 'https://gmgn.ai/*' });

      if (tabs.length > 0 && tabs[0].id !== undefined) {
        // Focus the existing GMGN tab
        await chrome.tabs.update(tabs[0].id, { active: true });

        // Send message to the content script to open settings panel
        await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'OPEN_SETTINGS_PANEL',
        });
      } else {
        // Open a new GMGN tab
        await chrome.tabs.create({ url: 'https://gmgn.ai' });
      }

      // Close the popup window
      window.close();
    } catch (err: unknown) {
      console.error('[popup] Failed to open settings overlay:', err);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Lifecycle Effects
  // ---------------------------------------------------------------------------

  /**
   * Initial status fetch on component mount.
   * Triggers immediately when the popup opens.
   */
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /**
   * Periodic status refresh while the popup is open.
   * Polls the service worker every 5 seconds to keep displayed data current.
   * setInterval is permitted here — this is the popup document context,
   * NOT the service worker (AAP Section 0.7.1).
   */
  useEffect(() => {
    const interval = setInterval(fetchStatus, STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // ---------------------------------------------------------------------------
  // Render: Loading State
  // ---------------------------------------------------------------------------

  if (loading && !status) {
    return (
      <>
        <style>{popupStyles}</style>
        <div class="popup-container">
          <div class="popup-header">
            <h1>{EXTENSION_INFO.NAME}</h1>
            <span class="version">v{EXTENSION_INFO.VERSION}</span>
          </div>
          <div class="popup-loading">
            <div class="loading-spinner" aria-hidden="true" />
            <span class="loading-text">Loading status...</span>
          </div>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Error State
  // ---------------------------------------------------------------------------

  if (error && !status) {
    return (
      <>
        <style>{popupStyles}</style>
        <div class="popup-container">
          <div class="popup-header">
            <h1>{EXTENSION_INFO.NAME}</h1>
            <span class="version">v{EXTENSION_INFO.VERSION}</span>
          </div>
          <div class="popup-error">
            <span class="error-icon" aria-hidden="true">
              {'\u26A0\uFE0F'}
            </span>
            <p class="error-message">{error}</p>
            <button
              type="button"
              class="retry-btn"
              onClick={fetchStatus}
            >
              Retry
            </button>
          </div>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Main Status UI
  // ---------------------------------------------------------------------------

  /**
   * Guard: if status is null here (shouldn't happen due to loading/error gates),
   * return null to satisfy strict TS null checks.
   */
  if (!status) {
    return null;
  }

  return (
    <>
      <style>{popupStyles}</style>
      <div class="popup-container">
        {/* Header — Extension name and version */}
        <header class="popup-header">
          <h1>{EXTENSION_INFO.NAME}</h1>
          <span class="version">v{EXTENSION_INFO.VERSION}</span>
        </header>

        {/* Connection Status Section */}
        <section class="popup-section">
          <h2>Connections</h2>
          <div class="connection-row">
            <span class="connection-label">PumpPortal</span>
            <span
              class={`connection-status status-${status.websockets.pumpPortal}`}
            >
              {getStatusIcon(status.websockets.pumpPortal)}{' '}
              {status.websockets.pumpPortal}
            </span>
          </div>
          <div class="connection-row">
            <span class="connection-label">Birdeye</span>
            <span
              class={`connection-status status-${status.websockets.birdeye}`}
            >
              {getStatusIcon(status.websockets.birdeye)}{' '}
              {status.websockets.birdeye}
            </span>
          </div>
        </section>

        {/* Active Signals Section */}
        <section class="popup-section">
          <h2>Active Signals</h2>
          <div class="signal-count">
            <span class="count-number">{status.activeSignalCount}</span>
            <span class="count-label">active signals</span>
          </div>
        </section>

        {/* Trading Mode Section */}
        <section class="popup-section">
          <h2>Trading Mode</h2>
          <div class="mode-toggle" role="group" aria-label="Trading mode selection">
            <button
              type="button"
              class={status.tradingMode === 'conservative' ? 'active' : ''}
              aria-pressed={status.tradingMode === 'conservative'}
              onClick={() =>
                status.tradingMode !== 'conservative' && toggleTradingMode()
              }
            >
              Conservative ({'\u2265'}80)
            </button>
            <button
              type="button"
              class={status.tradingMode === 'aggressive' ? 'active' : ''}
              aria-pressed={status.tradingMode === 'aggressive'}
              onClick={() =>
                status.tradingMode !== 'aggressive' && toggleTradingMode()
              }
            >
              Aggressive ({'\u2265'}45)
            </button>
          </div>
        </section>

        {/* Footer — Open Full Settings */}
        <footer class="popup-footer">
          <button
            type="button"
            class="open-settings-btn"
            onClick={openSettingsInOverlay}
          >
            Open Full Settings
          </button>
        </footer>
      </div>
    </>
  );
};

// =============================================================================
// Exports
// =============================================================================

export { App };
