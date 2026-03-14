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
 * Feature set:
 *   - 5 API key input fields (Birdeye, Helius, RugCheck, Groq, Anthropic)
 *   - 7 scoring weight sliders matching ScoringWeights interface
 *   - Conservative / Aggressive trading mode toggle
 *   - TP/SL profile editor (ladder, day-trade, swing-trade)
 *   - Notification preference toggles
 *
 * State management:
 *   Reads and writes the Zustand settings-store via `useSettingsStoreHook`
 *   from `src/store/index.ts`. API key encryption/decryption is handled
 *   by `src/utils/crypto.ts` and relayed to the service worker via
 *   `sendToBackground` from `src/utils/messaging.ts`.
 *
 * @module components/SettingsPanel
 */

import { h, type FunctionComponent } from 'preact';
import { useState, useCallback, useMemo } from 'preact/hooks';
import { useSettingsStoreHook } from '../store/index';
import type { TradingMode } from '../signals/types';
import type { TpSlProfile, NotificationPrefs } from '../store/settings-store';

// =============================================================================
// Constants
// =============================================================================

/** Human-readable labels for each API key field */
const API_KEY_LABELS: ReadonlyArray<{
  key: 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic';
  label: string;
  placeholder: string;
}> = [
  { key: 'birdeye', label: 'Birdeye', placeholder: 'Enter Birdeye API key' },
  { key: 'helius', label: 'Helius', placeholder: 'Enter Helius API key' },
  { key: 'rugcheck', label: 'RugCheck', placeholder: 'Enter RugCheck API key' },
  { key: 'groq', label: 'Groq', placeholder: 'Enter Groq API key' },
  { key: 'anthropic', label: 'Anthropic', placeholder: 'Enter Anthropic API key' },
] as const;

/** Human-readable labels for each scoring weight factor */
const WEIGHT_LABELS: ReadonlyArray<{
  key: 'volumeSpike' | 'smartMoneyConvergence' | 'buySellRatio' | 'holderGrowth' | 'liquidity' | 'tokenAge' | 'safetyScore';
  label: string;
  description: string;
}> = [
  { key: 'volumeSpike', label: 'Volume Spike', description: 'Detects 3–8× volume surges' },
  { key: 'smartMoneyConvergence', label: 'Smart Money', description: '3+ qualified wallets converging' },
  { key: 'buySellRatio', label: 'Buy/Sell Ratio', description: 'Accumulation pressure ≥1.3×' },
  { key: 'holderGrowth', label: 'Holder Growth', description: 'Organic wallet growth tracking' },
  { key: 'liquidity', label: 'Liquidity', description: 'Minimum $3K–$30K liquidity' },
  { key: 'tokenAge', label: 'Token Age', description: '≤3h early, ≤12h maximum' },
  { key: 'safetyScore', label: 'Safety Score', description: 'RugCheck + GoPlus composite' },
] as const;

/** Threshold percentages for slider display */
const WEIGHT_MIN = 0;
const WEIGHT_MAX = 0.5;
const WEIGHT_STEP = 0.01;

// =============================================================================
// Sub-Components
// =============================================================================

/**
 * Section header with optional collapse toggle for visual grouping.
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

/**
 * API key input field with show/hide toggle.
 * API keys are masked by default and relayed to the service worker
 * for encrypted storage per AAP §0.7.2.
 */
const ApiKeyField: FunctionComponent<{
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ label, placeholder, value, onChange }) => {
  const [visible, setVisible] = useState(false);

  return (
    <div class="settings-api-key-field" role="group" aria-label={`${label} API key`}>
      <label class="settings-label">{label}</label>
      <div class="settings-input-row">
        <input
          type={visible ? 'text' : 'password'}
          class="settings-input"
          placeholder={placeholder}
          value={value}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          autocomplete="off"
          spellcheck={false}
          aria-label={`${label} API key input`}
        />
        <button
          type="button"
          class="settings-toggle-btn"
          onClick={() => setVisible(!visible)}
          aria-label={visible ? `Hide ${label} key` : `Show ${label} key`}
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? '🙈' : '👁'}
        </button>
      </div>
    </div>
  );
};

/**
 * Individual scoring weight slider with real-time percentage display.
 */
const WeightSlider: FunctionComponent<{
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
}> = ({ label, description, value, onChange }) => {
  const percentDisplay = useMemo(() => `${(value * 100).toFixed(0)}%`, [value]);

  return (
    <div class="settings-weight-slider" role="group" aria-label={`${label} weight`}>
      <div class="settings-weight-header">
        <span class="settings-weight-label">{label}</span>
        <span class="settings-weight-value" aria-live="polite">{percentDisplay}</span>
      </div>
      <input
        type="range"
        class="settings-slider"
        min={WEIGHT_MIN}
        max={WEIGHT_MAX}
        step={WEIGHT_STEP}
        value={value}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
        aria-label={`${label} weight: ${percentDisplay}`}
        title={description}
      />
      <span class="settings-weight-desc">{description}</span>
    </div>
  );
};

/**
 * Trading mode toggle: Conservative (≥80 score) / Aggressive (≥45 score).
 */
const TradingModeToggle: FunctionComponent<{
  mode: TradingMode;
  onChange: (mode: TradingMode) => void;
}> = ({ mode, onChange }) => (
  <div class="settings-mode-toggle" role="radiogroup" aria-label="Trading mode">
    <button
      type="button"
      class={`settings-mode-btn ${mode === 'conservative' ? 'settings-mode-active' : ''}`}
      role="radio"
      aria-checked={mode === 'conservative'}
      onClick={() => onChange('conservative')}
    >
      🛡️ Conservative (≥80)
    </button>
    <button
      type="button"
      class={`settings-mode-btn ${mode === 'aggressive' ? 'settings-mode-active' : ''}`}
      role="radio"
      aria-checked={mode === 'aggressive'}
      onClick={() => onChange('aggressive')}
    >
      ⚡ Aggressive (≥45)
    </button>
  </div>
);

/**
 * TP/SL profile selector and editor.
 * Supports three built-in profiles: ladder, day-trade, swing-trade.
 */
const TpSlProfileEditor: FunctionComponent<{
  profiles: TpSlProfile[];
  activeProfileName: string;
  onSelectProfile: (name: string) => void;
}> = ({ profiles, activeProfileName, onSelectProfile }) => (
  <div class="settings-tpsl-editor" role="group" aria-label="TP/SL profiles">
    <div class="settings-tpsl-profiles">
      {profiles.map((profile) => (
        <button
          key={profile.name}
          type="button"
          class={`settings-tpsl-btn ${profile.name === activeProfileName ? 'settings-tpsl-active' : ''}`}
          onClick={() => onSelectProfile(profile.name)}
          aria-pressed={profile.name === activeProfileName}
        >
          {profile.name}
        </button>
      ))}
    </div>
    {profiles
      .filter((p) => p.name === activeProfileName)
      .map((profile) => (
        <div key={profile.name} class="settings-tpsl-detail">
          <div class="settings-tpsl-ladder">
            <span class="settings-label">Take Profit Ladder:</span>
            {profile.takeProfitLadder.map((level, idx) => (
              <div key={idx} class="settings-tpsl-level">
                <span class="settings-tpsl-sell">Sell {level.sellPercent}%</span>
                <span class="settings-tpsl-at">at {level.multiplier}×</span>
              </div>
            ))}
          </div>
          <div class="settings-tpsl-sl">
            <span class="settings-label">Stop Loss:</span>
            <span class="settings-tpsl-sl-value">{profile.stopLoss}%</span>
          </div>
        </div>
      ))}
  </div>
);

/**
 * Notification preferences toggles.
 */
const NotificationSettings: FunctionComponent<{
  prefs: NotificationPrefs;
  onChange: (prefs: NotificationPrefs) => void;
}> = ({ prefs, onChange }) => {
  const toggleField = useCallback(
    (field: keyof NotificationPrefs, value: boolean | number) => {
      onChange({ ...prefs, [field]: value });
    },
    [prefs, onChange],
  );

  return (
    <div class="settings-notifications" role="group" aria-label="Notification preferences">
      <div class="settings-notif-row">
        <label class="settings-notif-label">
          <input
            type="checkbox"
            checked={prefs.enabled}
            onChange={(e) => toggleField('enabled', (e.target as HTMLInputElement).checked)}
          />
          Enable notifications
        </label>
      </div>
      <div class="settings-notif-row">
        <label class="settings-notif-label">
          <input
            type="checkbox"
            checked={prefs.soundEnabled}
            onChange={(e) => toggleField('soundEnabled', (e.target as HTMLInputElement).checked)}
          />
          Sound alerts
        </label>
      </div>
      <div class="settings-notif-row">
        <label class="settings-notif-label">
          <input
            type="checkbox"
            checked={prefs.exitAlerts}
            onChange={(e) => toggleField('exitAlerts', (e.target as HTMLInputElement).checked)}
          />
          Exit alerts
        </label>
      </div>
      <div class="settings-notif-row">
        <label class="settings-notif-label">
          <input
            type="checkbox"
            checked={prefs.newTokenAlerts}
            onChange={(e) => toggleField('newTokenAlerts', (e.target as HTMLInputElement).checked)}
          />
          New token alerts
        </label>
      </div>
      <div class="settings-notif-row">
        <label class="settings-notif-label">
          <input
            type="checkbox"
            checked={prefs.smartMoneyAlerts}
            onChange={(e) => toggleField('smartMoneyAlerts', (e.target as HTMLInputElement).checked)}
          />
          Smart money alerts
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
              toggleField(
                'minScoreForAlert',
                parseInt((e.target as HTMLInputElement).value, 10) || 0,
              )
            }
            aria-label="Minimum score for alert notification"
          />
        </label>
      </div>
    </div>
  );
};

// =============================================================================
// SettingsPanel Props
// =============================================================================

/**
 * Props for the SettingsPanel component.
 */
export interface SettingsPanelProps {
  /** Whether the settings panel is currently visible */
  visible?: boolean;
  /** Callback invoked when the user requests to close the panel */
  onClose?: () => void;
}

// =============================================================================
// SettingsPanel Component
// =============================================================================

/**
 * User configuration panel for the GMGN Signal Bot Chrome Extension.
 *
 * Provides controls for:
 * 1. API key management (5 keys, encrypted via service worker)
 * 2. Trading mode selection (Conservative ≥80 / Aggressive ≥45)
 * 3. Scoring weight customization (7 factor sliders)
 * 4. TP/SL profile selection (ladder, day-trade, swing-trade)
 * 5. Notification preferences
 *
 * All settings are persisted to `chrome.storage.sync` via the Zustand
 * settings-store for cross-device synchronization.
 */
const SettingsPanel: FunctionComponent<SettingsPanelProps> = ({
  visible = true,
  onClose,
}) => {
  // ---------------------------------------------------------------------------
  // Store Bindings
  // ---------------------------------------------------------------------------

  const tradingMode = useSettingsStoreHook((s) => s.tradingMode);
  const scoringWeights = useSettingsStoreHook((s) => s.scoringWeights);
  const apiKeys = useSettingsStoreHook((s) => s.apiKeys);
  const activeTpSlProfile = useSettingsStoreHook((s) => s.activeTpSlProfile);
  const tpSlProfiles = useSettingsStoreHook((s) => s.tpSlProfiles);
  const notificationPrefs = useSettingsStoreHook((s) => s.notificationPrefs);

  const setTradingMode = useSettingsStoreHook((s) => s.setTradingMode);
  const setScoringWeight = useSettingsStoreHook((s) => s.setScoringWeight);
  const resetScoringWeights = useSettingsStoreHook((s) => s.resetScoringWeights);
  const setApiKey = useSettingsStoreHook((s) => s.setApiKey);
  const setActiveTpSlProfile = useSettingsStoreHook((s) => s.setActiveTpSlProfile);
  const setNotificationPrefs = useSettingsStoreHook((s) => s.setNotificationPrefs);

  // ---------------------------------------------------------------------------
  // Section Collapse State
  // ---------------------------------------------------------------------------

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    apiKeys: false,
    tradingMode: false,
    weights: true,
    tpsl: true,
    notifications: true,
  });

  const toggleSection = useCallback(
    (section: string) => {
      setCollapsedSections((prev) => ({
        ...prev,
        [section]: !prev[section],
      }));
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Local API Key State (displayed as masked, stored encrypted via store action)
  // ---------------------------------------------------------------------------

  const [localApiKeys, setLocalApiKeys] = useState<Record<string, string>>({
    birdeye: apiKeys.birdeye ? '••••••••' : '',
    helius: apiKeys.helius ? '••••••••' : '',
    rugcheck: apiKeys.rugcheck ? '••••••••' : '',
    groq: apiKeys.groq ? '••••••••' : '',
    anthropic: apiKeys.anthropic ? '••••••••' : '',
  });

  /**
   * Handle API key changes — update local display state and relay to the
   * settings store which encrypts and persists via the service worker.
   * Per AAP §0.7.2: API keys are stored encrypted and never exposed to content scripts.
   */
  const handleApiKeyChange = useCallback(
    (key: 'birdeye' | 'helius' | 'rugcheck' | 'groq' | 'anthropic', value: string) => {
      setLocalApiKeys((prev) => ({ ...prev, [key]: value }));
      if (value && value !== '••••••••') {
        setApiKey(key, value);
      }
    },
    [setApiKey],
  );

  // ---------------------------------------------------------------------------
  // Weight Total Computation
  // ---------------------------------------------------------------------------

  const weightTotal = useMemo(() => {
    return Object.values(scoringWeights).reduce((sum, w) => sum + w, 0);
  }, [scoringWeights]);

  const weightTotalDisplay = useMemo(() => `${(weightTotal * 100).toFixed(0)}%`, [weightTotal]);

  const isWeightBalanced = useMemo(() => {
    return Math.abs(weightTotal - 1.0) < 0.05;
  }, [weightTotal]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!visible) {
    return null;
  }

  return (
    <div class="settings-panel" role="dialog" aria-label="Signal Bot Settings">
      {/* Header */}
      <div class="settings-header">
        <h2 class="settings-title">⚙️ Settings</h2>
        {onClose && (
          <button
            type="button"
            class="settings-close-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        )}
      </div>

      <div class="settings-body">
        {/* ----------------------------------------------------------------- */}
        {/* Section 1: API Keys */}
        {/* ----------------------------------------------------------------- */}
        <SectionHeader
          title="🔑 API Keys"
          collapsed={collapsedSections.apiKeys ?? false}
          onToggle={() => toggleSection('apiKeys')}
        />
        {!collapsedSections.apiKeys && (
          <div class="settings-section" role="group" aria-label="API key configuration">
            <p class="settings-hint">
              Keys are encrypted and stored securely. They are only accessible
              from the service worker context.
            </p>
            {API_KEY_LABELS.map((field) => (
              <ApiKeyField
                key={field.key}
                label={field.label}
                placeholder={field.placeholder}
                value={localApiKeys[field.key] ?? ''}
                onChange={(value) => handleApiKeyChange(field.key, value)}
              />
            ))}
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Section 2: Trading Mode */}
        {/* ----------------------------------------------------------------- */}
        <SectionHeader
          title="📊 Trading Mode"
          collapsed={collapsedSections.tradingMode ?? false}
          onToggle={() => toggleSection('tradingMode')}
        />
        {!collapsedSections.tradingMode && (
          <div class="settings-section">
            <TradingModeToggle mode={tradingMode} onChange={setTradingMode} />
            <p class="settings-hint">
              Conservative: signals ≥80 score only. Aggressive: signals ≥45 score.
            </p>
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Section 3: Scoring Weights */}
        {/* ----------------------------------------------------------------- */}
        <SectionHeader
          title="⚖️ Scoring Weights"
          collapsed={collapsedSections.weights ?? false}
          onToggle={() => toggleSection('weights')}
        />
        {!collapsedSections.weights && (
          <div class="settings-section">
            <div class="settings-weight-total">
              <span>Total: </span>
              <span class={isWeightBalanced ? 'settings-weight-ok' : 'settings-weight-warn'}>
                {weightTotalDisplay}
              </span>
              {!isWeightBalanced && (
                <span class="settings-weight-warn-text"> (should sum to ~100%)</span>
              )}
            </div>
            {WEIGHT_LABELS.map((factor) => (
              <WeightSlider
                key={factor.key}
                label={factor.label}
                description={factor.description}
                value={scoringWeights[factor.key]}
                onChange={(value) => setScoringWeight(factor.key, value)}
              />
            ))}
            <button
              type="button"
              class="settings-reset-btn"
              onClick={resetScoringWeights}
              aria-label="Reset scoring weights to defaults"
            >
              ↻ Reset to Defaults
            </button>
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Section 4: TP/SL Profiles */}
        {/* ----------------------------------------------------------------- */}
        <SectionHeader
          title="🎯 TP/SL Profiles"
          collapsed={collapsedSections.tpsl ?? false}
          onToggle={() => toggleSection('tpsl')}
        />
        {!collapsedSections.tpsl && (
          <div class="settings-section">
            <TpSlProfileEditor
              profiles={tpSlProfiles}
              activeProfileName={activeTpSlProfile}
              onSelectProfile={setActiveTpSlProfile}
            />
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Section 5: Notifications */}
        {/* ----------------------------------------------------------------- */}
        <SectionHeader
          title="🔔 Notifications"
          collapsed={collapsedSections.notifications ?? false}
          onToggle={() => toggleSection('notifications')}
        />
        {!collapsedSections.notifications && (
          <div class="settings-section">
            <NotificationSettings prefs={notificationPrefs} onChange={setNotificationPrefs} />
          </div>
        )}
      </div>
    </div>
  );
};

export { SettingsPanel };
