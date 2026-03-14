/**
 * src/api/pump-portal.ts — PumpPortal WebSocket Client
 *
 * Manages a persistent WebSocket connection to the PumpPortal API at
 * `wss://pumpportal.fun/api/data` for real-time pump.fun token events.
 *
 * Per AAP Section 0.7.6:
 * - Single connection only — never open parallel connections
 * - 20-second keepalive ping to prevent Chrome 116+ service worker idle termination
 * - Exponential backoff reconnection: 1s → 2s → 4s → 8s → 16s, max 5 retries
 * - Graceful degradation — falls back to polling after max retries
 *
 * Supports multiplexed subscriptions on a single connection:
 * - subscribeNewToken — new pump.fun token creation events
 * - subscribeTokenTrade — buy/sell events for specific token mints
 * - subscribeMigration — pump.fun → DEX graduation events
 * - subscribeAccountTrade — trade activity for specific wallet accounts
 *
 * Consumers:
 * - entrypoints/background.ts — instantiates and manages lifecycle
 * - src/signals/scoring-engine.ts — receives new token events for screening
 * - src/store/token-store.ts — receives trade events for price updates
 *
 * @module api/pump-portal
 */

import type { PumpPortalEvent } from './types';
import { PUMP_PORTAL_WS, TIMING } from '../utils/config';
import { createLogger } from '../utils/logger';
import type { Logger } from '../utils/logger';
import type { ConnectionState } from '../streaming/types';

// =============================================================================
// PumpPortal-Specific Types
// =============================================================================

/**
 * Valid subscription method names for the PumpPortal WebSocket API.
 * Each method corresponds to a distinct event stream:
 * - 'subscribeNewToken' — fires when a new token is deployed on pump.fun
 * - 'subscribeTokenTrade' — fires on buy/sell activity for specific tokens
 * - 'subscribeMigration' — fires when tokens graduate from bonding curve to DEX
 * - 'subscribeAccountTrade' — fires on trade activity for specific wallet accounts
 */
export type PumpPortalMethod =
  | 'subscribeNewToken'
  | 'subscribeTokenTrade'
  | 'subscribeMigration'
  | 'subscribeAccountTrade';

/**
 * Subscription payload sent over the WebSocket connection.
 * The `method` field identifies the subscription type, and the optional
 * `keys` array provides token mints or account addresses for targeted
 * subscriptions (subscribeTokenTrade, subscribeAccountTrade).
 */
interface SubscriptionPayload {
  method: PumpPortalMethod | 'ping';
  keys?: string[];
}

/**
 * Callback function type for handling PumpPortal WebSocket events.
 * Each subscription method accepts a callback of this type which is
 * invoked whenever a matching event is received.
 */
type EventCallback = (event: PumpPortalEvent) => void;

/**
 * Callback for connection failure events. Invoked when all reconnection
 * attempts are exhausted, signaling the background script to switch
 * to chrome.alarms-based polling as a fallback.
 */
type ConnectionFailedCallback = () => void;

/**
 * Internal representation of a tracked subscription for automatic
 * re-subscription after reconnection. Stores the original payload
 * and associated callbacks.
 */
interface TrackedSubscription {
  payload: SubscriptionPayload;
  callbacks: EventCallback[];
}

/**
 * Internal type for pending subscriptions queued before the WebSocket
 * connection is fully established.
 */
interface PendingSubscription {
  payload: SubscriptionPayload;
  callback: EventCallback;
}

// =============================================================================
// PumpPortalClient Class
// =============================================================================

/**
 * WebSocket client for the PumpPortal real-time data stream.
 *
 * Maintains a SINGLE WebSocket connection to `wss://pumpportal.fun/api/data`
 * per PumpPortal guidelines. Supports multiplexed subscriptions for new tokens,
 * token trades, migrations, and account trades on the same connection.
 *
 * Features:
 * - Automatic reconnection with exponential backoff (1s → 2s → 4s → 8s → 16s)
 * - 20-second keepalive ping for Chrome 116+ service worker compatibility
 * - Subscription persistence across reconnections
 * - Graceful degradation signaling when max retries exhausted
 * - Type-safe event dispatch to registered callbacks
 *
 * @example
 * ```typescript
 * const client = new PumpPortalClient();
 * await client.connect();
 *
 * client.subscribeNewToken((event) => {
 *   if (event.type === 'newToken') {
 *     console.log('New token:', event.mint, event.name);
 *   }
 * });
 *
 * client.subscribeTokenTrade(['mint1', 'mint2'], (event) => {
 *   if (event.type === 'trade') {
 *     console.log('Trade:', event.txType, event.mint);
 *   }
 * });
 * ```
 */
export class PumpPortalClient {
  /** The underlying WebSocket connection instance */
  private ws: WebSocket | null = null;

  /** Structured logger with 'pump-portal' context tag */
  private logger: Logger;

  /**
   * Map of active subscriptions keyed by a unique subscription identifier.
   * The key is constructed as `${method}` for global subscriptions or
   * `${method}:${sortedKeys}` for key-specific subscriptions.
   * Values contain the original payload and registered callbacks.
   */
  private subscriptions: Map<string, TrackedSubscription> = new Map();

  /**
   * Queue of subscriptions requested before the WebSocket connection is open.
   * These are sent immediately once the connection is established.
   */
  private pendingSubscriptions: PendingSubscription[] = [];

  /** Current count of consecutive reconnection attempts */
  private reconnectAttempts: number = 0;

  /**
   * Timer ID for the keepalive ping interval.
   * In the service worker context, setInterval may be unreliable —
   * the background script should also call sendPing() via chrome.alarms.
   */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Timer ID for scheduled reconnection attempts.
   * Used to cancel pending reconnection if disconnect() is called.
   */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Timer ID for the reconnect counter reset delay.
   * The reconnect counter is only reset after the connection has been
   * stable (open without closing) for the stability period, preventing
   * counter reset on connections that open then immediately close.
   */
  private reconnectResetTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Flag indicating whether a connection attempt is currently in progress.
   * Prevents concurrent connection attempts from the connect() method.
   */
  private isConnecting: boolean = false;

  /**
   * Flag indicating whether disconnect() was explicitly called.
   * When true, the onclose handler will not attempt automatic reconnection.
   */
  private intentionalClose: boolean = false;

  /**
   * Current connection state for external status queries.
   * Updated throughout the connection lifecycle.
   */
  private connectionState: ConnectionState = 'closed';

  /**
   * Registered callback for connection failure events (max retries exhausted).
   * The background script registers this to switch to polling fallback.
   */
  private onConnectionFailed: ConnectionFailedCallback | null = null;

  /**
   * Creates a new PumpPortalClient instance.
   *
   * Initializes the logger with 'pump-portal' context tag and sets up
   * empty subscription tracking structures. Does NOT establish a connection —
   * call connect() to initiate the WebSocket connection.
   */
  constructor() {
    this.logger = createLogger('pump-portal');
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Establishes a WebSocket connection to the PumpPortal API.
   *
   * If a connection is already open, this method resolves immediately
   * (single connection enforcement). If a connection attempt is already
   * in progress, waits for that attempt to complete.
   *
   * On successful connection:
   * - Starts the 20-second keepalive ping timer
   * - Re-subscribes to all previously tracked subscriptions
   * - Flushes any pending subscriptions queued before connection
   * - Resets the reconnection attempt counter
   *
   * @returns Promise that resolves when the connection is established
   * @throws Error if the connection fails and no reconnection is scheduled
   */
  public connect(): Promise<void> {
    // If already connected, reuse the existing connection (single connection rule)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.debug('Already connected, reusing existing connection');
      return Promise.resolve();
    }

    // If a connection attempt is already in progress, wait for it
    if (this.isConnecting) {
      this.logger.debug('Connection attempt already in progress, waiting...');
      return new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (!this.isConnecting) {
            clearInterval(checkInterval);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              resolve();
            } else {
              reject(new Error('Connection attempt completed but WebSocket is not open'));
            }
          }
        }, 100);

        // Safety timeout to prevent infinite waiting
        setTimeout(() => {
          clearInterval(checkInterval);
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            resolve();
          } else {
            reject(new Error('Connection wait timeout'));
          }
        }, 30_000);
      });
    }

    this.intentionalClose = false;
    this.isConnecting = true;
    this.connectionState = 'connecting';

    return new Promise<void>((resolve, reject) => {
      try {
        this.logger.info(`Connecting to PumpPortal WebSocket at ${PUMP_PORTAL_WS}`);

        const ws = new WebSocket(PUMP_PORTAL_WS);
        this.ws = ws;

        ws.onopen = () => {
          this.isConnecting = false;
          this.connectionState = 'open';

          this.logger.info('WebSocket connection established');

          // Start keepalive ping timer (20-second interval)
          this.startKeepalive();

          // Re-subscribe to all tracked subscriptions after reconnection
          this.resubscribeAll();

          // Flush any pending subscriptions that were queued before connection
          this.flushPendingSubscriptions();

          // Schedule reconnect counter reset after stability period.
          // We only reset reconnectAttempts after the connection has been
          // open for 5 seconds without closing. This prevents counter reset
          // on unstable connections that open then immediately close.
          this.scheduleReconnectReset();

          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          this.handleMessage(event);
        };

        ws.onerror = (event: Event) => {
          this.logger.error('WebSocket error occurred', event);

          // If still connecting, reject the promise
          if (this.isConnecting) {
            this.isConnecting = false;
            this.connectionState = 'closed';
            reject(new Error('WebSocket connection failed'));
          }
        };

        ws.onclose = (event: CloseEvent) => {
          this.logger.info(
            `WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}, wasClean=${event.wasClean}`,
          );

          this.stopKeepalive();

          // If disconnect() was called intentionally, don't reconnect
          if (this.intentionalClose) {
            this.connectionState = 'closed';
            this.isConnecting = false;
            return;
          }

          // Attempt automatic reconnection with exponential backoff
          this.connectionState = 'reconnecting';
          this.attemptReconnection();
        };
      } catch (error) {
        this.isConnecting = false;
        this.connectionState = 'closed';
        this.logger.error('Failed to create WebSocket', error);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Gracefully closes the WebSocket connection.
   *
   * Sends a close frame with code 1000 (Normal Closure), stops the
   * keepalive timer, cancels any pending reconnection, clears all
   * subscription callbacks, and resets internal state.
   *
   * After calling disconnect(), no automatic reconnection will occur.
   * Subscriptions are preserved in tracking for potential future reconnection
   * if connect() is called again.
   */
  public disconnect(): void {
    this.logger.info('Disconnecting from PumpPortal WebSocket');

    this.intentionalClose = true;
    this.isConnecting = false;
    this.connectionState = 'closing';

    // Cancel any pending reconnection attempt
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Stop keepalive ping timer
    this.stopKeepalive();

    // Close the WebSocket connection gracefully
    if (this.ws) {
      try {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close(1000, 'Client disconnect');
        }
      } catch (error) {
        this.logger.warn('Error during WebSocket close', error);
      }
      this.ws = null;
    }

    // Clear all subscription callbacks and pending queue
    this.subscriptions.clear();
    this.pendingSubscriptions = [];
    this.reconnectAttempts = 0;
    this.connectionState = 'closed';

    this.logger.info('Disconnected and cleaned up');
  }

  // ===========================================================================
  // Subscription Methods
  // ===========================================================================

  /**
   * Subscribes to new token creation events on pump.fun.
   *
   * Sends `{ method: 'subscribeNewToken' }` to the PumpPortal WebSocket.
   * The callback is invoked with `PumpPortalNewToken` events whenever a
   * new token is deployed on pump.fun's bonding curve.
   *
   * The subscription is tracked for automatic re-subscription on reconnection.
   * If the WebSocket is not yet connected, the subscription is queued and
   * sent once the connection is established.
   *
   * @param callback - Function invoked with each new token event
   */
  public subscribeNewToken(callback: EventCallback): void {
    const payload: SubscriptionPayload = { method: 'subscribeNewToken' };
    this.addSubscription('subscribeNewToken', payload, callback);
  }

  /**
   * Subscribes to trade events for specific token mint addresses.
   *
   * Sends `{ method: 'subscribeTokenTrade', keys: mints }` to the PumpPortal
   * WebSocket. The callback is invoked with `PumpPortalTrade` events for
   * buy/sell activity on the specified tokens.
   *
   * Multiple calls with different mints are merged — each call adds new
   * mints to the subscription. The subscription is tracked for automatic
   * re-subscription on reconnection.
   *
   * @param mints - Array of token mint addresses to subscribe to
   * @param callback - Function invoked with each trade event
   */
  public subscribeTokenTrade(mints: string[], callback: EventCallback): void {
    if (mints.length === 0) {
      this.logger.warn('subscribeTokenTrade called with empty mints array');
      return;
    }

    const payload: SubscriptionPayload = {
      method: 'subscribeTokenTrade',
      keys: [...mints],
    };
    const subKey = `subscribeTokenTrade:${[...mints].sort().join(',')}`;
    this.addSubscription(subKey, payload, callback);
  }

  /**
   * Subscribes to token migration (graduation) events.
   *
   * Sends `{ method: 'subscribeMigration' }` to the PumpPortal WebSocket.
   * The callback is invoked with `PumpPortalMigration` events when tokens
   * graduate from pump.fun's bonding curve to a DEX (e.g., Raydium).
   *
   * Migration events are significant signals — only ~0.4–1.8% of pump.fun
   * tokens graduate to DEXes.
   *
   * @param callback - Function invoked with each migration event
   */
  public subscribeMigration(callback: EventCallback): void {
    const payload: SubscriptionPayload = { method: 'subscribeMigration' };
    this.addSubscription('subscribeMigration', payload, callback);
  }

  /**
   * Subscribes to trade events for specific wallet account addresses.
   *
   * Sends `{ method: 'subscribeAccountTrade', keys: accounts }` to the
   * PumpPortal WebSocket. The callback is invoked when the specified
   * accounts execute trades on pump.fun.
   *
   * Used for smart money wallet tracking — monitoring when known profitable
   * wallets enter or exit positions.
   *
   * @param accounts - Array of wallet account addresses to monitor
   * @param callback - Function invoked with each account trade event
   */
  public subscribeAccountTrade(accounts: string[], callback: EventCallback): void {
    if (accounts.length === 0) {
      this.logger.warn('subscribeAccountTrade called with empty accounts array');
      return;
    }

    const payload: SubscriptionPayload = {
      method: 'subscribeAccountTrade',
      keys: [...accounts],
    };
    const subKey = `subscribeAccountTrade:${[...accounts].sort().join(',')}`;
    this.addSubscription(subKey, payload, callback);
  }

  // ===========================================================================
  // Keepalive & Ping
  // ===========================================================================

  /**
   * Sends a keepalive ping message over the WebSocket connection.
   *
   * This is a public method so the service worker background script can
   * invoke it from a `chrome.alarms` handler (30-second minimum interval).
   * The internal keepalive timer also calls this every 20 seconds when
   * running in a context where setInterval is reliable.
   *
   * The ping message `{ method: 'ping' }` resets Chrome 116+'s service
   * worker idle termination timer by generating WebSocket activity.
   *
   * No-op if the WebSocket is not currently open.
   */
  public sendPing(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ method: 'ping' }));
        this.logger.debug('Keepalive ping sent');
      } catch (error) {
        this.logger.warn('Failed to send keepalive ping', error);
      }
    } else {
      this.logger.debug('Skipping ping — WebSocket not open');
    }
  }

  // ===========================================================================
  // Status Methods
  // ===========================================================================

  /**
   * Returns whether the WebSocket connection is currently open and ready
   * to send/receive messages.
   *
   * @returns `true` if the WebSocket is in the OPEN state, `false` otherwise
   */
  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Returns the current connection state as a `ConnectionState` string.
   *
   * Possible values:
   * - `'connecting'` — WebSocket handshake in progress
   * - `'open'` — Connection established and ready
   * - `'closing'` — Graceful close initiated
   * - `'closed'` — Connection closed (initial state or after disconnect)
   * - `'reconnecting'` — Automatic reconnection in progress after unexpected close
   *
   * @returns Current connection state
   */
  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Registers a callback to be invoked when all reconnection attempts
   * are exhausted. The background script uses this to switch to
   * chrome.alarms-based polling as a fallback data source.
   *
   * @param callback - Function invoked when max retries are exceeded
   */
  public onConnectionFailure(callback: ConnectionFailedCallback): void {
    this.onConnectionFailed = callback;
  }

  // ===========================================================================
  // Private — Subscription Management
  // ===========================================================================

  /**
   * Adds a subscription to the tracking map and sends it over the WebSocket.
   *
   * If the WebSocket is not yet open, the subscription is queued in
   * `pendingSubscriptions` and will be sent once the connection is established.
   *
   * Existing subscriptions with the same key have their callback appended
   * (multiple consumers can listen to the same subscription).
   *
   * @param key - Unique subscription identifier
   * @param payload - Subscription payload to send over WebSocket
   * @param callback - Event callback to register
   */
  private addSubscription(
    key: string,
    payload: SubscriptionPayload,
    callback: EventCallback,
  ): void {
    // Track the subscription for reconnection
    const existing = this.subscriptions.get(key);
    if (existing) {
      existing.callbacks.push(callback);
      this.logger.debug(`Added callback to existing subscription: ${key}`);
    } else {
      this.subscriptions.set(key, {
        payload,
        callbacks: [callback],
      });
      this.logger.debug(`Created new subscription: ${key}`);
    }

    // Send immediately if connected, otherwise queue
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(payload);
    } else {
      this.pendingSubscriptions.push({ payload, callback });
      this.logger.debug(`Queued subscription (WebSocket not open): ${key}`);
    }
  }

  /**
   * Sends a subscription payload over the active WebSocket connection.
   *
   * @param payload - The subscription payload to send
   */
  private sendSubscription(payload: SubscriptionPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send subscription — WebSocket not open');
      return;
    }

    try {
      const message = JSON.stringify(payload);
      this.ws.send(message);
      this.logger.info(`Subscription sent: ${payload.method}`, {
        keys: payload.keys,
      });
    } catch (error) {
      this.logger.error(`Failed to send subscription: ${payload.method}`, error);
    }
  }

  /**
   * Re-subscribes to all tracked subscriptions after a reconnection.
   *
   * Iterates through the subscription tracking map and re-sends each
   * subscription payload. This ensures continuity of data streams
   * after a connection drop and recovery.
   */
  private resubscribeAll(): void {
    if (this.subscriptions.size === 0) {
      return;
    }

    this.logger.info(`Re-subscribing to ${this.subscriptions.size} tracked subscriptions`);

    for (const [key, tracked] of this.subscriptions) {
      this.sendSubscription(tracked.payload);
      this.logger.debug(`Re-subscribed: ${key}`);
    }
  }

  /**
   * Flushes the pending subscription queue by sending all queued
   * subscriptions and clearing the queue.
   *
   * Called immediately after a successful connection is established.
   * Subscriptions in the queue are already tracked in the subscriptions
   * map, so only the WebSocket send is needed here.
   */
  private flushPendingSubscriptions(): void {
    if (this.pendingSubscriptions.length === 0) {
      return;
    }

    this.logger.info(`Flushing ${this.pendingSubscriptions.length} pending subscriptions`);

    // Deduplicate — pending subscriptions may overlap with tracked subs
    // that were already re-subscribed in resubscribeAll(). Track sent payloads.
    const sentPayloads = new Set<string>();

    for (const pending of this.pendingSubscriptions) {
      const payloadKey = JSON.stringify(pending.payload);
      if (!sentPayloads.has(payloadKey)) {
        this.sendSubscription(pending.payload);
        sentPayloads.add(payloadKey);
      }
    }

    this.pendingSubscriptions = [];
  }

  // ===========================================================================
  // Private — Keepalive Management
  // ===========================================================================

  /**
   * Starts the keepalive ping timer at the configured interval (20 seconds).
   *
   * Per AAP Section 0.7.6: "All WebSocket connections must send a keepalive
   * ping every 20 seconds to prevent Chrome 116+ service worker idle
   * termination and to detect dead connections."
   *
   * Note: In the service worker context, setInterval may be unreliable
   * when the worker is idle. The background script should ALSO trigger
   * sendPing() via chrome.alarms as a belt-and-suspenders approach.
   */
  private startKeepalive(): void {
    this.stopKeepalive();

    this.keepaliveTimer = setInterval(() => {
      this.sendPing();
    }, TIMING.WEBSOCKET_KEEPALIVE_MS);

    this.logger.debug(
      `Keepalive timer started: ${TIMING.WEBSOCKET_KEEPALIVE_MS}ms interval`,
    );
  }

  /**
   * Stops the keepalive ping timer.
   *
   * Called during disconnect and when the connection closes unexpectedly.
   * Safe to call multiple times.
   */
  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.logger.debug('Keepalive timer stopped');
    }

    // Cancel any pending reconnect counter reset
    if (this.reconnectResetTimer !== null) {
      clearTimeout(this.reconnectResetTimer);
      this.reconnectResetTimer = null;
    }
  }

  /**
   * Schedules a delayed reset of the reconnect attempt counter.
   *
   * The counter is only reset after the connection has been open for
   * 5 seconds without closing. This prevents the counter from resetting
   * on unstable connections that open then immediately close, which would
   * defeat the exponential backoff mechanism.
   *
   * If the connection closes before the 5-second stability window,
   * the timer is cancelled in stopKeepalive() and the counter is preserved.
   */
  private scheduleReconnectReset(): void {
    // Cancel any existing reset timer
    if (this.reconnectResetTimer !== null) {
      clearTimeout(this.reconnectResetTimer);
    }

    this.reconnectResetTimer = setTimeout(() => {
      this.reconnectResetTimer = null;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.reconnectAttempts = 0;
        this.logger.debug('Reconnect counter reset after stable connection');
      }
    }, 5_000);
  }

  // ===========================================================================
  // Private — Reconnection Logic
  // ===========================================================================

  /**
   * Attempts to reconnect to the PumpPortal WebSocket with exponential backoff.
   *
   * Backoff sequence: 1s → 2s → 4s → 8s → 16s (capped at 16s)
   * Maximum attempts: 5 (configurable via TIMING.RECONNECT_MAX_RETRIES)
   *
   * After exhausting all retry attempts, emits a connection failure event
   * to signal the background script to switch to chrome.alarms-based polling.
   *
   * On successful reconnection, the attempt counter is reset to 0 and all
   * tracked subscriptions are automatically restored.
   */
  private attemptReconnection(): void {
    // Don't reconnect if intentionally closed
    if (this.intentionalClose) {
      return;
    }

    this.reconnectAttempts++;

    if (this.reconnectAttempts > TIMING.RECONNECT_MAX_RETRIES) {
      this.logger.error(
        `Max reconnection attempts (${TIMING.RECONNECT_MAX_RETRIES}) reached. ` +
          'Falling back to polling mode.',
      );
      this.connectionState = 'closed';

      // Notify the background script to switch to polling
      if (this.onConnectionFailed) {
        try {
          this.onConnectionFailed();
        } catch (error) {
          this.logger.error('Error in connection failure callback', error);
        }
      }
      return;
    }

    // Calculate exponential backoff delay: baseDelay * 2^(attempt-1), capped at 16s
    const delay = Math.min(
      TIMING.RECONNECT_BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      16_000,
    );

    this.logger.info(
      `Reconnection attempt ${this.reconnectAttempts}/${TIMING.RECONNECT_MAX_RETRIES} ` +
        `in ${delay}ms`,
    );

    this.connectionState = 'reconnecting';

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      // Clean up the old WebSocket reference before creating a new one
      if (this.ws) {
        try {
          this.ws.onopen = null;
          this.ws.onmessage = null;
          this.ws.onerror = null;
          this.ws.onclose = null;
        } catch {
          // Ignore errors cleaning up old WebSocket handlers
        }
        this.ws = null;
      }

      this.logger.info(`Executing reconnection attempt ${this.reconnectAttempts}`);

      this.connect().catch((error) => {
        this.logger.error('Reconnection attempt failed', error);
        // The onclose handler of the new connection will trigger another
        // reconnection attempt, incrementing the counter again
      });
    }, delay);
  }

  // ===========================================================================
  // Private — Message Handling
  // ===========================================================================

  /**
   * Handles incoming WebSocket messages by parsing, classifying, and
   * dispatching them to registered callbacks.
   *
   * Message classification rules:
   * - Messages with `txType` field → trade events → dispatched to subscribeTokenTrade callbacks
   * - Messages with `mint` but no `txType` and no `pool` → new token events → dispatched to subscribeNewToken callbacks
   * - Messages with `pool` field → migration events → dispatched to subscribeMigration callbacks
   * - Pong or unrecognized messages → logged and ignored
   *
   * Malformed messages (non-JSON, missing fields) are caught and logged
   * without crashing the client.
   *
   * @param event - The raw WebSocket MessageEvent
   */
  private handleMessage(event: MessageEvent): void {
    let data: Record<string, unknown>;

    try {
      data = JSON.parse(String(event.data));
    } catch (error) {
      this.logger.warn('Received non-JSON WebSocket message', {
        data: String(event.data).substring(0, 200),
        error,
      });
      return;
    }

    // Ignore pong/ping responses and empty messages
    if (
      data === null ||
      typeof data !== 'object' ||
      ('type' in data && data.type === 'pong') ||
      ('method' in data && data.method === 'pong')
    ) {
      this.logger.debug('Received pong or empty response');
      return;
    }

    // Classify the event type based on message structure
    const eventType = this.classifyEvent(data);

    if (!eventType) {
      this.logger.debug('Unrecognized message format, ignoring', {
        keys: Object.keys(data),
      });
      return;
    }

    // Build the typed PumpPortalEvent from the raw data
    const typedEvent = this.buildTypedEvent(eventType, data);

    if (!typedEvent) {
      this.logger.warn('Failed to build typed event from message data');
      return;
    }

    // Dispatch to all matching callbacks
    this.dispatchEvent(eventType, typedEvent);
  }

  /**
   * Classifies a raw WebSocket message into an event type category.
   *
   * @param data - Parsed JSON message object
   * @returns The event type string, or null if unrecognizable
   */
  private classifyEvent(
    data: Record<string, unknown>,
  ): 'newToken' | 'trade' | 'migration' | null {
    // Trade events contain txType field (buy/sell)
    if ('txType' in data && (data.txType === 'buy' || data.txType === 'sell')) {
      return 'trade';
    }

    // Migration events contain a pool field indicating DEX graduation
    if ('pool' in data && typeof data.pool === 'string' && data.pool.length > 0) {
      return 'migration';
    }

    // New token events contain mint with creation metadata (initialBuy, bondingCurveKey)
    if (
      'mint' in data &&
      typeof data.mint === 'string' &&
      ('initialBuy' in data || 'bondingCurveKey' in data || 'vTokensInBondingCurve' in data)
    ) {
      return 'newToken';
    }

    return null;
  }

  /**
   * Constructs a fully typed PumpPortalEvent from raw message data.
   *
   * Provides default values for missing fields and ensures timestamp
   * is always present. Handles the varying structure of messages from
   * different PumpPortal subscription streams.
   *
   * @param eventType - The classified event type
   * @param data - Raw parsed JSON message
   * @returns Typed PumpPortalEvent, or null if construction fails
   */
  private buildTypedEvent(
    eventType: 'newToken' | 'trade' | 'migration',
    data: Record<string, unknown>,
  ): PumpPortalEvent | null {
    try {
      const now = Date.now();

      switch (eventType) {
        case 'newToken':
          return {
            type: 'newToken',
            mint: String(data.mint ?? ''),
            name: String(data.name ?? ''),
            symbol: String(data.symbol ?? ''),
            uri: String(data.uri ?? ''),
            traderPublicKey: String(data.traderPublicKey ?? ''),
            initialBuy: Number(data.initialBuy ?? 0),
            bondingCurveKey: String(data.bondingCurveKey ?? ''),
            vTokensInBondingCurve: Number(data.vTokensInBondingCurve ?? 0),
            vSolInBondingCurve: Number(data.vSolInBondingCurve ?? 0),
            marketCapSol: Number(data.marketCapSol ?? 0),
            timestamp: Number(data.timestamp ?? now),
          };

        case 'trade':
          return {
            type: 'trade',
            signature: String(data.signature ?? ''),
            mint: String(data.mint ?? ''),
            traderPublicKey: String(data.traderPublicKey ?? ''),
            txType: data.txType === 'sell' ? 'sell' : 'buy',
            tokenAmount: Number(data.tokenAmount ?? 0),
            solAmount: Number(data.solAmount ?? 0),
            newTokenBalance: Number(data.newTokenBalance ?? 0),
            bondingCurveKey: String(data.bondingCurveKey ?? ''),
            vTokensInBondingCurve: Number(data.vTokensInBondingCurve ?? 0),
            vSolInBondingCurve: Number(data.vSolInBondingCurve ?? 0),
            marketCapSol: Number(data.marketCapSol ?? 0),
            timestamp: Number(data.timestamp ?? now),
          };

        case 'migration':
          return {
            type: 'migration',
            mint: String(data.mint ?? ''),
            pool: String(data.pool ?? ''),
            timestamp: Number(data.timestamp ?? now),
          };

        default:
          return null;
      }
    } catch (error) {
      this.logger.error('Error building typed event', { eventType, error });
      return null;
    }
  }

  /**
   * Dispatches a typed event to all registered callbacks matching the
   * event type.
   *
   * For trade events, dispatches to both subscribeTokenTrade and
   * subscribeAccountTrade callbacks that match the event's mint or
   * trader account.
   *
   * Each callback is invoked within a try-catch to prevent one faulty
   * callback from blocking dispatch to other consumers.
   *
   * @param eventType - The classified event type
   * @param event - The fully typed PumpPortalEvent
   */
  private dispatchEvent(
    eventType: 'newToken' | 'trade' | 'migration',
    event: PumpPortalEvent,
  ): void {
    let dispatched = false;

    for (const [key, tracked] of this.subscriptions) {
      let shouldDispatch = false;

      // Match subscription to event type
      if (eventType === 'newToken' && key === 'subscribeNewToken') {
        shouldDispatch = true;
      } else if (eventType === 'migration' && key === 'subscribeMigration') {
        shouldDispatch = true;
      } else if (eventType === 'trade' && key.startsWith('subscribeTokenTrade')) {
        // For token trade subscriptions, check if the event's mint matches
        if (tracked.payload.keys && event.type === 'trade') {
          shouldDispatch = tracked.payload.keys.includes(event.mint);
        } else {
          // No keys filter — dispatch all trade events
          shouldDispatch = true;
        }
      } else if (eventType === 'trade' && key.startsWith('subscribeAccountTrade')) {
        // For account trade subscriptions, check if the trader matches
        if (tracked.payload.keys && event.type === 'trade') {
          shouldDispatch = tracked.payload.keys.includes(event.traderPublicKey);
        }
      }

      if (shouldDispatch) {
        for (const callback of tracked.callbacks) {
          try {
            callback(event);
            dispatched = true;
          } catch (error) {
            this.logger.error('Error in subscription callback', {
              key,
              error,
            });
          }
        }
      }
    }

    if (!dispatched) {
      this.logger.debug(`No matching subscriptions for ${eventType} event`);
    }
  }
}
