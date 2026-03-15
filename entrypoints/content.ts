/**
 * entrypoints/content.ts — Content Script (GMGN.ai Injection + Shadow DOM + Message Bridge)
 *
 * WXT content script injected into `https://gmgn.ai/*` pages at `document_idle`.
 * This is the critical bridge layer in the Chrome Extension's three-layer architecture:
 *
 * 1. **Injects** the page-context script (`injected.ts`) into GMGN's page DOM
 *    to monkey-patch `window.fetch` and `XMLHttpRequest` for passive data capture
 * 2. **Creates** a Shadow DOM container and mounts the Preact overlay UI sidebar
 * 3. **Bridges** messages between the page context (via `window.postMessage`) and
 *    the service worker (via `chrome.runtime.sendMessage`)
 * 4. **Observes** DOM changes on GMGN's token list container with MutationObserver
 *    (250ms debounce, narrowest subtree targeting per AAP Section 0.7.5)
 * 5. **Synchronizes** state from the service worker's Zustand stores via
 *    `chrome.storage.onChanged` listeners (per AAP Section 0.4.4)
 *
 * Architecture position (per AAP Section 0.4.2):
 *   Injected Script (page context)
 *     → window.postMessage → Content Script (isolated world) [THIS FILE]
 *       → chrome.runtime.sendMessage → Service Worker (background)
 *         → chrome.runtime.sendMessage / chrome.tabs.sendMessage → Content Script
 *           → Zustand store update → Preact re-render in Shadow DOM
 *
 * Key constraints (per AAP):
 * - All UI elements live inside Shadow DOM — never appended to GMGN's DOM (Section 0.7.5)
 * - Shadow DOM host uses z-index: 2147483647 (maximum 32-bit integer) (Section 0.7.5)
 * - Preact only — no React imports (Section 0.7.5)
 * - No API keys in content script (Section 0.7.2)
 * - Origin validation on all window.postMessage events (Section 0.7.2)
 * - MutationObserver targets narrowest subtree with 250ms debounce (Section 0.7.5)
 * - MutationObserver disconnects when panel is collapsed (Section 0.7.5)
 * - Content script size budget: <100KB gzipped (Section 0.7.5)
 *
 * `defineContentScript` is auto-imported by WXT — do NOT add a manual import.
 *
 * @module entrypoints/content
 */

// ---------------------------------------------------------------------------
// Internal Imports — Application Dependencies
// ---------------------------------------------------------------------------

import { render, type VNode } from 'preact';
import { h } from 'preact';
import { App } from '@/components/App';
import cssText from '@/components/styles.css?inline';
import {
  sendToBackground,
  onWindowMessage,
  onMessage,
  type ExtensionMessage,
} from '@/utils/messaging';
import { UI_CONFIG, TIMING } from '@/utils/config';
import { createLogger } from '@/utils/logger';
import { setupStorageSyncListener } from '@/store/index';
import type { GmgnInterceptedMessage } from '@/gmgn/types';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Structured logger with 'content-script' context tag.
 * Logs Shadow DOM creation, message bridge events, MutationObserver activity,
 * injected script loading, store sync events, and errors.
 * DEBUG/INFO are no-op in production builds.
 */
const log = createLogger('content-script', { forwardToBackground: true });

// ---------------------------------------------------------------------------
// Module-Level State
// ---------------------------------------------------------------------------

/** Reference to the MutationObserver for cleanup and panel-collapse disconnect */
let domObserver: MutationObserver | null = null;

/** Debounce timer ID for MutationObserver callback */
let observerDebounceTimer: ReturnType<typeof setTimeout> | undefined;

/** Reference to the Shadow DOM host element for lifecycle cleanup */
let shadowHostElement: HTMLDivElement | null = null;

/** Flag tracking whether the observer should be active (panel visible) */
let observerActive = false;

// ---------------------------------------------------------------------------
// GMGN DOM Selectors — Narrowest Subtree Targeting
// ---------------------------------------------------------------------------

/**
 * Candidate CSS selectors for GMGN's token list container.
 * Ordered from most specific to least specific. The MutationObserver
 * targets the FIRST matched element to observe the narrowest possible
 * subtree per AAP Section 0.7.5.
 *
 * These selectors target GMGN.ai's Next.js/React-rendered token list
 * areas. If none match, the observer falls back to document.body with
 * a warning log.
 */
const GMGN_TOKEN_LIST_SELECTORS: readonly string[] = [
  '[class*="token-list"]',
  '[class*="tokenList"]',
  '[class*="rank-list"]',
  '[class*="rankList"]',
  'main [class*="list"]',
  'main table tbody',
  'main',
] as const;

// ---------------------------------------------------------------------------
// Phase 2: Inject Page-Context Script
// ---------------------------------------------------------------------------

/**
 * Injects the page-context script (`injected.ts`) into GMGN's page DOM.
 *
 * Creates a `<script>` element referencing the WXT-built injected script
 * bundle and appends it to `document.head`. The script element is removed
 * after loading (cleanup, prevent detection). The injected script runs in
 * GMGN's page context and starts intercepting fetch/XHR calls.
 *
 * Uses `browser.runtime.getURL()` (WXT polyfill for `chrome.runtime.getURL`)
 * to resolve the built script path.
 */
function injectPageContextScript(): void {
  try {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('/injected.js');
    script.type = 'text/javascript';

    script.onload = () => {
      log.info('Page-context script (injected.js) loaded successfully');
      script.remove();
    };

    script.onerror = () => {
      log.error('Failed to load page-context script (injected.js)');
      script.remove();
    };

    (document.head || document.documentElement).appendChild(script);
    log.debug('Injecting page-context script via <script> tag');
  } catch (err) {
    log.error('Error injecting page-context script', err);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Shadow DOM Container Creation
// ---------------------------------------------------------------------------

/**
 * Creates the Shadow DOM host element and attaches an open shadow root.
 *
 * Per AAP Section 0.5.1 Group 2 and Section 0.7.5:
 * - Host element ID: from `UI_CONFIG.SHADOW_DOM_HOST_ID` ('gmgn-signal-bot')
 * - Position: fixed, right: 0, top: 0
 * - Width: from `UI_CONFIG.SIDEBAR_WIDTH_PX` (350px)
 * - Height: 100vh
 * - z-index: from `UI_CONFIG.Z_INDEX` (2147483647 — maximum 32-bit integer)
 * - Shadow DOM mode: 'open'
 *
 * All extension UI elements MUST be inside this Shadow DOM container.
 *
 * @returns Object containing the shadow root and host element, or null on failure
 */
function createShadowDomContainer(): {
  shadow: ShadowRoot;
  host: HTMLDivElement;
} | null {
  try {
    // Prevent duplicate injection
    const existing = document.getElementById(UI_CONFIG.SHADOW_DOM_HOST_ID);
    if (existing) {
      log.warn('Shadow DOM host already exists, removing previous instance');
      existing.remove();
    }

    const host = document.createElement('div');
    host.id = UI_CONFIG.SHADOW_DOM_HOST_ID;

    // Apply critical inline styles per AAP Section 0.7.5
    // These MUST be inline on the host element (not in Shadow DOM CSS)
    // because the host element lives in GMGN's DOM and Shadow DOM styles
    // cannot affect the host from inside.
    host.style.position = 'fixed';
    host.style.right = '0';
    host.style.top = '0';
    host.style.width = `${UI_CONFIG.SIDEBAR_WIDTH_PX}px`;
    host.style.height = '100vh';
    host.style.zIndex = String(UI_CONFIG.Z_INDEX);
    host.style.pointerEvents = 'auto';
    host.style.overflow = 'visible';

    const shadow = host.attachShadow({ mode: 'open' });

    document.body.appendChild(host);
    shadowHostElement = host;

    log.info('Shadow DOM container created', {
      id: UI_CONFIG.SHADOW_DOM_HOST_ID,
      width: UI_CONFIG.SIDEBAR_WIDTH_PX,
      zIndex: UI_CONFIG.Z_INDEX,
    });

    return { shadow, host };
  } catch (err) {
    log.error('Failed to create Shadow DOM container', err);
    return null;
  }
}

/**
 * Loads the scoped stylesheet into the Shadow DOM.
 *
 * Uses the `?inline` Vite import to get the CSS as a string, then injects
 * it via a `<style>` element inside the shadow root. This ensures all
 * component styles are completely isolated from GMGN's page CSS.
 *
 * @param shadow - The shadow root to inject styles into
 */
function loadShadowStyles(shadow: ShadowRoot): void {
  try {
    const styleElement = document.createElement('style');
    styleElement.textContent = cssText;
    shadow.appendChild(styleElement);
    log.debug('Shadow DOM styles loaded');
  } catch (err) {
    log.error('Failed to load Shadow DOM styles', err);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Mount Preact App
// ---------------------------------------------------------------------------

/**
 * Mounts the root Preact `<App />` component inside the Shadow DOM.
 *
 * Creates a dedicated mount-point `<div>` inside the shadow root so that
 * Preact's `render()` has a clean container. The App component handles its
 * own state management via Zustand stores and renders the full sidebar UI.
 *
 * @param shadow - The shadow root to mount the Preact app into
 */
function mountPreactApp(shadow: ShadowRoot): void {
  try {
    const appRoot = document.createElement('div');
    appRoot.id = 'app-root';
    shadow.appendChild(appRoot);

    render(h(App, null), appRoot);

    log.info('Preact App mounted inside Shadow DOM');
  } catch (err) {
    log.error('Failed to mount Preact App', err);
  }
}

// ---------------------------------------------------------------------------
// Phase 5: Message Bridge — Page Context ↔ Service Worker
// ---------------------------------------------------------------------------

/**
 * Sets up the message bridge between the page-context injected script
 * and the service worker.
 *
 * Phase 5a: Listens for `window.postMessage` from injected.ts with
 *           origin validation (`https://gmgn.ai`) and source filtering
 *           (`gmgn-signal-bot`). Forwards intercepted GMGN API data to
 *           the service worker via `sendToBackground()`.
 *
 * Phase 5b: Listens for `chrome.runtime.onMessage` from the service worker
 *           with sender.id validation. Handles SIGNAL_UPDATE, SAFETY_RESULT,
 *           AI_ANALYSIS, TOKEN_DATA, EXIT_ALERT, STREAM_EVENT message types.
 *
 * Phase 5c: Uses `sendToBackground()` from messaging.ts for all outbound
 *           messages to the service worker.
 */
function setupMessageBridge(): void {
  // Phase 5a: Receive intercepted GMGN data from injected.ts (page context)
  onWindowMessage((data) => {
    log.debug('Received window message', { type: data.type });

    if (data.type === 'GMGN_API_RESPONSE') {
      // Forward the intercepted GMGN API response to the service worker
      const payload = data.payload as GmgnInterceptedMessage['payload'];

      sendToBackground({
        type: 'GMGN_API_RESPONSE',
        payload: {
          url: payload.url,
          data: payload.data,
          patternType: payload.patternType,
        },
      }).catch((err) => {
        log.warn('Failed to forward GMGN data to background', err);
      });
    }
  });

  // Phase 5b: Receive messages from the service worker
  onMessage((message, _sender, _sendResponse) => {
    log.debug('Received service worker message', { type: message.type });

    switch (message.type) {
      case 'SIGNAL_UPDATE':
        // Signal store is updated automatically via chrome.storage.onChanged
        // listener in setupStorageSyncListener() — no manual store write needed.
        // This message serves as a real-time notification for logging/debugging.
        log.debug('Signal update received', {
          mint: (message.payload as { mint: string }).mint,
        });
        break;

      case 'SAFETY_CHECK_RESULT':
        log.debug('Safety result received', {
          mint: (message.payload as { mint: string }).mint,
        });
        break;

      case 'AI_ANALYSIS_RESULT':
        log.debug('AI analysis result received', {
          mint: (message.payload as { mint: string }).mint,
        });
        break;

      case 'TOKEN_DATA':
        log.debug('Token data received', {
          mint: (message.payload as { mint: string }).mint,
        });
        break;

      case 'EXIT_SIGNAL':
        log.info('Exit signal triggered', {
          mint: (message.payload as { mint: string }).mint,
        });
        break;

      case 'STREAM_EVENT':
        log.debug('Stream event received', {
          source: (message.payload as { source: string }).source,
        });
        break;

      default:
        // Other message types (LOG_FORWARD, SETTINGS_CHANGE, etc.)
        // are handled by the service worker — content script ignores them
        break;
    }
  });

  log.info('Message bridge established (window ↔ service worker)');
}

// ---------------------------------------------------------------------------
// Phase 6: MutationObserver for GMGN DOM Changes
// ---------------------------------------------------------------------------

/**
 * Finds the narrowest target element in GMGN's DOM to observe.
 *
 * Iterates through `GMGN_TOKEN_LIST_SELECTORS` and returns the first
 * matching element. Falls back to `document.body` if no candidate matches.
 *
 * @returns The DOM element to observe
 */
function findObserverTarget(): Element {
  for (const selector of GMGN_TOKEN_LIST_SELECTORS) {
    const target = document.querySelector(selector);
    if (target) {
      log.debug('MutationObserver targeting element', { selector });
      return target;
    }
  }
  log.warn('No specific GMGN token list element found, falling back to document.body');
  return document.body;
}

/**
 * Extracts Solana token addresses from DOM elements found in mutations.
 *
 * Scans added nodes for anchor elements with `href` patterns matching
 * GMGN's token page routes (e.g., `/sol/token/<address>`). Collects
 * unique addresses to avoid duplicate processing.
 *
 * @param mutations - Array of MutationRecords from the observer
 * @returns Set of unique Solana token mint addresses found in new nodes
 */
function extractTokenAddressesFromMutations(
  mutations: MutationRecord[]
): Set<string> {
  const addresses = new Set<string>();
  // Solana address pattern: 32-44 base58 characters
  const solanaAddressRegex = /\/sol\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/;

  for (const mutation of mutations) {
    for (const node of Array.from(mutation.addedNodes)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      const element = node as Element;

      // Check direct element and all descendant anchors
      const anchors = [
        ...(element.matches?.('a[href]') ? [element as HTMLAnchorElement] : []),
        ...Array.from(element.querySelectorAll?.('a[href]') ?? []),
      ] as HTMLAnchorElement[];

      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(solanaAddressRegex);
        if (match?.[1]) {
          addresses.add(match[1]);
        }
      }
    }
  }

  return addresses;
}

/**
 * Sets up the MutationObserver to detect new token cards appearing on
 * GMGN pages.
 *
 * Per AAP Section 0.1.2 and 0.7.5:
 * - Targets the narrowest possible subtree (not document.body)
 * - Debounces callbacks at 250ms minimum
 * - Disconnects when the extension panel is collapsed
 *
 * When new token elements are detected, their addresses are extracted
 * and forwarded to the service worker for analysis.
 */
function setupMutationObserver(): void {
  const target = findObserverTarget();

  domObserver = new MutationObserver((mutations: MutationRecord[]) => {
    // Debounce: clear any pending timer and set a new one
    if (observerDebounceTimer !== undefined) {
      clearTimeout(observerDebounceTimer);
    }

    observerDebounceTimer = setTimeout(() => {
      try {
        const newAddresses = extractTokenAddressesFromMutations(mutations);

        if (newAddresses.size > 0) {
          log.debug('New token addresses detected via DOM mutation', {
            count: newAddresses.size,
            addresses: Array.from(newAddresses).slice(0, 5), // Log first 5
          });

          // Forward each new token address to the service worker for analysis
          for (const mint of newAddresses) {
            sendToBackground({
              type: 'TOKEN_DATA',
              payload: { mint, data: { source: 'dom-mutation' } },
            }).catch((err) => {
              log.warn('Failed to forward DOM-detected token to background', err);
            });
          }
        }
      } catch (err) {
        log.error('Error processing MutationObserver mutations', err);
      }
    }, TIMING.MUTATION_OBSERVER_DEBOUNCE_MS);
  });

  domObserver.observe(target, {
    childList: true,
    subtree: true,
  });

  observerActive = true;
  log.info('MutationObserver active with 250ms debounce');
}

/**
 * Disconnects the MutationObserver and clears the debounce timer.
 * Called when the extension panel is collapsed or during cleanup.
 */
function disconnectMutationObserver(): void {
  if (domObserver) {
    domObserver.disconnect();
    observerActive = false;
    log.debug('MutationObserver disconnected');
  }

  if (observerDebounceTimer !== undefined) {
    clearTimeout(observerDebounceTimer);
    observerDebounceTimer = undefined;
  }
}

/**
 * Reconnects the MutationObserver when the panel is expanded.
 * Re-finds the target element (GMGN may have re-rendered since last disconnect).
 */
function reconnectMutationObserver(): void {
  if (domObserver && !observerActive) {
    const target = findObserverTarget();
    domObserver.observe(target, { childList: true, subtree: true });
    observerActive = true;
    log.debug('MutationObserver reconnected');
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Panel Visibility Tracking & Observer Sync
// ---------------------------------------------------------------------------

/**
 * Listens for panel visibility changes in `chrome.storage.sync` (settings-store)
 * and toggles the MutationObserver accordingly.
 *
 * Per AAP Section 0.7.5: "Disconnect observers when the extension panel is collapsed."
 * When the user collapses the sidebar, we disconnect the observer to save CPU.
 * When the sidebar is expanded, we reconnect it.
 */
function setupPanelVisibilityTracking(): void {
  if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged) {
    return;
  }

  chrome.storage.onChanged.addListener(
    (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName !== 'sync') return;

      const settingsChange = changes['settings-store'];
      if (!settingsChange?.newValue) return;

      try {
        // Parse the settings state to check panelVisible
        let settingsState: { panelVisible?: boolean } | null = null;

        if (typeof settingsChange.newValue === 'string') {
          settingsState = JSON.parse(settingsChange.newValue) as { panelVisible?: boolean };
        } else if (typeof settingsChange.newValue === 'object') {
          settingsState = settingsChange.newValue as { panelVisible?: boolean };
        }

        if (settingsState && typeof settingsState.panelVisible === 'boolean') {
          if (settingsState.panelVisible && !observerActive) {
            reconnectMutationObserver();
          } else if (!settingsState.panelVisible && observerActive) {
            disconnectMutationObserver();
          }
        }
      } catch (err) {
        log.warn('Error parsing settings-store change for panel visibility', err);
      }
    }
  );

  log.debug('Panel visibility tracking configured');
}

// ---------------------------------------------------------------------------
// Phase 8: Cleanup and Lifecycle
// ---------------------------------------------------------------------------

/**
 * Cleans up all resources when the content script is unloaded (page navigation)
 * or the extension context is invalidated.
 *
 * - Disconnects MutationObserver
 * - Removes Shadow DOM host element from the page
 * - Clears debounce timers
 */
function cleanup(): void {
  log.info('Content script cleanup initiated');

  disconnectMutationObserver();

  if (shadowHostElement) {
    try {
      shadowHostElement.remove();
      shadowHostElement = null;
      log.debug('Shadow DOM host element removed');
    } catch {
      // Ignore errors during cleanup — page may already be unloading
    }
  }
}

// ===========================================================================
// WXT Content Script Entry Point
// ===========================================================================

/**
 * WXT content script definition.
 *
 * `defineContentScript` is auto-imported by WXT — it wraps the content script
 * initialization code with configuration metadata that WXT uses to auto-generate
 * the manifest.json `content_scripts` entry.
 *
 * - `matches: ['https://gmgn.ai/*']` — Only inject on GMGN pages
 * - `runAt: 'document_idle'` — Inject after DOM is fully parsed
 *
 * The `main(ctx)` function receives a `ContentScriptContext` which provides
 * an `AbortSignal` for detecting when the content script is invalidated
 * (e.g., extension update/reload). We register `cleanup` as an invalidation
 * callback to gracefully tear down all resources.
 */
export default defineContentScript({
  matches: ['https://gmgn.ai/*'],
  runAt: 'document_idle',

  main(ctx) {
    log.info('GMGN Signal Bot content script initializing');

    // Register cleanup for when the content script context is invalidated
    // (extension reload, update, or page navigation)
    ctx.onInvalidated(() => {
      cleanup();
    });

    // -----------------------------------------------------------------------
    // Phase 2: Inject page-context script for fetch/XHR interception
    // -----------------------------------------------------------------------
    injectPageContextScript();

    // -----------------------------------------------------------------------
    // Phase 3: Create Shadow DOM container
    // -----------------------------------------------------------------------
    const container = createShadowDomContainer();
    if (!container) {
      log.error('Aborting initialization — Shadow DOM creation failed');
      return;
    }

    const { shadow } = container;

    // Load scoped stylesheet into Shadow DOM
    loadShadowStyles(shadow);

    // -----------------------------------------------------------------------
    // Phase 4: Mount Preact App inside Shadow DOM
    // -----------------------------------------------------------------------
    mountPreactApp(shadow);

    // -----------------------------------------------------------------------
    // Phase 5: Set up message bridge (page context ↔ service worker)
    // -----------------------------------------------------------------------
    setupMessageBridge();

    // -----------------------------------------------------------------------
    // Phase 6: Set up MutationObserver for GMGN DOM changes
    // -----------------------------------------------------------------------
    setupMutationObserver();

    // -----------------------------------------------------------------------
    // Phase 7: Set up cross-context store synchronization
    // -----------------------------------------------------------------------
    // This registers the chrome.storage.onChanged listener that propagates
    // service worker Zustand store state changes to the content script's
    // local store instances, triggering automatic Preact re-renders.
    setupStorageSyncListener();

    // Set up panel visibility tracking to disconnect/reconnect the observer
    setupPanelVisibilityTracking();

    log.info('GMGN Signal Bot content script initialization complete');
  },
});
