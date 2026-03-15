/**
 * @file src/streaming/types.ts — WebSocket Streaming Type Definitions
 *
 * Foundational type definitions for the streaming module. Defines the core
 * interfaces, types, and constants used by WebSocket connection managers
 * and stream-specific handlers (PumpPortal, Birdeye).
 *
 * This file has NO imports — it is a pure TypeScript type definitions module.
 *
 * Consumers:
 * - src/streaming/manager.ts → ConnectionState, ReconnectionConfig, KeepaliveConfig
 * - src/streaming/pump-portal-stream.ts → StreamSubscription, StreamEvent, ConnectionState
 * - src/streaming/birdeye-stream.ts → StreamSubscription, StreamEvent, ConnectionState
 * - src/api/pump-portal.ts → ConnectionState
 * - src/utils/messaging.ts → May reference streaming types
 *
 * @module streaming/types
 */

// ============================================================================
// Stream Source Identification
// ============================================================================

/**
 * Identifiers for WebSocket stream sources.
 * Used to tag events and subscriptions by their originating stream.
 */
export type StreamSource = 'pump-portal' | 'birdeye';

// ============================================================================
// Connection State
// ============================================================================

/**
 * Possible states of a WebSocket connection.
 * Maps to the WebSocket lifecycle and reconnection logic.
 *
 * State transitions:
 * - 'closed' → 'connecting' (initial connection or manual reconnect)
 * - 'connecting' → 'open' (connection established)
 * - 'connecting' → 'closed' (connection failed, no retries left)
 * - 'open' → 'closing' (graceful shutdown initiated)
 * - 'open' → 'reconnecting' (unexpected disconnect, auto-reconnect)
 * - 'closing' → 'closed' (clean shutdown complete)
 * - 'reconnecting' → 'connecting' (retry attempt in progress)
 * - 'reconnecting' → 'closed' (all retry attempts exhausted)
 */
export type ConnectionState =
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed'
  | 'reconnecting';

// ============================================================================
// Stream Events
// ============================================================================

/**
 * Generic stream event emitted from WebSocket connections.
 * Each stream handler (PumpPortal, Birdeye) produces events
 * that conform to this base shape.
 *
 * @example
 * ```typescript
 * const event: StreamEvent = {
 *   type: 'newToken',
 *   data: { mint: 'ABC123...', name: 'MoonCoin', symbol: 'MOON' },
 *   timestamp: Date.now(),
 *   source: 'pump-portal',
 * };
 * ```
 */
export interface StreamEvent {
  /** Event type identifier (e.g., 'newToken', 'trade', 'priceUpdate', 'migration') */
  type: string;

  /** Event data payload — specific shape depends on the event type and source */
  data: unknown;

  /** Timestamp when the event was received (milliseconds since Unix epoch) */
  timestamp: number;

  /**
   * Source of the event identifying which WebSocket stream produced it.
   * Optional to allow internal synthetic events without a specific source.
   */
  source?: StreamSource;
}

// ============================================================================
// Stream Subscriptions
// ============================================================================

/**
 * Represents an active subscription on a WebSocket connection.
 * Used to track active subscriptions for automatic re-subscription on reconnection.
 *
 * @example
 * ```typescript
 * const subscription: StreamSubscription = {
 *   channel: 'subscribeNewToken',
 *   params: {},
 *   subscribedAt: Date.now(),
 *   active: true,
 * };
 * ```
 */
export interface StreamSubscription {
  /**
   * Channel or event type subscribed to.
   * Examples: 'subscribeNewToken', 'subscribeTokenTrade', 'subscribeMigration',
   * 'SUBSCRIBE_PRICE', 'SUBSCRIBE_TXS', 'SUBSCRIBE_TOKEN_NEW_LISTING'
   */
  channel: string;

  /**
   * Subscription parameters specific to the channel.
   * For PumpPortal: may include `keys` array of token mint addresses.
   * For Birdeye: may include token addresses, query type, chain identifier.
   */
  params?: Record<string, unknown>;

  /** Timestamp (ms since epoch) when the subscription was first created */
  subscribedAt?: number;

  /** Whether this subscription is currently active and receiving events */
  active?: boolean;
}

// ============================================================================
// Reconnection Configuration
// ============================================================================

/**
 * Configuration for WebSocket reconnection behavior.
 *
 * Per AAP Section 0.7.6:
 * - Exponential backoff: 1s → 2s → 4s → 8s → 16s
 * - Maximum 5 retry attempts
 * - After max retries: fall back to chrome.alarms-based polling
 *
 * @example
 * ```typescript
 * const config: ReconnectionConfig = {
 *   maxRetries: 5,
 *   backoffMs: [1000, 2000, 4000, 8000, 16000],
 *   baseDelayMs: 1000,
 *   maxDelayMs: 16000,
 * };
 * ```
 */
export interface ReconnectionConfig {
  /** Maximum number of reconnection attempts before giving up (default: 5) */
  maxRetries: number;

  /**
   * Backoff delays in milliseconds for each retry attempt.
   * Index 0 = first retry delay, index 1 = second retry delay, etc.
   * If the attempt index exceeds the array length, the last value is used.
   */
  backoffMs: readonly number[];

  /**
   * Base delay in milliseconds for exponential backoff calculation.
   * Used when computing dynamic backoff instead of using the fixed array.
   */
  baseDelayMs?: number;

  /** Maximum delay cap in milliseconds to prevent excessively long waits */
  maxDelayMs?: number;
}

/**
 * Default reconnection configuration per AAP Section 0.7.6.
 *
 * Exponential backoff sequence: 1s, 2s, 4s, 8s, 16s
 * Maximum retry attempts: 5
 * After exhausting retries, the system should fall back to
 * chrome.alarms-based polling at 30-60 second intervals.
 */
export const DEFAULT_RECONNECTION_CONFIG: ReconnectionConfig = {
  maxRetries: 5,
  backoffMs: [1000, 2000, 4000, 8000, 16000] as const,
  baseDelayMs: 1000,
  maxDelayMs: 16000,
} as const;

// ============================================================================
// Keepalive Configuration
// ============================================================================

/**
 * Configuration for WebSocket keepalive behavior.
 *
 * Per AAP Section 0.7.6:
 * - All WebSocket connections must send a keepalive ping every 20 seconds
 *   to prevent Chrome 116+ service worker idle termination and to detect
 *   dead connections.
 *
 * @example
 * ```typescript
 * const keepalive: KeepaliveConfig = {
 *   intervalMs: 20000,
 *   pingMessage: JSON.stringify({ type: 'ping' }),
 *   deadTimeoutMs: 60000,
 * };
 * ```
 */
export interface KeepaliveConfig {
  /**
   * Interval between keepalive pings in milliseconds.
   * Default: 20000 (20 seconds) per AAP specification.
   */
  intervalMs: number;

  /**
   * The message to send as a keepalive ping.
   * Format depends on the WebSocket server protocol
   * (e.g., JSON string, plain text, or binary ping frame).
   */
  pingMessage: string;

  /**
   * Timeout in milliseconds after which a connection is considered dead
   * if no message (including pong responses) has been received.
   * Recommended: 3× the intervalMs (e.g., 60000ms for a 20s interval).
   */
  deadTimeoutMs: number;
}

// ============================================================================
// WebSocket Event Handlers
// ============================================================================

/**
 * Callbacks for WebSocket lifecycle events.
 * Used by the WebSocket connection manager to delegate event handling
 * to stream-specific handlers (PumpPortal, Birdeye).
 *
 * All callbacks are optional — handlers only need to implement the
 * events they care about.
 */
export interface WebSocketEventHandlers {
  /**
   * Called when a message is received from the WebSocket.
   * The data parameter is the raw string message from the WebSocket.
   * Parsing into specific event types is the handler's responsibility.
   *
   * @param data - Raw message string received from the WebSocket
   */
  onMessage?: (data: string) => void;

  /**
   * Called when the WebSocket connection is successfully established.
   * Handlers should use this to send initial subscription messages.
   */
  onOpen?: () => void;

  /**
   * Called when the WebSocket connection is closed.
   * The close code and reason provide context about why the connection ended.
   *
   * @param code - WebSocket close code (e.g., 1000 for normal closure, 1006 for abnormal)
   * @param reason - Human-readable reason for the closure
   */
  onClose?: (code: number, reason: string) => void;

  /**
   * Called when a WebSocket error occurs.
   * Note: In most browsers, the error event does not contain detailed
   * error information — the close event that follows typically provides
   * more useful diagnostics.
   *
   * @param error - The error event from the WebSocket
   */
  onError?: (error: Event) => void;

  /**
   * Called when all reconnection attempts have been exhausted.
   * Handlers should use this to trigger fallback behavior
   * (e.g., switching to chrome.alarms-based polling).
   */
  onReconnectFailed?: () => void;
}

// ============================================================================
// Stream Manager Status
// ============================================================================

/**
 * Status snapshot of a WebSocket stream manager.
 * Provides a read-only view of the connection's current health and state.
 * Useful for health monitoring dashboards and UI status indicators.
 *
 * @example
 * ```typescript
 * const status: StreamManagerStatus = {
 *   connectionState: 'open',
 *   isAlive: true,
 *   reconnectAttempts: 0,
 *   maxReconnectRetries: 5,
 *   lastMessageTime: Date.now(),
 *   activeSubscriptions: 3,
 *   url: 'wss://pumpportal.fun/api/data',
 * };
 * ```
 */
export interface StreamManagerStatus {
  /** Current connection state of the WebSocket */
  connectionState: ConnectionState;

  /**
   * Whether the connection is alive and actively receiving data.
   * True when connectionState is 'open' and the last message was received
   * within the keepalive dead timeout window.
   */
  isAlive: boolean;

  /** Number of reconnection attempts made since the last successful connection */
  reconnectAttempts: number;

  /** Maximum allowed reconnection attempts (from ReconnectionConfig.maxRetries) */
  maxReconnectRetries: number;

  /** Timestamp (ms since epoch) of the last received message. 0 if no messages received yet. */
  lastMessageTime: number;

  /** Count of currently active subscriptions on this connection */
  activeSubscriptions: number;

  /** The WebSocket URL this manager connects to */
  url: string;
}
