/**
 * @fileoverview Core Fetch/XHR Monkey-Patch Interception Logic for GMGN.ai
 *
 * This module runs in the PAGE CONTEXT (injected by `entrypoints/injected.ts`),
 * NOT in the content script's isolated world. It transparently intercepts
 * GMGN's own internal fetch/XHR calls that the GMGN Next.js/React frontend
 * makes, clones matching responses, and dispatches them via `window.postMessage`
 * to the content script layer.
 *
 * **Data Flow:**
 * ```
 * GMGN Frontend → fetch/XHR call
 *   → interceptor captures & clones response
 *   → window.postMessage({ source: 'gmgn-signal-bot', ... })
 *   → content.ts (isolated world) picks up the message
 *   → chrome.runtime.sendMessage → background.ts (service worker)
 * ```
 *
 * **Critical Constraints:**
 * - `chrome.runtime` is NOT available in page context — only `window.postMessage`
 * - Interception must be completely transparent — GMGN must not detect any change
 * - Always `response.clone()` before reading — consuming the original breaks GMGN
 * - All errors must be silently caught — never crash the host page
 * - Setup must be idempotent — calling `setupInterceptor()` twice is a no-op
 *
 * @module src/gmgn/interceptor
 */

import { matchesGmgnApi } from './url-patterns';

// =============================================================================
// Constants
// =============================================================================

/**
 * Message source identifier used in all `window.postMessage` payloads.
 * The content script filters on this value to distinguish extension messages
 * from any other `postMessage` traffic on the GMGN page.
 */
const MESSAGE_SOURCE = 'gmgn-signal-bot' as const;

/**
 * Discriminated message type for GMGN API response interceptions.
 * Matches the union type expected by `src/utils/messaging.ts`.
 */
const MESSAGE_TYPE = 'GMGN_API_RESPONSE' as const;

/**
 * Prefix for all console.debug messages emitted by the interceptor.
 * Using `console.debug` (not `console.log`) minimizes noise in the
 * user's browser console.
 */
const LOG_PREFIX = '[gmgn-signal-bot]' as const;

// =============================================================================
// Module State
// =============================================================================

/**
 * Tracks whether the interceptor has been initialized.
 * Prevents double-patching when `setupInterceptor()` is called multiple times.
 */
let isInitialized = false;

/**
 * Stored reference to the original, unpatched `window.fetch` function.
 * Bound to `window` to preserve the correct `this` context when called.
 * Initialized lazily inside `patchFetch()` to avoid capturing a reference
 * at module load time (before the page's native fetch is fully available).
 */
let originalFetch: typeof window.fetch;

/**
 * Stored reference to the original, unpatched `XMLHttpRequest.prototype.open`.
 * Used to restore the original behavior in `restoreInterceptor()`.
 */
let originalXHROpen: typeof XMLHttpRequest.prototype.open;

/**
 * Stored reference to the original, unpatched `XMLHttpRequest.prototype.send`.
 * Used to restore the original behavior in `restoreInterceptor()`.
 */
let originalXHRSend: typeof XMLHttpRequest.prototype.send;

// =============================================================================
// Message Dispatch
// =============================================================================

/**
 * Dispatches intercepted GMGN API response data to the content script
 * via `window.postMessage`.
 *
 * The content script listens for messages with `source === 'gmgn-signal-bot'`
 * and forwards payloads to the service worker via `chrome.runtime.sendMessage`.
 *
 * @param url - The full request URL that was intercepted.
 * @param data - The parsed JSON response body (cloned from the original response).
 * @param patternType - The GMGN API pattern identifier returned by `matchesGmgnApi()`
 *   (e.g., `'trending_tokens'`, `'token_detail'`, `'wallet_activity'`, `'smart_money'`).
 *
 * @example
 * ```ts
 * dispatchInterceptedData(
 *   'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
 *   { data: { rank: [...] } },
 *   'trending_tokens'
 * );
 * ```
 */
export function dispatchInterceptedData(
  url: string,
  data: unknown,
  patternType: string,
): void {
  try {
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: MESSAGE_TYPE,
        payload: {
          url,
          data,
          patternType,
          timestamp: Date.now(),
        },
      },
      '*',
    );
  } catch (err) {
    // Even the dispatch itself must never throw — protect the host page.
    console.debug(LOG_PREFIX, 'Failed to dispatch intercepted data:', err);
  }
}

// =============================================================================
// URL Extraction Helper
// =============================================================================

/**
 * Extracts a plain URL string from the various input types accepted by
 * `window.fetch()`.
 *
 * `fetch()` can receive:
 * - A plain string URL
 * - A `URL` object
 * - A `Request` object
 *
 * This helper normalizes all three to a simple string so that
 * `matchesGmgnApi()` can test it against the regex pattern registry.
 *
 * @param input - The first argument passed to `fetch()`.
 * @returns The URL as a string, or an empty string if extraction fails.
 */
function extractUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === 'string') {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    if (input instanceof Request) {
      return input.url;
    }
    // Fallback: attempt toString() for unexpected types.
    return String(input);
  } catch {
    return '';
  }
}

// =============================================================================
// Fetch Monkey-Patch
// =============================================================================

/**
 * Installs the `window.fetch` monkey-patch.
 *
 * The patched fetch:
 * 1. Calls the original `fetch()` with all original arguments (transparent).
 * 2. Checks the request URL against GMGN API patterns via `matchesGmgnApi()`.
 * 3. If no match → returns the original response immediately (zero overhead).
 * 4. If a match is found:
 *    a. Clones the response (`response.clone()`) so the body can be read
 *       without consuming the original stream.
 *    b. Reads the cloned response as JSON.
 *    c. Dispatches the parsed data via `dispatchInterceptedData()`.
 *    d. Returns the ORIGINAL (unconsumed) response to the GMGN frontend.
 *
 * All interception logic is wrapped in try/catch — errors are logged via
 * `console.debug` and never propagated to the calling GMGN code.
 */
function patchFetch(): void {
  // Capture and bind the current (presumably original) fetch to `window`.
  originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Always call the original fetch first to preserve transparent behavior.
    // If the original fetch throws (e.g., network error), let that propagate
    // naturally — we only intercept successful responses.
    const response = await originalFetch(input, init);

    // Extract the URL string from the (possibly complex) input argument.
    const url = extractUrl(input);

    // Fast path: check if this URL matches any known GMGN API pattern.
    const patternType = matchesGmgnApi(url);

    if (patternType) {
      // Matched a GMGN API pattern — intercept the response.
      // All interception work runs asynchronously and must never block
      // or modify the response returned to the GMGN frontend.
      try {
        // CRITICAL: Clone the response before reading the body.
        // `Response.json()` consumes the body stream, so calling it on
        // the original would break the GMGN frontend's own `.json()` call.
        const cloned = response.clone();
        const data = await cloned.json();
        dispatchInterceptedData(url, data, patternType);
      } catch (err) {
        // Silently ignore parse errors — non-JSON responses, empty bodies,
        // aborted requests, etc. Never break the GMGN page.
        console.debug(
          LOG_PREFIX,
          'Failed to parse intercepted fetch response:',
          url,
          err,
        );
      }
    }

    // Always return the original, unconsumed response to the caller.
    return response;
  };
}

// =============================================================================
// XMLHttpRequest Monkey-Patch (Fallback)
// =============================================================================

/**
 * Internal property key used to store the intercepted URL on XHR instances.
 * Using a string key (rather than a Symbol) for maximum compatibility with
 * the GMGN page's runtime environment.
 */
const XHR_URL_KEY = '__gmgnInterceptedUrl__';

/**
 * Internal property key used to store the intercepted HTTP method on
 * XHR instances (for potential future use in filtering GET vs POST).
 */
const XHR_METHOD_KEY = '__gmgnInterceptedMethod__';

/**
 * Installs the `XMLHttpRequest.prototype.open` and `.send` monkey-patches.
 *
 * While GMGN's Next.js frontend primarily uses `fetch()`, some third-party
 * scripts or legacy codepaths may use XHR. This fallback ensures we capture
 * GMGN API responses regardless of the transport mechanism.
 *
 * **Patch strategy:**
 * - `open()` is patched to capture the request URL and HTTP method on the
 *   XHR instance for later reference.
 * - `send()` is patched to attach a `load` event listener that reads the
 *   response text when the request completes successfully (status 200–299).
 *
 * All interception logic is wrapped in try/catch — errors are logged via
 * `console.debug` and never propagated.
 */
function patchXHR(): void {
  // Capture original prototypes before patching.
  originalXHROpen = XMLHttpRequest.prototype.open;
  originalXHRSend = XMLHttpRequest.prototype.send;

  // ── Patch XMLHttpRequest.prototype.open ──────────────────────────────
  // Captures the request URL and method on the XHR instance so that
  // the `send()` patch can check it against GMGN API patterns.
  XMLHttpRequest.prototype.open = function patchedOpen(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    try {
      // Store the URL and method on the instance for later retrieval.
      // Cast through `unknown` to satisfy TypeScript strict mode checks,
      // since XMLHttpRequest's type lacks an index signature.
      (this as unknown as Record<string, unknown>)[XHR_URL_KEY] = url.toString();
      (this as unknown as Record<string, unknown>)[XHR_METHOD_KEY] = method;
    } catch {
      // Silently ignore — never break the host page.
    }

    // Call the original `open()` with all arguments.
    // Using explicit argument passing (not spread) for maximum compatibility
    // with the browser's native XHR implementation.
    return originalXHROpen.call(
      this,
      method,
      url,
      async !== undefined ? async : true,
      username ?? null,
      password ?? null,
    );
  };

  // ── Patch XMLHttpRequest.prototype.send ──────────────────────────────
  // Attaches a `load` event listener that checks if the completed
  // request matches a GMGN API pattern and dispatches the response data.
  XMLHttpRequest.prototype.send = function patchedSend(
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const xhr = this;

    try {
      const url = (xhr as unknown as Record<string, unknown>)[XHR_URL_KEY] as
        | string
        | undefined;

      if (url) {
        const patternType = matchesGmgnApi(url);

        if (patternType) {
          // This XHR targets a GMGN API endpoint — attach a load listener
          // to capture the response once it completes.
          xhr.addEventListener('load', function onXHRLoad(): void {
            try {
              // Only process successful responses (HTTP 2xx).
              if (xhr.readyState === XMLHttpRequest.DONE && xhr.status >= 200 && xhr.status < 300) {
                // Ensure the response type is compatible with text parsing.
                // XHR responses with `responseType` set to 'arraybuffer', 'blob',
                // or 'document' cannot be read as text.
                const responseType = xhr.responseType;
                if (
                  responseType === '' ||
                  responseType === 'text' ||
                  responseType === 'json'
                ) {
                  let data: unknown;

                  if (responseType === 'json') {
                    // When responseType is 'json', the browser has already parsed
                    // the response — use `xhr.response` directly.
                    data = xhr.response;
                  } else {
                    // For '' (default) or 'text', parse the text as JSON manually.
                    data = JSON.parse(xhr.responseText);
                  }

                  dispatchInterceptedData(url, data, patternType);
                }
              }
            } catch (err) {
              // Silently ignore parse errors — binary responses, non-JSON
              // content types, aborted requests, etc.
              console.debug(
                LOG_PREFIX,
                'Failed to parse intercepted XHR response:',
                url,
                err,
              );
            }
          });
        }
      }
    } catch (err) {
      // Silently ignore — never prevent the original send() from executing.
      console.debug(LOG_PREFIX, 'Error in XHR send patch:', err);
    }

    // Call the original `send()` with the body argument.
    return originalXHRSend.call(this, body);
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Activates the fetch and XMLHttpRequest monkey-patches to begin
 * intercepting GMGN's internal API responses.
 *
 * This function is called once from `entrypoints/injected.ts` when the
 * extension's page-context script loads. It is **idempotent** — calling
 * it multiple times will not create nested patches.
 *
 * After setup:
 * - Every `fetch()` call on the page is transparently monitored
 * - Every `XMLHttpRequest` call is transparently monitored
 * - Responses matching GMGN API URL patterns are cloned, parsed as JSON,
 *   and dispatched to the content script via `window.postMessage`
 *
 * @example
 * ```ts
 * // In entrypoints/injected.ts:
 * import { setupInterceptor } from '../src/gmgn/interceptor';
 * setupInterceptor();
 * ```
 */
export function setupInterceptor(): void {
  // Idempotency guard — prevent double-patching.
  if (isInitialized) {
    console.debug(LOG_PREFIX, 'Interceptor already initialized, skipping.');
    return;
  }

  isInitialized = true;

  // Install both transport patches.
  patchFetch();
  patchXHR();

  console.debug(LOG_PREFIX, 'Interceptor initialized — monitoring fetch and XHR.');
}

/**
 * Removes the fetch and XMLHttpRequest monkey-patches, restoring the
 * original browser implementations.
 *
 * This is primarily useful for:
 * - Cleaning up during testing
 * - Disabling interception at runtime if the user toggles the extension off
 * - Preventing memory leaks during hot-module-replacement in development
 *
 * After calling `restoreInterceptor()`, `setupInterceptor()` can be
 * called again to re-enable interception.
 *
 * @example
 * ```ts
 * restoreInterceptor();
 * // fetch and XHR are now back to their original implementations
 * ```
 */
export function restoreInterceptor(): void {
  if (!isInitialized) {
    console.debug(LOG_PREFIX, 'Interceptor not initialized, nothing to restore.');
    return;
  }

  // Restore the original implementations.
  // Safety check: only restore if we actually have the originals.
  if (originalFetch) {
    window.fetch = originalFetch;
  }
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
  }
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
  }

  isInitialized = false;

  console.debug(LOG_PREFIX, 'Interceptor restored — original fetch and XHR active.');
}
