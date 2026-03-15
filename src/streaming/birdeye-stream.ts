/**
 * src/streaming/birdeye-stream.ts — Birdeye WebSocket Stream Handler
 *
 * Manages WebSocket connections to Birdeye's streaming API for real-time
 * price updates, transaction events, new token listings, and large trade
 * detection. This module runs exclusively in the service worker context.
 *
 * Per AAP Section 0.5.1 Group 9:
 * "Birdeye WebSocket handler; sends subscription commands for SUBSCRIBE_PRICE,
 * SUBSCRIBE_TXS, SUBSCRIBE_TOKEN_NEW_LISTING; requires API key authentication
 * on connection; parses price update and transaction events into typed objects"
 *
 * Per AAP Section 0.4.5 (WebSocket Stream Integration):
 * "Birdeye price subscription events (SUBSCRIBE_PRICE) update token price data
 * in token-store; large trade events (SUBSCRIBE_LARGE_TRADE_TXS) feed into the
 * volume spike and smart money convergence factors"
 *
 * Per AAP Section 0.7.6 (WebSocket Connection Rules):
 * - 20-second keepalive ping interval
 * - Exponential backoff reconnection: 1s→2s→4s→8s→16s, max 5 retries
 * - Graceful degradation to chrome.alarms polling on persistent failure
 *
 * Authentication: Birdeye WebSocket requires API key authentication on connection.
 * The API key is transmitted over secure WebSocket (wss://) only and NEVER logged.
 *
 * Consumers:
 * - entrypoints/background.ts — Service worker instantiates and manages this stream
 * - src/store/token-store.ts — Receives price update events via callbacks
 * - src/signals/scoring-engine.ts — Receives large trade events for factor analysis
 *
 * @module streaming/birdeye-stream
 */

import type { StreamSubscription, ConnectionState } from './types';
import { WebSocketManager } from './manager';
import type { BirdeyeTokenData } from '../api/types';
import { API_BASE_URLS, TIMING } from '../utils/config';
import { createLogger } from '../utils/logger';

// =============================================================================
// Exported Type Definitions
// =============================================================================

/**
 * Birdeye WebSocket subscription command types.
 * These correspond to the event channels available on Birdeye's streaming API.
 *
 * - SUBSCRIBE_PRICE: Real-time price updates for a specific token
 * - SUBSCRIBE_TXS: Transaction events (buys/sells) for a specific token
 * - SUBSCRIBE_TOKEN_NEW_LISTING: New token listing events
 * - SUBSCRIBE_LARGE_TRADE_TXS: Large trade events for volume spike and smart money detection
 */
export type BirdeyeSubscriptionType =
  | 'SUBSCRIBE_PRICE'
  | 'SUBSCRIBE_TXS'
  | 'SUBSCRIBE_TOKEN_NEW_LISTING'
  | 'SUBSCRIBE_LARGE_TRADE_TXS';

/**
 * Real-time price update event from Birdeye WebSocket.
 *
 * Dispatched when a subscribed token's price changes. Fields align with
 * the BirdeyeTokenData interface (address, price, priceChange24h, volume24h)
 * for consistent downstream processing in the token-store and scoring engine.
 */
export interface BirdeyePriceUpdate {
  /** Discriminant for event type narrowing */
  type: 'PRICE_UPDATE';
  /** Token mint address (Solana base58 public key) */
  address: string;
  /** Current price in USD */
  price: number;
  /** 24-hour price change as a percentage (e.g., 5.2 = +5.2%) */
  priceChange24h: number;
  /** 24-hour trading volume in USD */
  volume24h: number;
  /** Event timestamp in milliseconds since Unix epoch */
  timestamp: number;
}

/**
 * Transaction event from Birdeye WebSocket.
 *
 * Captures buy/sell activity for subscribed tokens. Feeds into the buy/sell
 * ratio factor and smart money tracking modules.
 */
export interface BirdeyeTransactionEvent {
  /** Discriminant for event type narrowing */
  type: 'TRANSACTION';
  /** Token mint address */
  address: string;
  /** Transaction signature hash */
  txHash: string;
  /** Trade direction */
  side: 'buy' | 'sell';
  /** Amount of tokens traded */
  amount: number;
  /** USD value of the trade */
  usdAmount: number;
  /** Trader wallet address */
  trader: string;
  /** Event timestamp in milliseconds since Unix epoch */
  timestamp: number;
}

/**
 * New token listing event from Birdeye WebSocket.
 *
 * Fires when a new token is listed on tracked DEXes and begins trading.
 * Triggers initial safety screening in the signal pipeline.
 */
export interface BirdeyeNewListingEvent {
  /** Discriminant for event type narrowing */
  type: 'NEW_LISTING';
  /** Token mint address */
  address: string;
  /** Token ticker symbol */
  symbol: string;
  /** Full token name */
  name: string;
  /** Initial listing price in USD */
  price: number;
  /** Initial liquidity in USD */
  liquidity: number;
  /** Event timestamp in milliseconds since Unix epoch */
  timestamp: number;
}

/**
 * Discriminated union of all Birdeye WebSocket stream events.
 * The `type` field enables exhaustive type narrowing in switch statements
 * and event handlers.
 */
export type BirdeyeStreamEvent =
  | BirdeyePriceUpdate
  | BirdeyeTransactionEvent
  | BirdeyeNewListingEvent;

// =============================================================================
// Internal Type Definitions
// =============================================================================

/**
 * Birdeye WebSocket subscription command payload.
 * Sent to the Birdeye WebSocket server to subscribe to specific event channels.
 */
interface BirdeyeSubscriptionCommand {
  /** Subscription channel type */
  type: BirdeyeSubscriptionType;
  /** Channel-specific parameters */
  data: {
    /** Token mint address for token-specific subscriptions */
    address?: string;
    /** Chart interval (e.g., '1m', '5m') for OHLCV subscriptions */
    chartType?: string;
    /** Quote currency for price subscriptions (default: 'usd') */
    currency?: string;
    /** Additional query parameter for specialized subscriptions */
    queryType?: string;
  };
}

/** Callback for price update events on a specific token */
type PriceUpdateCallback = (event: BirdeyePriceUpdate) => void;

/** Callback for transaction events (both regular and large trades) */
type TransactionCallback = (event: BirdeyeTransactionEvent) => void;

/** Callback for new token listing events */
type NewListingCallback = (event: BirdeyeNewListingEvent) => void;

/** Callback for all Birdeye stream events (generic listener) */
type BirdeyeEventCallback = (event: BirdeyeStreamEvent) => void;

// =============================================================================
// BirdeyeStream Class
// =============================================================================

/**
 * Birdeye WebSocket stream handler.
 *
 * Manages subscriptions to Birdeye's real-time data streams including
 * price updates, transaction events, new token listings, and large trades.
 * Handles authentication, subscription management, reconnection recovery,
 * and typed event dispatching.
 *
 * This class runs EXCLUSIVELY in the service worker context — API keys
 * are never exposed to content scripts per AAP Section 0.7.2.
 *
 * Architecture:
 * - Uses WebSocketManager from ./manager for connection lifecycle, keepalive
 *   (20-second ping), and exponential backoff reconnection (1s→2s→4s→8s→16s)
 * - Tracks active subscriptions via StreamSubscription objects for automatic
 *   re-subscription after reconnection
 * - Queues subscription commands when the WebSocket is not yet connected
 * - Dispatches parsed events to type-specific and generic callbacks
 *
 * @example
 * ```typescript
 * const stream = new BirdeyeStream(encryptedApiKey);
 * await stream.connect();
 *
 * stream.subscribePrice('TokenMintAddress', (event) => {
 *   tokenStore.updatePrice(event.address, event.price);
 * });
 *
 * stream.subscribeLargeTrades('TokenMintAddress', (event) => {
 *   scoringEngine.processLargeTrade(event);
 * });
 *
 * stream.onReconnectFailed(() => {
 *   // Switch to chrome.alarms-based polling
 *   enableBirdeyePolling();
 * });
 * ```
 */
export class BirdeyeStream {
  // ---------------------------------------------------------------------------
  // Private Fields
  // ---------------------------------------------------------------------------

  /** WebSocket lifecycle manager handling connection, keepalive, and reconnection */
  private readonly wsManager: WebSocketManager;

  /** Structured logger with 'birdeye-stream' context tag */
  private readonly logger: ReturnType<typeof createLogger>;

  /**
   * Birdeye API key for WebSocket authentication.
   * CRITICAL: This value is NEVER included in log messages, error reports,
   * or any user-visible output. Transmitted only over secure wss:// connections.
   */
  private readonly apiKey: string;

  /** Price update callbacks keyed by token mint address */
  private readonly priceCallbacks: Map<string, Set<PriceUpdateCallback>>;

  /** Transaction event callbacks keyed by token mint address */
  private readonly transactionCallbacks: Map<string, Set<TransactionCallback>>;

  /** New listing event callbacks (not address-specific) */
  private readonly newListingCallbacks: Set<NewListingCallback>;

  /** Generic event callbacks receiving ALL event types */
  private readonly genericCallbacks: Set<BirdeyeEventCallback>;

  /**
   * Active subscriptions tracked as StreamSubscription objects.
   * Keyed by a composite string (type:address) for efficient lookup.
   * Uses StreamSubscription.channel and StreamSubscription.params
   * to store subscription state for reconnection recovery.
   */
  private readonly activeSubscriptions: Map<string, StreamSubscription>;

  /** Commands queued while the WebSocket is not yet connected */
  private pendingSubscriptions: BirdeyeSubscriptionCommand[];

  /** External callback invoked when all reconnection attempts are exhausted */
  private reconnectFailedCallback?: () => void;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Creates a new BirdeyeStream instance.
   *
   * Initializes the WebSocketManager with the Birdeye WebSocket endpoint
   * derived from API_BASE_URLS.BIRDEYE, configured with the standard
   * keepalive interval (TIMING.WEBSOCKET_KEEPALIVE_MS = 20s), max retries
   * (TIMING.RECONNECT_MAX_RETRIES = 5), and backoff base delay
   * (TIMING.RECONNECT_BACKOFF_BASE_MS = 1s).
   *
   * @param apiKey - Birdeye API key for WebSocket authentication.
   *   Required for connection. NEVER stored in content scripts or logged.
   */
  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.logger = createLogger('birdeye-stream');

    // Derive WebSocket URL from the Birdeye REST API base URL.
    // API_BASE_URLS.BIRDEYE = 'https://public-api.birdeye.so'
    // Convert https:// protocol to wss:// for secure WebSocket, append /socket path
    const wsUrl = API_BASE_URLS.BIRDEYE.replace('https://', 'wss://') + '/socket';

    this.wsManager = new WebSocketManager({
      url: wsUrl,
      keepaliveIntervalMs: TIMING.WEBSOCKET_KEEPALIVE_MS,
      maxReconnectRetries: TIMING.RECONNECT_MAX_RETRIES,
      reconnectBackoffBaseMs: TIMING.RECONNECT_BACKOFF_BASE_MS,
      onMessage: this.handleMessage.bind(this),
      onOpen: this.handleOpen.bind(this),
      onClose: this.handleClose.bind(this),
      onError: this.handleError.bind(this),
      onReconnectFailed: this.handleReconnectFailed.bind(this),
      loggerContext: 'birdeye-ws',
    });

    // Initialize callback and subscription tracking collections
    this.priceCallbacks = new Map();
    this.transactionCallbacks = new Map();
    this.newListingCallbacks = new Set();
    this.genericCallbacks = new Set();
    this.activeSubscriptions = new Map();
    this.pendingSubscriptions = [];
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Connection Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Establishes a WebSocket connection to Birdeye's streaming API.
   *
   * Authentication is handled automatically in the `handleOpen()` callback
   * after the connection is established. All pending and previously active
   * subscriptions are restored after authentication.
   *
   * @throws Error if no API key was provided to the constructor
   * @throws Error if the WebSocket connection fails during handshake
   */
  async connect(): Promise<void> {
    if (!this.apiKey) {
      this.logger.error('Cannot connect to Birdeye WebSocket without API key');
      throw new Error('Birdeye API key is required for WebSocket connection');
    }
    this.logger.info('Connecting to Birdeye WebSocket...');
    await this.wsManager.connect();
  }

  /**
   * Cleanly disconnects from the Birdeye WebSocket stream.
   *
   * Closes the WebSocket connection via the manager (which sends a normal
   * closure code and prevents auto-reconnection), then clears all internal
   * state: callbacks, active subscriptions, and pending command queue.
   *
   * After disconnect, `connect()` can be called again to re-establish
   * a fresh connection.
   */
  disconnect(): void {
    this.wsManager.disconnect();
    this.pendingSubscriptions = [];
    this.activeSubscriptions.clear();
    this.priceCallbacks.clear();
    this.transactionCallbacks.clear();
    this.newListingCallbacks.clear();
    this.genericCallbacks.clear();
    this.logger.info('Birdeye stream disconnected and all state cleared');
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Subscription Management
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to real-time price updates for a specific token.
   *
   * Sends a SUBSCRIBE_PRICE command to Birdeye's WebSocket and registers
   * the callback to receive BirdeyePriceUpdate events for this address.
   * If the WebSocket is not yet connected, the subscription command is
   * queued and will be sent automatically when the connection opens.
   *
   * Multiple callbacks can be registered for the same address; all will
   * be invoked for each price update event.
   *
   * @param address - Token mint address (Solana base58) to subscribe to
   * @param callback - Function to call with each price update event
   */
  subscribePrice(address: string, callback: PriceUpdateCallback): void {
    if (!this.priceCallbacks.has(address)) {
      this.priceCallbacks.set(address, new Set());
    }
    this.priceCallbacks.get(address)!.add(callback);

    const command: BirdeyeSubscriptionCommand = {
      type: 'SUBSCRIBE_PRICE',
      data: { address, currency: 'usd' },
    };
    this.sendCommand(command);
    this.trackSubscription(command);
  }

  /**
   * Subscribe to real-time transaction events for a specific token.
   *
   * Sends a SUBSCRIBE_TXS command and registers the callback to receive
   * BirdeyeTransactionEvent events for buy/sell activity on this token.
   *
   * @param address - Token mint address to subscribe to
   * @param callback - Function to call with each transaction event
   */
  subscribeTransactions(address: string, callback: TransactionCallback): void {
    if (!this.transactionCallbacks.has(address)) {
      this.transactionCallbacks.set(address, new Set());
    }
    this.transactionCallbacks.get(address)!.add(callback);

    const command: BirdeyeSubscriptionCommand = {
      type: 'SUBSCRIBE_TXS',
      data: { address },
    };
    this.sendCommand(command);
    this.trackSubscription(command);
  }

  /**
   * Subscribe to new token listing events from Birdeye.
   *
   * Sends a SUBSCRIBE_TOKEN_NEW_LISTING command and registers the callback
   * to receive BirdeyeNewListingEvent events for newly listed tokens.
   * This is a global subscription — not tied to a specific token address.
   *
   * @param callback - Function to call with each new listing event
   */
  subscribeNewListings(callback: NewListingCallback): void {
    this.newListingCallbacks.add(callback);

    const command: BirdeyeSubscriptionCommand = {
      type: 'SUBSCRIBE_TOKEN_NEW_LISTING',
      data: {},
    };
    this.sendCommand(command);
    this.trackSubscription(command);
  }

  /**
   * Subscribe to large trade events for a specific token.
   *
   * Per AAP Section 0.4.5: "large trade events (SUBSCRIBE_LARGE_TRADE_TXS)
   * feed into the volume spike and smart money convergence factors"
   *
   * Large trade events are delivered as BirdeyeTransactionEvent objects
   * and share the transaction callback map to enable unified processing.
   *
   * @param address - Token mint address to subscribe to
   * @param callback - Function to call with each large trade event
   */
  subscribeLargeTrades(address: string, callback: TransactionCallback): void {
    if (!this.transactionCallbacks.has(address)) {
      this.transactionCallbacks.set(address, new Set());
    }
    this.transactionCallbacks.get(address)!.add(callback);

    const command: BirdeyeSubscriptionCommand = {
      type: 'SUBSCRIBE_LARGE_TRADE_TXS',
      data: { address },
    };
    this.sendCommand(command);
    this.trackSubscription(command);
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Unsubscribe
  // ---------------------------------------------------------------------------

  /**
   * Unsubscribe from price updates for a specific token.
   *
   * Removes all registered price callbacks for the address, removes
   * the subscription from active tracking, and sends an unsubscribe
   * command to the Birdeye server if connected.
   *
   * @param address - Token mint address to unsubscribe from
   */
  unsubscribePrice(address: string): void {
    this.priceCallbacks.delete(address);
    this.removeSubscription('SUBSCRIBE_PRICE', address);

    if (this.wsManager.isConnected()) {
      try {
        this.wsManager.send(JSON.stringify({
          type: 'UNSUBSCRIBE_PRICE',
          data: { address },
        }));
        this.logger.debug(`Unsubscribed from price updates for ${address}`);
      } catch (err: unknown) {
        this.logger.warn('Failed to send price unsubscribe command', err);
      }
    }
  }

  /**
   * Unsubscribe from transaction events for a specific token.
   *
   * Removes all registered transaction callbacks for the address and
   * removes both SUBSCRIBE_TXS and SUBSCRIBE_LARGE_TRADE_TXS subscriptions
   * from active tracking.
   *
   * @param address - Token mint address to unsubscribe from
   */
  unsubscribeTransactions(address: string): void {
    this.transactionCallbacks.delete(address);
    this.removeSubscription('SUBSCRIBE_TXS', address);
    this.removeSubscription('SUBSCRIBE_LARGE_TRADE_TXS', address);

    if (this.wsManager.isConnected()) {
      try {
        this.wsManager.send(JSON.stringify({
          type: 'UNSUBSCRIBE_TXS',
          data: { address },
        }));
        this.logger.debug(`Unsubscribed from transactions for ${address}`);
      } catch (err: unknown) {
        this.logger.warn('Failed to send transaction unsubscribe command', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Status Queries
  // ---------------------------------------------------------------------------

  /**
   * Sends a keepalive ping through the WebSocket connection.
   * Delegates to the underlying WebSocketManager.
   *
   * Called by the service worker's chrome.alarms handler to ensure
   * the connection stays alive and the service worker doesn't terminate.
   * Per AAP Section 0.7.6: all WebSocket connections must send a
   * keepalive ping every 20 seconds.
   */
  sendPing(): void {
    this.wsManager.sendPing();
  }

  /**
   * Checks whether the WebSocket is currently connected.
   *
   * @returns true if the underlying WebSocket is in OPEN state
   */
  isConnected(): boolean {
    return this.wsManager.isConnected();
  }

  /**
   * Returns the current WebSocket connection state.
   *
   * @returns Current connection state: 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting'
   */
  getConnectionState(): ConnectionState {
    return this.wsManager.getConnectionState();
  }

  /**
   * Returns the list of token mint addresses currently being tracked.
   *
   * Collects unique addresses from all active subscriptions (price,
   * transactions, and large trades). Excludes global subscriptions
   * like new listings that are not address-specific.
   *
   * @returns Array of unique token mint addresses with active subscriptions
   */
  getSubscribedTokens(): string[] {
    const tokens = new Set<string>();

    for (const [address] of this.priceCallbacks) {
      tokens.add(address);
    }
    for (const [address] of this.transactionCallbacks) {
      tokens.add(address);
    }

    return Array.from(tokens);
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Event Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a callback to be invoked when all WebSocket reconnection
   * attempts are exhausted.
   *
   * The background script should use this to switch to chrome.alarms-based
   * polling at 30–60 second intervals per AAP Section 0.7.6 graceful
   * degradation rules.
   *
   * @param callback - Function to call when reconnection fails permanently
   */
  onReconnectFailed(callback: () => void): void {
    this.reconnectFailedCallback = callback;
  }

  /**
   * Register a generic event callback that receives ALL Birdeye stream events.
   *
   * Useful for the background script to forward all events to the signal
   * pipeline without type-specific filtering. The callback receives the
   * already-parsed and typed BirdeyeStreamEvent.
   *
   * @param callback - Function to call with every stream event
   */
  onEvent(callback: BirdeyeEventCallback): void {
    this.genericCallbacks.add(callback);
  }

  // ---------------------------------------------------------------------------
  // Private — Connection Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handles WebSocket connection open event.
   *
   * Performs the following sequence:
   * 1. Sends authentication message with the API key
   * 2. Re-subscribes to all previously active subscriptions (reconnection recovery)
   * 3. Flushes the pending subscription queue
   *
   * CRITICAL: API key is transmitted only over secure WebSocket (wss://).
   * The API key value is never included in log messages.
   */
  private handleOpen(): void {
    this.logger.info('Birdeye WebSocket connected, sending authentication...');

    // Step 1: Send authentication message with API key
    try {
      this.wsManager.send(JSON.stringify({
        type: 'AUTH',
        data: { apiKey: this.apiKey },
      }));
    } catch (err: unknown) {
      this.logger.error('Failed to send authentication message', err);
      return;
    }

    // Step 2: Re-subscribe to all active subscriptions after authentication.
    // Uses StreamSubscription.channel and StreamSubscription.params to
    // reconstruct subscription commands.
    for (const [, subscription] of this.activeSubscriptions) {
      const command = this.subscriptionToCommand(subscription);
      if (command) {
        try {
          this.wsManager.send(JSON.stringify(command));
          this.logger.debug(`Re-subscribed to ${subscription.channel}`, {
            params: subscription.params,
          });
        } catch (err: unknown) {
          this.logger.warn(`Failed to re-subscribe to ${subscription.channel}`, err);
        }
      }
    }

    // Step 3: Flush pending subscriptions queued before connection opened
    const pending = [...this.pendingSubscriptions];
    this.pendingSubscriptions = [];
    for (const command of pending) {
      this.sendCommand(command);
    }

    this.logger.info('Birdeye WebSocket authentication and subscriptions restored');
  }

  /**
   * Handles WebSocket close event.
   *
   * Logs the close reason for diagnostics. Reconnection is managed
   * automatically by the WebSocketManager with exponential backoff.
   *
   * @param code - WebSocket close code (e.g., 1000 for normal closure)
   * @param reason - Human-readable close reason string
   */
  private handleClose(code: number, reason: string): void {
    this.logger.info(`Birdeye WebSocket closed: code=${code}, reason=${reason}`);
  }

  /**
   * Handles WebSocket error event.
   *
   * Error details are logged without exposing the API key. The error event
   * is always followed by a close event per the WebSocket specification;
   * reconnection is handled in the close handler via WebSocketManager.
   *
   * @param _error - WebSocket error event (browser error events contain minimal details)
   */
  private handleError(_error: Event): void {
    // Log error without exposing the API key — per AAP Section 0.7.2
    this.logger.error('Birdeye WebSocket error occurred');
  }

  /**
   * Handles the event when all reconnection attempts are exhausted.
   *
   * Logs the permanent failure and invokes the registered reconnect
   * failed callback so the background script can switch to
   * chrome.alarms-based polling at 30–60 second intervals.
   */
  private handleReconnectFailed(): void {
    this.logger.error(
      'Birdeye WebSocket reconnection failed after maximum retries. ' +
      'Background script should switch to chrome.alarms polling.',
    );

    if (this.reconnectFailedCallback) {
      try {
        this.reconnectFailedCallback();
      } catch (err: unknown) {
        this.logger.error('Reconnect failed callback threw an error', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Message Handling and Event Dispatching
  // ---------------------------------------------------------------------------

  /**
   * Handles incoming WebSocket messages.
   *
   * Parses the raw JSON message into a typed BirdeyeStreamEvent and
   * dispatches it to the appropriate registered callbacks based on
   * event type and token address.
   *
   * Each callback invocation is wrapped in try/catch to prevent a single
   * callback error from blocking other callbacks or crashing the handler.
   * Malformed messages are caught and logged without crashing.
   *
   * @param data - Raw JSON string from the WebSocket
   */
  private handleMessage(data: string): void {
    try {
      const raw: unknown = JSON.parse(data);
      const event = this.parseEvent(raw);

      // Non-event messages (auth responses, pongs, heartbeats) return null
      if (!event) {
        return;
      }

      // Dispatch to type-specific callbacks
      switch (event.type) {
        case 'PRICE_UPDATE': {
          const callbacks = this.priceCallbacks.get(event.address);
          if (callbacks) {
            for (const cb of callbacks) {
              try {
                cb(event);
              } catch (err: unknown) {
                this.logger.warn('Price update callback threw an error', err);
              }
            }
          }
          break;
        }
        case 'TRANSACTION': {
          const callbacks = this.transactionCallbacks.get(event.address);
          if (callbacks) {
            for (const cb of callbacks) {
              try {
                cb(event);
              } catch (err: unknown) {
                this.logger.warn('Transaction callback threw an error', err);
              }
            }
          }
          break;
        }
        case 'NEW_LISTING': {
          for (const cb of this.newListingCallbacks) {
            try {
              cb(event);
            } catch (err: unknown) {
              this.logger.warn('New listing callback threw an error', err);
            }
          }
          break;
        }
      }

      // Dispatch to generic event callbacks (all event types)
      for (const cb of this.genericCallbacks) {
        try {
          cb(event);
        } catch (err: unknown) {
          this.logger.warn('Generic event callback threw an error', err);
        }
      }
    } catch (err: unknown) {
      this.logger.warn('Failed to parse Birdeye WebSocket message', err);
    }
  }

  /**
   * Parses a raw WebSocket message into a typed BirdeyeStreamEvent.
   *
   * Birdeye WebSocket messages have varying structures depending on the
   * event type. This method normalizes the raw data into the appropriate
   * typed interface, adding timestamps where missing.
   *
   * Returns null for non-event messages (authentication responses,
   * heartbeats, error responses) or messages that cannot be parsed.
   *
   * Type alignment: Price update fields (address, price, priceChange24h,
   * volume24h) map to corresponding fields on the BirdeyeTokenData interface
   * to ensure consistent downstream processing in token-store and scoring.
   *
   * @param raw - Parsed JSON object from the WebSocket message
   * @returns Typed BirdeyeStreamEvent or null if not a recognized event
   */
  private parseEvent(raw: unknown): BirdeyeStreamEvent | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const msg = raw as Record<string, unknown>;

    // Identify the message type — Birdeye may use different type field names
    const msgType = (msg['type'] ?? msg['eventType'] ?? msg['event']) as string | undefined;

    // Skip non-event messages: authentication responses, pong, heartbeats, errors
    if (msgType === 'AUTH_RESPONSE' || msgType === 'auth' || msgType === 'pong' ||
        msgType === 'heartbeat' || msgType === 'PONG') {
      return null;
    }

    // Log and skip server error messages
    if (msgType === 'error' || msgType === 'ERROR') {
      this.logger.warn('Birdeye server error message received', {
        errorMessage: msg['message'],
        errorCode: msg['code'],
      });
      return null;
    }

    // Extract data payload — some messages nest data under a 'data' key
    const payload = (msg['data'] !== null && msg['data'] !== undefined && typeof msg['data'] === 'object')
      ? msg['data'] as Record<string, unknown>
      : msg;

    const now = Date.now();

    // Route by recognized message type strings
    if (msgType === 'PRICE_UPDATE' || msgType === 'price_update' ||
        msgType === 'SUBSCRIBE_PRICE' || msgType === 'priceUpdate') {
      return this.parsePriceUpdate(payload, now);
    }

    if (msgType === 'TRANSACTION' || msgType === 'transaction' ||
        msgType === 'TXS' || msgType === 'SUBSCRIBE_TXS' ||
        msgType === 'LARGE_TRADE' || msgType === 'large_trade' ||
        msgType === 'SUBSCRIBE_LARGE_TRADE_TXS' || msgType === 'largeTrade') {
      return this.parseTransactionEvent(payload, now);
    }

    if (msgType === 'NEW_LISTING' || msgType === 'new_listing' ||
        msgType === 'TOKEN_NEW_LISTING' || msgType === 'SUBSCRIBE_TOKEN_NEW_LISTING' ||
        msgType === 'newListing') {
      return this.parseNewListingEvent(payload, now);
    }

    // If type field is not recognized, try to infer from payload structure.
    // This provides resilience against minor API changes in field naming.
    if (typeof payload['price'] === 'number' && typeof payload['address'] === 'string' &&
        !payload['txHash'] && !payload['signature'] && !payload['symbol']) {
      return this.parsePriceUpdate(payload, now);
    }

    if ((payload['txHash'] || payload['signature']) &&
        (payload['side'] === 'buy' || payload['side'] === 'sell' ||
         payload['txType'] === 'buy' || payload['txType'] === 'sell')) {
      return this.parseTransactionEvent(payload, now);
    }

    if (typeof payload['symbol'] === 'string' && typeof payload['name'] === 'string' &&
        typeof payload['liquidity'] === 'number') {
      return this.parseNewListingEvent(payload, now);
    }

    // Unrecognized message — silently skip with debug log
    this.logger.debug('Unrecognized Birdeye WebSocket message', { type: msgType });
    return null;
  }

  /**
   * Parses a raw payload into a BirdeyePriceUpdate event.
   *
   * Handles field name variations across different Birdeye message formats.
   * Returns null if the required address field is missing.
   *
   * @param payload - Raw message payload object
   * @param fallbackTimestamp - Timestamp to use if not present in payload
   * @returns Parsed BirdeyePriceUpdate or null if address is missing
   */
  private parsePriceUpdate(
    payload: Record<string, unknown>,
    fallbackTimestamp: number,
  ): BirdeyePriceUpdate | null {
    const address = this.extractAddress(payload);
    if (!address) {
      this.logger.debug('Price update missing required address field');
      return null;
    }

    return {
      type: 'PRICE_UPDATE',
      address,
      price: this.toNumber(payload['price'] ?? payload['value'] ?? payload['currentPrice'] ?? 0),
      priceChange24h: this.toNumber(
        payload['priceChange24h'] ?? payload['priceChange'] ?? payload['change24h'] ?? 0,
      ),
      volume24h: this.toNumber(
        payload['volume24h'] ?? payload['volume'] ?? payload['v24hUSD'] ?? 0,
      ),
      timestamp: this.toNumber(
        payload['timestamp'] ?? payload['unixTime'] ?? payload['time'] ?? fallbackTimestamp,
      ),
    };
  }

  /**
   * Parses a raw payload into a BirdeyeTransactionEvent.
   *
   * Handles field name variations and normalizes the trade side to
   * 'buy' | 'sell'. Returns null if the required address field is missing.
   *
   * @param payload - Raw message payload object
   * @param fallbackTimestamp - Timestamp to use if not present in payload
   * @returns Parsed BirdeyeTransactionEvent or null if address is missing
   */
  private parseTransactionEvent(
    payload: Record<string, unknown>,
    fallbackTimestamp: number,
  ): BirdeyeTransactionEvent | null {
    const address = this.extractAddress(payload);
    if (!address) {
      this.logger.debug('Transaction event missing required address field');
      return null;
    }

    // Extract and normalize transaction hash
    const txHash = String(
      payload['txHash'] ?? payload['signature'] ?? payload['hash'] ?? payload['tx'] ?? '',
    );

    // Normalize trade side to 'buy' | 'sell'
    const sideRaw = String(
      payload['side'] ?? payload['txType'] ?? payload['direction'] ?? 'buy',
    ).toLowerCase();
    const side: 'buy' | 'sell' = sideRaw === 'sell' ? 'sell' : 'buy';

    return {
      type: 'TRANSACTION',
      address,
      txHash,
      side,
      amount: this.toNumber(payload['amount'] ?? payload['tokenAmount'] ?? payload['qty'] ?? 0),
      usdAmount: this.toNumber(
        payload['usdAmount'] ?? payload['usdValue'] ?? payload['valueUsd'] ?? 0,
      ),
      trader: String(
        payload['trader'] ?? payload['traderPublicKey'] ?? payload['owner'] ?? payload['wallet'] ?? '',
      ),
      timestamp: this.toNumber(
        payload['timestamp'] ?? payload['blockUnixTime'] ?? payload['time'] ?? fallbackTimestamp,
      ),
    };
  }

  /**
   * Parses a raw payload into a BirdeyeNewListingEvent.
   *
   * Returns null if the required address field is missing.
   *
   * @param payload - Raw message payload object
   * @param fallbackTimestamp - Timestamp to use if not present in payload
   * @returns Parsed BirdeyeNewListingEvent or null if address is missing
   */
  private parseNewListingEvent(
    payload: Record<string, unknown>,
    fallbackTimestamp: number,
  ): BirdeyeNewListingEvent | null {
    const address = this.extractAddress(payload);
    if (!address) {
      this.logger.debug('New listing event missing required address field');
      return null;
    }

    return {
      type: 'NEW_LISTING',
      address,
      symbol: String(payload['symbol'] ?? payload['ticker'] ?? ''),
      name: String(payload['name'] ?? payload['tokenName'] ?? ''),
      price: this.toNumber(payload['price'] ?? payload['initialPrice'] ?? 0),
      liquidity: this.toNumber(payload['liquidity'] ?? payload['lp'] ?? payload['tvl'] ?? 0),
      timestamp: this.toNumber(
        payload['timestamp'] ?? payload['listingTime'] ?? payload['time'] ?? fallbackTimestamp,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Private — Command and Subscription Management
  // ---------------------------------------------------------------------------

  /**
   * Sends a subscription command through the WebSocket.
   *
   * If the WebSocket is not connected, the command is queued in
   * pendingSubscriptions and will be flushed when the connection opens.
   * Failed send attempts also queue the command for retry.
   *
   * @param command - Birdeye subscription command to send
   */
  private sendCommand(command: BirdeyeSubscriptionCommand): void {
    if (this.wsManager.isConnected()) {
      try {
        this.wsManager.send(JSON.stringify(command));
        this.logger.debug(`Sent Birdeye command: ${command.type}`, {
          address: command.data.address,
        });
      } catch (err: unknown) {
        this.logger.warn(`Failed to send Birdeye command: ${command.type}`, err);
        this.pendingSubscriptions.push(command);
      }
    } else {
      this.pendingSubscriptions.push(command);
      this.logger.debug(`Queued Birdeye command (WS not connected): ${command.type}`);
    }
  }

  /**
   * Tracks a subscription command as a StreamSubscription for reconnection recovery.
   *
   * Uses StreamSubscription.channel to store the subscription type and
   * StreamSubscription.params to store the command data, enabling automatic
   * re-subscription via subscriptionToCommand() after reconnection.
   *
   * @param command - The subscription command to track
   */
  private trackSubscription(command: BirdeyeSubscriptionCommand): void {
    const key = this.buildSubscriptionKey(command.type, command.data.address);

    const subscription: StreamSubscription = {
      channel: command.type,
      params: { ...command.data } as Record<string, unknown>,
      subscribedAt: Date.now(),
      active: true,
    };

    this.activeSubscriptions.set(key, subscription);
  }

  /**
   * Removes a subscription from active tracking.
   *
   * @param type - Subscription type (e.g., 'SUBSCRIBE_PRICE')
   * @param address - Token mint address (optional for global subscriptions)
   */
  private removeSubscription(type: BirdeyeSubscriptionType, address?: string): void {
    const key = this.buildSubscriptionKey(type, address);
    this.activeSubscriptions.delete(key);
  }

  /**
   * Builds a unique key for subscription tracking.
   *
   * Format: "TYPE:address" for token-specific subscriptions,
   * or just "TYPE" for global subscriptions (e.g., new listings).
   *
   * @param type - Subscription type string
   * @param address - Optional token mint address
   * @returns Unique subscription key
   */
  private buildSubscriptionKey(type: string, address?: string): string {
    return address ? `${type}:${address}` : type;
  }

  /**
   * Converts a StreamSubscription back into a BirdeyeSubscriptionCommand
   * for re-sending during reconnection recovery.
   *
   * Reads StreamSubscription.channel for the command type and
   * StreamSubscription.params for the command data. Returns null if
   * the subscription's channel is not a recognized BirdeyeSubscriptionType.
   *
   * @param subscription - The stored subscription to convert
   * @returns The corresponding command, or null if the channel is invalid
   */
  private subscriptionToCommand(
    subscription: StreamSubscription,
  ): BirdeyeSubscriptionCommand | null {
    const validTypes: ReadonlyArray<BirdeyeSubscriptionType> = [
      'SUBSCRIBE_PRICE',
      'SUBSCRIBE_TXS',
      'SUBSCRIBE_TOKEN_NEW_LISTING',
      'SUBSCRIBE_LARGE_TRADE_TXS',
    ];

    if (!validTypes.includes(subscription.channel as BirdeyeSubscriptionType)) {
      this.logger.warn(`Unknown subscription channel during re-subscribe: ${subscription.channel}`);
      return null;
    }

    return {
      type: subscription.channel as BirdeyeSubscriptionType,
      data: (subscription.params ?? {}) as BirdeyeSubscriptionCommand['data'],
    };
  }

  // ---------------------------------------------------------------------------
  // Private — Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Extracts the token address from a raw message payload.
   *
   * Checks common field name variations used by Birdeye's API.
   * Returns null if no valid address string is found.
   *
   * @param payload - Raw message payload
   * @returns Token address string or null
   */
  private extractAddress(payload: Record<string, unknown>): string | null {
    const candidates = [
      payload['address'],
      payload['mint'],
      payload['tokenAddress'],
      payload['token'],
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Safely converts an unknown value to a number.
   *
   * Returns 0 for non-numeric, NaN, null, or undefined values.
   * Handles both number and string inputs.
   *
   * @param value - Value to convert
   * @returns Numeric value or 0
   */
  private toNumber(value: unknown): number {
    if (typeof value === 'number' && !Number.isNaN(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }
}
