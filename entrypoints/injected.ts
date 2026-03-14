/**
 * @fileoverview Page-Context Fetch/XHR Interceptor Script.
 *
 * This WXT "unlisted" script runs inside GMGN's actual page context (NOT
 * the content script's isolated world). Its sole purpose is to monkey-patch
 * `window.fetch` and `XMLHttpRequest` to passively intercept GMGN's internal
 * API responses and relay parsed JSON payloads to the content script via
 * `window.postMessage`.
 *
 * **Architecture position** (per AAP Section 0.4.2):
 *   Injected Script (page context)
 *     → window.postMessage → Content Script (isolated world)
 *       → chrome.runtime.sendMessage → Service Worker (background)
 *
 * **Key constraints**:
 * - Runs in GMGN's JS context → shares `window`, `document`, global scope
 * - No access to `chrome.*` APIs (page context, not extension context)
 * - Must be completely transparent — GMGN's page MUST continue functioning
 *   without errors, slowdowns, or behavioral changes
 * - Cannot import from `src/` modules at runtime — all URL patterns are
 *   inlined (mirrored from `src/gmgn/url-patterns.ts`)
 * - Only INTERCEPTS existing requests — NEVER initiates new requests
 *
 * The content script (`entrypoints/content.ts`) injects this file via a
 * `<script>` tag using `browser.runtime.getURL('/injected.js')`.
 *
 * @module entrypoints/injected
 */

// `defineUnlistedScript` is auto-imported by WXT — do NOT add a manual import.
// See `.wxt/types/imports.d.ts` for the global type declaration.

export default defineUnlistedScript(() => {
  // =========================================================================
  // Constants
  // =========================================================================

  /** Message source discriminator — content script filters by this value. */
  const MESSAGE_SOURCE = 'gmgn-signal-bot' as const;

  /** Message type for all intercepted GMGN API responses. */
  const MESSAGE_TYPE = 'GMGN_API_RESPONSE' as const;

  // =========================================================================
  // GMGN API URL Pattern Registry (inlined from src/gmgn/url-patterns.ts)
  // =========================================================================
  // These patterns MUST stay in sync with `src/gmgn/url-patterns.ts`.
  // They are duplicated here because the injected script runs in the page
  // context and cannot import from bundled extension modules.
  //
  // **Ordering matters**: more specific `/api/v1/token_*` patterns precede
  // the generic `/api/v1/token/` catch-all to prevent false matches.

  /**
   * Registry entry mapping a regex to a pattern type identifier.
   * @internal
   */
  interface UrlPatternEntry {
    readonly regex: RegExp;
    readonly type: string;
  }

  const URL_PATTERNS: readonly UrlPatternEntry[] = [
    // ── Trending / Rank ─────────────────────────────────────────────
    { regex: /\/defi\/quotation\/v1\/rank\/[a-z]+\/swaps\//i, type: 'trending_tokens' },
    { regex: /\/defi\/quotation\/v1\/tokens\//i,              type: 'trending_tokens' },

    // ── Wallet activity ─────────────────────────────────────────────
    { regex: /\/api\/v1\/wallet_activity\//i, type: 'wallet_activity' },

    // ── Smart money ─────────────────────────────────────────────────
    { regex: /\/api\/v1\/smartmoney\//i, type: 'smart_money' },

    // ── Token holders ───────────────────────────────────────────────
    { regex: /\/api\/v1\/token_holders\//i, type: 'token_holders' },

    // ── Token security ──────────────────────────────────────────────
    { regex: /\/api\/v1\/token_security\//i, type: 'token_security' },

    // ── Token trade history ─────────────────────────────────────────
    { regex: /\/api\/v1\/token_trade_his\//i, type: 'token_trade_history' },

    // ── KOL activity ────────────────────────────────────────────────
    { regex: /\/api\/v1\/kol\//i, type: 'kol_activity' },

    // ── Token detail (MUST be LAST among /api/v1/token* patterns) ──
    // This is the most general pattern and would match token_holders,
    // token_security, token_trade_his if placed earlier.
    { regex: /\/api\/v1\/token\/[a-zA-Z0-9]+/i, type: 'token_detail' },
  ];

  // =========================================================================
  // URL Pattern Matching
  // =========================================================================

  /**
   * Tests a URL against all known GMGN internal API patterns.
   *
   * Called on every `fetch()` and `XMLHttpRequest` from the GMGN page context.
   * Returns the matched pattern type identifier or `null` for non-matching URLs.
   *
   * @param url - The full URL string or relative path to test.
   * @returns The matched pattern type string, or `null` if no match.
   */
  function matchesGmgnApi(url: string): string | null {
    if (!url) {
      return null;
    }
    for (let i = 0; i < URL_PATTERNS.length; i++) {
      if (URL_PATTERNS[i].regex.test(url)) {
        return URL_PATTERNS[i].type;
      }
    }
    return null;
  }

  // =========================================================================
  // Message Dispatch Helper
  // =========================================================================

  /**
   * Posts an intercepted GMGN API response to the content script via
   * `window.postMessage`. The content script filters by `source` and
   * validates `event.origin` before forwarding to the service worker.
   *
   * @param url         - Full URL of the intercepted request.
   * @param patternType - Matched pattern type from `matchesGmgnApi()`.
   * @param data        - Parsed JSON response body.
   */
  function postInterceptedData(
    url: string,
    patternType: string,
    data: unknown,
  ): void {
    try {
      window.postMessage(
        {
          source: MESSAGE_SOURCE,
          type: MESSAGE_TYPE,
          payload: {
            url,
            patternType,
            data,
            timestamp: Date.now(),
          },
        },
        '*',
      );
    } catch (_postErr) {
      // Silently ignore postMessage failures — never break the page.
    }
  }

  // =========================================================================
  // Monkey-Patch: window.fetch (Primary Interception)
  // =========================================================================

  const originalFetch: typeof window.fetch = window.fetch.bind(window);

  /**
   * Replacement `fetch` function that transparently intercepts responses
   * matching GMGN API URL patterns. The original response is always
   * returned unmodified to the caller; only a *cloned* response is read
   * for interception purposes.
   */
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Always call original fetch first — failure here is the page's own
    // network error and must propagate unmodified.
    const response: Response = await originalFetch(input, init);

    try {
      // Extract the URL string from the various calling conventions:
      // fetch('url'), fetch(new Request('url')), fetch(new URL('url'))
      let requestUrl: string;
      if (input instanceof Request) {
        requestUrl = input.url;
      } else if (input instanceof URL) {
        requestUrl = input.href;
      } else {
        requestUrl = String(input);
      }

      const patternType = matchesGmgnApi(requestUrl);
      if (patternType !== null) {
        // Clone before reading — the original body stream is still
        // consumed by GMGN's own code.
        const clonedResponse = response.clone();
        clonedResponse
          .json()
          .then((data: unknown) => {
            postInterceptedData(requestUrl, patternType, data);
          })
          .catch(() => {
            // Non-JSON response (e.g., binary, HTML error page) — skip silently.
          });
      }
    } catch (_interceptErr) {
      // Interception errors must never propagate to the caller.
    }

    // Always return the original, untouched response.
    return response;
  };

  // =========================================================================
  // Monkey-Patch: XMLHttpRequest (Fallback Interception)
  // =========================================================================

  /**
   * Extended XMLHttpRequest interface to store the captured URL on the
   * instance for later use in the `send` override.
   * @internal
   */
  interface PatchedXHR extends XMLHttpRequest {
    _gmgnUrl?: string;
  }

  const originalOpen: typeof XMLHttpRequest.prototype.open =
    XMLHttpRequest.prototype.open;
  const originalSend: typeof XMLHttpRequest.prototype.send =
    XMLHttpRequest.prototype.send;

  /**
   * Override `XMLHttpRequest.prototype.open` to capture the request URL.
   * The URL is stored on the instance as `_gmgnUrl` for inspection in the
   * `send` override.
   */
  XMLHttpRequest.prototype.open = function patchedOpen(
    this: PatchedXHR,
    method: string,
    url: string | URL,
    // The remaining parameters (async, user, password) are optional and
    // vary across overload signatures. We forward them all via `arguments`.
  ): void {
    try {
      this._gmgnUrl = url instanceof URL ? url.href : String(url);
    } catch (_e) {
      // Silently ignore — preserves original behavior.
    }
    // Forward all arguments to the original method (preserves all overloads).
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>);
  } as typeof XMLHttpRequest.prototype.open;

  /**
   * Override `XMLHttpRequest.prototype.send` to attach a `load` event
   * listener that intercepts the response body when the URL matches a
   * known GMGN API pattern.
   */
  XMLHttpRequest.prototype.send = function patchedSend(
    this: PatchedXHR,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    try {
      const capturedUrl = this._gmgnUrl;
      if (capturedUrl) {
        const patternType = matchesGmgnApi(capturedUrl);
        if (patternType !== null) {
          this.addEventListener('load', function onLoad(this: PatchedXHR) {
            try {
              // Only intercept if the response looks like valid JSON.
              if (this.responseText) {
                const data: unknown = JSON.parse(this.responseText);
                postInterceptedData(capturedUrl, patternType, data);
              }
            } catch (_parseErr) {
              // Non-JSON response or parse error — skip silently.
            }
          });
        }
      }
    } catch (_interceptErr) {
      // Interception setup errors must not propagate.
    }

    // Forward all arguments to the original method.
    // eslint-disable-next-line prefer-rest-params
    return originalSend.apply(this, arguments as unknown as Parameters<typeof originalSend>);
  } as typeof XMLHttpRequest.prototype.send;
});
