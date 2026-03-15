/**
 * @fileoverview Unit Tests for GMGN Fetch/XHR Interception Module
 *
 * Tests the core `src/gmgn/interceptor.ts` module that runs in the GMGN page
 * context and monkey-patches `window.fetch` and `XMLHttpRequest` to intercept
 * GMGN's internal API responses, relaying them via `window.postMessage`.
 *
 * Coverage areas:
 * 1. window.fetch monkey-patch preserves original behavior
 * 2. XMLHttpRequest monkey-patch preserves original behavior
 * 3. Matching URLs intercepted and posted via window.postMessage
 * 4. Non-matching URLs pass through (zero overhead)
 * 5. Message format { source: 'gmgn-signal-bot', type: 'GMGN_API_RESPONSE', payload }
 * 6. Errors don't break GMGN page (silent failure)
 * 7. Idempotent setup (double-call, restore, re-setup)
 * 8. Edge cases (empty URLs, query params, concurrent fetches, etc.)
 *
 * @module tests/unit/gmgn/interceptor.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock for url-patterns — MUST be defined before module import
// ---------------------------------------------------------------------------
vi.mock('../../../src/gmgn/url-patterns', () => ({
  matchesGmgnApi: vi.fn((url: string): string | null => {
    if (url.includes('/defi/quotation/v1/rank/')) return 'trending_tokens';
    if (url.includes('/api/v1/token_holders/')) return 'token_holders';
    if (url.includes('/api/v1/token_security/')) return 'token_security';
    if (url.includes('/api/v1/token_trade_his/')) return 'token_trade_history';
    if (url.includes('/api/v1/token/')) return 'token_detail';
    if (url.includes('/api/v1/wallet_activity/')) return 'wallet_activity';
    if (url.includes('/api/v1/smartmoney/')) return 'smart_money';
    if (url.includes('/api/v1/kol/')) return 'kol_activity';
    return null;
  }),
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER the vi.mock call
// ---------------------------------------------------------------------------
import { setupInterceptor, restoreInterceptor } from '../../../src/gmgn/interceptor';

// =============================================================================
// Shared Test State
// =============================================================================

/** Spy that replaces `window.postMessage` for assertion purposes. */
let postMessageSpy: ReturnType<typeof vi.fn>;

/**
 * Reference to the mock fetch implementation injected before each test.
 * This simulates what GMGN's page would normally have as `window.fetch`.
 */
let mockFetch: ReturnType<typeof vi.fn>;

/**
 * Reference to the original `window.fetch` captured before we inject our
 * mock. This lets us verify that `restoreInterceptor()` truly reverts the
 * patching.
 */
let preMockFetch: typeof window.fetch;

// =============================================================================
// Helper — create a JSON Response
// =============================================================================

/**
 * Creates a standard `Response` object with a JSON body.
 *
 * @param body - Any JSON-serialisable value.
 * @param status - HTTP status code (default 200).
 * @param headers - Optional extra headers.
 */
function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// =============================================================================
// Lifecycle hooks
// =============================================================================

beforeEach(() => {
  // Capture what the environment currently considers `window.fetch` so we can
  // detect whether `setupInterceptor()` actually replaces it.
  preMockFetch = window.fetch;

  // Install a controlled mock fetch that returns a predictable JSON Response.
  mockFetch = vi.fn().mockImplementation(
    async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : String(input);
      return jsonResponse({ mock: true, url });
    },
  );
  window.fetch = mockFetch as unknown as typeof window.fetch;

  // Replace window.postMessage with a spy so we can assert on interception.
  postMessageSpy = vi.fn();
  window.postMessage = postMessageSpy as unknown as typeof window.postMessage;
});

afterEach(() => {
  // Always restore interceptor patches so tests are isolated.
  restoreInterceptor();
  vi.restoreAllMocks();
});

// =============================================================================
// 1) Fetch Monkey-Patch Preserves Original Behavior
// =============================================================================

describe('setupInterceptor - fetch monkey-patch', () => {
  it('replaces window.fetch with a wrapper', () => {
    const fetchBeforeSetup = window.fetch;
    setupInterceptor();
    // After setup, window.fetch must be a different function reference.
    expect(window.fetch).not.toBe(fetchBeforeSetup);
  });

  it('calls the original fetch with all arguments', async () => {
    setupInterceptor();

    const url = 'https://example.com/data';
    const opts: RequestInit = { method: 'POST', body: 'test' };
    await window.fetch(url, opts);

    // The underlying mockFetch should have been invoked with the same args.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(url, opts);
  });

  it('returns the original Response body for non-GMGN URLs', async () => {
    const payload = { data: 'original-content' };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    const response = await window.fetch('https://example.com/non-gmgn');
    const body = await response.json();

    expect(body).toEqual(payload);
  });

  it('preserves Response status and headers', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Not Found', {
        status: 404,
        headers: { 'X-Custom-Header': 'test-value' },
      }),
    );

    setupInterceptor();
    const response = await window.fetch('https://example.com/missing');

    expect(response.status).toBe(404);
    expect(response.headers.get('X-Custom-Header')).toBe('test-value');
  });

  it('handles Request objects (not just string URLs)', async () => {
    const responsePayload = { token: 'abc123' };
    mockFetch.mockResolvedValueOnce(jsonResponse(responsePayload));

    setupInterceptor();
    const request = new Request('https://gmgn.ai/api/v1/token/abc123');
    await window.fetch(request);

    // The mockFetch should have received the Request object transparently.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const receivedInput = mockFetch.mock.calls[0][0];
    // The interceptor passes the Request through to original fetch.
    if (receivedInput instanceof Request) {
      expect(receivedInput.url).toContain('/api/v1/token/abc123');
    } else if (typeof receivedInput === 'string') {
      expect(receivedInput).toContain('/api/v1/token/abc123');
    }
  });

  it('returns the original (unconsumed) Response even when URL matches', async () => {
    const payload = { data: { rank: [{ address: 'xyz' }] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    const response = await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );

    // The caller must still be able to consume the response body.
    const body = await response.json();
    expect(body).toEqual(payload);
  });
});

// =============================================================================
// 2) XHR Monkey-Patch Preserves Original Behavior
// =============================================================================

describe('setupInterceptor - XHR monkey-patch', () => {
  let OriginalXHR: typeof XMLHttpRequest;
  let xhrOpenSpy: ReturnType<typeof vi.fn>;
  let xhrSendSpy: ReturnType<typeof vi.fn>;
  let xhrAddEventListenerSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create a lightweight mock for XMLHttpRequest with instance tracking.
    xhrOpenSpy = vi.fn();
    xhrSendSpy = vi.fn();
    xhrAddEventListenerSpy = vi.fn();

    // Save the real XHR so we can detect patching.
    OriginalXHR = globalThis.XMLHttpRequest;

    // Build a mock XHR constructor and prototype.
    function MockXHRConstructor(this: Record<string, unknown>) {
      this.readyState = 0;
      this.status = 0;
      this.responseText = '';
      this.responseType = '';
      this.response = null;
    }

    MockXHRConstructor.prototype.open = xhrOpenSpy;
    MockXHRConstructor.prototype.send = xhrSendSpy;
    MockXHRConstructor.prototype.addEventListener = xhrAddEventListenerSpy;
    MockXHRConstructor.prototype.setRequestHeader = vi.fn();
    MockXHRConstructor.DONE = 4;

    // Install the mock globally.
    (globalThis as Record<string, unknown>).XMLHttpRequest =
      MockXHRConstructor as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    // Restore real XHR after each test in this block.
    globalThis.XMLHttpRequest = OriginalXHR;
  });

  it('patches XMLHttpRequest.prototype.open and send', () => {
    const openBefore = XMLHttpRequest.prototype.open;
    const sendBefore = XMLHttpRequest.prototype.send;

    setupInterceptor();

    expect(XMLHttpRequest.prototype.open).not.toBe(openBefore);
    expect(XMLHttpRequest.prototype.send).not.toBe(sendBefore);
  });

  it('XHR open() and send() still invoke original implementations', () => {
    setupInterceptor();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://example.com/data');
    xhr.send();

    // The original open and send spies should have been called.
    expect(xhrOpenSpy).toHaveBeenCalledTimes(1);
    expect(xhrSendSpy).toHaveBeenCalledTimes(1);
  });

  it('XHR responses from non-GMGN URLs are not intercepted', () => {
    setupInterceptor();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.birdeye.so/defi/price');
    xhr.send();

    // No event listener should be attached for non-matching URLs.
    // And postMessage should never be called.
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('XHR to matching GMGN URL attaches a load listener', () => {
    setupInterceptor();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://gmgn.ai/api/v1/token/abc123');
    xhr.send();

    // The patched send() should attach a 'load' event listener.
    expect(xhrAddEventListenerSpy).toHaveBeenCalledWith(
      'load',
      expect.any(Function),
    );
  });

  it('XHR load listener dispatches intercepted data on success', () => {
    setupInterceptor();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://gmgn.ai/api/v1/token/abc123');
    xhr.send();

    // Retrieve the load listener that was attached.
    const loadCall = xhrAddEventListenerSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'load',
    );
    expect(loadCall).toBeDefined();
    const loadHandler = loadCall![1] as () => void;

    // Simulate a successful response.
    const xhrInstance = xhr as unknown as Record<string, unknown>;
    xhrInstance.readyState = 4;
    xhrInstance.status = 200;
    xhrInstance.responseType = '';
    xhrInstance.responseText = JSON.stringify({ data: { symbol: 'TEST' } });

    // Fire the load handler.
    loadHandler.call(xhr);

    // Verify postMessage was called with correct structure.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const message = postMessageSpy.mock.calls[0][0];
    expect(message.source).toBe('gmgn-signal-bot');
    expect(message.type).toBe('GMGN_API_RESPONSE');
    expect(message.payload.patternType).toBe('token_detail');
    expect(message.payload.data).toEqual({ data: { symbol: 'TEST' } });
  });

  it('XHR load listener handles responseType "json" correctly', () => {
    setupInterceptor();

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://gmgn.ai/api/v1/token/def456');
    xhr.send();

    const loadCall = xhrAddEventListenerSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'load',
    );
    const loadHandler = loadCall![1] as () => void;

    const xhrInstance = xhr as unknown as Record<string, unknown>;
    xhrInstance.readyState = 4;
    xhrInstance.status = 200;
    xhrInstance.responseType = 'json';
    xhrInstance.response = { data: { preparse: true } };

    loadHandler.call(xhr);

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][0].payload.data).toEqual({
      data: { preparse: true },
    });
  });
});

// =============================================================================
// 3) Matching URL Interception and PostMessage
// =============================================================================

describe('URL matching and interception', () => {
  it('GMGN trending tokens URL triggers interception', async () => {
    const payload = { data: { rank: [{ address: 'abc', symbol: 'TEST' }] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.patternType).toBe('trending_tokens');
  });

  it('GMGN token detail URL triggers interception', async () => {
    const payload = { data: { symbol: 'SOL', price: 120 } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/api/v1/token/So11111111111111111111111111111111111111112',
    );

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.patternType).toBe('token_detail');
  });

  it('GMGN wallet activity URL triggers interception', async () => {
    const payload = { data: { activities: [] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/api/v1/wallet_activity/some-wallet-address',
    );

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.patternType).toBe('wallet_activity');
  });

  it('GMGN smart money URL triggers interception', async () => {
    const payload = { data: { wallets: [] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    await window.fetch('https://gmgn.ai/api/v1/smartmoney/some-address');

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.patternType).toBe('smart_money');
  });

  it('GMGN token holders URL triggers interception', async () => {
    const payload = { data: { holders: [] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/api/v1/token_holders/some-token-mint',
    );

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.patternType).toBe('token_holders');
  });

  it('intercepted response data matches the parsed JSON from cloned response', async () => {
    const payload = { data: { rank: [{ address: 'test123', volume: 5000 }] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m',
    );

    expect(postMessageSpy).toHaveBeenCalled();
    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.data).toEqual(payload);
    expect(msg.payload.url).toBe(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/5m',
    );
  });

  it('intercepted message includes a timestamp', async () => {
    const payload = { data: {} };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload));

    setupInterceptor();
    const before = Date.now();
    await window.fetch('https://gmgn.ai/api/v1/token/xyz');
    const after = Date.now();

    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.payload.timestamp).toBeLessThanOrEqual(after);
  });
});

// =============================================================================
// 4) Non-Matching URLs Pass Through
// =============================================================================

describe('non-matching URL passthrough', () => {
  it('non-GMGN URL is NOT intercepted', async () => {
    setupInterceptor();
    const response = await window.fetch('https://api.birdeye.so/defi/price');
    const body = await response.json();

    expect(postMessageSpy).not.toHaveBeenCalled();
    // The response should still be valid.
    expect(body).toHaveProperty('mock', true);
  });

  it('multiple random external URLs pass through without interception', async () => {
    setupInterceptor();

    const urls = [
      'https://api.example.com/data',
      'https://google.com',
      'https://api.rugcheck.xyz/tokens/abc/report',
      'https://price.jup.ag/price/v3/',
      'https://api.dexscreener.com/dex/tokens/abc',
    ];

    for (const url of urls) {
      await window.fetch(url);
    }

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('relative URL that does not match GMGN patterns passes through', async () => {
    setupInterceptor();
    await window.fetch('/some/random/endpoint');

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('URL with /api/v1/ but not a known GMGN sub-path passes through', async () => {
    setupInterceptor();
    await window.fetch('https://some-other-api.com/api/v1/unrelated');

    // Our mock matchesGmgnApi only matches specific known sub-paths.
    // '/api/v1/unrelated' doesn't contain any of the known patterns.
    expect(postMessageSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 5) PostMessage Format Validation
// =============================================================================

describe('postMessage format', () => {
  it('message has source: "gmgn-signal-bot"', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );

    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.source).toBe('gmgn-signal-bot');
  });

  it('message has type: "GMGN_API_RESPONSE"', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );

    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.type).toBe('GMGN_API_RESPONSE');
  });

  it('message payload has url, data, patternType, and timestamp', async () => {
    const responseData = { data: { rank: [] } };
    mockFetch.mockResolvedValueOnce(jsonResponse(responseData));
    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );

    const msg = postMessageSpy.mock.calls[0][0];
    expect(msg.payload).toEqual(
      expect.objectContaining({
        url: expect.any(String),
        data: expect.any(Object),
        patternType: expect.any(String),
        timestamp: expect.any(Number),
      }),
    );
    expect(msg.payload.url).toBe(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );
    expect(msg.payload.data).toEqual(responseData);
    expect(msg.payload.patternType).toBe('trending_tokens');
  });

  it('complete message structure matches discriminated union format', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { symbol: 'BONK' } }),
    );
    setupInterceptor();
    await window.fetch('https://gmgn.ai/api/v1/token/bonk123');

    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'gmgn-signal-bot',
        type: 'GMGN_API_RESPONSE',
        payload: expect.objectContaining({
          url: expect.any(String),
          data: expect.any(Object),
          patternType: expect.any(String),
          timestamp: expect.any(Number),
        }),
      }),
      expect.anything(),
    );
  });

  it('postMessage is called with origin as second argument', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }));
    setupInterceptor();
    await window.fetch('https://gmgn.ai/api/v1/token/test');

    // The second argument to postMessage should be the window origin.
    const secondArg = postMessageSpy.mock.calls[0][1];
    expect(typeof secondArg).toBe('string');
  });
});

// =============================================================================
// 6) Error Handling — Silent Failure (Errors Don't Break GMGN Page)
// =============================================================================

describe('error handling - silent failure', () => {
  it('non-JSON response from GMGN URL does not crash', async () => {
    // Return a Response with plain text body that will fail JSON parsing.
    mockFetch.mockResolvedValueOnce(
      new Response('this is not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    setupInterceptor();

    // Must not throw — the interceptor swallows parse errors.
    const response = await window.fetch(
      'https://gmgn.ai/api/v1/token/abc',
    );

    // The original response is still returned to the caller.
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('this is not json');
  });

  it('network error during fetch propagates to caller normally', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network error'));

    setupInterceptor();

    await expect(
      window.fetch('https://gmgn.ai/api/v1/token/abc'),
    ).rejects.toThrow('Network error');

    // postMessage should NOT have been called since fetch itself failed.
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('Response.clone() failure is handled gracefully', async () => {
    // Create a Response whose .clone() throws.
    const badResponse = jsonResponse({ data: {} });
    const origClone = badResponse.clone.bind(badResponse);
    badResponse.clone = () => {
      throw new Error('clone failed');
    };
    mockFetch.mockResolvedValueOnce(badResponse);

    setupInterceptor();
    const response = await window.fetch(
      'https://gmgn.ai/api/v1/token/abc',
    );

    // The interceptor should catch the clone error and still return
    // the original response.
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
  });

  it('postMessage error does not crash fetch', async () => {
    postMessageSpy.mockImplementation(() => {
      throw new Error('postMessage exploded');
    });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { token: 'test' } }),
    );

    setupInterceptor();

    // Must not throw — the dispatch error is silently caught.
    const response = await window.fetch(
      'https://gmgn.ai/api/v1/token/abc',
    );
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
  });

  it('handles 204 No Content response body without crashing', async () => {
    // 204 typically has no body.
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    setupInterceptor();

    const response = await window.fetch(
      'https://gmgn.ai/api/v1/token/abc',
    );

    // The interceptor will try to clone and parse JSON — it should fail
    // silently and still return the original response.
    expect(response).toBeDefined();
    expect(response.status).toBe(204);
  });

  it('handles response with empty string body without crashing', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', { status: 200 }),
    );

    setupInterceptor();

    const response = await window.fetch(
      'https://gmgn.ai/api/v1/token/abc',
    );

    expect(response).toBeDefined();
    expect(response.status).toBe(200);
  });
});

// =============================================================================
// 7) Idempotent Setup
// =============================================================================

describe('idempotent setup', () => {
  it('calling setupInterceptor() twice does not double-patch', async () => {
    const payload = { data: { token: 'single' } };
    mockFetch.mockResolvedValue(jsonResponse(payload));

    setupInterceptor();
    setupInterceptor(); // second call should be a no-op

    await window.fetch('https://gmgn.ai/api/v1/token/abc');

    // postMessage must be called exactly ONCE (no double interception).
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('restoreInterceptor() reverses the patches', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: {} }));

    setupInterceptor();
    restoreInterceptor();

    await window.fetch('https://gmgn.ai/api/v1/token/abc');

    // After restore, interception should be off — no postMessage call.
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('after restoreInterceptor(), setupInterceptor() can be called again', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ data: { round: 'two' } }),
    );

    // First cycle: setup → restore.
    setupInterceptor();
    restoreInterceptor();

    // Second cycle: re-setup should work.
    setupInterceptor();
    await window.fetch('https://gmgn.ai/api/v1/token/xyz');

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'token_detail',
    );
  });

  it('restoreInterceptor() is safe to call when not initialised', () => {
    // Should not throw even when there are no patches to reverse.
    expect(() => restoreInterceptor()).not.toThrow();
  });

  it('setupInterceptor() → restoreInterceptor() → restoreInterceptor() is safe', () => {
    setupInterceptor();
    restoreInterceptor();
    // Calling restore again should be a no-op, not an error.
    expect(() => restoreInterceptor()).not.toThrow();
  });
});

// =============================================================================
// 8) Edge Cases
// =============================================================================

describe('edge cases', () => {
  it('empty string URL passes through without interception', async () => {
    setupInterceptor();
    await window.fetch('');

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('URL with query parameters is still matched', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { filtered: true } }),
    );

    setupInterceptor();
    await window.fetch(
      'https://gmgn.ai/api/v1/token/abc?chain=sol&limit=20',
    );

    expect(postMessageSpy).toHaveBeenCalled();
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'token_detail',
    );
  });

  it('relative GMGN URL paths are matched', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { relative: true } }),
    );

    setupInterceptor();
    await window.fetch('/api/v1/token/abc123');

    expect(postMessageSpy).toHaveBeenCalled();
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'token_detail',
    );
  });

  it('multiple concurrent fetch calls are all handled correctly', async () => {
    mockFetch.mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
        return jsonResponse({ mock: true, url });
      },
    );

    setupInterceptor();

    // Fire 3 fetches concurrently: 1 GMGN, 2 external.
    const [r1, r2, r3] = await Promise.all([
      window.fetch('https://gmgn.ai/api/v1/token/concurrent'),
      window.fetch('https://api.birdeye.so/defi/price'),
      window.fetch('https://google.com'),
    ]);

    // All three responses should be valid.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    // Only the GMGN URL should have triggered postMessage.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'token_detail',
    );
  });

  it('URL object input is handled correctly', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { urlObj: true } }),
    );

    setupInterceptor();
    const url = new URL('https://gmgn.ai/api/v1/token/urlobj');
    await window.fetch(url);

    expect(postMessageSpy).toHaveBeenCalled();
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'token_detail',
    );
  });

  it('multiple GMGN fetches each produce separate postMessage calls', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: {} }));

    setupInterceptor();

    await window.fetch(
      'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h',
    );
    await window.fetch('https://gmgn.ai/api/v1/token/abc');
    await window.fetch(
      'https://gmgn.ai/api/v1/wallet_activity/wallet123',
    );

    expect(postMessageSpy).toHaveBeenCalledTimes(3);
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'trending_tokens',
    );
    expect(postMessageSpy.mock.calls[1][0].payload.patternType).toBe(
      'token_detail',
    );
    expect(postMessageSpy.mock.calls[2][0].payload.patternType).toBe(
      'wallet_activity',
    );
  });

  it('fetch with POST method on GMGN URL still intercepts the response', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { posted: true } }),
    );

    setupInterceptor();
    await window.fetch('https://gmgn.ai/api/v1/token/abc', {
      method: 'POST',
      body: JSON.stringify({ query: 'test' }),
    });

    expect(postMessageSpy).toHaveBeenCalled();
    expect(postMessageSpy.mock.calls[0][0].payload.patternType).toBe(
      'token_detail',
    );
  });
});
