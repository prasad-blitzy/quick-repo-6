/**
 * src/streaming/manager.ts — WebSocket Lifecycle Manager
 *
 * Foundational WebSocket infrastructure for the GMGN Signal Bot Chrome Extension.
 * Manages WebSocket creation, 20-second keepalive pings, automatic reconnection
 * with exponential backoff (1s→2s→4s→8s→16s, max 5 retries), and Chrome 116+
 * service worker idle timer reset.
 *
 * Consumers:
 * - src/streaming/pump-portal-stream.ts — PumpPortal WebSocket client
 * - src/streaming/birdeye-stream.ts — Birdeye WebSocket client
 * - src/api/pump-portal.ts — PumpPortal API client
 * - entrypoints/background.ts — Service worker orchestration
 *
 * Chrome 116+ Behavior:
 * - WebSocket send/receive activity resets the 30-second service worker idle timer
 * - The 20-second keepalive ping ensures the worker never reaches the idle timeout
 * - `setInterval` provides keepalive while the worker is active;
 *   `chrome.alarms` (managed by background.ts) serves as a safety net
 *
 * Per AAP Section 0.7.6 (WebSocket Connection Rules):
 * - 20-second keepalive ping interval
 * - Exponential backoff reconnection: 1s→2s→4s→8s→16s
 * - Maximum 5 retry attempts before falling back to chrome.alarms polling
 * - Graceful degradation: remain functional without WebSocket streaming
 * - Single connection enforcement per PumpPortal guidelines
 *
 * @module streaming/manager
 */

import type { ConnectionState } from './types';
import { TIMING } from '../utils/config';
import { createLogger } from '../utils/logger';

// =============================================================================
// Configuration Interface
// =============================================================================

/**
 * Configuration options for creating a WebSocketManager instance.
 *
 * Only `url` is required — all other fields have sensible defaults derived
 * from the AAP timing constants (20s keepalive, 5 max retries, 1s base backoff).
 *
 * @example
 * ```typescript
 * const config: WebSocketManagerConfig = {
 *   url: 'wss://pumpportal.fun/api/data',
 *   onMessage: (data) => console.log('Received:', data),
 *   onReconnectFailed: () => switchToPollingMode(),
 *   loggerContext: 'pump-portal',
 * };
 * ```
 */
export interface WebSocketManagerConfig {
  /** WebSocket URL to connect to (e.g., 'wss://pumpportal.fun/api/data') */
  url: string;

  /**
   * Keepalive ping interval in milliseconds.
   * Default: 20000 (20 seconds) per AAP Section 0.7.6.
   * Prevents Chrome 116+ service worker idle termination and detects dead connections.
   */
  keepaliveIntervalMs?: number;

  /**
   * Maximum number of reconnection retry attempts before giving up.
   * Default: 5 per AAP Section 0.7.6.
   * After exhausting retries, `onReconnectFailed` is invoked and the background
   * script should fall back to chrome.alarms-based polling.
   */
  maxReconnectRetries?: number;

  /**
   * Base delay in milliseconds for exponential backoff calculation.
   * Default: 1000 (1 second) per AAP Section 0.7.6.
   * Produces backoff sequence: 1s, 2s, 4s, 8s, 16s.
   */
  reconnectBackoffBaseMs?: number;

  /**
   * Callback invoked when a message is received from the WebSocket.
   * Receives the raw string message data — parsing into typed events
   * is the caller's responsibility.
   */
  onMessage?: (data: string) => void;

  /**
   * Callback invoked when the WebSocket connection is successfully established.
   * Useful for sending initial subscription payloads after connection opens.
   */
  onOpen?: () => void;

  /**
   * Callback invoked when the WebSocket connection closes.
   * @param code - WebSocket close code (e.g., 1000 for normal closure)
   * @param reason - Human-readable close reason string
   */
  onClose?: (code: number, reason: string) => void;

  /**
   * Callback invoked when a WebSocket error occurs.
   * Note: WebSocket errors are always followed by a close event —
   * reconnection is handled via the close handler.
   */
  onError?: (error: Event) => void;

  /**
   * Callback invoked when all reconnection attempts are exhausted.
   * The background script should use this to switch to chrome.alarms-based
   * polling at 30–60 second intervals as per AAP graceful degradation rules.
   */
  onReconnectFailed?: () => void;

  /**
   * Context tag for the logger instance (e.g., 'pump-portal', 'birdeye').
   * Default: 'websocket'.
   */
  loggerContext?: string;

  /**
   * Custom keepalive message to send at each ping interval.
   * Default: `'{"type":"ping"}'`.
   * Override for WebSocket protocols that expect specific ping formats.
   */
  keepaliveMessage?: string;

  /**
   * Optional WebSocket sub-protocols for the constructor.
   * Passed directly to `new WebSocket(url, protocols)`.
   */
  protocols?: string | string[];
}

// =============================================================================
// Internal Configuration Type
// =============================================================================

/**
 * Resolved configuration with all optional fields filled to their defaults.
 * Protocols remains optional as it may not be provided.
 */
type ResolvedConfig = Required<Omit<WebSocketManagerConfig, 'protocols'>> & {
  protocols?: string | string[];
};

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum backoff delay cap in milliseconds.
 * Prevents excessively long waits between reconnection attempts.
 * The backoff sequence 1s→2s→4s→8s→16s naturally caps at 16s,
 * but this constant provides an explicit safety bound.
 */
const MAX_BACKOFF_DELAY_MS = 16_000;

/**
 * Multiplier for the keepalive interval to determine the "dead connection" timeout.
 * If no message is received within (keepalive interval × this multiplier),
 * the connection is considered dead. 3× means 60 seconds at 20s keepalive.
 */
const DEAD_CONNECTION_MULTIPLIER = 3;

/**
 * WebSocket close code for normal closure (RFC 6455 Section 7.4.1).
 * Used when the manager intentionally disconnects.
 */
const NORMAL_CLOSURE_CODE = 1000;

// =============================================================================
// WebSocketManager Class
// =============================================================================

/**
 * WebSocket lifecycle manager with keepalive, reconnection, and state tracking.
 *
 * Handles the complete WebSocket lifecycle:
 * 1. **Connection** — Creates a WebSocket with configured URL and protocols
 * 2. **Keepalive** — Sends periodic pings every 20 seconds (configurable)
 * 3. **Reconnection** — Automatic retry with exponential backoff on disconnect
 * 4. **Graceful degradation** — Invokes callback when all retries exhausted
 * 5. **State tracking** — Exposes connection state, health, and metrics
 *
 * The manager enforces single-connection semantics — calling `connect()` while
 * already connected or connecting is a no-op, per PumpPortal's single-connection
 * requirement documented in AAP Section 0.7.6.
 *
 * @example
 * ```typescript
 * const manager = new WebSocketManager({
 *   url: 'wss://pumpportal.fun/api/data',
 *   onMessage: (data) => handleStreamEvent(JSON.parse(data)),
 *   onReconnectFailed: () => enableAlarmPolling(),
 *   loggerContext: 'pump-portal',
 * });
 *
 * await manager.connect();
 * manager.send(JSON.stringify({ method: 'subscribeNewToken' }));
 *
 * // Later, clean shutdown:
 * manager.disconnect();
 * ```
 */
export class WebSocketManager {
  // ---------------------------------------------------------------------------
  // Private Fields
  // ---------------------------------------------------------------------------

  /** The underlying WebSocket instance, or null when disconnected. */
  private ws: WebSocket | null = null;

  /** Resolved configuration with all defaults applied. */
  private readonly config: ResolvedConfig;

  /** Structured logger for this manager instance. */
  private readonly logger: ReturnType<typeof createLogger>;

  /**
   * Current connection state tracking.
   * Updated on every lifecycle event (open, close, reconnecting).
   */
  private connectionState: ConnectionState = 'closed';

  /**
   * Number of consecutive reconnection attempts.
   * Resets to 0 on successful connection.
   */
  private reconnectAttempts: number = 0;

  /**
   * Timer ID for pending reconnection delay.
   * Cleared on intentional disconnect to prevent zombie reconnections.
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Timer ID for the keepalive ping interval.
   * Uses setInterval while the service worker is active.
   * chrome.alarms in background.ts provides the safety net.
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Flag indicating whether the current/last close was intentional.
   * Prevents auto-reconnection when the user explicitly calls disconnect().
   */
  private intentionalClose: boolean = false;

  /**
   * Timestamp (ms since epoch) of the last message sent or received.
   * Used by isAlive() to detect dead connections and by Chrome 116+
   * to track when the last service worker idle timer reset occurred.
   */
  private lastMessageTime: number = 0;

  /**
   * Flag to track if a connect promise is currently pending.
   * Prevents overlapping connect attempts during reconnection.
   */
  private connectPromisePending: boolean = false;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Creates a new WebSocketManager with the given configuration.
   *
   * All optional configuration fields are filled with defaults from the
   * AAP timing constants:
   * - keepaliveIntervalMs: 20,000ms (20 seconds)
   * - maxReconnectRetries: 5
   * - reconnectBackoffBaseMs: 1,000ms (1 second)
   *
   * @param config - WebSocket connection and behavior configuration
   */
  constructor(config: WebSocketManagerConfig) {
    this.config = {
      url: config.url,
      keepaliveIntervalMs: config.keepaliveIntervalMs ?? TIMING.WEBSOCKET_KEEPALIVE_MS,
      maxReconnectRetries: config.maxReconnectRetries ?? TIMING.RECONNECT_MAX_RETRIES,
      reconnectBackoffBaseMs: config.reconnectBackoffBaseMs ?? TIMING.RECONNECT_BACKOFF_BASE_MS,
      onMessage: config.onMessage ?? noop,
      onOpen: config.onOpen ?? noop,
      onClose: config.onClose ?? noop2,
      onError: config.onError ?? noop,
      onReconnectFailed: config.onReconnectFailed ?? noop,
      loggerContext: config.loggerContext ?? 'websocket',
      keepaliveMessage: config.keepaliveMessage ?? JSON.stringify({ type: 'ping' }),
      protocols: config.protocols,
    };

    this.logger = createLogger(this.config.loggerContext);
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Connection Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Establishes a new WebSocket connection to the configured URL.
   *
   * Returns a Promise that resolves when the connection is open, or rejects
   * if the connection fails during the initial handshake. If the WebSocket is
   * already open or connecting, the call is a no-op (single connection enforcement).
   *
   * On successful connection:
   * - Resets the reconnection counter to 0
   * - Starts the keepalive ping timer (20-second default)
   * - Invokes the `onOpen` callback
   *
   * On connection failure:
   * - The returned promise rejects with an Error
   * - The `onError` callback is invoked
   * - The `onClose` handler triggers automatic reconnection (unless intentional)
   *
   * @returns Promise that resolves when WebSocket is open
   * @throws Error if the WebSocket connection fails
   */
  async connect(): Promise<void> {
    // Single connection enforcement — no-op if already connected or connecting
    if (this.ws !== null) {
      const readyState = this.ws.readyState;
      if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
        this.logger.debug('WebSocket already connected or connecting, skipping connect()');
        return;
      }
    }

    // Prevent overlapping connect promises from reconnection race conditions
    if (this.connectPromisePending) {
      this.logger.debug('Connect already in progress, skipping duplicate call');
      return;
    }

    this.intentionalClose = false;
    this.connectionState = 'connecting';
    this.connectPromisePending = true;

    return new Promise<void>((resolve, reject) => {
      try {
        // Create native WebSocket — no external libraries per AAP
        this.ws = this.config.protocols
          ? new WebSocket(this.config.url, this.config.protocols)
          : new WebSocket(this.config.url);

        // Track whether the promise has been settled to prevent double resolution
        let settled = false;

        this.ws.onopen = () => {
          this.connectionState = 'open';
          this.reconnectAttempts = 0; // Reset counter on successful connection
          this.lastMessageTime = Date.now();
          this.connectPromisePending = false;
          this.startKeepalive();

          this.logger.info(`WebSocket connected to ${this.config.url}`);
          this.config.onOpen();

          if (!settled) {
            settled = true;
            resolve();
          }
        };

        this.ws.onmessage = (event: MessageEvent) => {
          // Every received message resets Chrome 116+ service worker idle timer
          this.lastMessageTime = Date.now();

          if (typeof event.data === 'string') {
            this.config.onMessage(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            // Convert ArrayBuffer to string for uniform handling
            const decoder = new TextDecoder();
            this.config.onMessage(decoder.decode(event.data));
          } else if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
            // Blob data — read as text asynchronously
            event.data.text().then((text: string) => {
              this.config.onMessage(text);
            }).catch((err: unknown) => {
              this.logger.warn('Failed to read Blob message data', err);
            });
          }
        };

        this.ws.onclose = (event: CloseEvent) => {
          const previousState = this.connectionState;
          this.connectionState = 'closed';
          this.connectPromisePending = false;
          this.stopKeepalive();

          const reason = event.reason || 'unknown';
          this.logger.info(
            `WebSocket closed: code=${event.code}, reason=${reason}, wasClean=${event.wasClean}`,
          );
          this.config.onClose(event.code, reason);

          // Reject the connect promise if we were still in the connecting phase
          if (!settled && previousState === 'connecting') {
            settled = true;
            reject(new Error(`WebSocket connection failed: code=${event.code}, reason=${reason}`));
          }

          // Only attempt reconnection if the close was not intentional
          if (!this.intentionalClose) {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (event: Event) => {
          this.logger.error('WebSocket error occurred');
          this.config.onError(event);

          // Note: onerror is always followed by onclose in the WebSocket spec.
          // The onclose handler manages promise rejection and reconnection.
          // We only reject here if onclose hasn't fired yet (defensive).
          if (!settled && this.connectionState === 'connecting') {
            settled = true;
            this.connectPromisePending = false;
            reject(new Error('WebSocket connection failed'));
          }
        };
      } catch (err: unknown) {
        // Synchronous errors from the WebSocket constructor (e.g., invalid URL)
        this.connectionState = 'closed';
        this.connectPromisePending = false;
        this.logger.error('Failed to create WebSocket instance', err);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Cleanly disconnects the WebSocket connection.
   *
   * Sets the `intentionalClose` flag to prevent automatic reconnection,
   * cancels any pending reconnection timers, stops the keepalive ping,
   * and closes the WebSocket with code 1000 (Normal Closure).
   *
   * After disconnect(), `connect()` can be called again to establish a new
   * connection. The reconnection counter is reset to 0.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.stopKeepalive();

    // Cancel any pending reconnection attempt
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close the WebSocket with Normal Closure code (1000)
    if (this.ws !== null) {
      const readyState = this.ws.readyState;
      if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
        try {
          this.ws.close(NORMAL_CLOSURE_CODE, 'Intentional disconnect');
        } catch (err: unknown) {
          this.logger.warn('Error during WebSocket close', err);
        }
      }
      this.ws = null;
    }

    this.connectionState = 'closed';
    this.reconnectAttempts = 0;
    this.connectPromisePending = false;
    this.logger.info('WebSocket disconnected intentionally');
  }

  /**
   * Sends a string message through the WebSocket connection.
   *
   * Both sending and receiving messages reset the Chrome 116+ service worker
   * idle timer, which is why this method updates `lastMessageTime`.
   *
   * @param data - String data to send (typically JSON-serialized)
   * @throws Error if the WebSocket is not in the OPEN state
   */
  send(data: string): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      // Sending data resets Chrome 116+ service worker idle timer
      this.lastMessageTime = Date.now();
    } else {
      this.logger.warn('Cannot send message — WebSocket not open');
      throw new Error('WebSocket is not connected');
    }
  }

  /**
   * Sends a keepalive ping through the WebSocket.
   *
   * This is a public method intended to be called from the `chrome.alarms`
   * handler in `entrypoints/background.ts`. The internal `setInterval`-based
   * keepalive provides 20-second pings while the service worker is active,
   * but `chrome.alarms` (minimum 30-second interval) serves as a safety net
   * to ensure the worker stays alive even if `setInterval` was lost during
   * a service worker lifecycle event.
   *
   * If the WebSocket is not open, the ping is silently skipped.
   */
  sendPing(): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(this.config.keepaliveMessage);
        this.lastMessageTime = Date.now();
        this.logger.debug('External keepalive ping sent (e.g., from chrome.alarms)');
      } catch (err: unknown) {
        this.logger.warn('Failed to send external keepalive ping', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Status Queries
  // ---------------------------------------------------------------------------

  /**
   * Checks whether the WebSocket is currently in the OPEN state.
   *
   * @returns `true` if the underlying WebSocket readyState is OPEN
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Checks whether the WebSocket connection is alive and recently active.
   *
   * A connection is considered "alive" when:
   * 1. The WebSocket is in the OPEN state, AND
   * 2. A message was sent or received within the last 3× keepalive interval
   *    (default: 60 seconds at 20s keepalive)
   *
   * This helps detect "zombie" connections where the TCP socket is open
   * but no data is flowing — a common issue with mobile/unstable networks.
   *
   * @returns `true` if the connection is open and recently active
   */
  isAlive(): boolean {
    if (!this.isConnected()) {
      return false;
    }
    // Consider connection dead if no activity in 3× keepalive interval
    const deadTimeout = this.config.keepaliveIntervalMs * DEAD_CONNECTION_MULTIPLIER;
    return (Date.now() - this.lastMessageTime) < deadTimeout;
  }

  /**
   * Returns the current connection state.
   *
   * Possible states: 'connecting', 'open', 'closing', 'closed', 'reconnecting'.
   *
   * @returns Current ConnectionState value
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Returns the number of consecutive reconnection attempts.
   *
   * Resets to 0 on successful connection or manual disconnect.
   * Useful for UI display and monitoring.
   *
   * @returns Number of reconnection attempts (0 when connected)
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Returns the timestamp of the last message sent or received.
   *
   * Returns 0 if no messages have been exchanged yet.
   * Used by isAlive() for dead connection detection and by monitoring
   * systems to track connection health.
   *
   * @returns Timestamp in milliseconds since Unix epoch
   */
  getLastMessageTime(): number {
    return this.lastMessageTime;
  }

  /**
   * Resets the reconnection attempt counter to 0.
   *
   * Called externally when switching from chrome.alarms polling back to
   * WebSocket streaming (e.g., after a period of stability). This allows
   * a fresh set of reconnection attempts.
   */
  resetReconnectCounter(): void {
    this.reconnectAttempts = 0;
    this.logger.debug('Reconnection counter reset to 0');
  }

  // ---------------------------------------------------------------------------
  // Private Methods — Keepalive
  // ---------------------------------------------------------------------------

  /**
   * Starts the keepalive ping timer.
   *
   * Uses `setInterval` to send a ping message at the configured interval
   * (default 20 seconds). While `setInterval` may be unreliable in Manifest V3
   * service workers (which can terminate after ~30s of inactivity), the 20-second
   * keepalive ping itself generates WebSocket activity that resets the Chrome 116+
   * idle timer, keeping the worker alive.
   *
   * The background script should additionally call `sendPing()` via `chrome.alarms`
   * (minimum 30-second interval) as a belt-and-suspenders safety net.
   */
  private startKeepalive(): void {
    this.stopKeepalive();

    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(this.config.keepaliveMessage);
          this.lastMessageTime = Date.now();
          this.logger.debug('Keepalive ping sent');
        } catch (err: unknown) {
          this.logger.warn('Failed to send keepalive ping', err);
        }
      }
    }, this.config.keepaliveIntervalMs);

    this.logger.debug(
      `Keepalive timer started: interval=${this.config.keepaliveIntervalMs}ms`,
    );
  }

  /**
   * Stops the keepalive ping timer.
   * Called on disconnect, connection close, and before starting a new timer.
   */
  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.logger.debug('Keepalive timer stopped');
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods — Reconnection
  // ---------------------------------------------------------------------------

  /**
   * Attempts to reconnect with exponential backoff.
   *
   * Per AAP Section 0.7.6:
   * - Backoff sequence: 1s → 2s → 4s → 8s → 16s
   * - Maximum 5 retry attempts
   * - After max retries: invoke `onReconnectFailed` for chrome.alarms fallback
   *
   * The backoff delay is computed as: `baseDelay × 2^(attempt - 1)`,
   * capped at MAX_BACKOFF_DELAY_MS (16 seconds).
   *
   * Reconnection is skipped if:
   * - The close was intentional (user called disconnect())
   * - Maximum retries have been exhausted
   */
  private attemptReconnect(): void {
    // Never reconnect after intentional disconnect
    if (this.intentionalClose) {
      return;
    }

    // Check if we've exhausted all retry attempts
    if (this.reconnectAttempts >= this.config.maxReconnectRetries) {
      this.connectionState = 'closed';
      this.logger.error(
        `Max reconnection attempts reached (${this.config.maxReconnectRetries}). ` +
        'Falling back to polling mode.',
      );
      this.config.onReconnectFailed();
      return;
    }

    this.connectionState = 'reconnecting';
    this.reconnectAttempts++;

    // Compute exponential backoff delay: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(
      this.config.reconnectBackoffBaseMs * Math.pow(2, this.reconnectAttempts - 1),
      MAX_BACKOFF_DELAY_MS,
    );

    this.logger.info(
      `Reconnection attempt ${this.reconnectAttempts}/${this.config.maxReconnectRetries} ` +
      `in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      // Guard against reconnect after intentional disconnect during the delay
      if (this.intentionalClose) {
        return;
      }

      try {
        await this.connect();
        this.logger.info('Reconnection successful');
      } catch (err: unknown) {
        this.logger.warn(
          `Reconnection attempt ${this.reconnectAttempts} failed`,
          err,
        );
        // The onclose handler on the failed WebSocket will trigger the next
        // attemptReconnect() call — the loop continues until maxRetries.
      }
    }, delay);
  }
}

// =============================================================================
// Internal No-op Helpers
// =============================================================================

/**
 * No-op function used as default for optional single-argument callbacks.
 * Avoids creating new function instances in every constructor call.
 */
function noop(): void {
  // Intentionally empty — default callback
}

/**
 * No-op function for the onClose callback signature (code, reason).
 * Matches the `(code: number, reason: string) => void` signature.
 */
function noop2(_code: number, _reason: string): void {
  // Intentionally empty — default onClose callback
}
