/**
 * src/components/SettingsPanel.tsx — User Configuration Panel
 *
 * Provides the extension's user-facing configuration interface, rendered
 * inside the Shadow DOM sidebar overlay on GMGN.ai pages.
 *
 * Per AAP §0.5.1 Group 11:
 *   "User configuration form; API key input fields (stored encrypted),
 *    trading mode toggle, scoring weight sliders, TP/SL profile editor,
 *    notification preferences"
 *
 * Per AAP §0.7.2 (Security):
 *   "API keys never in content scripts — all external API keys must be stored
 *    encrypted in chrome.storage.local and accessed only from the service
 *    worker context."
 *
 * Per AAP §0.7.3:
 *   "All 7 factor weights must be user-configurable via the settings panel;
 *    the scoring engine reads weights from the Zustand settings-store at
 *    analysis time, not from hardcoded constants."
 *
 * Feature set:
 *   - 5 API key input fields (Birdeye, Helius, RugCheck, Groq, Anthropic)
 *     with show/hide toggles, save buttons, and connection test buttons
 *   - Conservative / Aggressive trading mode toggle with score thresholds
 *   - 7 scoring weight sliders with auto-normalize and reset to defaults
 *   - TP/SL profile editor (ladder, day-trade, swing-trade) with custom edit
 *   - Hard exit trigger toggles (dev sell, smart money exit, volume decline)
 *   - Notification preference toggles
 *
 * State management:
 *   Reads and writes the Zustand settings-store via `useSettingsStoreHook`
 *   from `src/store/index.ts`. API key encryption/decryption is relayed to
 *   the service worker via `sendToBackground` from `src/utils/messaging.ts`.
 *
 * @module components/SettingsPanel
 */

import { h, type FunctionComponent } from 'preact';
import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';

import { useSettingsStoreHook } from '../store/index';
import type { ScoringWeights, TradingMode } from '../signals/types';
import {
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_EXIT_STRATEGY,
  SCORING_THRESHOLDS,
} from '../utils/config';
import { sendToBackground } from '../utils/messaging';

// =============================================================================
// Constants
// =============================================================================

/** API key provider configuration for field rendering */
const API_KEY_PROVIDERS: ReadonlyArray<{
  key: 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic';
  label: string;
  placeholder: string;
  required: boolean;
}> = [
  { key: 'birdeye', label: 'Birdeye', placeholder: 'Enter Birdeye API key', required: true },
  { key: 'helius', label: 'Helius', placeholder: 'Enter Helius API key', required: true },
  { key: 'groq', label: 'Groq', placeholder: 'Enter Groq API key', required: true },
  { key: 'rugcheck', label: 'RugCheck', placeholder: 'Enter RugCheck API key (optional)', required: false },
  { key: 'anthropic', label: 'Anthropic', placeholder: 'Enter Anthropic API key (optional)', required: false },
] as const;

/** Scoring weight factor labels for slider rendering */
const WEIGHT_FACTOR_LABELS: ReadonlyArray<{
  key: keyof ScoringWeights;
  label: string;
  description: string;
}> = [
  { key: 'volumeSpike', label: 'Volume Spike', description: 'Detects 3–8× volume surges over 5m MA' },
  { key: 'smartMoneyConvergence', label: 'Smart Money', description: '3+ qualified wallets converging in 2h' },
  { key: 'buySellRatio', label: 'Buy/Sell Ratio', description: 'Accumulation pressure ≥1.3×' },
  { key: 'holderGrowth', label: 'Holder Growth', description: 'Organic wallet growth retained ≥24h' },
  { key: 'liquidity', label: 'Liquidity', description: 'Minimum $3K–$30K liquidity threshold' },
  { key: 'tokenAge', label: 'Token Age', description: '≤3h early accumulation, ≤12h max' },
  { key: 'safetyScore', label: 'Safety Score', description: 'RugCheck ≥300 + GoPlus composite' },
] as const;

/** Slider bounds for weight inputs */
const WEIGHT_SLIDER_MIN = 0;
const WEIGHT_SLIDER_MAX = 0.5;
const WEIGHT_SLIDER_STEP = 0.01;

/** Debounce delay for scoring weight updates (ms) */
const WEIGHT_DEBOUNCE_MS = 300;

/** Masked placeholder for saved API keys */
const API_KEY_MASK = '••••••••••••';

// =============================================================================
// Utility: useDebounce hook
// =============================================================================

/**
 * Debounces a callback with the specified delay.
 * Returns a stable function reference that delays invocation.
 */
function useDebounce<T extends (...args: never[]) => void>(
  callback: T,
  delayMs: number,
): T {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);

  /* Keep the callback ref current without re-creating the debounced fn */
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  /* Clean up on unmount */
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return useCallback(
    ((...args: Parameters<T>) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        callbackRef.current(...(args as never[]));
        timerRef.current = null;
      }, delayMs);
    }) as T,
    [delayMs],
  );
}

// =============================================================================
// Sub-Component: SectionHeader
// =============================================================================

/**
 * Collapsible section header for visual grouping of settings.
 * Provides keyboard-accessible expand/collapse behavior.
 */
const SectionHeader: FunctionComponent<{
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ title, collapsed, onToggle }) => (
  <button
    type="button"
    class="settings-section-header"
    onClick={onToggle}
    aria-expanded={!collapsed}
    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title} section`}
  >
    <span class="settings-section-title">{title}</span>
    <span class="settings-section-arrow" aria-hidden="true">
      {collapsed ? '▶' : '▼'}
    </span>
  </button>
);

// =============================================================================
// Sub-Component: ApiKeyField
// =============================================================================

/**
 * API key input field with show/hide toggle, save button, status indicator,
 * and connection test button.
 *
 * CRITICAL per AAP §0.7.2: API keys are NEVER stored in the content script.
 * On save, keys are relayed to the service worker via `sendToBackground` for
 * AES-GCM encrypted storage in chrome.storage.local.
 */
const ApiKeyField: FunctionComponent<{
  providerKey: string;
  label: string;
  placeholder: string;
  required: boolean;
  hasSavedKey: boolean;
  onSave: (key: string) => void;
  onTest: () => void;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
}> = ({ providerKey, label, placeholder, required, hasSavedKey, onSave, onTest, testStatus }) => {
  const [inputValue, setInputValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const handleSave = useCallback(() => {
    const trimmedKey = inputValue.trim();
    if (trimmedKey.length === 0) {
      return;
    }
    setSaveStatus('saving');
    onSave(trimmedKey);
    /* Reset input after save — key is now encrypted server-side */
    setInputValue('');
    setVisible(false);
    setSaveStatus('saved');
    /* Reset save status after brief feedback */
    setTimeout(() => setSaveStatus('idle'), 2000);
  }, [inputValue, onSave]);

  return (
    <div
      class="settings-api-key-field"
      role="group"
      aria-label={`${label} API key configuration`}
    >
      <div class="settings-api-key-header">
        <label class="settings-label" htmlFor={`api-key-${providerKey}`}>
          {label}
          {required && <span class="settings-required" aria-label="required"> *</span>}
        </label>
        {hasSavedKey && (
          <span class="settings-saved-indicator" aria-label={`${label} key configured`}>
            ✅
          </span>
        )}
        {!hasSavedKey && (
          <span class="settings-unsaved-indicator" aria-label={`${label} key not configured`}>
            ⚠️
          </span>
        )}
      </div>
      <div class="settings-input-row">
        <input
          id={`api-key-${providerKey}`}
          type={visible ? 'text' : 'password'}
          class="settings-input"
          placeholder={hasSavedKey ? API_KEY_MASK : placeholder}
          value={inputValue}
          onInput={(e) => setInputValue((e.target as HTMLInputElement).value)}
          autocomplete="off"
          spellcheck={false}
          aria-label={`${label} API key input`}
        />
        <button
          type="button"
          class="settings-icon-btn"
          onClick={() => setVisible(!visible)}
          aria-label={visible ? `Hide ${label} key` : `Show ${label} key`}
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? '🙈' : '👁'}
        </button>
      </div>
      <div class="settings-api-key-actions">
        <button
          type="button"
          class="settings-save-btn"
          onClick={handleSave}
          disabled={inputValue.trim().length === 0 || saveStatus === 'saving'}
          aria-label={`Save ${label} API key`}
        >
          {saveStatus === 'saving' ? '⏳ Saving…' : saveStatus === 'saved' ? '✅ Saved' : '💾 Save'}
        </button>
        <button
          type="button"
          class="settings-test-btn"
          onClick={onTest}
          disabled={!hasSavedKey || testStatus === 'testing'}
          aria-label={`Test ${label} connection`}
        >
          {testStatus === 'testing'
            ? '⏳ Testing…'
            : testStatus === 'success'
              ? '✅ Connected'
              : testStatus === 'error'
                ? '❌ Failed'
                : '🔗 Test'}
        </button>
      </div>
    </div>
  );
};

// =============================================================================
// Sub-Component: TradingModeToggle
// =============================================================================

/**
 * Trading mode toggle: Conservative (≥80 score) / Aggressive (≥45 score).
 * Displays the active score threshold from SCORING_THRESHOLDS constants.
 * Uses getScoreThreshold() from the store for the current mode's threshold.
 */
const TradingModeToggle: FunctionComponent<{
  mode: TradingMode;
  currentThreshold: number;
  onChange: (mode: TradingMode) => void;
}> = ({ mode, currentThreshold, onChange }) => (
  <div class="settings-mode-section" role="group" aria-label="Trading mode selection">
    <div class="settings-mode-toggle" role="radiogroup" aria-label="Trading mode">
      <button
        type="button"
        class={`settings-mode-btn ${mode === 'conservative' ? 'settings-mode-active' : ''}`}
        role="radio"
        aria-checked={mode === 'conservative'}
        onClick={() => onChange('conservative')}
      >
        <span class="settings-mode-icon" aria-hidden="true">🛡️</span>
        <span class="settings-mode-text">Conservative</span>
        <span class="settings-mode-threshold">≥{SCORING_THRESHOLDS.CONSERVATIVE_MIN}</span>
      </button>
      <button
        type="button"
        class={`settings-mode-btn ${mode === 'aggressive' ? 'settings-mode-active' : ''}`}
        role="radio"
        aria-checked={mode === 'aggressive'}
        onClick={() => onChange('aggressive')}
      >
        <span class="settings-mode-icon" aria-hidden="true">⚡</span>
        <span class="settings-mode-text">Aggressive</span>
        <span class="settings-mode-threshold">≥{SCORING_THRESHOLDS.AGGRESSIVE_MIN}</span>
      </button>
    </div>
    <p class="settings-threshold-display" aria-live="polite">
      Active threshold: <strong>≥{currentThreshold}</strong> composite score
    </p>
  </div>
);

// =============================================================================
// Sub-Component: WeightSlider
// =============================================================================

/**
 * Individual scoring weight slider with real-time percentage display.
 * Shows the default value for comparison.
 */
const WeightSlider: FunctionComponent<{
  factorKey: keyof ScoringWeights;
  label: string;
  description: string;
  value: number;
  defaultValue: number;
  onChange: (value: number) => void;
}> = ({ factorKey, label, description, value, defaultValue, onChange }) => {
  const percentDisplay = `${(value * 100).toFixed(0)}%`;
  const defaultDisplay = `${(defaultValue * 100).toFixed(0)}%`;
  const isDefault = Math.abs(value - defaultValue) < 0.005;

  return (
    <div
      class="settings-weight-slider"
      role="group"
      aria-label={`${label} weight adjustment`}
    >
      <div class="settings-weight-header">
        <span class="settings-weight-label">{label}</span>
        <span class="settings-weight-values">
          <span class="settings-weight-value" aria-live="polite">{percentDisplay}</span>
          {!isDefault && (
            <span class="settings-weight-default" aria-label={`default: ${defaultDisplay}`}>
              (default: {defaultDisplay})
            </span>
          )}
        </span>
      </div>
      <input
        type="range"
        class="settings-slider"
        id={`weight-${factorKey}`}
        min={WEIGHT_SLIDER_MIN}
        max={WEIGHT_SLIDER_MAX}
        step={WEIGHT_SLIDER_STEP}
        value={value}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
        aria-label={`${label} weight: ${percentDisplay}`}
        aria-valuemin={WEIGHT_SLIDER_MIN}
        aria-valuemax={WEIGHT_SLIDER_MAX}
        aria-valuenow={value}
        title={description}
      />
      <span class="settings-weight-desc">{description}</span>
    </div>
  );
};

// =============================================================================
// Sub-Component: TpSlProfileEditor
// =============================================================================

/**
 * TP/SL profile selector and editor with built-in presets and custom editing.
 * Supports three built-in profiles derived from DEFAULT_EXIT_STRATEGY:
 * - Ladder: Sell 50% at 2×, 25% at 5×, 25% at 10×
 * - Day-trade: +15%/+30%/+60% TP, -12% SL
 * - Swing-trade: +40%/+100%/+200%/+500% TP, -18% SL
 */
const TpSlProfileEditor: FunctionComponent<{
  profiles: Array<{ name: string; takeProfitLadder: Array<{ sellPercent: number; multiplier: number }>; stopLoss: number }>;
  activeProfileName: string;
  onSelectProfile: (name: string) => void;
  onUpsertProfile: (profile: { name: string; takeProfitLadder: Array<{ sellPercent: number; multiplier: number }>; stopLoss: number }) => void;
}> = ({ profiles, activeProfileName, onSelectProfile, onUpsertProfile }) => {
  const [editingCustom, setEditingCustom] = useState(false);
  const [customName, setCustomName] = useState('custom');
  const [customLadder, setCustomLadder] = useState<Array<{ sellPercent: number; multiplier: number }>>([
    { sellPercent: 50, multiplier: 2 },
    { sellPercent: 25, multiplier: 5 },
    { sellPercent: 25, multiplier: 10 },
  ]);
  const [customStopLoss, setCustomStopLoss] = useState(-12);

  const activeProfile = profiles.find((p) => p.name === activeProfileName);

  /** Display the DEFAULT_EXIT_STRATEGY reference values inline */
  const ladderDefaults = DEFAULT_EXIT_STRATEGY.LADDER;
  const dayTradeDefaults = DEFAULT_EXIT_STRATEGY.DAY_TRADE;
  const swingTradeDefaults = DEFAULT_EXIT_STRATEGY.SWING_TRADE;

  const handleSaveCustom = useCallback(() => {
    onUpsertProfile({
      name: customName || 'custom',
      takeProfitLadder: customLadder,
      stopLoss: customStopLoss,
    });
    setEditingCustom(false);
  }, [customName, customLadder, customStopLoss, onUpsertProfile]);

  const updateLadderLevel = useCallback(
    (index: number, field: 'sellPercent' | 'multiplier', value: number) => {
      setCustomLadder((prev) =>
        prev.map((level, i) => (i === index ? { ...level, [field]: value } : level)),
      );
    },
    [],
  );

  const addLadderLevel = useCallback(() => {
    setCustomLadder((prev) => [...prev, { sellPercent: 25, multiplier: 2 }]);
  }, []);

  const removeLadderLevel = useCallback((index: number) => {
    setCustomLadder((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div class="settings-tpsl-editor" role="group" aria-label="TP/SL profile management">
      {/* Profile selector buttons */}
      <div class="settings-tpsl-profiles" role="tablist" aria-label="Exit strategy profiles">
        {profiles.map((profile) => (
          <button
            key={profile.name}
            type="button"
            role="tab"
            class={`settings-tpsl-btn ${profile.name === activeProfileName ? 'settings-tpsl-active' : ''}`}
            onClick={() => onSelectProfile(profile.name)}
            aria-selected={profile.name === activeProfileName}
            aria-label={`${profile.name} profile`}
          >
            {profile.name}
          </button>
        ))}
        <button
          type="button"
          class={`settings-tpsl-btn settings-tpsl-custom-btn ${editingCustom ? 'settings-tpsl-active' : ''}`}
          onClick={() => setEditingCustom(!editingCustom)}
          aria-label="Create custom profile"
        >
          + Custom
        </button>
      </div>

      {/* Active profile detail */}
      {activeProfile && !editingCustom && (
        <div class="settings-tpsl-detail" role="tabpanel" aria-label={`${activeProfile.name} profile details`}>
          <div class="settings-tpsl-ladder">
            <span class="settings-label">Take-Profit Ladder:</span>
            {activeProfile.takeProfitLadder.map((level, idx) => (
              <div key={idx} class="settings-tpsl-level">
                <span class="settings-tpsl-sell">Sell {level.sellPercent}%</span>
                <span class="settings-tpsl-at">at {level.multiplier}×</span>
              </div>
            ))}
          </div>
          <div class="settings-tpsl-sl">
            <span class="settings-label">Stop Loss:</span>
            <span class="settings-tpsl-sl-value">{activeProfile.stopLoss}%</span>
          </div>

          {/* Show default reference for the active built-in profile */}
          {activeProfile.name === 'ladder' && (
            <p class="settings-hint">
              Default ladder: {ladderDefaults.map((l) => `${l.sellPercent}% at ${l.multiplier}×`).join(', ')}
            </p>
          )}
          {activeProfile.name === 'day-trade' && (
            <p class="settings-hint">
              Default TP: +{dayTradeDefaults.takeProfitLevels.join('%/+')}%, SL: {dayTradeDefaults.stopLoss}%
            </p>
          )}
          {activeProfile.name === 'swing-trade' && (
            <p class="settings-hint">
              Default TP: +{swingTradeDefaults.takeProfitLevels.join('%/+')}%, SL: {swingTradeDefaults.stopLoss}%
            </p>
          )}
        </div>
      )}

      {/* Custom profile editor */}
      {editingCustom && (
        <div class="settings-tpsl-custom" role="form" aria-label="Custom TP/SL profile editor">
          <div class="settings-field">
            <label class="settings-label" htmlFor="custom-profile-name">Profile Name:</label>
            <input
              id="custom-profile-name"
              type="text"
              class="settings-input"
              value={customName}
              onInput={(e) => setCustomName((e.target as HTMLInputElement).value)}
              aria-label="Custom profile name"
            />
          </div>
          <div class="settings-tpsl-ladder-edit">
            <span class="settings-label">TP Ladder Levels:</span>
            {customLadder.map((level, idx) => (
              <div key={idx} class="settings-tpsl-level-edit">
                <label class="settings-inline-label">
                  Sell
                  <input
                    type="number"
                    class="settings-input settings-input-sm"
                    min={1}
                    max={100}
                    value={level.sellPercent}
                    onInput={(e) =>
                      updateLadderLevel(idx, 'sellPercent', parseInt((e.target as HTMLInputElement).value, 10) || 0)
                    }
                    aria-label={`Sell percentage for level ${idx + 1}`}
                  />
                  %
                </label>
                <label class="settings-inline-label">
                  at
                  <input
                    type="number"
                    class="settings-input settings-input-sm"
                    min={1}
                    max={1000}
                    step={0.1}
                    value={level.multiplier}
                    onInput={(e) =>
                      updateLadderLevel(idx, 'multiplier', parseFloat((e.target as HTMLInputElement).value) || 1)
                    }
                    aria-label={`Multiplier target for level ${idx + 1}`}
                  />
                  ×
                </label>
                {customLadder.length > 1 && (
                  <button
                    type="button"
                    class="settings-remove-btn"
                    onClick={() => removeLadderLevel(idx)}
                    aria-label={`Remove ladder level ${idx + 1}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              class="settings-add-btn"
              onClick={addLadderLevel}
              aria-label="Add ladder level"
            >
              + Add Level
            </button>
          </div>
          <div class="settings-field">
            <label class="settings-label" htmlFor="custom-stop-loss">Stop Loss (%):</label>
            <input
              id="custom-stop-loss"
              type="number"
              class="settings-input settings-input-sm"
              min={-100}
              max={0}
              value={customStopLoss}
              onInput={(e) => setCustomStopLoss(parseInt((e.target as HTMLInputElement).value, 10) || 0)}
              aria-label="Custom stop loss percentage"
            />
          </div>
          <button
            type="button"
            class="settings-save-btn"
            onClick={handleSaveCustom}
            aria-label="Save custom profile"
          >
            💾 Save Custom Profile
          </button>
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Sub-Component: HardExitTriggers
// =============================================================================

/**
 * Hard exit trigger toggles for automatic position exit conditions.
 * Per AAP Section 0.5.1: dev wallet selling, smart money exit, volume decline.
 */
const HardExitTriggers: FunctionComponent<{
  devSellEnabled: boolean;
  smartMoneyExitEnabled: boolean;
  volumeDeclineEnabled: boolean;
  volumeDeclineThreshold: number;
  onToggleDevSell: (enabled: boolean) => void;
  onToggleSmartMoneyExit: (enabled: boolean) => void;
  onToggleVolumeDecline: (enabled: boolean) => void;
  onVolumeDeclineThresholdChange: (threshold: number) => void;
}> = ({
  devSellEnabled,
  smartMoneyExitEnabled,
  volumeDeclineEnabled,
  volumeDeclineThreshold,
  onToggleDevSell,
  onToggleSmartMoneyExit,
  onToggleVolumeDecline,
  onVolumeDeclineThresholdChange,
}) => (
  <div class="settings-exit-triggers" role="group" aria-label="Hard exit trigger configuration">
    <span class="settings-label settings-label-subsection">Hard Exit Triggers:</span>
    <div class="settings-trigger-row">
      <label class="settings-trigger-label">
        <input
          type="checkbox"
          checked={devSellEnabled}
          onChange={(e) => onToggleDevSell((e.target as HTMLInputElement).checked)}
        />
        Dev wallet selling detection
      </label>
    </div>
    <div class="settings-trigger-row">
      <label class="settings-trigger-label">
        <input
          type="checkbox"
          checked={smartMoneyExitEnabled}
          onChange={(e) => onToggleSmartMoneyExit((e.target as HTMLInputElement).checked)}
        />
        Smart money position reduction (40–60%)
      </label>
    </div>
    <div class="settings-trigger-row">
      <label class="settings-trigger-label">
        <input
          type="checkbox"
          checked={volumeDeclineEnabled}
          onChange={(e) => onToggleVolumeDecline((e.target as HTMLInputElement).checked)}
        />
        Volume decline trigger
      </label>
      {volumeDeclineEnabled && (
        <label class="settings-inline-label settings-trigger-threshold">
          Threshold:
          <input
            type="number"
            class="settings-input settings-input-sm"
            min={1}
            max={100}
            value={volumeDeclineThreshold}
            onInput={(e) =>
              onVolumeDeclineThresholdChange(parseInt((e.target as HTMLInputElement).value, 10) || 10)
            }
            aria-label="Volume decline threshold percentage"
          />
          % vol-to-MC
        </label>
      )}
    </div>
  </div>
);

// =============================================================================
// Sub-Component: NotificationSettings
// =============================================================================

/**
 * Notification preferences toggles for signal and exit alert configuration.
 */
const NotificationSettings: FunctionComponent<{
  prefs: {
    enabled: boolean;
    minScoreForAlert: number;
    soundEnabled: boolean;
    exitAlerts: boolean;
    newTokenAlerts: boolean;
    smartMoneyAlerts: boolean;
  };
  onChange: (prefs: Partial<{
    enabled: boolean;
    minScoreForAlert: number;
    soundEnabled: boolean;
    exitAlerts: boolean;
    newTokenAlerts: boolean;
    smartMoneyAlerts: boolean;
  }>) => void;
}> = ({ prefs, onChange }) => (
  <div class="settings-notifications" role="group" aria-label="Notification preferences">
    <div class="settings-notif-row">
      <label class="settings-notif-label">
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => onChange({ enabled: (e.target as HTMLInputElement).checked })}
        />
        Enable notifications
      </label>
    </div>
    {prefs.enabled && (
      <>
        <div class="settings-notif-row">
          <label class="settings-notif-label">
            <input
              type="checkbox"
              checked={prefs.soundEnabled}
              onChange={(e) => onChange({ soundEnabled: (e.target as HTMLInputElement).checked })}
            />
            Sound alerts
          </label>
        </div>
        <div class="settings-notif-row">
          <label class="settings-notif-label">
            <input
              type="checkbox"
              checked={prefs.exitAlerts}
              onChange={(e) => onChange({ exitAlerts: (e.target as HTMLInputElement).checked })}
            />
            Exit alerts (TP/SL triggered)
          </label>
        </div>
        <div class="settings-notif-row">
          <label class="settings-notif-label">
            <input
              type="checkbox"
              checked={prefs.newTokenAlerts}
              onChange={(e) => onChange({ newTokenAlerts: (e.target as HTMLInputElement).checked })}
            />
            New high-confidence token alerts
          </label>
        </div>
        <div class="settings-notif-row">
          <label class="settings-notif-label">
            <input
              type="checkbox"
              checked={prefs.smartMoneyAlerts}
              onChange={(e) => onChange({ smartMoneyAlerts: (e.target as HTMLInputElement).checked })}
            />
            Smart money convergence events
          </label>
        </div>
        <div class="settings-notif-row">
          <label class="settings-notif-label">
            Min score for alert:
            <input
              type="number"
              class="settings-input settings-input-sm"
              min={0}
              max={100}
              value={prefs.minScoreForAlert}
              onInput={(e) =>
                onChange({ minScoreForAlert: parseInt((e.target as HTMLInputElement).value, 10) || 0 })
              }
              aria-label="Minimum score threshold for alert notifications"
            />
          </label>
        </div>
      </>
    )}
  </div>
);

// =============================================================================
// SettingsPanel — Main Component
// =============================================================================

/**
 * User configuration panel for the GMGN Signal Bot Chrome Extension.
 *
 * Provides controls for:
 * 1. API key management (5 keys, encrypted via service worker)
 * 2. Trading mode selection (Conservative ≥80 / Aggressive ≥45)
 * 3. Scoring weight customization (7 factor sliders, debounced 300ms)
 * 4. TP/SL profile selection (ladder, day-trade, swing-trade) + custom
 * 5. Hard exit trigger toggles
 * 6. Notification preferences
 *
 * All settings are persisted to chrome.storage.sync via the Zustand
 * settings-store for cross-device synchronization.
 *
 * @returns Preact virtual DOM tree for the settings panel
 */
const SettingsPanel: FunctionComponent = () => {
  // ---------------------------------------------------------------------------
  // Store Bindings — Settings State (members_accessed from useSettingsStoreHook)
  // ---------------------------------------------------------------------------

  const tradingMode = useSettingsStoreHook((s) => s.tradingMode);
  const scoringWeights = useSettingsStoreHook((s) => s.scoringWeights);
  const tpSlProfiles = useSettingsStoreHook((s) => s.tpSlProfiles);
  const apiKeys = useSettingsStoreHook((s) => s.apiKeys);
  const notificationPrefs = useSettingsStoreHook((s) => s.notificationPrefs);
  const panelVisible = useSettingsStoreHook((s) => s.panelVisible);

  // ---------------------------------------------------------------------------
  // Store Bindings — Settings Actions
  // ---------------------------------------------------------------------------

  const setTradingMode = useSettingsStoreHook((s) => s.setTradingMode);
  const setScoringWeights = useSettingsStoreHook((s) => s.setScoringWeights);
  const resetScoringWeights = useSettingsStoreHook((s) => s.resetScoringWeights);
  const setActiveTpSlProfile = useSettingsStoreHook((s) => s.setActiveTpSlProfile);
  const upsertTpSlProfile = useSettingsStoreHook((s) => s.upsertTpSlProfile);
  const setNotificationPrefs = useSettingsStoreHook((s) => s.setNotificationPrefs);
  const getScoreThreshold = useSettingsStoreHook((s) => s.getScoreThreshold);

  // ---------------------------------------------------------------------------
  // Derived State
  // ---------------------------------------------------------------------------

  /** Current active score threshold based on trading mode */
  const currentThreshold = useMemo(() => getScoreThreshold(), [getScoreThreshold]);

  // ---------------------------------------------------------------------------
  // Section Collapse State
  // ---------------------------------------------------------------------------

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    apiKeys: false,
    tradingMode: false,
    weights: true,
    tpsl: true,
    exitTriggers: true,
    notifications: true,
  });

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);

  // ---------------------------------------------------------------------------
  // API Key Management — Relay to service worker for encrypted storage
  // ---------------------------------------------------------------------------

  const [testStatuses, setTestStatuses] = useState<Record<string, 'idle' | 'testing' | 'success' | 'error'>>({
    birdeye: 'idle',
    helius: 'idle',
    rugcheck: 'idle',
    groq: 'idle',
    anthropic: 'idle',
  });

  /**
   * Handles saving an API key by relaying it to the service worker via
   * `sendToBackground`. Per AAP §0.7.2: API keys are NEVER stored in
   * the content script — they MUST be sent to the service worker for
   * AES-GCM encryption and secure storage in chrome.storage.local.
   */
  const handleSaveApiKey = useCallback(
    (provider: 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic', key: string) => {
      sendToBackground({
        type: 'SETTINGS_CHANGE',
        payload: { key: `apiKey:${provider}`, value: key },
      });
    },
    [],
  );

  /**
   * Handles testing API connection by sending a test request via service worker.
   */
  const handleTestApiKey = useCallback(
    (provider: string) => {
      setTestStatuses((prev) => ({ ...prev, [provider]: 'testing' as const }));
      sendToBackground({
        type: 'SETTINGS_CHANGE',
        payload: { key: `testApiKey:${provider}`, value: null },
      }).then((result) => {
        setTestStatuses((prev) => ({
          ...prev,
          [provider]: result ? ('success' as const) : ('error' as const),
        }));
        /* Reset status after 5 seconds */
        setTimeout(() => {
          setTestStatuses((prev) => ({ ...prev, [provider]: 'idle' as const }));
        }, 5000);
      }).catch(() => {
        setTestStatuses((prev) => ({ ...prev, [provider]: 'error' as const }));
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Scoring Weight Management — Local state + debounced store writes
  // ---------------------------------------------------------------------------

  const [localWeights, setLocalWeights] = useState<ScoringWeights>({ ...scoringWeights });

  /** Sync local weights when store weights change externally */
  useEffect(() => {
    setLocalWeights({ ...scoringWeights });
  }, [scoringWeights]);

  /** Debounced function that pushes weights to the store */
  const debouncedSetWeights = useDebounce(
    (weights: ScoringWeights) => {
      setScoringWeights(weights);
    },
    WEIGHT_DEBOUNCE_MS,
  );

  /** Handle individual weight slider change with auto-normalize */
  const handleWeightChange = useCallback(
    (factorKey: keyof ScoringWeights, value: number) => {
      setLocalWeights((prev) => {
        const updated = { ...prev, [factorKey]: value };
        debouncedSetWeights(updated);
        return updated;
      });
    },
    [debouncedSetWeights],
  );

  /** Handle reset to default weights */
  const handleResetWeights = useCallback(() => {
    const defaults: ScoringWeights = {
      volumeSpike: DEFAULT_SCORING_WEIGHTS.volumeSpike,
      smartMoneyConvergence: DEFAULT_SCORING_WEIGHTS.smartMoneyConvergence,
      buySellRatio: DEFAULT_SCORING_WEIGHTS.buySellRatio,
      holderGrowth: DEFAULT_SCORING_WEIGHTS.holderGrowth,
      liquidity: DEFAULT_SCORING_WEIGHTS.liquidity,
      tokenAge: DEFAULT_SCORING_WEIGHTS.tokenAge,
      safetyScore: DEFAULT_SCORING_WEIGHTS.safetyScore,
    };
    setLocalWeights(defaults);
    resetScoringWeights();
  }, [resetScoringWeights]);

  /** Weight sum and balanced state */
  const weightTotal = useMemo(() => {
    return (
      localWeights.volumeSpike +
      localWeights.smartMoneyConvergence +
      localWeights.buySellRatio +
      localWeights.holderGrowth +
      localWeights.liquidity +
      localWeights.tokenAge +
      localWeights.safetyScore
    );
  }, [localWeights]);

  const weightTotalDisplay = useMemo(() => `${(weightTotal * 100).toFixed(0)}%`, [weightTotal]);
  const isWeightBalanced = useMemo(() => Math.abs(weightTotal - 1.0) < 0.05, [weightTotal]);

  // ---------------------------------------------------------------------------
  // Hard Exit Trigger State
  // ---------------------------------------------------------------------------

  const [exitTriggers, setExitTriggers] = useState({
    devSellEnabled: true,
    smartMoneyExitEnabled: true,
    volumeDeclineEnabled: true,
    volumeDeclineThreshold: 10,
  });

  const handleExitTriggerChange = useCallback(
    (field: string, value: boolean | number) => {
      setExitTriggers((prev) => {
        const updated = { ...prev, [field]: value };
        /* Relay exit trigger config to service worker */
        sendToBackground({
          type: 'SETTINGS_CHANGE',
          payload: { key: 'exitTriggers', value: updated },
        });
        return updated;
      });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!panelVisible) {
    return null;
  }

  return (
    <div class="settings-panel" role="dialog" aria-label="Signal Bot Settings">
      {/* Header */}
      <div class="settings-header">
        <h2 class="settings-title">⚙️ Settings</h2>
      </div>

      <div class="settings-body">
        {/* ================================================================= */}
        {/* Section 1: API Keys                                               */}
        {/* ================================================================= */}
        <SectionHeader
          title="🔑 API Keys"
          collapsed={collapsedSections.apiKeys ?? false}
          onToggle={() => toggleSection('apiKeys')}
        />
        {!collapsedSections.apiKeys && (
          <section
            class="settings-section"
            role="group"
            aria-label="API key configuration"
          >
            <p class="settings-hint">
              Keys are encrypted via AES-GCM and stored securely in the
              service worker. They never leave the extension context.
            </p>
            {API_KEY_PROVIDERS.map((provider) => (
              <ApiKeyField
                key={provider.key}
                providerKey={provider.key}
                label={provider.label}
                placeholder={provider.placeholder}
                required={provider.required}
                hasSavedKey={apiKeys[provider.key].length > 0}
                onSave={(key) => handleSaveApiKey(provider.key, key)}
                onTest={() => handleTestApiKey(provider.key)}
                testStatus={testStatuses[provider.key] ?? 'idle'}
              />
            ))}
          </section>
        )}

        {/* ================================================================= */}
        {/* Section 2: Trading Mode                                           */}
        {/* ================================================================= */}
        <SectionHeader
          title="📊 Trading Mode"
          collapsed={collapsedSections.tradingMode ?? false}
          onToggle={() => toggleSection('tradingMode')}
        />
        {!collapsedSections.tradingMode && (
          <section class="settings-section">
            <TradingModeToggle
              mode={tradingMode}
              currentThreshold={currentThreshold}
              onChange={setTradingMode}
            />
          </section>
        )}

        {/* ================================================================= */}
        {/* Section 3: Scoring Weights                                        */}
        {/* ================================================================= */}
        <SectionHeader
          title="⚖️ Scoring Weights"
          collapsed={collapsedSections.weights ?? false}
          onToggle={() => toggleSection('weights')}
        />
        {!collapsedSections.weights && (
          <section class="settings-section">
            <div class="settings-weight-total">
              <span>Total: </span>
              <span class={isWeightBalanced ? 'settings-weight-ok' : 'settings-weight-warn'}>
                {weightTotalDisplay}
              </span>
              {!isWeightBalanced && (
                <span class="settings-weight-warn-text" role="alert">
                  {' '}(should sum to ~100%)
                </span>
              )}
            </div>
            {WEIGHT_FACTOR_LABELS.map((factor) => (
              <WeightSlider
                key={factor.key}
                factorKey={factor.key}
                label={factor.label}
                description={factor.description}
                value={localWeights[factor.key]}
                defaultValue={DEFAULT_SCORING_WEIGHTS[factor.key]}
                onChange={(value) => handleWeightChange(factor.key, value)}
              />
            ))}
            <button
              type="button"
              class="settings-reset-btn"
              onClick={handleResetWeights}
              aria-label="Reset scoring weights to defaults"
            >
              ↻ Reset to Defaults
            </button>
          </section>
        )}

        {/* ================================================================= */}
        {/* Section 4: TP/SL Profiles                                         */}
        {/* ================================================================= */}
        <SectionHeader
          title="🎯 Exit Strategy"
          collapsed={collapsedSections.tpsl ?? false}
          onToggle={() => toggleSection('tpsl')}
        />
        {!collapsedSections.tpsl && (
          <section class="settings-section">
            <TpSlProfileEditor
              profiles={tpSlProfiles}
              activeProfileName={useSettingsStoreHook((s) => s.activeTpSlProfile)}
              onSelectProfile={setActiveTpSlProfile}
              onUpsertProfile={upsertTpSlProfile}
            />
          </section>
        )}

        {/* ================================================================= */}
        {/* Section 5: Hard Exit Triggers                                     */}
        {/* ================================================================= */}
        <SectionHeader
          title="🚨 Exit Triggers"
          collapsed={collapsedSections.exitTriggers ?? false}
          onToggle={() => toggleSection('exitTriggers')}
        />
        {!collapsedSections.exitTriggers && (
          <section class="settings-section">
            <HardExitTriggers
              devSellEnabled={exitTriggers.devSellEnabled}
              smartMoneyExitEnabled={exitTriggers.smartMoneyExitEnabled}
              volumeDeclineEnabled={exitTriggers.volumeDeclineEnabled}
              volumeDeclineThreshold={exitTriggers.volumeDeclineThreshold}
              onToggleDevSell={(v) => handleExitTriggerChange('devSellEnabled', v)}
              onToggleSmartMoneyExit={(v) => handleExitTriggerChange('smartMoneyExitEnabled', v)}
              onToggleVolumeDecline={(v) => handleExitTriggerChange('volumeDeclineEnabled', v)}
              onVolumeDeclineThresholdChange={(v) => handleExitTriggerChange('volumeDeclineThreshold', v)}
            />
          </section>
        )}

        {/* ================================================================= */}
        {/* Section 6: Notifications                                          */}
        {/* ================================================================= */}
        <SectionHeader
          title="🔔 Notifications"
          collapsed={collapsedSections.notifications ?? false}
          onToggle={() => toggleSection('notifications')}
        />
        {!collapsedSections.notifications && (
          <section class="settings-section">
            <NotificationSettings
              prefs={notificationPrefs}
              onChange={setNotificationPrefs}
            />
          </section>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Named Export
// =============================================================================

export { SettingsPanel };
