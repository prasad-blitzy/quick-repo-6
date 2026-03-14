/**
 * tests/integration/websocket-stream.test.ts — WebSocket Manager Reconnection and Keepalive Test
 *
 * Integration test verifying the WebSocket manager's lifecycle management,
 * keepalive behavior, reconnection logic, subscription management, and
 * graceful degradation for both PumpPortal and Birdeye WebSocket connections.
 *
 * Per AAP Section 0.7.6 (WebSocket Connection Rules):
 * - 20-second keepalive ping interval
 * - Exponential backoff reconnection: 1s → 2s → 4s → 8s → 16s
 * - Maximum 5 retry attempts before falling back to chrome.alarms polling
 * - Graceful degradation: remain functional without WebSocket streaming
 * - Single PumpPortal connection enforcement
 *
 * @module tests/integration/websocket-stream
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocketManager } from '../../src/streaming/manager';
import { PumpPortalStream } from '../../src/streaming/pump-portal-stream';
import { BirdeyeStream } from '../../src/streaming/birdeye-stream';
import type {
  ConnectionState,
  ReconnectionConfig,
  StreamEvent,
  StreamSubscription,
  KeepaliveConfig,
} from '../../src/streaming/types';
import { DEFAULT_RECONNECTION_CONFIG } from '../../src/streaming/types';
import type {
  PumpPortalNewToken,
  PumpPortalTrade,
  PumpPortalMigration,
} from '../../src/api/types';
import { PUMP_PORTAL_WS, TIMING } from '../../src/utils/config';

// =============================================================================
// Mock Logger — suppress console output during tests
// =============================================================================

vi.mock('../../src/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// MockWebSocket — Simulates the native WebSocket API with controllable events
// =============================================================================

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sentMessages: string[] = [];
  protocol: string = '';
  extensions: string = '';
  binaryType: BinaryType = 'blob';
  bufferedAmount: number = 0;

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSING;
    setTimeout(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({
        code: code ?? 1000,
        reason: reason ?? '',
        wasClean: true,
      } as CloseEvent);
    }, 0);
  }

  // --- Test helper methods ---

  /** Simulate the WebSocket open event (server accepted connection) */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  /** Simulate receiving a message from the server */
  simulateMessage(data: unknown): void {
    this.onmessage?.({
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MessageEvent);
  }

  /** Simulate an abnormal or clean close event */
  simulateClose(
    code: number = 1006,
    reason: string = '',
    wasClean: boolean = false,
  ): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }

  /** Simulate a WebSocket error event */
  simulateError(): void {
    this.onerror?.({} as Event);
  }

  /** Add no-op event listener method for compatibility */
  addEventListener(): void {
    // No-op for compatibility
  }

  /** Add no-op removeEventListener for compatibility */
  removeEventListener(): void {
    // No-op for compatibility
  }

  /** No-op dispatchEvent for compatibility */
  dispatchEvent(_event: Event): boolean {
    return true;
  }
}

// =============================================================================
// Test Utility Helpers
// =============================================================================

/** Returns the latest MockWebSocket instance created */
function getLatestWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

/** Returns the first MockWebSocket instance created */
function getFirstWs(): MockWebSocket {
  return MockWebSocket.instances[0];
}

/**
 * Helper to create a WebSocketManager, connect it, and simulate the connection
 * opening. Returns both the manager and the mock WebSocket instance.
 */
async function createConnectedManager(
  url: string = 'wss://pumpportal.fun/api/data',
  overrides: Partial<ConstructorParameters<typeof WebSocketManager>[0]> = {},
): Promise<{ manager: WebSocketManager; ws: MockWebSocket }> {
  const manager = new WebSocketManager({ url, ...overrides });
  const connectPromise = manager.connect();
  const ws = getLatestWs();
  ws.simulateOpen();
  await connectPromise;
  return { manager, ws };
}

/**
 * Helper that advances fake timers, processes micro-tasks, and then flushes
 * any newly scheduled timers. Essential for async reconnection workflows.
 */
async function advanceTimersAndFlush(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  // Allow pending Promises to resolve
  await vi.runAllTimersAsync?.() ?? Promise.resolve();
}

// =============================================================================
// Test Setup & Teardown
// =============================================================================

describe('WebSocket Integration Tests', () => {
  /** Store original WebSocket reference for cleanup */
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // Replace globalThis.WebSocket with MockWebSocket
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown as typeof WebSocket;

    // Reset chrome.alarms mocks for each test
    vi.mocked(chrome.alarms.create).mockClear();
    vi.mocked(chrome.alarms.clear).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // Restore original WebSocket
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  // ===========================================================================
  // Phase 4: WebSocket Manager Lifecycle
  // ===========================================================================

  describe('WebSocket Manager Lifecycle', () => {
    it('creates a WebSocket connection to the specified URL', async () => {
      const manager = new WebSocketManager({
        url: 'wss://pumpportal.fun/api/data',
      });

      const connectPromise = manager.connect();
      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.instances[0].url).toBe('wss://pumpportal.fun/api/data');

      // Complete the connection
      getLatestWs().simulateOpen();
      await connectPromise;
    });

    it('transitions through connection states: connecting → open', async () => {
      const manager = new WebSocketManager({
        url: 'wss://pumpportal.fun/api/data',
      });

      expect(manager.getConnectionState()).toBe('closed');

      const connectPromise = manager.connect();
      expect(manager.getConnectionState()).toBe('connecting');

      getLatestWs().simulateOpen();
      await connectPromise;

      expect(manager.getConnectionState()).toBe('open');
    });

    it('transitions to closed state on disconnect', async () => {
      const { manager } = await createConnectedManager();

      expect(manager.getConnectionState()).toBe('open');
      manager.disconnect();
      expect(manager.getConnectionState()).toBe('closed');
    });

    it('isConnected() returns true only when connection is open', async () => {
      const manager = new WebSocketManager({
        url: 'wss://pumpportal.fun/api/data',
      });

      // Before connect
      expect(manager.isConnected()).toBe(false);

      // After connect + open
      const connectPromise = manager.connect();
      expect(manager.isConnected()).toBe(false); // Still connecting

      getLatestWs().simulateOpen();
      await connectPromise;
      expect(manager.isConnected()).toBe(true);

      // After disconnect
      manager.disconnect();
      expect(manager.isConnected()).toBe(false);
    });

    it('isAlive() returns true when connection is open and recently active', async () => {
      const { manager } = await createConnectedManager();

      // Immediately after connection, isAlive() should be true
      expect(manager.isAlive()).toBe(true);

      // After advancing time close to the dead timeout (3x keepalive = 60s)
      // but still within it, isAlive() should be true
      vi.advanceTimersByTime(50_000);
      expect(manager.isAlive()).toBe(true);

      // After advancing past the dead timeout without activity
      vi.advanceTimersByTime(20_000); // Now 70s since last activity
      // The keepalive pings at 20s intervals will have reset lastMessageTime,
      // so isAlive should still be true as pings are being sent
      expect(manager.isAlive()).toBe(true);
    });

    it('allows sending messages when connected', async () => {
      const { manager, ws } = await createConnectedManager();

      manager.send('{"type":"test"}');
      expect(ws.sentMessages).toContain('{"type":"test"}');
    });

    it('throws when sending messages while not connected', () => {
      const manager = new WebSocketManager({
        url: 'wss://pumpportal.fun/api/data',
      });

      expect(() => manager.send('test')).toThrow('WebSocket is not connected');
    });

    it('enforces single connection semantics (no-op on duplicate connect)', async () => {
      const { manager } = await createConnectedManager();

      // Call connect again — should be a no-op
      await manager.connect();
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('getReconnectAttempts() returns 0 on successful connection', async () => {
      const { manager } = await createConnectedManager();
      expect(manager.getReconnectAttempts()).toBe(0);
    });

    it('resetReconnectCounter() resets the counter to 0', async () => {
      const { manager, ws } = await createConnectedManager();

      // Trigger abnormal close to increment counter
      ws.simulateClose(1006, 'abnormal');

      // Wait for first reconnect attempt
      vi.advanceTimersByTime(1000);
      expect(manager.getReconnectAttempts()).toBe(1);

      // Reset
      manager.resetReconnectCounter();
      expect(manager.getReconnectAttempts()).toBe(0);
    });
  });

  // ===========================================================================
  // Phase 5: 20-Second Keepalive Ping Behavior
  // ===========================================================================

  describe('20-Second Keepalive Ping', () => {
    it('sends a keepalive ping every 20 seconds', async () => {
      const { ws } = await createConnectedManager();

      // Clear initial messages
      ws.sentMessages = [];

      // Advance by 20 seconds — first ping
      vi.advanceTimersByTime(20_000);
      const pingMessages = ws.sentMessages.filter(
        (msg) => msg === '{"type":"ping"}',
      );
      expect(pingMessages.length).toBe(1);

      // Advance another 20 seconds — second ping
      vi.advanceTimersByTime(20_000);
      const allPings = ws.sentMessages.filter(
        (msg) => msg === '{"type":"ping"}',
      );
      expect(allPings.length).toBe(2);
    });

    it('keepalive interval matches TIMING.WEBSOCKET_KEEPALIVE_MS (20000ms)', async () => {
      expect(TIMING.WEBSOCKET_KEEPALIVE_MS).toBe(20_000);

      const { ws } = await createConnectedManager();
      ws.sentMessages = [];

      // Advance by 19999ms — should NOT have pinged yet
      vi.advanceTimersByTime(19_999);
      const noPings = ws.sentMessages.filter(
        (msg) => msg === '{"type":"ping"}',
      );
      expect(noPings.length).toBe(0);

      // Advance by 1ms more to hit exactly 20000ms
      vi.advanceTimersByTime(1);
      const onePing = ws.sentMessages.filter(
        (msg) => msg === '{"type":"ping"}',
      );
      expect(onePing.length).toBe(1);
    });

    it('stops keepalive pings when connection is closed', async () => {
      const { manager, ws } = await createConnectedManager();
      ws.sentMessages = [];

      // Verify first ping
      vi.advanceTimersByTime(20_000);
      expect(ws.sentMessages.filter((m) => m === '{"type":"ping"}').length).toBe(1);

      // Disconnect
      manager.disconnect();

      // Advance another 20s — no additional pings should be sent
      vi.advanceTimersByTime(20_000);
      expect(ws.sentMessages.filter((m) => m === '{"type":"ping"}').length).toBe(1);
    });

    it('resumes keepalive pings after successful reconnection', async () => {
      const { manager, ws } = await createConnectedManager();
      ws.sentMessages = [];

      // Verify first keepalive
      vi.advanceTimersByTime(20_000);
      expect(ws.sentMessages.filter((m) => m === '{"type":"ping"}').length).toBe(1);

      // Simulate abnormal close — triggers reconnection
      ws.simulateClose(1006, 'abnormal');

      // Advance past reconnect delay (1s)
      vi.advanceTimersByTime(1_000);

      // A new MockWebSocket instance should have been created
      const newWs = getLatestWs();
      expect(newWs).not.toBe(ws);

      // Simulate new connection opening
      newWs.simulateOpen();

      // Wait for keepalive to resume
      newWs.sentMessages = [];
      vi.advanceTimersByTime(20_000);

      const newPings = newWs.sentMessages.filter(
        (m) => m === '{"type":"ping"}',
      );
      expect(newPings.length).toBe(1);
    });

    it('sendPing() sends a keepalive through external trigger', async () => {
      const { manager, ws } = await createConnectedManager();
      ws.sentMessages = [];

      manager.sendPing();

      const pings = ws.sentMessages.filter((m) => m === '{"type":"ping"}');
      expect(pings.length).toBe(1);
    });

    it('sendPing() is a no-op when not connected', () => {
      const manager = new WebSocketManager({
        url: 'wss://pumpportal.fun/api/data',
      });

      // Should not throw
      expect(() => manager.sendPing()).not.toThrow();
    });
  });

  // ===========================================================================
  // Phase 6: Exponential Backoff Reconnection
  // ===========================================================================

  describe('Exponential Backoff Reconnection', () => {
    it('attempts reconnection with exponential backoff: 1s → 2s → 4s → 8s → 16s', async () => {
      const { ws } = await createConnectedManager();
      const initialInstanceCount = MockWebSocket.instances.length;

      // Simulate abnormal close
      ws.simulateClose(1006, 'abnormal');

      // Backoff attempt 1: 1000ms
      expect(MockWebSocket.instances.length).toBe(initialInstanceCount);
      vi.advanceTimersByTime(1_000);
      expect(MockWebSocket.instances.length).toBe(initialInstanceCount + 1);

      // Fail attempt 1
      getLatestWs().simulateClose(1006, 'failed');

      // Backoff attempt 2: 2000ms
      vi.advanceTimersByTime(2_000);
      expect(MockWebSocket.instances.length).toBe(initialInstanceCount + 2);

      // Fail attempt 2
      getLatestWs().simulateClose(1006, 'failed');

      // Backoff attempt 3: 4000ms
      vi.advanceTimersByTime(4_000);
      expect(MockWebSocket.instances.length).toBe(initialInstanceCount + 3);

      // Fail attempt 3
      getLatestWs().simulateClose(1006, 'failed');

      // Backoff attempt 4: 8000ms
      vi.advanceTimersByTime(8_000);
      expect(MockWebSocket.instances.length).toBe(initialInstanceCount + 4);

      // Fail attempt 4
      getLatestWs().simulateClose(1006, 'failed');

      // Backoff attempt 5: 16000ms
      vi.advanceTimersByTime(16_000);
      expect(MockWebSocket.instances.length).toBe(initialInstanceCount + 5);
    });

    it('limits reconnection to max 5 retries', async () => {
      const onReconnectFailed = vi.fn();
      const { ws, manager } = await createConnectedManager(
        'wss://pumpportal.fun/api/data',
        { onReconnectFailed },
      );
      const initialCount = MockWebSocket.instances.length;

      // Trigger abnormal close
      ws.simulateClose(1006, 'abnormal');

      // Exhaust all 5 retry attempts
      for (let attempt = 1; attempt <= 5; attempt++) {
        const delay = TIMING.RECONNECT_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        vi.advanceTimersByTime(delay);

        // Each attempt creates a new WS instance
        expect(MockWebSocket.instances.length).toBe(initialCount + attempt);

        // Fail the attempt (except on the last one, where we wait for the callback)
        getLatestWs().simulateClose(1006, 'failed');
      }

      // After 5 failures, onReconnectFailed should have been called
      expect(onReconnectFailed).toHaveBeenCalledTimes(1);

      // No 6th attempt should be made
      const countAfterMaxRetries = MockWebSocket.instances.length;
      vi.advanceTimersByTime(32_000); // Wait well beyond any possible backoff
      expect(MockWebSocket.instances.length).toBe(countAfterMaxRetries);

      // Manager should be in closed state
      expect(manager.getConnectionState()).toBe('closed');
    });

    it('resets retry counter on successful reconnection', async () => {
      const { manager, ws } = await createConnectedManager();

      // First abnormal close — triggers attemptReconnect(), counter → 1
      ws.simulateClose(1006, 'abnormal');

      // Reconnection attempt 1 fires after 1s, creates new WS
      vi.advanceTimersByTime(1_000);
      // Fail attempt 1 — triggers attemptReconnect() again, counter → 2
      getLatestWs().simulateClose(1006, 'failed');

      // Reconnection attempt 2 fires after 2s, creates new WS
      vi.advanceTimersByTime(2_000);
      // Succeed on attempt 2 — counter resets to 0 on open
      getLatestWs().simulateOpen();

      // Counter should reset to 0 on successful connection
      expect(manager.getReconnectAttempts()).toBe(0);

      // Now close again — backoff should restart from 1s (fresh cycle)
      const countBeforeSecondClose = MockWebSocket.instances.length;
      getLatestWs().simulateClose(1006, 'second failure');

      // First attempt of new cycle: 1000ms (not 4000ms, proving reset worked)
      vi.advanceTimersByTime(1_000);
      expect(MockWebSocket.instances.length).toBe(countBeforeSecondClose + 1);
      expect(manager.getReconnectAttempts()).toBe(1);
    });

    it('does not attempt reconnection on clean close (code 1000)', async () => {
      const { manager, ws } = await createConnectedManager();
      const countBefore = MockWebSocket.instances.length;

      // Intentional disconnect sends code 1000
      manager.disconnect();

      // Wait well beyond reconnection delay
      vi.advanceTimersByTime(30_000);

      // No new WebSocket instances should be created
      expect(MockWebSocket.instances.length).toBe(countBefore);
      expect(manager.getConnectionState()).toBe('closed');
    });

    it('attempts reconnection on abnormal close (code 1006)', async () => {
      const { ws } = await createConnectedManager();
      const countBefore = MockWebSocket.instances.length;

      // Simulate abnormal close
      ws.simulateClose(1006, 'abnormal');

      // After 1s backoff, a reconnection attempt should be made
      vi.advanceTimersByTime(1_000);
      expect(MockWebSocket.instances.length).toBe(countBefore + 1);
    });

    it('verifies backoff timing constants match AAP specification', () => {
      // Per AAP Section 0.7.6: base delay 1s, max retries 5
      expect(TIMING.RECONNECT_BACKOFF_BASE_MS).toBe(1_000);
      expect(TIMING.RECONNECT_MAX_RETRIES).toBe(5);

      // Verify DEFAULT_RECONNECTION_CONFIG matches
      expect(DEFAULT_RECONNECTION_CONFIG.maxRetries).toBe(5);
      expect(DEFAULT_RECONNECTION_CONFIG.backoffMs).toEqual([
        1000, 2000, 4000, 8000, 16000,
      ]);
      expect(DEFAULT_RECONNECTION_CONFIG.baseDelayMs).toBe(1_000);
      expect(DEFAULT_RECONNECTION_CONFIG.maxDelayMs).toBe(16_000);
    });
  });

  // ===========================================================================
  // Phase 7: Graceful Degradation to chrome.alarms Polling
  // ===========================================================================

  describe('Graceful Degradation', () => {
    it('invokes onReconnectFailed callback after max retries exceeded', async () => {
      const onReconnectFailed = vi.fn();
      const { ws } = await createConnectedManager(
        'wss://pumpportal.fun/api/data',
        { onReconnectFailed },
      );

      // Trigger abnormal close
      ws.simulateClose(1006, 'abnormal');

      // Exhaust all 5 retry attempts
      const backoffSequence = [1_000, 2_000, 4_000, 8_000, 16_000];
      for (const delay of backoffSequence) {
        vi.advanceTimersByTime(delay);
        getLatestWs().simulateClose(1006, 'failed');
      }

      // onReconnectFailed should have been called once
      expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    });

    it('the onReconnectFailed callback can create chrome.alarms for polling fallback', async () => {
      const onReconnectFailed = vi.fn(() => {
        // Simulate background.ts creating a polling alarm
        chrome.alarms.create('ws-fallback-poll', {
          periodInMinutes: 0.5, // 30 seconds
        });
      });

      const { ws } = await createConnectedManager(
        'wss://pumpportal.fun/api/data',
        { onReconnectFailed },
      );

      // Trigger abnormal close and exhaust retries
      ws.simulateClose(1006, 'abnormal');
      const backoffSequence = [1_000, 2_000, 4_000, 8_000, 16_000];
      for (const delay of backoffSequence) {
        vi.advanceTimersByTime(delay);
        getLatestWs().simulateClose(1006, 'failed');
      }

      // Verify chrome.alarms.create was called with appropriate period
      expect(chrome.alarms.create).toHaveBeenCalledWith(
        'ws-fallback-poll',
        expect.objectContaining({
          periodInMinutes: expect.any(Number),
        }),
      );

      // Per AAP Section 0.7.6: polling at 30-60 second intervals
      const alarmCall = vi.mocked(chrome.alarms.create).mock.calls[0];
      const period = (alarmCall[1] as { periodInMinutes: number }).periodInMinutes;
      expect(period).toBeGreaterThanOrEqual(0.5); // 30 seconds
      expect(period).toBeLessThanOrEqual(1.0); // 60 seconds
    });

    it('manager reports closed state after all retries exhausted', async () => {
      const onReconnectFailed = vi.fn();
      const { manager, ws } = await createConnectedManager(
        'wss://pumpportal.fun/api/data',
        { onReconnectFailed },
      );

      ws.simulateClose(1006, 'abnormal');
      const backoffSequence = [1_000, 2_000, 4_000, 8_000, 16_000];
      for (const delay of backoffSequence) {
        vi.advanceTimersByTime(delay);
        getLatestWs().simulateClose(1006, 'failed');
      }

      // Manager should be in 'closed' state (not 'reconnecting')
      expect(manager.getConnectionState()).toBe('closed');
      expect(manager.isConnected()).toBe(false);
    });
  });

  // ===========================================================================
  // Phase 8: PumpPortal Single Connection Constraint
  // ===========================================================================

  describe('PumpPortal Single Connection', () => {
    it('maintains exactly one WebSocket connection (PumpPortal requirement)', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      const ws = getLatestWs();
      ws.simulateOpen();
      await connectPromise;

      // Try to connect again — should be no-op
      await stream.connect();

      // Only ONE WebSocket instance should exist
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('connects to wss://pumpportal.fun/api/data', async () => {
      expect(PUMP_PORTAL_WS).toBe('wss://pumpportal.fun/api/data');

      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      const ws = getLatestWs();

      expect(ws.url).toBe('wss://pumpportal.fun/api/data');

      ws.simulateOpen();
      await connectPromise;
    });

    it('does not create parallel connections on rapid connect calls', async () => {
      const stream = new PumpPortalStream();

      // Fire multiple connect calls rapidly
      const promise1 = stream.connect();
      const promise2 = stream.connect();
      const promise3 = stream.connect();

      // Only one WebSocket should be created
      expect(MockWebSocket.instances.length).toBe(1);

      getLatestWs().simulateOpen();
      await Promise.all([promise1, promise2, promise3]);

      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('reports connection state correctly', async () => {
      const stream = new PumpPortalStream();

      expect(stream.getConnectionState()).toBe('closed');

      const connectPromise = stream.connect();
      expect(stream.getConnectionState()).toBe('connecting');
      expect(stream.isConnected()).toBe(false);

      getLatestWs().simulateOpen();
      await connectPromise;

      expect(stream.getConnectionState()).toBe('open');
      expect(stream.isConnected()).toBe(true);
    });
  });

  // ===========================================================================
  // Phase 9: Subscription Multiplexing
  // ===========================================================================

  describe('Subscription Multiplexing', () => {
    it('subscribes to subscribeNewToken on single connection', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      stream.subscribeNewToken(vi.fn());

      const newTokenSubs = ws.sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.method === 'subscribeNewToken';
        } catch {
          return false;
        }
      });
      expect(newTokenSubs.length).toBe(1);
      expect(JSON.parse(newTokenSubs[0])).toEqual({
        method: 'subscribeNewToken',
      });
    });

    it('subscribes to subscribeTokenTrade on same connection', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      stream.subscribeTokenTrade(['mint123'], vi.fn());

      const tradeSubs = ws.sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.method === 'subscribeTokenTrade';
        } catch {
          return false;
        }
      });
      expect(tradeSubs.length).toBe(1);
      expect(JSON.parse(tradeSubs[0])).toEqual({
        method: 'subscribeTokenTrade',
        keys: ['mint123'],
      });
    });

    it('subscribes to subscribeMigration on same connection', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      stream.subscribeMigration(vi.fn());

      const migrationSubs = ws.sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.method === 'subscribeMigration';
        } catch {
          return false;
        }
      });
      expect(migrationSubs.length).toBe(1);
      expect(JSON.parse(migrationSubs[0])).toEqual({
        method: 'subscribeMigration',
      });
    });

    it('all subscriptions use the SAME WebSocket instance', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      stream.subscribeNewToken(vi.fn());
      stream.subscribeTokenTrade(['mintABC'], vi.fn());
      stream.subscribeMigration(vi.fn());

      // All subscriptions should be on the same WebSocket instance
      expect(MockWebSocket.instances.length).toBe(1);

      // All subscription messages should appear in the SAME ws.sentMessages
      const parsedMessages = ws.sentMessages.map((msg) => JSON.parse(msg));
      const methods = parsedMessages.map(
        (m: { method: string }) => m.method,
      );

      expect(methods).toContain('subscribeNewToken');
      expect(methods).toContain('subscribeTokenTrade');
      expect(methods).toContain('subscribeMigration');
    });

    it('handles multiple concurrent subscriptions without conflict', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      // Subscribe to multiple event types and multiple mints
      stream.subscribeNewToken(vi.fn());
      stream.subscribeTokenTrade(['mint1'], vi.fn());
      stream.subscribeTokenTrade(['mint2'], vi.fn());

      const parsedMessages = ws.sentMessages.map((msg) => JSON.parse(msg));

      // Should have 3 distinct subscription payloads
      expect(parsedMessages.length).toBe(3);

      // Verify each subscription type is present
      expect(parsedMessages).toContainEqual({ method: 'subscribeNewToken' });
      expect(parsedMessages).toContainEqual({
        method: 'subscribeTokenTrade',
        keys: ['mint1'],
      });
      expect(parsedMessages).toContainEqual({
        method: 'subscribeTokenTrade',
        keys: ['mint2'],
      });
    });

    it('tracks active subscription count accurately', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      expect(stream.getActiveSubscriptionCount()).toBe(0);

      stream.subscribeNewToken(vi.fn());
      expect(stream.getActiveSubscriptionCount()).toBe(1);

      stream.subscribeTokenTrade(['mint1'], vi.fn());
      expect(stream.getActiveSubscriptionCount()).toBe(2);

      stream.subscribeMigration(vi.fn());
      expect(stream.getActiveSubscriptionCount()).toBe(3);
    });
  });

  // ===========================================================================
  // Phase 10: Automatic Re-Subscription After Reconnection
  // ===========================================================================

  describe('Automatic Re-Subscription', () => {
    it('re-subscribes to all active subscriptions after successful reconnection', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      // Subscribe to 3 different event types
      stream.subscribeNewToken(vi.fn());
      stream.subscribeTokenTrade(['mintX'], vi.fn());
      stream.subscribeMigration(vi.fn());

      // Simulate abnormal close (triggers reconnection via WebSocketManager)
      getLatestWs().simulateClose(1006, 'abnormal');

      // Wait for first reconnection attempt (1s backoff)
      vi.advanceTimersByTime(1_000);

      // A new WebSocket instance should be created
      const newWs = getLatestWs();
      expect(newWs).toBeTruthy();

      // Simulate new connection open — this triggers handleOpen()
      // which re-subscribes to all active subscriptions
      newWs.simulateOpen();

      // Check that the new WebSocket received re-subscription messages
      const parsedMessages = newWs.sentMessages.map((msg) => {
        try { return JSON.parse(msg); } catch { return null; }
      }).filter(Boolean);

      const methods = parsedMessages.map(
        (m: Record<string, unknown>) => m.method,
      );

      expect(methods).toContain('subscribeNewToken');
      expect(methods).toContain('subscribeTokenTrade');
      expect(methods).toContain('subscribeMigration');
    });

    it('preserves subscription state across reconnections', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      // Subscribe to trades for multiple mints
      const tradeCallback = vi.fn();
      stream.subscribeTokenTrade(['mintA', 'mintB', 'mintC'], tradeCallback);

      // Disconnect + reconnect
      getLatestWs().simulateClose(1006, 'abnormal');
      vi.advanceTimersByTime(1_000);
      const newWs = getLatestWs();
      newWs.simulateOpen();

      // Check that trade subscription with all 3 mints is restored
      const tradeMessages = newWs.sentMessages
        .map((msg) => {
          try { return JSON.parse(msg); } catch { return null; }
        })
        .filter((m) => m && m.method === 'subscribeTokenTrade');

      expect(tradeMessages.length).toBeGreaterThanOrEqual(1);

      // The keys should contain all original mints
      const allKeys = tradeMessages.flatMap(
        (m: Record<string, unknown>) => (m.keys as string[]) || [],
      );
      expect(allKeys).toContain('mintA');
      expect(allKeys).toContain('mintB');
      expect(allKeys).toContain('mintC');
    });

    it('does not duplicate subscriptions on reconnection', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      // Subscribe once
      stream.subscribeNewToken(vi.fn());

      // Disconnect + reconnect
      getLatestWs().simulateClose(1006, 'abnormal');
      vi.advanceTimersByTime(1_000);
      const newWs = getLatestWs();
      newWs.simulateOpen();

      // Count subscribeNewToken messages on the new connection
      const newTokenMessages = newWs.sentMessages
        .map((msg) => {
          try { return JSON.parse(msg); } catch { return null; }
        })
        .filter((m) => m && m.method === 'subscribeNewToken');

      // Should appear exactly once (re-subscription), not duplicated
      expect(newTokenMessages.length).toBe(1);
    });
  });

  // ===========================================================================
  // Phase 11: PumpPortal Event Parsing
  // ===========================================================================

  describe('PumpPortal Event Parsing', () => {
    it('parses subscribeNewToken events into typed PumpPortalNewToken', async () => {
      const onNewToken = vi.fn();
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribeNewToken(onNewToken);

      // Simulate incoming new token event
      const rawEvent = {
        mint: 'TokenMint123abc',
        name: 'MoonCoin',
        symbol: 'MOON',
        uri: 'https://arweave.net/metadata123',
        traderPublicKey: 'CreatorWallet456',
        initialBuy: 1.5,
        bondingCurveKey: 'BondingCurve789',
        vTokensInBondingCurve: 1000000,
        vSolInBondingCurve: 100,
        marketCapSol: 50,
        timestamp: 1710000000000,
      };

      getLatestWs().simulateMessage(rawEvent);

      expect(onNewToken).toHaveBeenCalledTimes(1);
      const event = onNewToken.mock.calls[0][0] as PumpPortalNewToken;
      expect(event.type).toBe('newToken');
      expect(event.mint).toBe('TokenMint123abc');
      expect(event.name).toBe('MoonCoin');
      expect(event.symbol).toBe('MOON');
      expect(event.uri).toBe('https://arweave.net/metadata123');
      expect(event.bondingCurveKey).toBe('BondingCurve789');
      expect(event.timestamp).toBe(1710000000000);
    });

    it('parses subscribeTokenTrade events into typed PumpPortalTrade', async () => {
      const onTrade = vi.fn();
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribeTokenTrade(['tradeMint'], onTrade);

      // Simulate incoming trade event
      const rawTrade = {
        signature: 'TxSig123abc',
        mint: 'tradeMint',
        traderPublicKey: 'TraderWallet789',
        txType: 'buy',
        tokenAmount: 50000,
        solAmount: 2.5,
        newTokenBalance: 50000,
        bondingCurveKey: 'BC456',
        vTokensInBondingCurve: 950000,
        vSolInBondingCurve: 102.5,
        marketCapSol: 55,
        timestamp: 1710000001000,
      };

      getLatestWs().simulateMessage(rawTrade);

      expect(onTrade).toHaveBeenCalledTimes(1);
      const event = onTrade.mock.calls[0][0] as PumpPortalTrade;
      expect(event.type).toBe('trade');
      expect(event.mint).toBe('tradeMint');
      expect(event.traderPublicKey).toBe('TraderWallet789');
      expect(event.txType).toBe('buy');
      expect(event.tokenAmount).toBe(50000);
      expect(event.solAmount).toBe(2.5);
      expect(event.signature).toBe('TxSig123abc');
    });

    it('parses subscribeMigration events into typed PumpPortalMigration', async () => {
      const onMigration = vi.fn();
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribeMigration(onMigration);

      // Simulate incoming migration event
      const rawMigration = {
        mint: 'migratedMint',
        pool: 'RaydiumPool123',
        timestamp: 1710000002000,
      };

      getLatestWs().simulateMessage(rawMigration);

      expect(onMigration).toHaveBeenCalledTimes(1);
      const event = onMigration.mock.calls[0][0] as PumpPortalMigration;
      expect(event.type).toBe('migration');
      expect(event.mint).toBe('migratedMint');
      expect(event.pool).toBe('RaydiumPool123');
      expect(event.timestamp).toBe(1710000002000);
    });

    it('handles malformed WebSocket messages gracefully', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const onNewToken = vi.fn();
      stream.subscribeNewToken(onNewToken);

      // Send invalid JSON — should not crash the stream
      const ws = getLatestWs();
      ws.onmessage?.({
        data: 'this is not valid JSON {{{',
      } as MessageEvent);

      // Callback should not have been called
      expect(onNewToken).not.toHaveBeenCalled();

      // Stream should still be operational — send a valid event
      const validEvent = {
        mint: 'validMint',
        name: 'ValidCoin',
        symbol: 'VAL',
        uri: 'https://example.com',
        traderPublicKey: 'wallet',
        initialBuy: 1.0,
        bondingCurveKey: 'bc',
        vTokensInBondingCurve: 1000000,
        vSolInBondingCurve: 100,
        marketCapSol: 50,
        timestamp: Date.now(),
      };
      ws.simulateMessage(validEvent);
      expect(onNewToken).toHaveBeenCalledTimes(1);
    });

    it('handles empty/null WebSocket messages gracefully', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const onNewToken = vi.fn();
      stream.subscribeNewToken(onNewToken);

      // Send null-ish JSON
      getLatestWs().simulateMessage(null);
      expect(onNewToken).not.toHaveBeenCalled();

      // Send empty object
      getLatestWs().simulateMessage({});
      expect(onNewToken).not.toHaveBeenCalled();
    });

    it('parses sell trades with correct txType', async () => {
      const onTrade = vi.fn();
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribeTokenTrade(['sellMint'], onTrade);

      const rawSellTrade = {
        signature: 'SellSig',
        mint: 'sellMint',
        traderPublicKey: 'Seller',
        txType: 'sell',
        tokenAmount: 10000,
        solAmount: 1.0,
        newTokenBalance: 0,
        bondingCurveKey: 'bc',
        vTokensInBondingCurve: 1010000,
        vSolInBondingCurve: 99,
        marketCapSol: 48,
        timestamp: Date.now(),
      };

      getLatestWs().simulateMessage(rawSellTrade);

      const event = onTrade.mock.calls[0][0] as PumpPortalTrade;
      expect(event.txType).toBe('sell');
    });
  });

  // ===========================================================================
  // Phase 12: Birdeye WebSocket Stream
  // ===========================================================================

  describe('Birdeye WebSocket Stream', () => {
    it('connects to Birdeye WebSocket with API key authentication', async () => {
      const stream = new BirdeyeStream('test-birdeye-api-key');
      const connectPromise = stream.connect();
      const ws = getLatestWs();

      // Verify connection URL is derived from Birdeye base URL
      expect(ws.url).toContain('birdeye');

      // Simulate open
      ws.simulateOpen();
      await connectPromise;

      // After open, the BirdeyeStream should send an AUTH message
      const authMessages = ws.sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === 'AUTH';
        } catch {
          return false;
        }
      });

      expect(authMessages.length).toBe(1);
      const authPayload = JSON.parse(authMessages[0]);
      expect(authPayload.type).toBe('AUTH');
      expect(authPayload.data.apiKey).toBe('test-birdeye-api-key');
    });

    it('subscribes to SUBSCRIBE_PRICE events', async () => {
      const stream = new BirdeyeStream('test-key');
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      // Clear auth message
      ws.sentMessages = [];

      const priceCallback = vi.fn();
      stream.subscribePrice('TokenMint456', priceCallback);

      // Find the price subscription command
      const priceSubs = ws.sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.type === 'SUBSCRIBE_PRICE';
        } catch {
          return false;
        }
      });

      expect(priceSubs.length).toBe(1);
      const parsed = JSON.parse(priceSubs[0]);
      expect(parsed.type).toBe('SUBSCRIBE_PRICE');
      expect(parsed.data.address).toBe('TokenMint456');
    });

    it('parses Birdeye price update events', async () => {
      const priceCallback = vi.fn();
      const stream = new BirdeyeStream('test-key');
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribePrice('PriceMint', priceCallback);

      // Simulate incoming price update
      const rawPriceUpdate = {
        type: 'PRICE_UPDATE',
        data: {
          address: 'PriceMint',
          price: 0.00123,
          priceChange24h: 15.5,
          volume24h: 50000,
          timestamp: Date.now(),
        },
      };

      getLatestWs().simulateMessage(JSON.stringify(rawPriceUpdate));

      // Verify callback was invoked with parsed data
      expect(priceCallback).toHaveBeenCalledTimes(1);
    });

    it('requires API key to connect', async () => {
      const stream = new BirdeyeStream('');
      await expect(stream.connect()).rejects.toThrow();
    });

    it('reports connection state correctly', async () => {
      const stream = new BirdeyeStream('api-key');

      expect(stream.getConnectionState()).toBe('closed');
      expect(stream.isConnected()).toBe(false);

      const connectPromise = stream.connect();
      expect(stream.getConnectionState()).toBe('connecting');

      getLatestWs().simulateOpen();
      await connectPromise;

      expect(stream.getConnectionState()).toBe('open');
      expect(stream.isConnected()).toBe(true);
    });

    it('tracks subscribed tokens', async () => {
      const stream = new BirdeyeStream('api-key');
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribePrice('Token1', vi.fn());
      stream.subscribePrice('Token2', vi.fn());
      stream.subscribeTransactions('Token3', vi.fn());

      const tokens = stream.getSubscribedTokens();
      expect(tokens).toContain('Token1');
      expect(tokens).toContain('Token2');
      expect(tokens).toContain('Token3');
    });

    it('supports onReconnectFailed callback', async () => {
      const reconnectFailed = vi.fn();
      const stream = new BirdeyeStream('api-key');

      stream.onReconnectFailed(reconnectFailed);

      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      // Trigger abnormal close and exhaust retries
      getLatestWs().simulateClose(1006, 'abnormal');

      const backoffSequence = [1_000, 2_000, 4_000, 8_000, 16_000];
      for (const delay of backoffSequence) {
        vi.advanceTimersByTime(delay);
        getLatestWs().simulateClose(1006, 'failed');
      }

      expect(reconnectFailed).toHaveBeenCalledTimes(1);
    });

    it('cleans up on disconnect', async () => {
      const stream = new BirdeyeStream('api-key');
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribePrice('Token1', vi.fn());
      stream.subscribeTransactions('Token2', vi.fn());

      // Disconnect should clear all state
      stream.disconnect();

      expect(stream.isConnected()).toBe(false);
      expect(stream.getSubscribedTokens()).toEqual([]);
    });
  });

  // ===========================================================================
  // Phase 13: PumpPortal subscribeAccountTrade
  // ===========================================================================

  describe('PumpPortal Account Trade Subscription', () => {
    it('subscribes to account trade events', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      const callback = vi.fn();
      stream.subscribeAccountTrade(['wallet1', 'wallet2'], callback);

      const accountSubs = ws.sentMessages.filter((msg) => {
        try {
          const parsed = JSON.parse(msg);
          return parsed.method === 'subscribeAccountTrade';
        } catch {
          return false;
        }
      });

      expect(accountSubs.length).toBe(1);
      const parsed = JSON.parse(accountSubs[0]);
      expect(parsed.method).toBe('subscribeAccountTrade');
      expect(parsed.keys).toContain('wallet1');
      expect(parsed.keys).toContain('wallet2');
    });
  });

  // ===========================================================================
  // Phase 14: PumpPortal Stream Keepalive Delegation
  // ===========================================================================

  describe('PumpPortal Stream Keepalive', () => {
    it('delegates sendPing to underlying WebSocketManager', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      const ws = getLatestWs();
      ws.sentMessages = [];

      stream.sendPing();

      const pings = ws.sentMessages.filter(
        (m) => m === '{"type":"ping"}',
      );
      expect(pings.length).toBe(1);
    });
  });

  // ===========================================================================
  // Phase 15: Comprehensive Disconnect and Cleanup
  // ===========================================================================

  describe('Disconnect and Cleanup', () => {
    it('PumpPortal disconnect clears all state', async () => {
      const stream = new PumpPortalStream();
      const connectPromise = stream.connect();
      getLatestWs().simulateOpen();
      await connectPromise;

      stream.subscribeNewToken(vi.fn());
      stream.subscribeTokenTrade(['m1'], vi.fn());
      stream.subscribeMigration(vi.fn());

      expect(stream.getActiveSubscriptionCount()).toBe(3);

      stream.disconnect();

      expect(stream.isConnected()).toBe(false);
      expect(stream.getConnectionState()).toBe('closed');
      expect(stream.getActiveSubscriptionCount()).toBe(0);
    });

    it('WebSocketManager disconnect cancels pending reconnections', async () => {
      const { manager, ws } = await createConnectedManager();

      // Trigger abnormal close
      ws.simulateClose(1006, 'abnormal');

      // Don't wait for reconnection — disconnect immediately
      manager.disconnect();

      // Advance past all potential backoff delays
      vi.advanceTimersByTime(60_000);

      // Only the original WS instance + no new reconnection attempts
      // The manager should have cancelled the pending reconnect timer
      expect(manager.getConnectionState()).toBe('closed');
      expect(manager.getReconnectAttempts()).toBe(0);
    });
  });
});
