/**
 * src/streaming/pump-portal-stream.ts — PumpPortal WebSocket Stream Handler
 *
 * Manages the PumpPortal WebSocket connection for real-time pump.fun events.
 * Connects to `wss://pumpportal.fun/api/data` and handles:
 * - New token creation events (`subscribeNewToken`)
 * - Token trade events (`subscribeTokenTrade`)
 * - Token migration/graduation events (`subscribeMigration`)
 * - Account-specific trade events (`subscribeAccountTrade`)
 *
 * Architecture:
 * - Uses a single WebSocket connection with multiplexed subscriptions
 *   per PumpPortal's documented guidelines (AAP Section 0.7.6)
 * - Delegates connection lifecycle (keepalive, reconnection, backoff)
 *   to the WebSocketManager from `./manager`
 * - Automatically re-subscribes to all active subscriptions on reconnect
 * - Queues subscriptions issued before the connection is open
 * - Exposes a reconnect-failed callback for chrome.alarms fallback
 *
 * Consumers:
 * - entrypoints/background.ts — instantiates and orchestrates the stream
 * - src/signals/scoring-engine.ts — receives new token events for screening
 * - src/store/token-store.ts — receives trade events for active tokens
 *
 * Per AAP Section 0.7.6 (WebSocket Connection Rules — CRITICAL):
 * - SINGLE CONNECTION ONLY: never open parallel connections to PumpPortal
 * - 20-second keepalive ping: prevents Chrome 116+ service worker idle termination
 * - Exponential backoff reconnection: 1s→2s→4s→8s→16s, max 5 retries
 * - Graceful degradation: signal background script for chrome.alarms polling fallback
 *
 * @module streaming/pump-portal-stream
 */

import type { StreamSubscription, ConnectionState } from './types';
import { WebSocketManager } from './manager';
import type {
  PumpPortalEvent,
  PumpPortalNewToken,
  PumpPortalTrade,
  PumpPortalMigration,
} from '../api/types';
import { PUMP_PORTAL_WS, TIMING } from '../utils/config';
import { createLogger } from '../utils/logger';

// =============================================================================
// PumpPortal-Specific Types
// =============================================================================

/**
 * WebSocket subscription method names supported by PumpPortal.
 *
 * Each method corresponds to a specific event stream:
 * - `subscribeNewToken`: New token creation events on pump.fun
 * - `subscribeTokenTrade`: Buy/sell trade events for specific token mints
 * - `subscribeMigration`: Token graduation events (pump.fun → DEX)
 * - `subscribeAccountTrade`: Trade events for specific wallet accounts
 */
export type PumpPortalMethod =
  | 'subscribeNewToken'
  | 'subscribeTokenTrade'
  | 'subscribeMigration'
  | 'subscribeAccountTrade';

/**
 * Payload sent over the WebSocket to subscribe to a PumpPortal event stream.
 * The `method` field identifies the subscription type, and the optional `keys`
 * array provides token mint addresses or account addresses for targeted subscriptions.
 */
interface SubscriptionPayload {
  /** The PumpPortal subscription method name */
  method: PumpPortalMethod;
  /** Token mints or account addresses for targeted subscriptions (optional) */
  keys?: string[];
}

// =============================================================================
// Callback Type Definitions
// =============================================================================

/**
 * Generic callback for any PumpPortal event (new token, trade, or migration).
 * Used by `subscribeAccountTrade` and the internal generic dispatch mechanism.
 */
type PumpPortalEventCallback = (event: PumpPortalEvent) => void;

/**
 * Callback specifically for new token creation events.
 * Receives a fully typed `PumpPortalNewToken` with creation metadata.
 */
type NewTokenCallback = (event: PumpPortalNewToken) => void;

/**
 * Callback specifically for trade events (buy/sell) on subscribed tokens.
 * Receives a fully typed `PumpPortalTrade` with trade details.
 */
type TradeCallback = (event: PumpPortalTrade) => void;

/**
 * Callback specifically for token migration/graduation events.
 * Receives a fully typed `PumpPortalMigration` with the new DEX pool address.
 */
type MigrationCallback = (event: PumpPortalMigration) => void;

// =============================================================================
// PumpPortalStream Class
// =============================================================================

/**
 * PumpPortal WebSocket stream handler with subscription management,
 * automatic reconnection, and typed event dispatching.
 *
 * Enforces a single WebSocket connection to `wss://pumpportal.fun/api/data`
 * with multiplexed subscriptions per PumpPortal's documented protocol.
 *
 * Key features:
 * - Typed subscription methods for each PumpPortal event type
 * - Automatic re-subscription on reconnection
 * - Pending subscription queue for pre-connection subscribe calls
 * - Mint-specific trade callback routing
 * - Graceful degradation callback when reconnection fails
 * - Chrome 116+ service worker compatible (keepalive via WebSocketManager)
 *
 * @example
 * ```typescript
 * const stream = new PumpPortalStream();
 *
 * stream.subscribeNewToken((event) => {
 *   console.log('New token:', event.name, event.symbol, event.mint);
 * });
 *
 * stream.subscribeTokenTrade(['tokenMintAddress'], (trade) => {
 *   console.log('Trade:', trade.txType, trade.tokenAmount, trade.solAmount);
 * });
 *
 * stream.subscribeMigration((migration) => {
 *   console.log('Graduated to DEX:', migration.mint, migration.pool);
 * });
 *
 * // Set fallback handler before connecting
 * stream.onReconnectFailed(() => {
 *   console.warn('Switching to chrome.alarms polling');
 *   enablePollingFallback();
 * });
 *
 * await stream.connect();
 * ```
 */
export class PumpPortalStream {
  // ---------------------------------------------------------------------------
  // Private Fields
  // ---------------------------------------------------------------------------

  /** WebSocket lifecycle manager handling connection, keepalive, and reconnection */
  private readonly wsManager: WebSocketManager;

  /** Structured logger with 'pump-portal-stream' context tag */
  private readonly logger: ReturnType<typeof createLogger>;

  /**
   * Generic event callbacks keyed by a caller-provided channel identifier.
   * These receive ALL event types regardless of subscription method.
   */
  private readonly eventCallbacks: Map<string, Set<PumpPortalEventCallback>>;

  /** Callbacks registered for new token creation events */
  private readonly newTokenCallbacks: Set<NewTokenCallback>;

  /**
   * Trade callbacks keyed by token mint address.
   * Enables efficient dispatch to only the callbacks interested in a specific token.
   */
  private readonly tradeCallbacks: Map<string, Set<TradeCallback>>;

  /** Callbacks registered for token migration/graduation events */
  private readonly migrationCallbacks: Set<MigrationCallback>;

  /**
   * Account trade callbacks keyed by account address.
   * Dispatches trade events that match specific wallet accounts.
   */
  private readonly accountTradeCallbacks: Map<string, Set<PumpPortalEventCallback>>;

  /**
   * Subscriptions queued before the WebSocket connection is open.
   * Processed in FIFO order when `handleOpen()` fires.
   */
  private pendingSubscriptions: SubscriptionPayload[];

  /**
   * JSON-serialized subscription payloads for active subscriptions.
   * Enables automatic re-subscription after reconnection by replaying
   * these payloads when the connection reopens.
   */
  private readonly activeSubscriptions: Set<string>;

  /**
   * StreamSubscription tracking for getActiveSubscriptionCount() and status reporting.
   * Keyed by a composite string of method + optional keys hash.
   */
  private readonly subscriptionRegistry: Map<string, StreamSubscription>;

  /**
   * External callback invoked when all reconnection attempts are exhausted.
   * The background script sets this to trigger chrome.alarms fallback polling.
   */
  private reconnectFailedCallback?: () => void;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Creates a new PumpPortalStream instance.
   *
   * Initializes the WebSocketManager targeting `wss://pumpportal.fun/api/data`
   * with AAP-compliant timing configuration:
   * - 20-second keepalive ping interval (TIMING.WEBSOCKET_KEEPALIVE_MS)
   * - 5 max reconnection retries (TIMING.RECONNECT_MAX_RETRIES)
   * - 1-second base backoff delay (TIMING.RECONNECT_BACKOFF_BASE_MS)
   *
   * The WebSocketManager delegates all lifecycle events (open, close, error,
   * message, reconnect-failed) back to this handler for PumpPortal-specific processing.
   */
  constructor() {
    this.logger = createLogger('pump-portal-stream');

    this.wsManager = new WebSocketManager({
      url: PUMP_PORTAL_WS,
      keepaliveIntervalMs: TIMING.WEBSOCKET_KEEPALIVE_MS,
      maxReconnectRetries: TIMING.RECONNECT_MAX_RETRIES,
      reconnectBackoffBaseMs: TIMING.RECONNECT_BACKOFF_BASE_MS,
      onMessage: this.handleMessage.bind(this),
      onOpen: this.handleOpen.bind(this),
      onClose: this.handleClose.bind(this),
      onError: this.handleError.bind(this),
      onReconnectFailed: this.handleReconnectFailed.bind(this),
      loggerContext: 'pump-portal',
    });

    this.eventCallbacks = new Map();
    this.newTokenCallbacks = new Set();
    this.tradeCallbacks = new Map();
    this.migrationCallbacks = new Set();
    this.accountTradeCallbacks = new Map();
    this.pendingSubscriptions = [];
    this.activeSubscriptions = new Set();
    this.subscriptionRegistry = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Connection Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Establishes the WebSocket connection to PumpPortal.
   *
   * Delegates to WebSocketManager.connect() which enforces single-connection
   * semantics (no-op if already connected/connecting). After the connection
   * opens, `handleOpen()` automatically sends all pending and active
   * subscriptions.
   *
   * @returns Promise that resolves when the WebSocket connection is established
   * @throws Error if the initial connection handshake fails
   */
  async connect(): Promise<void> {
    this.logger.info('Connecting to PumpPortal WebSocket...');
    await this.wsManager.connect();
  }

  /**
   * Cleanly disconnects the WebSocket and clears all state.
   *
   * After disconnect:
   * - The WebSocket connection is closed with code 1000 (Normal Closure)
   * - All pending subscriptions are discarded
   * - All active subscription tracking is cleared
   * - All registered callbacks are removed
   * - Reconnection is suppressed (intentional close)
   *
   * Call `connect()` again to re-establish the connection.
   * Subscriptions must be re-registered after reconnecting.
   */
  disconnect(): void {
    this.wsManager.disconnect();
    this.pendingSubscriptions = [];
    this.activeSubscriptions.clear();
    this.subscriptionRegistry.clear();
    this.newTokenCallbacks.clear();
    this.tradeCallbacks.clear();
    this.migrationCallbacks.clear();
    this.accountTradeCallbacks.clear();
    this.eventCallbacks.clear();
    this.reconnectFailedCallback = undefined;
    this.logger.info('PumpPortal stream disconnected and all state cleared');
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to new token creation events on pump.fun.
   *
   * Sends `{ method: 'subscribeNewToken' }` to PumpPortal when connected.
   * If the WebSocket is not yet open, the subscription is queued and sent
   * automatically when the connection opens.
   *
   * The callback receives `PumpPortalNewToken` events containing:
   * - Token mint address, name, symbol, metadata URI
   * - Creator wallet address and initial buy amount
   * - Bonding curve state (virtual reserves, market cap in SOL)
   *
   * Per AAP Section 0.4.5: "PumpPortal new token events are forwarded to
   * the scoring engine for immediate initial screening"
   *
   * @param callback - Function invoked for each new token creation event
   */
  subscribeNewToken(callback: NewTokenCallback): void {
    this.newTokenCallbacks.add(callback);

    const payload: SubscriptionPayload = { method: 'subscribeNewToken' };
    this.registerSubscription(payload);
    this.sendSubscription(payload);

    this.logger.info('Subscribed to new token events');
  }

  /**
   * Subscribes to trade events for specific token mint addresses.
   *
   * Sends `{ method: 'subscribeTokenTrade', keys: [mint1, mint2, ...] }` to
   * PumpPortal. Multiple calls with different mints accumulate — each mint's
   * callbacks are tracked independently for efficient dispatch.
   *
   * The callback receives `PumpPortalTrade` events containing:
   * - Trade direction (buy/sell), token amount, SOL amount
   * - Trader wallet address and post-trade balance
   * - Updated bonding curve state and market cap
   *
   * Per AAP Section 0.4.5: "Trade events update the token-store for active tokens"
   *
   * @param mints - Array of token mint addresses to monitor
   * @param callback - Function invoked for each trade on the specified mints
   */
  subscribeTokenTrade(mints: string[], callback: TradeCallback): void {
    if (mints.length === 0) {
      this.logger.warn('subscribeTokenTrade called with empty mints array');
      return;
    }

    // Register callback for each mint address
    for (const mint of mints) {
      let mintCallbacks = this.tradeCallbacks.get(mint);
      if (!mintCallbacks) {
        mintCallbacks = new Set();
        this.tradeCallbacks.set(mint, mintCallbacks);
      }
      mintCallbacks.add(callback);
    }

    const payload: SubscriptionPayload = {
      method: 'subscribeTokenTrade',
      keys: [...mints],
    };
    this.registerSubscription(payload);
    this.sendSubscription(payload);

    this.logger.info(`Subscribed to trade events for ${mints.length} token(s)`);
  }

  /**
   * Subscribes to token migration/graduation events.
   *
   * Sends `{ method: 'subscribeMigration' }` to PumpPortal when connected.
   * Migration events fire when a pump.fun token graduates from the bonding
   * curve to a DEX (e.g., Raydium), which is a significant signal — only
   * ~0.4–1.8% of pump.fun tokens graduate to DEXes.
   *
   * The callback receives `PumpPortalMigration` events containing:
   * - Token mint address that graduated
   * - New DEX liquidity pool address
   * - Migration timestamp
   *
   * @param callback - Function invoked for each token migration event
   */
  subscribeMigration(callback: MigrationCallback): void {
    this.migrationCallbacks.add(callback);

    const payload: SubscriptionPayload = { method: 'subscribeMigration' };
    this.registerSubscription(payload);
    this.sendSubscription(payload);

    this.logger.info('Subscribed to migration events');
  }

  /**
   * Subscribes to trade events for specific wallet accounts.
   *
   * Sends `{ method: 'subscribeAccountTrade', keys: [account1, ...] }` to
   * PumpPortal. Enables monitoring of smart money wallet activity on pump.fun.
   *
   * The callback receives generic `PumpPortalEvent` objects which may be
   * trades or other account-related events.
   *
   * @param accounts - Array of wallet account addresses to monitor
   * @param callback - Function invoked for each trade by the specified accounts
   */
  subscribeAccountTrade(accounts: string[], callback: PumpPortalEventCallback): void {
    if (accounts.length === 0) {
      this.logger.warn('subscribeAccountTrade called with empty accounts array');
      return;
    }

    // Register callback for each account address
    for (const account of accounts) {
      let accountCallbacks = this.accountTradeCallbacks.get(account);
      if (!accountCallbacks) {
        accountCallbacks = new Set();
        this.accountTradeCallbacks.set(account, accountCallbacks);
      }
      accountCallbacks.add(callback);
    }

    const payload: SubscriptionPayload = {
      method: 'subscribeAccountTrade',
      keys: [...accounts],
    };
    this.registerSubscription(payload);
    this.sendSubscription(payload);

    this.logger.info(`Subscribed to account trade events for ${accounts.length} account(s)`);
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Keepalive
  // ---------------------------------------------------------------------------

  /**
   * Sends a keepalive ping through the WebSocket.
   *
   * This public method is intended to be called by the service worker's
   * `chrome.alarms` handler as a safety net keepalive mechanism. The
   * WebSocketManager also runs its own internal 20-second keepalive timer,
   * but `chrome.alarms` (30-second minimum interval) provides a backup
   * in case `setInterval` is lost during service worker lifecycle events.
   *
   * If the WebSocket is not connected, the ping is silently skipped.
   */
  sendPing(): void {
    this.wsManager.sendPing();
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Status Queries
  // ---------------------------------------------------------------------------

  /**
   * Checks whether the PumpPortal WebSocket is currently connected.
   *
   * @returns `true` if the underlying WebSocket is in the OPEN state
   */
  isConnected(): boolean {
    return this.wsManager.isConnected();
  }

  /**
   * Returns the current connection state of the PumpPortal WebSocket.
   *
   * Possible states: 'connecting', 'open', 'closing', 'closed', 'reconnecting'
   *
   * @returns Current ConnectionState value
   */
  getConnectionState(): ConnectionState {
    return this.wsManager.getConnectionState();
  }

  /**
   * Returns the number of active subscriptions on the PumpPortal connection.
   *
   * Counts unique subscription payloads (method + keys combinations).
   * Useful for status display and health monitoring.
   *
   * @returns Count of active subscriptions
   */
  getActiveSubscriptionCount(): number {
    return this.subscriptionRegistry.size;
  }

  // ---------------------------------------------------------------------------
  // Public Methods — Reconnect Failed Callback
  // ---------------------------------------------------------------------------

  /**
   * Registers a callback invoked when all WebSocket reconnection attempts
   * are exhausted.
   *
   * The background script should set this callback to trigger a fallback
   * to chrome.alarms-based polling at 30–60 second intervals, as required
   * by AAP Section 0.7.6 (Graceful Degradation).
   *
   * @param callback - Function to call when reconnection permanently fails
   *
   * @example
   * ```typescript
   * stream.onReconnectFailed(() => {
   *   // Switch to chrome.alarms polling as fallback
   *   chrome.alarms.create('pump-portal-poll', { periodInMinutes: 0.5 });
   * });
   * ```
   */
  onReconnectFailed(callback: () => void): void {
    this.reconnectFailedCallback = callback;
  }

  // ---------------------------------------------------------------------------
  // Private Methods — Subscription Management
  // ---------------------------------------------------------------------------

  /**
   * Sends a subscription payload over the WebSocket, or queues it if not connected.
   *
   * If the WebSocket is currently open, the payload is sent immediately and
   * tracked in `activeSubscriptions` for re-subscription on reconnect.
   * If the WebSocket is not yet open, the payload is added to the pending
   * queue and will be sent when `handleOpen()` fires.
   *
   * @param payload - The subscription message to send
   */
  private sendSubscription(payload: SubscriptionPayload): void {
    const serialized = JSON.stringify(payload);

    if (this.wsManager.isConnected()) {
      try {
        this.wsManager.send(serialized);
        this.activeSubscriptions.add(serialized);
        this.logger.debug(
          `Sent subscription: ${payload.method}`,
          payload.keys ? { keys: payload.keys } : undefined,
        );
      } catch (err: unknown) {
        this.logger.warn(`Failed to send subscription: ${payload.method}`, err);
        // Queue for retry on next connection
        this.pendingSubscriptions.push(payload);
      }
    } else {
      this.pendingSubscriptions.push(payload);
      this.logger.debug(`Queued subscription (WS not open): ${payload.method}`);
    }
  }

  /**
   * Registers a subscription in the tracking registry for status reporting
   * and active subscription counting.
   *
   * @param payload - The subscription payload to register
   */
  private registerSubscription(payload: SubscriptionPayload): void {
    const key = this.buildSubscriptionKey(payload);

    const subscription: StreamSubscription = {
      channel: payload.method,
      params: payload.keys ? { keys: payload.keys } : undefined,
      subscribedAt: Date.now(),
      active: true,
    };

    this.subscriptionRegistry.set(key, subscription);
  }

  /**
   * Builds a unique key for a subscription payload.
   * Used to deduplicate subscriptions in the registry and active set.
   *
   * @param payload - The subscription payload
   * @returns A unique string key for the subscription
   */
  private buildSubscriptionKey(payload: SubscriptionPayload): string {
    if (payload.keys && payload.keys.length > 0) {
      return `${payload.method}:${[...payload.keys].sort().join(',')}`;
    }
    return payload.method;
  }

  // ---------------------------------------------------------------------------
  // Private Methods — Message Handling
  // ---------------------------------------------------------------------------

  /**
   * Handles incoming WebSocket messages from PumpPortal.
   *
   * Parses the raw JSON message into a typed PumpPortalEvent and dispatches
   * it to the appropriate registered callbacks based on event type.
   *
   * Dispatch routing:
   * - 'newToken' events → all `newTokenCallbacks`
   * - 'trade' events → mint-specific `tradeCallbacks` + account-specific callbacks
   * - 'migration' events → all `migrationCallbacks`
   * - All events → generic `eventCallbacks`
   *
   * Malformed messages are caught and logged without crashing the handler.
   *
   * @param data - Raw JSON string received from the WebSocket
   */
  private handleMessage(data: string): void {
    try {
      const raw: unknown = JSON.parse(data);
      const event = this.parseEvent(raw);

      if (!event) {
        return; // Unrecognized event type — already logged in parseEvent
      }

      // Dispatch based on discriminated event type
      switch (event.type) {
        case 'newToken': {
          const newToken = event as PumpPortalNewToken;
          this.newTokenCallbacks.forEach((cb) => {
            try {
              cb(newToken);
            } catch (cbErr: unknown) {
              this.logger.error('Error in newToken callback', cbErr);
            }
          });
          break;
        }

        case 'trade': {
          const trade = event as PumpPortalTrade;

          // Dispatch to mint-specific trade callbacks
          const mintCallbacks = this.tradeCallbacks.get(trade.mint);
          if (mintCallbacks) {
            mintCallbacks.forEach((cb) => {
              try {
                cb(trade);
              } catch (cbErr: unknown) {
                this.logger.error('Error in trade callback', cbErr);
              }
            });
          }

          // Dispatch to account-specific callbacks if the trader matches
          const accountCallbacks = this.accountTradeCallbacks.get(trade.traderPublicKey);
          if (accountCallbacks) {
            accountCallbacks.forEach((cb) => {
              try {
                cb(trade);
              } catch (cbErr: unknown) {
                this.logger.error('Error in account trade callback', cbErr);
              }
            });
          }
          break;
        }

        case 'migration': {
          const migration = event as PumpPortalMigration;
          this.migrationCallbacks.forEach((cb) => {
            try {
              cb(migration);
            } catch (cbErr: unknown) {
              this.logger.error('Error in migration callback', cbErr);
            }
          });
          break;
        }
      }

      // Also dispatch to generic event callbacks
      this.eventCallbacks.forEach((callbacks) => {
        callbacks.forEach((cb) => {
          try {
            cb(event);
          } catch (cbErr: unknown) {
            this.logger.error('Error in generic event callback', cbErr);
          }
        });
      });
    } catch (err: unknown) {
      this.logger.warn('Failed to parse PumpPortal message', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods — Event Parsing
  // ---------------------------------------------------------------------------

  /**
   * Parses a raw WebSocket message into a typed PumpPortalEvent.
   *
   * Event type determination follows PumpPortal's message structure:
   * 1. If `txType` field exists → PumpPortalTrade (type: 'trade')
   * 2. If `pool` field exists (and no txType) → PumpPortalMigration (type: 'migration')
   * 3. If `mint` field exists with `initialBuy` → PumpPortalNewToken (type: 'newToken')
   *
   * Adds `timestamp: Date.now()` if the raw event does not include one.
   *
   * @param raw - The parsed JSON object from the WebSocket message
   * @returns A typed PumpPortalEvent, or null for unrecognized event types
   */
  private parseEvent(raw: unknown): PumpPortalEvent | null {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      this.logger.debug('Received non-object WebSocket message, skipping');
      return null;
    }

    const msg = raw as Record<string, unknown>;
    const timestamp =
      typeof msg['timestamp'] === 'number' ? msg['timestamp'] : Date.now();

    // Detection order matters — check most specific fields first

    // 1. Trade event: has txType field ('buy' or 'sell')
    if (typeof msg['txType'] === 'string') {
      const txType = msg['txType'] as string;
      if (txType === 'buy' || txType === 'sell') {
        const trade: PumpPortalTrade = {
          type: 'trade',
          signature: typeof msg['signature'] === 'string' ? msg['signature'] : '',
          mint: typeof msg['mint'] === 'string' ? msg['mint'] : '',
          traderPublicKey:
            typeof msg['traderPublicKey'] === 'string' ? msg['traderPublicKey'] : '',
          txType: txType as 'buy' | 'sell',
          tokenAmount: typeof msg['tokenAmount'] === 'number' ? msg['tokenAmount'] : 0,
          solAmount: typeof msg['solAmount'] === 'number' ? msg['solAmount'] : 0,
          newTokenBalance:
            typeof msg['newTokenBalance'] === 'number' ? msg['newTokenBalance'] : 0,
          bondingCurveKey:
            typeof msg['bondingCurveKey'] === 'string' ? msg['bondingCurveKey'] : '',
          vTokensInBondingCurve:
            typeof msg['vTokensInBondingCurve'] === 'number'
              ? msg['vTokensInBondingCurve']
              : 0,
          vSolInBondingCurve:
            typeof msg['vSolInBondingCurve'] === 'number'
              ? msg['vSolInBondingCurve']
              : 0,
          marketCapSol:
            typeof msg['marketCapSol'] === 'number' ? msg['marketCapSol'] : 0,
          timestamp,
        };
        return trade;
      }
    }

    // 2. Migration event: has pool field (and not a trade)
    if (typeof msg['pool'] === 'string' && typeof msg['txType'] !== 'string') {
      const migration: PumpPortalMigration = {
        type: 'migration',
        mint: typeof msg['mint'] === 'string' ? msg['mint'] : '',
        pool: msg['pool'] as string,
        timestamp,
      };
      return migration;
    }

    // 3. New token event: has mint field with creation metadata (initialBuy)
    if (typeof msg['mint'] === 'string' && msg['initialBuy'] !== undefined) {
      const newToken: PumpPortalNewToken = {
        type: 'newToken',
        mint: msg['mint'] as string,
        name: typeof msg['name'] === 'string' ? msg['name'] : '',
        symbol: typeof msg['symbol'] === 'string' ? msg['symbol'] : '',
        uri: typeof msg['uri'] === 'string' ? msg['uri'] : '',
        traderPublicKey:
          typeof msg['traderPublicKey'] === 'string' ? msg['traderPublicKey'] : '',
        initialBuy:
          typeof msg['initialBuy'] === 'number' ? msg['initialBuy'] : 0,
        bondingCurveKey:
          typeof msg['bondingCurveKey'] === 'string' ? msg['bondingCurveKey'] : '',
        vTokensInBondingCurve:
          typeof msg['vTokensInBondingCurve'] === 'number'
            ? msg['vTokensInBondingCurve']
            : 0,
        vSolInBondingCurve:
          typeof msg['vSolInBondingCurve'] === 'number'
            ? msg['vSolInBondingCurve']
            : 0,
        marketCapSol:
          typeof msg['marketCapSol'] === 'number' ? msg['marketCapSol'] : 0,
        timestamp,
      };
      return newToken;
    }

    // Unrecognized event type
    this.logger.debug('Unrecognized PumpPortal event structure', msg);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private Methods — Connection Event Handlers
  // ---------------------------------------------------------------------------

  /**
   * Handles the WebSocket `open` event.
   *
   * When the connection opens (either initial connection or reconnection):
   * 1. Re-subscribes to all previously active subscriptions (ensures
   *    continuity after reconnection)
   * 2. Sends all pending subscriptions that were queued before connection
   * 3. Clears the pending subscription queue
   *
   * This method is critical for the reconnection workflow — without it,
   * subscriptions would be lost after every WebSocket reconnect cycle.
   */
  private handleOpen(): void {
    this.logger.info('PumpPortal WebSocket connected');

    // Re-subscribe to all active subscriptions (reconnection recovery)
    for (const subJson of this.activeSubscriptions) {
      try {
        const payload = JSON.parse(subJson) as SubscriptionPayload;
        this.wsManager.send(JSON.stringify(payload));
        this.logger.debug(`Re-subscribed: ${payload.method}`);
      } catch (err: unknown) {
        this.logger.warn('Failed to re-subscribe on reconnect', err);
      }
    }

    // Send pending subscriptions that were queued while disconnected
    const pending = [...this.pendingSubscriptions];
    this.pendingSubscriptions = [];

    for (const payload of pending) {
      this.sendSubscription(payload);
    }

    if (pending.length > 0) {
      this.logger.info(`Sent ${pending.length} pending subscription(s)`);
    }
  }

  /**
   * Handles the WebSocket `close` event.
   *
   * Logs the disconnect with code and reason. The WebSocketManager handles
   * automatic reconnection with exponential backoff — this handler just
   * provides diagnostic logging and subscription state marking.
   *
   * @param code - WebSocket close code (e.g., 1000 for normal closure)
   * @param reason - Human-readable close reason
   */
  private handleClose(code: number, reason: string): void {
    this.logger.info(`PumpPortal WebSocket closed: code=${code}, reason=${reason}`);

    // Mark all subscriptions as inactive during disconnect
    for (const [, subscription] of this.subscriptionRegistry) {
      subscription.active = false;
    }
  }

  /**
   * Handles WebSocket error events.
   *
   * WebSocket errors are always followed by a close event, so reconnection
   * is handled via `handleClose` → WebSocketManager's auto-reconnect.
   * This handler provides diagnostic error logging.
   *
   * @param error - The WebSocket error event
   */
  private handleError(error: Event): void {
    this.logger.error('PumpPortal WebSocket error occurred', error);
  }

  /**
   * Handles the reconnection-exhausted event from WebSocketManager.
   *
   * Invoked when all reconnection attempts (default: 5 with exponential
   * backoff 1s→2s→4s→8s→16s) have been exhausted. Delegates to the
   * external `reconnectFailedCallback` which the background script should
   * set to trigger chrome.alarms-based polling at 30–60 second intervals.
   *
   * Per AAP Section 0.7.6: "If WebSocket connections fail persistently,
   * the system must degrade to polling-based data retrieval using
   * chrome.alarms at 30–60 second intervals"
   */
  private handleReconnectFailed(): void {
    this.logger.error(
      'PumpPortal WebSocket reconnection failed after all retries. ' +
      'Background script should switch to chrome.alarms polling fallback.',
    );

    // Mark all subscriptions as inactive
    for (const [, subscription] of this.subscriptionRegistry) {
      subscription.active = false;
    }

    // Invoke the external callback for graceful degradation
    if (this.reconnectFailedCallback) {
      try {
        this.reconnectFailedCallback();
      } catch (err: unknown) {
        this.logger.error('Error in reconnectFailed callback', err);
      }
    }
  }
}
