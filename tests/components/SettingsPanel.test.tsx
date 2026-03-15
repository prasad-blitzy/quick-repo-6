/**
 * @fileoverview SettingsPanel Component Tests
 *
 * Comprehensive test suite for the SettingsPanel Preact component that renders
 * the user configuration interface for the GMGN Signal Bot Chrome Extension.
 *
 * Test coverage:
 * - API key input fields render for all 5 providers and accept input
 * - Trading mode toggle (conservative/aggressive) switches correctly
 * - Scoring weight sliders render all 7 factors and adjust values
 * - Reset to defaults button restores scoring weights
 * - TP/SL profile editor displays presets (Ladder, Day Trade, Swing Trade)
 * - Notification toggle functionality
 * - All 5 settings sections are rendered
 *
 * Per AAP Section 0.6.1 Test Files:
 * "tests/components/ [glob .test.tsx] — Preact component rendering tests
 *  (SignalPanel, TokenCard, SafetyBadge, ScoreGauge, SettingsPanel)"
 *
 * Per AAP Section 0.7.2 (Security):
 * - API keys must be relayed to the service worker via sendToBackground
 * - API keys NEVER stored in the content script
 *
 * Per AAP Section 0.7.5 (UI Rules):
 * - Preact 10.29.0 ONLY — NO React imports
 *
 * @module tests/components/SettingsPanel.test
 */

import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SettingsPanel } from '../../src/components/SettingsPanel';
import type { ScoringWeights, TradingMode } from '../../src/signals/types';

// ---------------------------------------------------------------------------
// Mock: Zustand Settings Store
// ---------------------------------------------------------------------------

const mockSetTradingMode = vi.fn();
const mockSetScoringWeights = vi.fn();
const mockSetScoringWeight = vi.fn();
const mockResetScoringWeights = vi.fn();
const mockSetNotificationPrefs = vi.fn();
const mockTogglePanel = vi.fn();
const mockSetApiKey = vi.fn().mockResolvedValue(undefined);
const mockSetActiveTpSlProfile = vi.fn();
const mockUpsertTpSlProfile = vi.fn();
const mockGetDecryptedApiKey = vi.fn().mockResolvedValue('');

vi.mock('../../src/store/index', () => ({
  useSettingsStoreHook: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: Messaging Utility (API key relay to service worker)
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/messaging', () => ({
  sendToBackground: vi.fn().mockResolvedValue(undefined),
  MESSAGE_SOURCE: 'gmgn-signal-bot',
}));

// ---------------------------------------------------------------------------
// Mock: Config Constants
// ---------------------------------------------------------------------------

vi.mock('../../src/utils/config', () => ({
  DEFAULT_SCORING_WEIGHTS: {
    volumeSpike: 0.20,
    smartMoneyConvergence: 0.20,
    buySellRatio: 0.15,
    holderGrowth: 0.10,
    liquidity: 0.15,
    tokenAge: 0.10,
    safetyScore: 0.10,
  },
  DEFAULT_EXIT_STRATEGY: {
    LADDER: [
      { sellPercent: 50, multiplier: 2 },
      { sellPercent: 25, multiplier: 5 },
      { sellPercent: 25, multiplier: 10 },
    ],
    DAY_TRADE: {
      takeProfitLevels: [15, 30, 60],
      stopLoss: -12,
    },
    SWING_TRADE: {
      takeProfitLevels: [40, 100, 200, 500],
      stopLoss: -18,
    },
  },
  SCORING_THRESHOLDS: {
    CONSERVATIVE_MIN: 80,
    AGGRESSIVE_MIN: 45,
  },
  LLM_CONFIG: {
    FAST_THRESHOLD: 45,
    DETAILED_THRESHOLD: 80,
  },
}));

// ---------------------------------------------------------------------------
// Import mocked module references (after vi.mock calls)
// ---------------------------------------------------------------------------

import { useSettingsStoreHook } from '../../src/store/index';
import { sendToBackground } from '../../src/utils/messaging';

// ---------------------------------------------------------------------------
// Default Mock Settings State Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-populated settings store state with sensible defaults
 * and mock action functions. All 7 scoring weight factors are included
 * with values matching DEFAULT_SCORING_WEIGHTS from the AAP.
 *
 * Override any field via the `overrides` parameter to create specific
 * test scenarios (e.g., aggressive trading mode, custom weights).
 */
function createMockSettings(overrides: Record<string, unknown> = {}) {
  return {
    // State
    tradingMode: 'conservative' as TradingMode,
    scoringWeights: {
      volumeSpike: 0.20,
      smartMoneyConvergence: 0.20,
      buySellRatio: 0.15,
      holderGrowth: 0.10,
      liquidity: 0.15,
      tokenAge: 0.10,
      safetyScore: 0.10,
    } as ScoringWeights,
    activeTpSlProfile: 'ladder',
    tpSlProfiles: [
      {
        name: 'ladder',
        takeProfitLadder: [
          { sellPercent: 50, multiplier: 2 },
          { sellPercent: 25, multiplier: 5 },
          { sellPercent: 25, multiplier: 10 },
        ],
        stopLoss: -12,
      },
      {
        name: 'day-trade',
        takeProfitLadder: [
          { sellPercent: 50, multiplier: 1.15 },
          { sellPercent: 25, multiplier: 1.30 },
          { sellPercent: 25, multiplier: 1.60 },
        ],
        stopLoss: -12,
      },
      {
        name: 'swing-trade',
        takeProfitLadder: [
          { sellPercent: 25, multiplier: 1.40 },
          { sellPercent: 25, multiplier: 2 },
          { sellPercent: 25, multiplier: 3 },
          { sellPercent: 25, multiplier: 6 },
        ],
        stopLoss: -18,
      },
    ],
    apiKeys: {
      birdeye: '',
      helius: '',
      rugcheck: '',
      groq: '',
      anthropic: '',
    },
    notificationPrefs: {
      enabled: true,
      minScoreForAlert: 70,
      soundEnabled: false,
      exitAlerts: true,
      newTokenAlerts: true,
      smartMoneyAlerts: true,
    },
    panelVisible: true,
    llmFastThreshold: 45,
    llmDetailedThreshold: 80,

    // Actions
    setTradingMode: mockSetTradingMode,
    setScoringWeights: mockSetScoringWeights,
    setScoringWeight: mockSetScoringWeight,
    resetScoringWeights: mockResetScoringWeights,
    setActiveTpSlProfile: mockSetActiveTpSlProfile,
    upsertTpSlProfile: mockUpsertTpSlProfile,
    setApiKey: mockSetApiKey,
    getDecryptedApiKey: mockGetDecryptedApiKey,
    setNotificationPrefs: mockSetNotificationPrefs,
    togglePanel: mockTogglePanel,
    getScoreThreshold: () => 80,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  const settings = createMockSettings();
  (useSettingsStoreHook as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (state: ReturnType<typeof createMockSettings>) => unknown) => {
      if (typeof selector === 'function') {
        return selector(settings);
      }
      return settings;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// =============================================================================
// Test Suite: SettingsPanel Component
// =============================================================================

describe('SettingsPanel', () => {
  // =========================================================================
  // Test 1: API key input fields render
  // =========================================================================

  describe('API Key Management', () => {
    it('renders input fields for all 5 API key providers', () => {
      render(<SettingsPanel />);

      // The component should render labeled inputs for all 5 providers:
      // Birdeye, Helius, Groq, RugCheck, Anthropic
      const birdeyeInput = screen.getByLabelText('Birdeye API key input');
      const heliusInput = screen.getByLabelText('Helius API key input');
      const groqInput = screen.getByLabelText('Groq API key input');
      const rugcheckInput = screen.getByLabelText('RugCheck API key input');
      const anthropicInput = screen.getByLabelText('Anthropic API key input');

      expect(birdeyeInput).toBeTruthy();
      expect(heliusInput).toBeTruthy();
      expect(groqInput).toBeTruthy();
      expect(rugcheckInput).toBeTruthy();
      expect(anthropicInput).toBeTruthy();

      // All API key inputs should default to type="password" for security
      expect(birdeyeInput.getAttribute('type')).toBe('password');
      expect(heliusInput.getAttribute('type')).toBe('password');
      expect(groqInput.getAttribute('type')).toBe('password');
      expect(rugcheckInput.getAttribute('type')).toBe('password');
      expect(anthropicInput.getAttribute('type')).toBe('password');
    });

    // =========================================================================
    // Test 2: API key inputs accept input and relay via sendToBackground
    // =========================================================================

    it('accepts input and relays API key to service worker on save', async () => {
      render(<SettingsPanel />);

      // Find the Birdeye API key input field
      const birdeyeInput = screen.getByLabelText(
        'Birdeye API key input',
      ) as HTMLInputElement;

      // Simulate typing an API key value
      fireEvent.input(birdeyeInput, {
        target: { value: 'test-birdeye-key-abc123' },
      });

      // Verify the input element reflects the typed value
      expect(birdeyeInput.value).toBe('test-birdeye-key-abc123');

      // Find and click the Save button for Birdeye
      const saveButton = screen.getByLabelText('Save Birdeye API key');
      fireEvent.click(saveButton);

      // Per AAP §0.7.2: API keys must be relayed to the service worker
      // via sendToBackground for encrypted storage — NEVER stored in
      // the content script context.
      await waitFor(() => {
        expect(sendToBackground).toHaveBeenCalledWith({
          type: 'SETTINGS_CHANGE',
          payload: {
            key: 'apiKey:birdeye',
            value: 'test-birdeye-key-abc123',
          },
        });
      });
    });
  });

  // =========================================================================
  // Test 3 & 4: Trading mode toggle
  // =========================================================================

  describe('Trading Mode Toggle', () => {
    it('switches from conservative to aggressive when Aggressive button is clicked', () => {
      render(<SettingsPanel />);

      // Find the Aggressive radio button
      // The component renders buttons with role="radio" inside a radiogroup
      const aggressiveButton = screen.getByRole('radio', {
        name: /aggressive/i,
      });

      // Click it to switch modes
      fireEvent.click(aggressiveButton);

      // Expect the store action to have been called with 'aggressive'
      expect(mockSetTradingMode).toHaveBeenCalledWith('aggressive');
    });

    it('switches from aggressive to conservative when Conservative button is clicked', () => {
      // Set initial mock state to aggressive mode
      const aggressiveSettings = createMockSettings({
        tradingMode: 'aggressive' as TradingMode,
        getScoreThreshold: () => 45,
      });
      (useSettingsStoreHook as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: ReturnType<typeof createMockSettings>) => unknown) => {
          if (typeof selector === 'function') {
            return selector(aggressiveSettings);
          }
          return aggressiveSettings;
        },
      );

      render(<SettingsPanel />);

      // Find the Conservative radio button
      const conservativeButton = screen.getByRole('radio', {
        name: /conservative/i,
      });

      // Click it to switch to conservative
      fireEvent.click(conservativeButton);

      // Expect the store action to have been called with 'conservative'
      expect(mockSetTradingMode).toHaveBeenCalledWith('conservative');
    });
  });

  // =========================================================================
  // Test 5 & 6: Scoring weight sliders
  // =========================================================================

  describe('Scoring Weight Sliders', () => {
    /**
     * Helper to expand the Scoring Weights section, which is collapsed
     * by default in the SettingsPanel component.
     */
    function expandWeightsSection() {
      const header = screen.getByLabelText(/Scoring Weights section/i);
      if (header.getAttribute('aria-expanded') === 'false') {
        fireEvent.click(header);
      }
    }

    it('renders sliders for all 7 scoring factors', () => {
      render(<SettingsPanel />);

      // Expand the collapsed "Scoring Weights" section
      expandWeightsSection();

      // There should be exactly 7 range inputs (sliders)
      const rangeInputs = screen.getAllByRole('slider');
      expect(rangeInputs.length).toBe(7);

      // Verify all 7 factor labels are present in the rendered output.
      // Each WeightSlider has a group with aria-label "<Factor> weight adjustment"
      const expectedFactors = [
        'Volume Spike',
        'Smart Money',
        'Buy/Sell Ratio',
        'Holder Growth',
        'Liquidity',
        'Token Age',
        'Safety Score',
      ];

      for (const factorLabel of expectedFactors) {
        // Query for the group wrapper with the specific "adjustment" suffix
        // to avoid matching the input's aria-label too
        const factorGroup = screen.getByLabelText(
          new RegExp(`${factorLabel} weight adjustment`, 'i'),
        );
        expect(factorGroup).toBeTruthy();
      }
    });

    it('updates store when a weight slider value is changed', async () => {
      render(<SettingsPanel />);

      // Expand the Scoring Weights section
      expandWeightsSection();

      // Find the Volume Spike weight slider using role="slider" to target
      // only the <input type="range"> and avoid the group wrapper.
      const volumeSpikeSlider = screen.getByRole('slider', {
        name: /Volume Spike weight/i,
      }) as HTMLInputElement;

      expect(volumeSpikeSlider).toBeTruthy();

      // Simulate changing the slider value to 0.30 (30%)
      fireEvent.input(volumeSpikeSlider, { target: { value: '0.30' } });

      // The component uses a debounced write (300ms). After debounce,
      // setScoringWeights should be called with the updated weights.
      // We use waitFor to handle the async debounce.
      await waitFor(
        () => {
          expect(mockSetScoringWeights).toHaveBeenCalled();
        },
        { timeout: 1000 },
      );
    });

    // =========================================================================
    // Test 7: Reset to defaults
    // =========================================================================

    it('resets scoring weights to defaults when reset button is clicked', () => {
      render(<SettingsPanel />);

      // Expand the Scoring Weights section
      expandWeightsSection();

      // Find the "Reset to Defaults" button
      const resetButton = screen.getByLabelText(
        /reset scoring weights to defaults/i,
      );
      expect(resetButton).toBeTruthy();

      // Click reset
      fireEvent.click(resetButton);

      // Expect the store's resetScoringWeights action to have been called
      expect(mockResetScoringWeights).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Test 8: TP/SL profile editor
  // =========================================================================

  describe('TP/SL Profile Editor', () => {
    /**
     * Helper to expand the "Exit Strategy" section, which is collapsed
     * by default in the SettingsPanel component.
     */
    function expandExitStrategySection() {
      const header = screen.getByLabelText(/Exit Strategy section/i);
      if (header.getAttribute('aria-expanded') === 'false') {
        fireEvent.click(header);
      }
    }

    it('displays all three preset profiles with correct default selection', () => {
      render(<SettingsPanel />);

      // Expand the Exit Strategy section
      expandExitStrategySection();

      // The TpSlProfileEditor renders profile selector buttons:
      // ladder, day-trade, swing-trade
      const ladderTab = screen.getByRole('tab', { name: /ladder/i });
      const dayTradeTab = screen.getByRole('tab', { name: /day-trade/i });
      const swingTradeTab = screen.getByRole('tab', {
        name: /swing-trade/i,
      });

      expect(ladderTab).toBeTruthy();
      expect(dayTradeTab).toBeTruthy();
      expect(swingTradeTab).toBeTruthy();

      // Default active profile should be "ladder" per mock state
      expect(ladderTab.getAttribute('aria-selected')).toBe('true');
      expect(dayTradeTab.getAttribute('aria-selected')).toBe('false');
      expect(swingTradeTab.getAttribute('aria-selected')).toBe('false');
    });

    it('calls setActiveTpSlProfile when a different profile is selected', () => {
      render(<SettingsPanel />);

      // Expand the Exit Strategy section
      expandExitStrategySection();

      // Click the day-trade profile tab
      const dayTradeTab = screen.getByRole('tab', { name: /day-trade/i });
      fireEvent.click(dayTradeTab);

      expect(mockSetActiveTpSlProfile).toHaveBeenCalledWith('day-trade');
    });
  });

  // =========================================================================
  // Test 9: Notification toggles
  // =========================================================================

  describe('Notification Preferences', () => {
    /**
     * Helper to expand the Notifications section, which is collapsed
     * by default in the SettingsPanel component.
     */
    function expandNotificationsSection() {
      const header = screen.getByLabelText(/Notifications section/i);
      if (header.getAttribute('aria-expanded') === 'false') {
        fireEvent.click(header);
      }
    }

    it('renders notification toggles and calls setNotificationPrefs on change', () => {
      render(<SettingsPanel />);

      // Expand the Notifications section
      expandNotificationsSection();

      // The NotificationSettings sub-component renders checkboxes.
      // The master "Enable notifications" toggle should be checked (enabled=true in mock).
      const allCheckboxes = screen.getAllByRole('checkbox');

      // With notifications enabled, we should see multiple checkboxes:
      // 1. Enable notifications (master toggle)
      // 2. Sound alerts
      // 3. Exit alerts
      // 4. New high-confidence token alerts
      // 5. Smart money convergence events
      // The exact count depends on what's in the Notifications section.
      // Per the component source, there are 5 checkboxes when enabled=true.
      expect(allCheckboxes.length).toBeGreaterThanOrEqual(5);

      // Find the "Sound alerts" checkbox and toggle it
      // The checkbox label text is "Sound alerts" in the component
      const soundCheckbox = screen.getByLabelText(/sound alerts/i) as HTMLInputElement
        ?? screen.getByRole('checkbox', { name: /sound/i }) as HTMLInputElement;

      // Sound should be unchecked by default (soundEnabled: false in mock)
      expect(soundCheckbox.checked).toBe(false);

      // Toggle it on
      fireEvent.change(soundCheckbox, { target: { checked: true } });

      // Expect the store action to be called with the partial update
      expect(mockSetNotificationPrefs).toHaveBeenCalledWith({
        soundEnabled: true,
      });
    });
  });

  // =========================================================================
  // Test 10: All settings sections rendered
  // =========================================================================

  describe('Settings Sections', () => {
    it('renders all expected section headers', () => {
      render(<SettingsPanel />);

      // The SettingsPanel renders 6 collapsible SectionHeader components:
      // 1. "🔑 API Keys"
      // 2. "📊 Trading Mode"
      // 3. "⚖️ Scoring Weights"
      // 4. "🎯 Exit Strategy"
      // 5. "🚨 Exit Triggers"
      // 6. "🔔 Notifications"
      //
      // At minimum, per the AAP specification, these 5 categories must exist:
      // API Keys, Trading Mode, Scoring Weights, Exit Strategy/TP/SL, Notifications

      // Check for the presence of section title text
      expect(screen.getByText(/API Keys/i)).toBeTruthy();
      expect(screen.getByText(/Trading Mode/i)).toBeTruthy();
      expect(screen.getByText(/Scoring Weights/i)).toBeTruthy();
      expect(screen.getByText(/Exit Strategy/i)).toBeTruthy();
      expect(screen.getByText(/Notifications/i)).toBeTruthy();
    });

    it('renders the settings panel title', () => {
      render(<SettingsPanel />);

      // The component renders "⚙️ Settings" as the panel title
      expect(screen.getByText(/Settings/i)).toBeTruthy();
    });

    it('does not render when panelVisible is false', () => {
      // Override panelVisible to false
      const hiddenSettings = createMockSettings({ panelVisible: false });
      (useSettingsStoreHook as ReturnType<typeof vi.fn>).mockImplementation(
        (selector: (state: ReturnType<typeof createMockSettings>) => unknown) => {
          if (typeof selector === 'function') {
            return selector(hiddenSettings);
          }
          return hiddenSettings;
        },
      );

      const { container } = render(<SettingsPanel />);

      // When panelVisible is false, the component returns null
      expect(container.innerHTML).toBe('');
    });
  });
});
