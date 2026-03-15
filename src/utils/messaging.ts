/**
 * src/utils/messaging.ts — Type-Safe Chrome Runtime Messaging Helpers
 *
 * Central message bus layer for the GMGN Signal Bot Chrome Extension.
 * Provides discriminated union message types and type-safe wrappers for
 * Chrome Extension inter-context communication:
 *
 * - Injected Script → Content Script: window.postMessage with origin validation
 * - Content Script → Service Worker: chrome.runtime.sendMessage with sender validation
 * - Service Worker → Content Script: chrome.tabs.sendMessage with error handling
 *
 * SECURITY (AAP Section 0.7.2):
 * - All chrome.runtime.onMessage handlers validate sender.id === chrome.runtime.id
 * - All window.postMessage handlers validate event.origin === 'https://gmgn.ai'
 * - All window.postMessage handlers validate data.source === MESSAGE_SOURCE
 *
 * Cross-Context Compatibility:
 * - sendToBackground / onWindowMessage: used in content scripts
 * - sendToContent / onMessage: used in service worker
 * - postWindowMessage: used in injected page-context script
 *
 * No external dependencies — uses only Chrome Extension APIs (chrome.runtime, chrome.tabs).
 *
 * @module messaging
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Unique identifier for messages originating from the GMGN Signal Bot extension.
 * Used as the `source` field in WindowMessage to distinguish extension messages
 * from other window.postMessage traffic on the GMGN page.
 */
export const MESSAGE_SOURCE = 'gmgn-signal-bot' as const;

/**
 * Expected origin for window.postMessage events from the GMGN page.
 * Used for origin validation in onWindowMessage to ensure messages
 * come from the legitimate GMGN.ai domain.
 */
const GMGN_ORIGIN = 'https://gmgn.ai' as const;

// =============================================================================
// Message Interfaces — Discriminated Union Members
// =============================================================================

/**
 * GMGN API Response Message (Injected → Content → Background)
 *
 * Carries intercepted GMGN internal API response data captured by the
 * fetch/XHR monkey-patch in the injected page-context script.
 */
export interface GmgnApiResponseMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'GMGN_API_RESPONSE';
  /** Intercepted GMGN API response data */
  readonly payload: {
    /** The intercepted GMGN API URL */
    url: string;
    /** The parsed JSON response body */
    data: unknown;
    /** The matched URL pattern type from url-patterns.ts */
    patternType: string;
  };
}

/**
 * Token Data Message (Background → Content/UI)
 *
 * Carries enriched token data from the service worker to the UI layer,
 * including data from Birdeye, DexScreener, and other enrichment sources.
 */
export interface TokenDataMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'TOKEN_DATA';
  /** Token data payload */
  readonly payload: {
    /** Solana token mint address */
    mint: string;
    /** Enriched token data object */
    data: unknown;
  };
}

/**
 * Signal Update Message (Background → Content/UI)
 *
 * Carries composite signal scoring results from the scoring engine
 * to the UI layer for display in the signal panel.
 */
export interface SignalUpdateMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'SIGNAL_UPDATE';
  /** Signal scoring result payload */
  readonly payload: {
    /** Solana token mint address */
    mint: string;
    /** Composite signal result with score, factors, and decision */
    signal: unknown;
  };
}

/**
 * Safety Check Request Message (Content/UI → Background)
 *
 * Requests a safety analysis for a specific token, triggering concurrent
 * RugCheck + GoPlus + Jupiter honeypot checks in the service worker.
 */
export interface SafetyCheckRequestMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'SAFETY_CHECK_REQUEST';
  /** Safety check request payload */
  readonly payload: {
    /** Solana token mint address to analyze */
    mint: string;
  };
}

/**
 * Safety Check Result Message (Background → Content/UI)
 *
 * Returns aggregated safety analysis results from multi-source checks
 * (RugCheck, GoPlus, Jupiter honeypot simulation).
 */
export interface SafetyCheckResultMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'SAFETY_CHECK_RESULT';
  /** Safety check result payload */
  readonly payload: {
    /** Solana token mint address */
    mint: string;
    /** Aggregated safety report */
    report: unknown;
  };
}

/**
 * Settings Change Message (UI → Background)
 *
 * Notifies the service worker when user settings change, such as
 * trading mode toggle, scoring weight adjustments, or API key updates.
 */
export interface SettingsChangeMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'SETTINGS_CHANGE';
  /** Settings change payload */
  readonly payload: {
    /** Settings key that changed (e.g., 'tradingMode', 'scoringWeights') */
    key: string;
    /** New value for the setting */
    value: unknown;
  };
}

/**
 * AI Analysis Request Message (Background internal / Content → Background)
 *
 * Requests three-tier AI/LLM analysis for a token that passed initial
 * scoring thresholds and hard filters.
 */
export interface AIAnalysisRequestMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'AI_ANALYSIS_REQUEST';
  /** AI analysis request payload */
  readonly payload: {
    /** Solana token mint address */
    mint: string;
    /** Current composite score (determines LLM tier routing) */
    score: number;
  };
}

/**
 * AI Analysis Result Message (Background → Content/UI)
 *
 * Returns AI/LLM analysis results including dimension scores,
 * confidence level, and narrative summary from the three-tier router.
 */
export interface AIAnalysisResultMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'AI_ANALYSIS_RESULT';
  /** AI analysis result payload */
  readonly payload: {
    /** Solana token mint address */
    mint: string;
    /** Complete AI analysis result with dimensions and narrative */
    result: unknown;
  };
}

/**
 * Stream Event Message (Background → Content)
 *
 * Carries real-time WebSocket stream events from PumpPortal (new tokens,
 * trades, migrations) and Birdeye (price updates, large trades).
 */
export interface StreamEventMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'STREAM_EVENT';
  /** Stream event payload */
  readonly payload: {
    /** Stream source identifier (e.g., 'pump-portal', 'birdeye') */
    source: string;
    /** The stream event data */
    event: unknown;
  };
}

/**
 * Log Forward Message (Content → Background)
 *
 * Forwards structured log entries from the content script to the service
 * worker for aggregated logging and debugging.
 */
export interface LogForwardMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'LOG_FORWARD';
  /** Log entry payload */
  readonly payload: {
    /** Log level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' */
    level: string;
    /** Context tag identifying the log source (e.g., '[signal-engine]') */
    context: string;
    /** Human-readable log message */
    message: string;
    /** Optional additional data attached to the log entry */
    data?: unknown[];
  };
}

/**
 * Exit Signal Message (Background → Content/UI)
 *
 * Notifies the UI layer when an exit trigger fires for a tracked position,
 * including TP ladder hits, SL triggers, dev wallet sells, and smart money exits.
 */
export interface ExitSignalMessage {
  /** Discriminant field for type narrowing */
  readonly type: 'EXIT_SIGNAL';
  /** Exit signal payload */
  readonly payload: {
    /** Solana token mint address of the tracked position */
    mint: string;
    /** Exit trigger details (type, reason, price context) */
    trigger: unknown;
  };
}

// =============================================================================
// Discriminated Union Type
// =============================================================================

/**
 * Union of all Chrome runtime extension messages.
 *
 * This discriminated union uses the `type` field as the discriminant,
 * enabling exhaustive type narrowing in switch/case handlers:
 *
 * @example
 * ```typescript
 * onMessage((message, sender, sendResponse) => {
 *   switch (message.type) {
 *     case 'SIGNAL_UPDATE':
 *       // message.payload is { mint: string; signal: unknown }
 *       break;
 *     case 'TOKEN_DATA':
 *       // message.payload is { mint: string; data: unknown }
 *       break;
 *   }
 * });
 * ```
 */
export type ExtensionMessage =
  | GmgnApiResponseMessage
  | TokenDataMessage
  | SignalUpdateMessage
  | SafetyCheckRequestMessage
  | SafetyCheckResultMessage
  | SettingsChangeMessage
  | AIAnalysisRequestMessage
  | AIAnalysisResultMessage
  | StreamEventMessage
  | LogForwardMessage
  | ExitSignalMessage;

// =============================================================================
// Window PostMessage Types (Injected ↔ Content)
// =============================================================================

/**
 * Message format for window.postMessage communication between the
 * injected page-context script and the content script.
 *
 * The `source` field is always set to MESSAGE_SOURCE ('gmgn-signal-bot')
 * to distinguish extension messages from other window message traffic
 * on the GMGN page.
 *
 * @example
 * ```typescript
 * // Injected script posts:
 * postWindowMessage({ type: 'GMGN_API_RESPONSE', payload: { ... } });
 *
 * // Content script receives:
 * onWindowMessage((data) => {
 *   // data.source === 'gmgn-signal-bot'
 *   // data.type === 'GMGN_API_RESPONSE'
 *   // data.payload contains intercepted API response
 * });
 * ```
 */
export interface WindowMessage {
  /** Source identifier — always 'gmgn-signal-bot' */
  readonly source: typeof MESSAGE_SOURCE;
  /** Message type identifier */
  readonly type: string;
  /** Message payload data */
  readonly payload: unknown;
}

// =============================================================================
// Handler Types
// =============================================================================

/**
 * Type-safe handler for Chrome runtime extension messages.
 *
 * Receives validated messages that have passed sender.id verification.
 * Return `true` to keep the message channel open for asynchronous responses
 * via `sendResponse()`.
 *
 * @param message - The typed extension message (discriminated by `type` field)
 * @param sender - Chrome runtime message sender metadata (tab, origin, etc.)
 * @param sendResponse - Callback to send an asynchronous response back to the sender
 * @returns `true` to keep channel open for async response, `void`/`false` otherwise
 */
export type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

/**
 * Handler for validated window.postMessage events from the injected script.
 *
 * Only receives messages that have passed both origin validation
 * (event.origin === 'https://gmgn.ai') and source validation
 * (data.source === MESSAGE_SOURCE).
 *
 * @param data - The validated WindowMessage containing type and payload
 */
export type WindowMessageHandler = (data: WindowMessage) => void;

// =============================================================================
// Chrome Runtime Messaging Functions
// =============================================================================

/**
 * Sends a typed message from the content script to the service worker (background).
 *
 * Wraps `chrome.runtime.sendMessage` with type safety and error handling for
 * common Chrome Extension failure modes:
 * - Service worker terminated (Extension context invalidated)
 * - Extension disabled or unloaded
 * - Runtime not available (called from non-extension context)
 *
 * @param message - The extension message to send to the service worker
 * @returns Promise resolving to the service worker's response, or null on failure
 *
 * @example
 * ```typescript
 * await sendToBackground({
 *   type: 'TOKEN_DATA',
 *   payload: { mint: 'So11111111111111111111111111111111111111112', data: tokenData }
 * });
 * ```
 */
export async function sendToBackground(message: ExtensionMessage): Promise<unknown> {
  try {
    // Guard: chrome.runtime may not be available in all contexts
    // (e.g., after extension reload or in non-extension pages)
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return null;
    }

    const response = await chrome.runtime.sendMessage(message);
    return response;
  } catch (error: unknown) {
    // Handle common Chrome Extension runtime errors gracefully
    const errorMessage = error instanceof Error ? error.message : String(error);

    // "Extension context invalidated" — service worker terminated or extension reloaded
    if (errorMessage.includes('Extension context invalidated')) {
      return null;
    }

    // "Could not establish connection" — no listener registered in background
    if (errorMessage.includes('Could not establish connection')) {
      return null;
    }

    // "The message port closed before a response was received" — handler didn't sendResponse
    if (errorMessage.includes('message port closed')) {
      return null;
    }

    // Re-throw unexpected errors with additional context for debugging
    throw new Error(
      `[messaging] sendToBackground failed for message type "${message.type}": ${errorMessage}`
    );
  }
}

/**
 * Sends a typed message from the service worker to a specific content script tab.
 *
 * Wraps `chrome.tabs.sendMessage` with type safety and error handling for
 * common failure modes:
 * - Tab no longer exists (user closed it)
 * - Content script not loaded yet (race condition on page navigation)
 * - Tab ID is invalid
 *
 * @param tabId - The Chrome tab ID to send the message to
 * @param message - The extension message to send to the content script
 * @returns Promise resolving to the content script's response, or null on failure
 *
 * @example
 * ```typescript
 * await sendToContent(tab.id, {
 *   type: 'SIGNAL_UPDATE',
 *   payload: { mint: '...', signal: compositeResult }
 * });
 * ```
 */
export async function sendToContent(
  tabId: number,
  message: ExtensionMessage
): Promise<unknown> {
  try {
    // Guard: chrome.tabs may not be available in content script context
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) {
      return null;
    }

    // Validate tab ID is a positive integer
    if (!Number.isFinite(tabId) || tabId < 0) {
      return null;
    }

    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // "No tab with id" — tab was closed before message delivery
    if (errorMessage.includes('No tab with id')) {
      return null;
    }

    // "Could not establish connection" — content script not loaded in the tab
    if (errorMessage.includes('Could not establish connection')) {
      return null;
    }

    // "The message port closed before a response was received"
    if (errorMessage.includes('message port closed')) {
      return null;
    }

    // "Receiving end does not exist" — content script was unloaded
    if (errorMessage.includes('Receiving end does not exist')) {
      return null;
    }

    // Re-throw unexpected errors with context
    throw new Error(
      `[messaging] sendToContent failed for tab ${tabId}, message type "${message.type}": ${errorMessage}`
    );
  }
}

/**
 * Registers a type-safe Chrome runtime message listener with mandatory
 * sender validation.
 *
 * SECURITY (AAP Section 0.7.2): Every registered listener validates
 * `sender.id === chrome.runtime.id` BEFORE forwarding to the handler.
 * Messages from external extensions or web pages are silently discarded.
 *
 * The handler's return value controls async response behavior:
 * - Return `true` to keep the message channel open for async `sendResponse()` calls
 * - Return `void`/`false` for synchronous handling (channel closes immediately)
 *
 * @param handler - The message handler function receiving validated messages
 *
 * @example
 * ```typescript
 * // In background.ts (service worker):
 * onMessage((message, sender, sendResponse) => {
 *   switch (message.type) {
 *     case 'GMGN_API_RESPONSE':
 *       processGmgnData(message.payload);
 *       break;
 *     case 'SAFETY_CHECK_REQUEST':
 *       runSafetyCheck(message.payload.mint).then(sendResponse);
 *       return true; // Keep channel open for async response
 *   }
 * });
 * ```
 */
export function onMessage(handler: MessageHandler): void {
  // Guard: chrome.runtime may not be available in page-context scripts
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    return;
  }

  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ): boolean | void => {
      // CRITICAL SECURITY: Validate sender is from our own extension.
      // Messages from external extensions, web pages, or other sources
      // are silently discarded without processing.
      if (!sender.id || sender.id !== chrome.runtime.id) {
        return;
      }

      // Validate message has the expected discriminated union structure
      if (!isValidExtensionMessage(message)) {
        return;
      }

      // Forward validated message to the handler
      return handler(message, sender, sendResponse);
    }
  );
}

// =============================================================================
// Window PostMessage Functions
// =============================================================================

/**
 * Registers a listener for window.postMessage events from the injected
 * page-context script, with mandatory origin and source validation.
 *
 * SECURITY (AAP Section 0.7.2):
 * - Validates `event.origin === 'https://gmgn.ai'` to prevent cross-origin spoofing
 * - Validates `event.data.source === MESSAGE_SOURCE` to filter unrelated messages
 *
 * Only messages passing both security checks are forwarded to the handler.
 *
 * @param handler - Callback receiving validated WindowMessage objects
 *
 * @example
 * ```typescript
 * // In content.ts:
 * onWindowMessage((data) => {
 *   if (data.type === 'GMGN_API_RESPONSE') {
 *     sendToBackground({
 *       type: 'GMGN_API_RESPONSE',
 *       payload: data.payload as GmgnApiResponseMessage['payload']
 *     });
 *   }
 * });
 * ```
 */
export function onWindowMessage(handler: WindowMessageHandler): void {
  // Guard: window may not be available in service worker context
  if (typeof window === 'undefined' || !window.addEventListener) {
    return;
  }

  window.addEventListener('message', (event: MessageEvent): void => {
    // CRITICAL SECURITY: Validate the message origin is the GMGN page.
    // This prevents malicious pages or iframes from injecting fake messages.
    if (event.origin !== GMGN_ORIGIN) {
      return;
    }

    // Validate message data exists and has the expected structure
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }

    // Validate the message source field matches our extension identifier.
    // This filters out unrelated window.postMessage traffic on the GMGN page
    // (e.g., from GMGN's own code, analytics scripts, or other extensions).
    if ((data as WindowMessage).source !== MESSAGE_SOURCE) {
      return;
    }

    // Validate required fields are present
    if (typeof (data as WindowMessage).type !== 'string') {
      return;
    }

    handler(data as WindowMessage);
  });
}

/**
 * Posts a message from the injected page-context script to the content script
 * via window.postMessage.
 *
 * Automatically prepends the `source: MESSAGE_SOURCE` ('gmgn-signal-bot')
 * field to identify the message as originating from this extension.
 * The content script's onWindowMessage handler validates this source field.
 *
 * Uses `'*'` as the target origin because the injected script runs in the
 * page context and posts to the same window — origin restriction is enforced
 * on the receiving side via onWindowMessage's origin validation.
 *
 * @param message - Message object with `type` and `payload` (source is auto-added)
 *
 * @example
 * ```typescript
 * // In injected.ts (page context):
 * postWindowMessage({
 *   type: 'GMGN_API_RESPONSE',
 *   payload: { url: interceptedUrl, data: responseData, patternType: 'trending' }
 * });
 * ```
 */
export function postWindowMessage(
  message: Omit<WindowMessage, 'source'>
): void {
  // Guard: window.postMessage may not be available in service worker context
  if (typeof window === 'undefined' || !window.postMessage) {
    return;
  }

  const fullMessage: WindowMessage = {
    ...message,
    source: MESSAGE_SOURCE,
  };

  window.postMessage(fullMessage, '*');
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Set of all valid ExtensionMessage type discriminants.
 * Used for runtime validation of incoming messages before casting
 * to the ExtensionMessage union type.
 */
const VALID_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'GMGN_API_RESPONSE',
  'TOKEN_DATA',
  'SIGNAL_UPDATE',
  'SAFETY_CHECK_REQUEST',
  'SAFETY_CHECK_RESULT',
  'SETTINGS_CHANGE',
  'AI_ANALYSIS_REQUEST',
  'AI_ANALYSIS_RESULT',
  'STREAM_EVENT',
  'LOG_FORWARD',
  'EXIT_SIGNAL',
]);

/**
 * Runtime type guard that validates an unknown message conforms to the
 * ExtensionMessage discriminated union structure.
 *
 * Checks:
 * 1. Message is a non-null object
 * 2. Has a `type` field that is a string
 * 3. The `type` value is one of the known message types
 * 4. Has a `payload` field (can be any type)
 *
 * @param message - Unknown value to validate
 * @returns True if the message has valid ExtensionMessage structure
 */
function isValidExtensionMessage(message: unknown): message is ExtensionMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const msg = message as Record<string, unknown>;

  // Validate discriminant field
  if (typeof msg.type !== 'string') {
    return false;
  }

  // Validate the type is a known message type
  if (!VALID_MESSAGE_TYPES.has(msg.type)) {
    return false;
  }

  // Validate payload field exists
  if (!('payload' in msg)) {
    return false;
  }

  return true;
}
