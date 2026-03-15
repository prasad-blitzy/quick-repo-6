import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

/**
 * WXT Framework Configuration for the GMGN Signal Bot Chrome Extension.
 *
 * This configuration defines the Manifest V3 Chrome Extension build settings including:
 * - Preact JSX transformation via @preact/preset-vite plugin
 * - Path alias resolution for the '@/' prefix mapping to './src/'
 * - React-to-Preact/compat aliasing for libraries that depend on React APIs (e.g. Zustand hooks)
 * - Chrome Extension permissions for storage, alarms, offscreen documents, and active tab access
 * - Host permissions for all external API domains (Birdeye, Helius, Groq, RugCheck, GoPlus, Jupiter, DexScreener, Anthropic, PumpPortal)
 * - Minimum Chrome 116 requirement for WebSocket service-worker keepalive behavior
 * - Extension icons at 16×16, 48×48, and 128×128 resolutions
 */
export default defineConfig({
  /** Root directory containing entrypoints/ and src/ directories */
  srcDir: '.',

  /** No WXT modules required for this project */
  modules: [],

  /**
   * Vite build configuration.
   *
   * WXT expects the `vite` property to be a function that receives a Vite ConfigEnv
   * and returns a WxtViteConfig object (Omit<vite.UserConfig, 'root' | 'configFile' | 'mode'>).
   *
   * The Preact plugin provides JSX transformation, Hot Module Replacement via prefresh,
   * Preact Devtools bridge, and automatic React-to-preact/compat aliasing. Although the
   * plugin auto-applies React aliases when reactAliasesEnabled is true (the default),
   * we also declare them explicitly for clarity and to ensure consistency if the default
   * behavior changes in a future release.
   */
  vite: () => ({
    plugins: [
      preact(),
      /**
       * WXT's internal tsconfigPaths plugin (a regular-priority Vite plugin) always
       * overrides the '@' alias with the WXT srcDir value.  With srcDir: '.' the
       * override maps '@' to the project root instead of './src/', breaking every
       * '@/...' import.
       *
       * By using enforce: 'post' this plugin's config() hook runs AFTER WXT's
       * tsconfigPaths plugin, so the correct '@' → './src/' alias wins the merge.
       */
      {
        name: 'src-alias-override',
        enforce: 'post' as const,
        config() {
          return {
            resolve: {
              alias: {
                '@': resolve(__dirname, 'src'),
              },
            },
          };
        },
      },
    ],
    resolve: {
      alias: {
        /**
         * React compatibility aliases — route React imports through preact/compat.
         * These enable React-dependent libraries like Zustand hooks to work with Preact.
         * Note: @preact/preset-vite also sets these automatically, but we declare them
         * explicitly for documentation and resilience.
         */
        'react': 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
      },
    },
  }),

  /**
   * Chrome Extension Manifest V3 configuration.
   *
   * WXT auto-generates the manifest.json from this configuration object merged
   * with inline metadata from entrypoint files (e.g. defineContentScript matches).
   * Content script registration (matches, run_at) is handled by each entrypoint's
   * inline config — not declared here.
   */
  manifest: {
    name: 'GMGN Signal Bot',
    description:
      'Automated real-time memecoin trading signal generation overlay for GMGN.ai — provides 7-factor composite scoring, smart money tracking, safety analysis, and AI-powered insights for Solana tokens.',
    version: '1.0.0',

    /**
     * Chrome 116+ required: WebSocket activity in the service worker began
     * extending the 30-second idle termination timer starting in Chrome 116.
     * This is critical for maintaining persistent streaming connections to
     * PumpPortal and Birdeye WebSocket endpoints.
     */
    minimum_chrome_version: '116',

    /** Extension icons for toolbar (16), management page (48), and Chrome Web Store (128) */
    icons: {
      16: 'assets/icon-16.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },

    /**
     * Extension permissions:
     * - storage: chrome.storage.local, .sync, .session for Zustand persistence and encrypted API key storage
     * - alarms: chrome.alarms replaces setTimeout/setInterval in MV3 service workers (30s minimum interval)
     * - offscreen: chrome.offscreen for background operations that require DOM access
     * - activeTab: Required for tab-specific messaging via chrome.tabs.sendMessage
     */
    permissions: ['storage', 'alarms', 'offscreen', 'activeTab'],

    /**
     * Host permissions for all external API domains the service worker communicates with.
     * Each permission allows the service worker to make cross-origin fetch() calls to
     * the respective API without CORS restrictions.
     *
     * Domain list:
     * 1. gmgn.ai — Target page for content script injection and data interception
     * 2. public-api.birdeye.so — Birdeye REST API (token analytics, OHLCV, transactions)
     * 3. api.helius.xyz — Helius RPC API (enhanced transaction parsing, webhooks)
     * 4. api.groq.com — Groq LLM API (llama-3.1-8b-instant, llama-3.3-70b-versatile)
     * 5. api.rugcheck.xyz — RugCheck API (token safety reports, insider detection)
     * 6. api.gopluslabs.io — GoPlus Security API (mint/freeze authority, holder distribution)
     * 7. price.jup.ag — Jupiter Price API v3 (real-time price quotes)
     * 8. quote-api.jup.ag — Jupiter Quote API (swap simulation, honeypot detection)
     * 9. api.dexscreener.com — DexScreener API (fallback token data)
     * 10. api.anthropic.com — Anthropic Claude API (narrative analysis for top 5% signals)
     * 11. pumpportal.fun — PumpPortal WebSocket (new pump.fun token events, trade events)
     */
    host_permissions: [
      'https://gmgn.ai/*',
      'https://public-api.birdeye.so/*',
      'https://api.helius.xyz/*',
      'https://api.groq.com/*',
      'https://api.rugcheck.xyz/*',
      'https://api.gopluslabs.io/*',
      'https://price.jup.ag/*',
      'https://quote-api.jup.ag/*',
      'https://api.dexscreener.com/*',
      'https://api.anthropic.com/*',
      'wss://pumpportal.fun/*',
    ],
  },
});
