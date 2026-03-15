/**
 * Settings Page — User Notification Preferences Configuration
 *
 * Route-level page component rendered at `/settings` inside DashboardLayout.
 * Provides a form for managing notification preferences including market
 * selection checkboxes, confidence threshold slider, timeframe selection,
 * and notification active/inactive toggle.
 *
 * Since there is no authentication system (AAP §0.6.2), settings are
 * identified by Telegram chat ID — the user enters their chat ID to
 * load and modify their preferences.
 *
 * Per AAP §0.7.5: "Notifications must only be sent to users whose
 * preference filters (market, min_confidence, timeframes) match the
 * trade opportunity attributes."
 *
 * @module apps/web/src/pages/Settings
 */

import {
  useState,
  useEffect,
  useCallback,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import clsx from 'clsx';

import { useApi } from '../hooks/useApi';
import { apiPut } from '../lib/api-client';
import { Market, Timeframe } from '../types';
import type { UserSettings } from '../types';

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

/**
 * Internal form state for the settings page.
 * Maps to the editable subset of UserSettings fields.
 */
interface SettingsFormState {
  /** Telegram chat ID (readonly once loaded, for display purposes). */
  telegramChatId: string;
  /** Selected markets for trade alert notifications. */
  markets: Market[];
  /** Minimum confidence score threshold (0.00–1.00). */
  minConfidence: number;
  /** Selected timeframes for trade alert notifications. */
  timeframes: Timeframe[];
  /** Whether the user is actively receiving notifications. */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Constants — Option Definitions
// ---------------------------------------------------------------------------

/**
 * Market selection options displayed as checkbox cards.
 * Values use the Market enum from the shared types package to ensure
 * type safety and database parity. SOCIAL market is excluded since
 * it is a data source category, not a user-facing notification filter.
 */
const MARKET_OPTIONS: Array<{ value: Market; label: string; icon: string }> = [
  { value: Market.US_STOCK, label: 'US Stocks', icon: '🇺🇸' },
  { value: Market.INDIAN_EQUITY, label: 'Indian Equities', icon: '🇮🇳' },
  { value: Market.CRYPTO, label: 'Cryptocurrency', icon: '₿' },
];

/**
 * Timeframe selection options displayed as checkbox cards.
 * Values use the Timeframe enum from the shared types package.
 */
const TIMEFRAME_OPTIONS: Array<{
  value: Timeframe;
  label: string;
  description: string;
}> = [
  { value: Timeframe.INTRADAY, label: 'Intraday', description: 'Same-day trades' },
  { value: Timeframe.SWING, label: 'Swing', description: '2-10 day positions' },
  { value: Timeframe.POSITION, label: 'Positional', description: 'Multi-week positions' },
];

/** Default form state for new users or initial load. */
const DEFAULT_FORM_STATE: SettingsFormState = {
  telegramChatId: '',
  markets: [],
  minConfidence: 0.6,
  timeframes: [],
  isActive: true,
};

// ---------------------------------------------------------------------------
// Settings Page Component
// ---------------------------------------------------------------------------

/**
 * User settings configuration page component.
 *
 * Rendered inside DashboardLayout at the `/settings` route. Provides:
 * - Telegram chat ID input for identifying the user (no auth system)
 * - Notification enable/disable toggle
 * - Market selection checkboxes (US Stocks, Indian Equities, Crypto)
 * - Confidence threshold slider (0–100%, maps to 0.00–1.00 internally)
 * - Timeframe selection checkboxes (Intraday, Swing, Positional)
 * - Save button with loading/success/error status feedback
 */
export default function Settings() {
  // -----------------------------------------------------------------------
  // State — Chat ID input and editing mode
  // -----------------------------------------------------------------------

  /** The Telegram chat ID text currently in the input field. */
  const [chatId, setChatId] = useState<string>('');

  /**
   * The "submitted" chat ID that has been confirmed by the user clicking
   * "Load Settings". Only this value is used in the API URL, preventing
   * auto-fetch on every keystroke in the chat ID input.
   */
  const [submittedChatId, setSubmittedChatId] = useState<string>('');

  /** Whether the user has loaded existing settings (editing mode). */
  const [isEditing, setIsEditing] = useState<boolean>(false);

  // -----------------------------------------------------------------------
  // Data fetching — load existing settings by Telegram chat ID
  // -----------------------------------------------------------------------

  /**
   * Fetch user settings from the Express API backend.
   * Only fetches when a non-empty submittedChatId is provided (enabled flag).
   * The URL uses submittedChatId (not chatId) to prevent firing API calls
   * on every keystroke — requests are only made after the user explicitly
   * clicks "Load Settings".
   */
  const { data: settings, loading, error, refetch } = useApi<UserSettings>(
    `/settings/${submittedChatId}`,
    {
      enabled: submittedChatId.length > 0,
    },
  );

  // -----------------------------------------------------------------------
  // State — Form values and save status
  // -----------------------------------------------------------------------

  /** Current form field values, initialized from fetched data or defaults. */
  const [formState, setFormState] = useState<SettingsFormState>(DEFAULT_FORM_STATE);

  /** Save operation status for user feedback. */
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  /** Error message from a failed save operation. */
  const [saveError, setSaveError] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Effect — Sync form state when settings data loads from API
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (settings) {
      setFormState({
        telegramChatId: settings.telegramChatId,
        markets: settings.markets ?? [],
        minConfidence: settings.minConfidence ?? 0.6,
        timeframes: settings.timeframes ?? [],
        isActive: settings.isActive ?? true,
      });
      setIsEditing(true);
    }
  }, [settings]);

  // -----------------------------------------------------------------------
  // Handlers — Form field changes (all memoized to prevent re-renders)
  // -----------------------------------------------------------------------

  /**
   * Toggle a market in the selected markets array.
   * If the market is already selected, remove it; otherwise add it.
   */
  const handleMarketToggle = useCallback((market: Market): void => {
    setFormState((prev) => ({
      ...prev,
      markets: prev.markets.includes(market)
        ? prev.markets.filter((m) => m !== market)
        : [...prev.markets, market],
    }));
  }, []);

  /**
   * Toggle a timeframe in the selected timeframes array.
   * If the timeframe is already selected, remove it; otherwise add it.
   */
  const handleTimeframeToggle = useCallback((timeframe: Timeframe): void => {
    setFormState((prev) => ({
      ...prev,
      timeframes: prev.timeframes.includes(timeframe)
        ? prev.timeframes.filter((t) => t !== timeframe)
        : [...prev.timeframes, timeframe],
    }));
  }, []);

  /**
   * Handle confidence slider value change.
   * The slider uses 0–100 integer range; we convert to 0.00–1.00 decimal.
   */
  const handleConfidenceChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const value = parseInt(e.target.value, 10) / 100;
      setFormState((prev) => ({ ...prev, minConfidence: value }));
    },
    [],
  );

  /**
   * Toggle the notification active/inactive state.
   * When inactive, no trade alerts are sent regardless of other filters.
   */
  const handleActiveToggle = useCallback((): void => {
    setFormState((prev) => ({ ...prev, isActive: !prev.isActive }));
  }, []);

  // -----------------------------------------------------------------------
  // Handler — Form submission (save settings via PUT)
  // -----------------------------------------------------------------------

  /**
   * Submit the settings form to the Express API backend.
   * Uses apiPut to send the updated preferences to PUT /api/settings/:chatId.
   * Manages save status feedback (saving → saved → idle after 3s, or error).
   */
  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      setSaveStatus('saving');
      setSaveError(null);

      try {
        await apiPut(`/settings/${submittedChatId}`, {
          markets: formState.markets,
          minConfidence: formState.minConfidence,
          timeframes: formState.timeframes,
          isActive: formState.isActive,
        });
        setSaveStatus('saved');
        // Reset saved status after 3 seconds for transient feedback
        setTimeout(() => {
          setSaveStatus('idle');
        }, 3000);
      } catch (err: unknown) {
        setSaveStatus('error');
        setSaveError(
          err instanceof Error ? err.message : 'Failed to save settings',
        );
      }
    },
    [submittedChatId, formState],
  );

  // -----------------------------------------------------------------------
  // Handler — Chat ID lookup (manual re-fetch)
  // -----------------------------------------------------------------------

  /**
   * Manually trigger a settings fetch for the entered chat ID.
   * Used by the "Load Settings" button for explicit user-initiated lookup.
   * Sets the submittedChatId which triggers the useApi hook to fetch,
   * or calls refetch() if the same chat ID is being re-fetched.
   */
  const handleLookup = useCallback((): void => {
    const trimmed = chatId.trim();
    if (trimmed) {
      if (trimmed === submittedChatId) {
        refetch();
      } else {
        setSubmittedChatId(trimmed);
      }
    }
  }, [chatId, submittedChatId, refetch]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="page-content">
      {/* Page header */}
      <div className="page-header">
        <h1 className="page-title">⚙️ Settings</h1>
        <p className="text-secondary text-sm">
          Configure your notification preferences
        </p>
      </div>

      {/* Telegram Chat ID input section */}
      <section className="card settings-section" aria-labelledby="telegram-heading">
        <h2 id="telegram-heading" className="section-title">
          Telegram Connection
        </h2>
        <p className="text-sm text-secondary mb-3">
          Enter your Telegram chat ID to manage notification preferences. You
          can get your chat ID by messaging the bot with /start.
        </p>
        <div className="chat-id-input-group">
          <input
            type="text"
            value={chatId}
            onChange={(e) => {
              setChatId(e.target.value);
            }}
            placeholder="Enter Telegram Chat ID"
            className="filter-input"
            aria-label="Telegram Chat ID"
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleLookup}
            disabled={!chatId.trim() || loading}
          >
            {loading ? 'Loading...' : 'Load Settings'}
          </button>
        </div>
        {error !== null && (
          <p className="text-danger text-sm mt-2" role="alert">
            {error}
          </p>
        )}
      </section>

      {/* Settings form — visible when settings loaded or chat ID entered */}
      {(isEditing || chatId.trim()) && (
        <form onSubmit={handleSubmit}>
          {/* Notification toggle section */}
          <section
            className="card settings-section"
            aria-labelledby="notifications-heading"
          >
            <h2 id="notifications-heading" className="section-title">
              Notifications
            </h2>
            <div className="toggle-row">
              <div>
                <span className="font-medium">Enable Notifications</span>
                <p className="text-xs text-secondary">
                  Receive trade alerts via Telegram
                </p>
              </div>
              <button
                type="button"
                className={clsx(
                  'toggle-switch',
                  formState.isActive && 'toggle-active',
                )}
                onClick={handleActiveToggle}
                role="switch"
                aria-checked={formState.isActive}
                aria-label="Toggle notifications"
              >
                <span className="toggle-knob" />
              </button>
            </div>
          </section>

          {/* Market selection section */}
          <section
            className="card settings-section"
            aria-labelledby="markets-heading"
          >
            <h2 id="markets-heading" className="section-title">
              Markets
            </h2>
            <p className="text-sm text-secondary mb-3">
              Select which markets you want to receive trade alerts for
            </p>
            <div className="checkbox-grid" role="group" aria-label="Market selection">
              {MARKET_OPTIONS.map((option) => (
                <label key={option.value} className="checkbox-card">
                  <input
                    type="checkbox"
                    checked={formState.markets.includes(option.value)}
                    onChange={() => {
                      handleMarketToggle(option.value);
                    }}
                  />
                  <span className="checkbox-icon" aria-hidden="true">
                    {option.icon}
                  </span>
                  <span className="checkbox-label">{option.label}</span>
                </label>
              ))}
            </div>
          </section>

          {/* Confidence threshold slider section */}
          <section
            className="card settings-section"
            aria-labelledby="confidence-heading"
          >
            <h2 id="confidence-heading" className="section-title">
              Confidence Threshold
            </h2>
            <p className="text-sm text-secondary mb-3">
              Minimum confidence score for trade alerts (higher = fewer but more
              confident alerts)
            </p>
            <div className="slider-container">
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round(formState.minConfidence * 100)}
                onChange={handleConfidenceChange}
                className="confidence-slider"
                aria-label="Confidence threshold percentage"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(formState.minConfidence * 100)}
                aria-valuetext={`${String(Math.round(formState.minConfidence * 100))} percent`}
              />
              <div className="slider-labels">
                <span className="text-xs text-secondary">0%</span>
                <span className="text-lg font-bold font-mono">
                  {Math.round(formState.minConfidence * 100)}%
                </span>
                <span className="text-xs text-secondary">100%</span>
              </div>
            </div>
          </section>

          {/* Timeframe selection section */}
          <section
            className="card settings-section"
            aria-labelledby="timeframes-heading"
          >
            <h2 id="timeframes-heading" className="section-title">
              Timeframes
            </h2>
            <p className="text-sm text-secondary mb-3">
              Select which trade timeframes you&apos;re interested in
            </p>
            <div
              className="checkbox-grid"
              role="group"
              aria-label="Timeframe selection"
            >
              {TIMEFRAME_OPTIONS.map((option) => (
                <label key={option.value} className="checkbox-card">
                  <input
                    type="checkbox"
                    checked={formState.timeframes.includes(option.value)}
                    onChange={() => {
                      handleTimeframeToggle(option.value);
                    }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span className="checkbox-label">{option.label}</span>
                    <span className="text-xs text-secondary">
                      {option.description}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* Save button and status feedback */}
          <div className="settings-actions">
            <button
              type="submit"
              className={clsx(
                'btn btn-primary',
                saveStatus === 'saving' && 'btn-loading',
              )}
              disabled={saveStatus === 'saving'}
            >
              {saveStatus === 'saving' ? 'Saving...' : 'Save Settings'}
            </button>
            {saveStatus === 'saved' && (
              <span className="text-success text-sm" role="status">
                ✓ Settings saved successfully
              </span>
            )}
            {saveStatus === 'error' && saveError !== null && (
              <span className="text-danger text-sm" role="alert">
                ✗ {saveError}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
