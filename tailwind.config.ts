import type { Config } from 'tailwindcss';

/**
 * TailwindCSS Configuration for GMGN Signal Bot Chrome Extension
 *
 * This configuration is optimized for Shadow DOM rendering within the Chrome
 * Extension's content script overlay. All styles generated from this config
 * are injected into the Shadow DOM root, providing complete isolation from
 * the host GMGN.ai page CSS.
 *
 * Key design decisions:
 * - Dark theme colors match GMGN.ai's trading interface aesthetic
 * - Signal score colors follow the traffic-light pattern (red/yellow/green)
 * - Safety badge colors align with risk severity (green=safe, yellow=warning, red=danger)
 * - Custom sidebar width (350px) matches the AAP-specified fixed panel width
 * - System font stack ensures lightweight rendering without web font downloads
 * - No prefix needed since Shadow DOM provides inherent style isolation
 */
export default {
  /**
   * Content paths for Tailwind's JIT class scanning.
   * Covers all Preact UI components and popup entry point files
   * that may contain Tailwind utility classes.
   */
  content: [
    './src/components/**/*.{tsx,ts}',
    './entrypoints/popup/**/*.{tsx,ts,html}',
  ],

  /**
   * Manual dark mode control via CSS class.
   * Within the Shadow DOM, we add a 'dark' class to the shadow root
   * container to enable dark mode variants (e.g., dark:bg-gmgn-bg-primary).
   * This is preferred over 'media' because the extension UI should always
   * render in dark mode to complement GMGN.ai's dark trading interface,
   * regardless of the user's system preference.
   */
  darkMode: 'class',

  theme: {
    extend: {
      /**
       * Custom color palette for the GMGN Signal Bot overlay.
       *
       * Colors are organized into semantic groups:
       * - gmgn.*   : Background, text, and border colors matching GMGN's dark UI
       * - signal.*  : Composite score indicators (high/medium/low)
       * - safety.*  : Token safety badge colors (safe/warning/danger)
       * - accent.*  : Interactive element highlights and primary actions
       * - smart.*   : Smart money and whale tracking indicators
       */
      colors: {
        /* GMGN dark theme background colors */
        gmgn: {
          bg: {
            primary: '#0d0d0f',
            secondary: '#161618',
            tertiary: '#1c1c1f',
            card: '#1a1a1d',
            hover: '#242428',
            input: '#111113',
          },
          text: {
            primary: '#e5e5e7',
            secondary: '#a1a1a6',
            muted: '#6b6b70',
            inverse: '#0d0d0f',
          },
          border: {
            DEFAULT: '#2a2a2e',
            light: '#3a3a3e',
            focus: '#4a4a4e',
          },
        },

        /**
         * Signal score colors — traffic-light pattern for composite scores.
         * High (≥80): green, Medium (45–79): yellow, Low (<45): red
         * Per AAP: conservative mode threshold ≥80, aggressive mode ≥45.
         */
        signal: {
          high: '#22c55e',
          'high-bg': 'rgba(34, 197, 94, 0.12)',
          medium: '#eab308',
          'medium-bg': 'rgba(234, 179, 8, 0.12)',
          low: '#ef4444',
          'low-bg': 'rgba(239, 68, 68, 0.12)',
        },

        /**
         * Safety badge colors — risk severity indicators.
         * Safe: score ≥300, all authorities revoked (green)
         * Warning: partial concerns, some risk factors (amber)
         * Danger: critical risks — active mint/freeze, honeypot detected (red)
         */
        safety: {
          safe: '#22c55e',
          'safe-bg': 'rgba(34, 197, 94, 0.15)',
          warning: '#f59e0b',
          'warning-bg': 'rgba(245, 158, 11, 0.15)',
          danger: '#ef4444',
          'danger-bg': 'rgba(239, 68, 68, 0.15)',
        },

        /* Accent colors for interactive elements and primary actions */
        accent: {
          primary: '#6366f1',
          'primary-hover': '#818cf8',
          secondary: '#8b5cf6',
          'secondary-hover': '#a78bfa',
          muted: 'rgba(99, 102, 241, 0.15)',
        },

        /* Smart money and whale tracking indicators */
        smart: {
          whale: '#3b82f6',
          convergence: '#06b6d4',
          kol: '#d946ef',
          sniper: '#f97316',
        },
      },

      /**
       * Custom width utilities for the sidebar panel.
       * Per AAP: "position: fixed; right: 0; width: 350px"
       */
      width: {
        sidebar: '350px',
      },

      /**
       * System font stack for lightweight rendering.
       * No web font downloads needed — uses fonts already available
       * on the user's system for minimal performance impact.
       * Monospace stack included for token addresses and numerical data.
       */
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace',
        ],
      },
    },
  },
} satisfies Config;
