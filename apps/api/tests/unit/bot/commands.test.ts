/**
 * Bot Command Handler Unit Tests — /start, /settings, /status
 *
 * Comprehensive unit tests for all 3 Telegram bot command handlers exported
 * from `apps/api/src/bot/commands/`. Uses Vitest ^3.0.x with vi.mock() for
 * complete dependency isolation — no real database, Redis, or Telegram API
 * connections. Every test validates isolated command handler behavior.
 *
 * Test coverage:
 *  - handleStart  — 7 test cases (registration, idempotency, MarkdownV2, errors)
 *  - handleSettings — 8 test cases (lookup, keyboard, escaping, error handling)
 *  - handleStatus  — 10 test cases (queues, sources, graceful degradation, indicators)
 *
 * @module tests/unit/bot/commands
 * @see AAP Rule 0.7.1 — TypeScript strict mode, no `any` types
 * @see AAP Rule 0.7.2 — Financial decimal precision (minConfidence as string)
 * @see AAP Rule 0.7.5 — MarkdownV2 character escaping compliance
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// vi.mock() calls — hoisted to file top by Vitest's transform engine.
// Factory functions execute BEFORE any imports, providing complete module
// isolation. Variables declared outside vi.mock() are NOT accessible inside
// the factory — only vi.fn() and other vitest globals are available.
// ---------------------------------------------------------------------------

vi.mock("../../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../../../src/db/schema/user-settings.js", () => ({
  userSettings: {
    telegramChatId: "telegram_chat_id",
  },
}));

vi.mock("../../../src/db/schema/api-sources.js", () => ({
  apiSources: {
    name: "name",
    isActive: "is_active",
    errorCount: "error_count",
  },
}));

vi.mock("../../../src/lib/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../../src/bot/keyboards.js", () => ({
  buildSettingsKeyboard: vi.fn().mockReturnValue({ inline_keyboard: [] }),
  buildMarketKeyboard: vi.fn().mockReturnValue({ inline_keyboard: [] }),
  buildTimeframeKeyboard: vi.fn().mockReturnValue({ inline_keyboard: [] }),
  buildConfidenceKeyboard: vi.fn().mockReturnValue({ inline_keyboard: [] }),
  CALLBACK_PREFIXES: {
    MARKET_TOGGLE: "market:",
    TIMEFRAME_TOGGLE: "timeframe:",
    CONFIDENCE_SET: "confidence:",
    BACK_TO_SETTINGS: "settings:back",
  },
}));

vi.mock("../../../src/queues/index.js", () => ({
  newsPollingQueue: { getJobCounts: vi.fn() },
  analysisQueue: { getJobCounts: vi.fn() },
  notificationsQueue: { getJobCounts: vi.fn() },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ column: col, value: val })),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Handler imports (test subjects) — loaded AFTER mocks are established.
// Vitest's mock hoisting guarantees the mocks are active when these modules
// are resolved, so each handler receives mocked dependencies.
// ---------------------------------------------------------------------------

import { handleStart } from "../../../src/bot/commands/start.js";
import { handleSettings } from "../../../src/bot/commands/settings.js";
import { handleStatus } from "../../../src/bot/commands/status.js";

// ---------------------------------------------------------------------------
// Mocked module imports for assertion access.
// These imports resolve to the same mock objects created in vi.mock(),
// allowing tests to configure return values and verify call arguments.
// ---------------------------------------------------------------------------

import { db } from "../../../src/db/index.js";
import { buildSettingsKeyboard } from "../../../src/bot/keyboards.js";
import {
  newsPollingQueue,
  analysisQueue,
  notificationsQueue,
} from "../../../src/queues/index.js";

// ---------------------------------------------------------------------------
// Mock grammY Context Factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock grammY Context object with configurable overrides.
 * All async methods (reply, answerCallbackQuery, etc.) are pre-configured
 * as Vitest mock functions resolving to undefined.
 *
 * @param overrides — Optional configuration for chat ID, user identity, etc.
 * @returns A plain object matching the subset of grammY Context used by handlers.
 */
function createMockContext(
  overrides: {
    chatId?: number;
    username?: string;
    firstName?: string;
    noChatId?: boolean;
    noUsername?: boolean;
  } = {},
) {
  return {
    chat: overrides.noChatId
      ? undefined
      : { id: overrides.chatId ?? 123456789 },
    from: {
      username: overrides.noUsername
        ? undefined
        : (overrides.username ?? "test_user"),
      first_name: overrides.firstName ?? "Test",
    },
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    update: { update_id: 12345 },
  };
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe("Bot Command Handlers", () => {
  // ======================================================================
  // handleStart — /start Command Handler Tests
  // ======================================================================
  describe("handleStart", () => {
    let mockCtx: ReturnType<typeof createMockContext>;
    let mockOnConflictDoNothing: Mock;
    let mockValues: Mock;

    beforeEach(() => {
      vi.clearAllMocks();
      mockCtx = createMockContext({
        chatId: 123456789,
        username: "test_trader",
      });

      // Setup chainable mock: db.insert(table).values({...}).onConflictDoNothing()
      mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
      mockValues = vi.fn().mockReturnValue({
        onConflictDoNothing: mockOnConflictDoNothing,
      });
      (db.insert as Mock).mockReturnValue({ values: mockValues });
    });

    it("should register new user with default preferences", async () => {
      await handleStart(
        mockCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // Verify db.insert() was called
      expect(db.insert).toHaveBeenCalled();

      // Verify .values() received correct default preferences
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramChatId: "123456789",
          username: "test_trader",
          markets: ["us_stock", "indian_equity", "crypto"],
          minConfidence: "0.70",
          timeframes: ["intraday", "swing", "position"],
          isActive: true,
        }),
      );

      // Verify idempotent insert via onConflictDoNothing
      expect(mockOnConflictDoNothing).toHaveBeenCalled();

      // Verify MarkdownV2 welcome message was sent
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parse_mode: "MarkdownV2" }),
      );
    });

    it("should handle duplicate registration gracefully via onConflictDoNothing", async () => {
      // First registration
      await handleStart(
        mockCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // Second registration with same context (duplicate)
      await handleStart(
        mockCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // onConflictDoNothing should have been called for both invocations
      expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(2);

      // Welcome message sent both times (returning users see intro again)
      expect(mockCtx.reply).toHaveBeenCalledTimes(2);
    });

    it("should send MarkdownV2 formatted welcome message", async () => {
      await handleStart(
        mockCtx as unknown as Parameters<typeof handleStart>[0],
      );

      const replyCall = mockCtx.reply.mock.calls[0] as unknown[] | undefined;
      expect(replyCall).toBeDefined();
      const messageText = replyCall![0] as string;

      // Verify MarkdownV2 escape sequences (AAP Rule 0.7.5)
      // In TS source: \\! → runtime string: \!
      expect(messageText).toContain("\\!");  // escaped exclamation
      expect(messageText).toContain("\\+");  // escaped plus (30+)
      expect(messageText).toContain("\\(");  // escaped open paren
      expect(messageText).toContain("\\)");  // escaped close paren
      expect(messageText).toContain("\\-");  // escaped hyphen (stop-loss)
      expect(messageText).toContain("\\'");   // escaped apostrophe (I'll)

      // Verify parse_mode in options
      const options = replyCall![1] as Record<string, unknown>;
      expect(options.parse_mode).toBe("MarkdownV2");
    });

    it("should handle missing chat ID gracefully", async () => {
      const noChatCtx = createMockContext({ noChatId: true });

      await handleStart(
        noChatCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // Should reply with identification error
      expect(noChatCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Unable to identify"),
      );

      // Database should NOT be accessed
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("should use username fallback to first_name when username is absent", async () => {
      const noUsernameCtx = createMockContext({
        chatId: 123456789,
        noUsername: true,
        firstName: "TestUser",
      });

      await handleStart(
        noUsernameCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // Verify .values() was called with first_name as the username fallback
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "TestUser",
        }),
      );
    });

    it("should handle database error gracefully", async () => {
      // Make the onConflictDoNothing call reject to simulate DB failure
      mockOnConflictDoNothing.mockRejectedValueOnce(
        new Error("Database connection failed"),
      );

      await handleStart(
        mockCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // Verify an error reply was sent
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("error occurred"),
      );

      // Verify the error reply is plain text (NOT MarkdownV2)
      // Since the DB error occurs before the welcome message reply,
      // only the catch-block reply fires — with 1 argument (no options)
      const lastCall = mockCtx.reply.mock.calls[
        mockCtx.reply.mock.calls.length - 1
      ] as unknown[];
      expect(lastCall).toHaveLength(1);
    });

    it("should store minConfidence as string '0.70' not number", async () => {
      await handleStart(
        mockCtx as unknown as Parameters<typeof handleStart>[0],
      );

      // Extract the values argument passed to .values()
      const valuesArg = mockValues.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(valuesArg).toBeDefined();

      // CRITICAL — AAP Rule 0.7.2: Financial decimal precision
      // minConfidence MUST be stored as a string "0.70", NOT a number 0.7
      // This prevents floating-point precision loss in PostgreSQL numeric(3,2)
      expect(typeof valuesArg!.minConfidence).toBe("string");
      expect(valuesArg!.minConfidence).toBe("0.70");
    });
  });

  // ======================================================================
  // handleSettings — /settings Command Handler Tests
  // ======================================================================
  describe("handleSettings", () => {
    let mockCtx: ReturnType<typeof createMockContext>;
    let mockLimit: Mock;
    let mockWhere: Mock;
    let mockFrom: Mock;

    /** Default registered user returned by the mock DB chain. */
    const defaultMockUser = {
      id: "uuid-123",
      telegramChatId: "123456789",
      username: "test_trader",
      markets: ["us_stock", "crypto"],
      minConfidence: "0.70",
      timeframes: ["intraday", "swing"],
      isActive: true,
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockCtx = createMockContext({ chatId: 123456789 });

      // Setup chainable mock: db.select().from(table).where(cond).limit(n)
      // Default: returns a registered user
      mockLimit = vi.fn().mockResolvedValue([defaultMockUser]);
      mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as Mock).mockReturnValue({ from: mockFrom });
    });

    it("should display current settings with inline keyboard", async () => {
      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Settings"),
        expect.objectContaining({
          parse_mode: "MarkdownV2",
          reply_markup: expect.any(Object),
        }),
      );
      expect(buildSettingsKeyboard).toHaveBeenCalled();
    });

    it("should show current markets, timeframes, and confidence in settings message", async () => {
      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      const replyCall = mockCtx.reply.mock.calls[0] as unknown[] | undefined;
      expect(replyCall).toBeDefined();
      const messageText = replyCall![0] as string;

      // The handler escapes _ in "us_stock" → "us\_stock" for MarkdownV2
      expect(messageText).toContain("us\\_stock");
      expect(messageText).toContain("crypto");

      // Timeframes should be present in the message
      expect(messageText).toContain("intraday");
      expect(messageText).toContain("swing");

      // Confidence 0.70 is escaped to 0\.70 for MarkdownV2
      expect(messageText).toContain("0\\.70");
    });

    it("should prompt unregistered user to use /start", async () => {
      // Override mock to return empty array — no user found
      mockLimit.mockResolvedValue([]);

      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      // Should prompt user to register
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("/start"),
        expect.objectContaining({ parse_mode: "MarkdownV2" }),
      );

      // buildSettingsKeyboard should NOT be called for unregistered users
      expect(buildSettingsKeyboard).not.toHaveBeenCalled();
    });

    it("should look up user by telegram chat ID", async () => {
      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      // Verify the full query chain was invoked
      expect(db.select).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(1);
    });

    it("should handle missing chat ID gracefully", async () => {
      const noChatCtx = createMockContext({ noChatId: true });

      await handleSettings(
        noChatCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      expect(noChatCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Unable to identify"),
      );

      // No database query should be made
      expect(db.select).not.toHaveBeenCalled();
    });

    it("should handle database error gracefully", async () => {
      // Make the query chain reject to simulate DB failure
      mockLimit.mockRejectedValue(new Error("Database connection failed"));

      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      // Should send plain-text error reply (not MarkdownV2)
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("error occurred"),
      );
    });

    it("should escape special characters in dynamic settings values for MarkdownV2", async () => {
      // Override user with values containing MarkdownV2 special characters
      mockLimit.mockResolvedValue([
        {
          ...defaultMockUser,
          markets: ["us_stock", "indian_equity"],
          timeframes: ["intraday", "position"],
          minConfidence: "0.80",
        },
      ]);

      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      const replyCall = mockCtx.reply.mock.calls[0] as unknown[] | undefined;
      expect(replyCall).toBeDefined();
      const messageText = replyCall![0] as string;

      // _ in "us_stock" escaped to "us\_stock"
      expect(messageText).toContain("us\\_stock");
      // _ in "indian_equity" escaped to "indian\_equity"
      expect(messageText).toContain("indian\\_equity");
      // . in "0.80" escaped to "0\.80"
      expect(messageText).toContain("0\\.80");
    });

    it("should use buildSettingsKeyboard from keyboards.ts", async () => {
      await handleSettings(
        mockCtx as unknown as Parameters<typeof handleSettings>[0],
      );

      // Verify keyboard builder was called exactly once
      expect(buildSettingsKeyboard).toHaveBeenCalledTimes(1);

      // Verify the returned keyboard was passed as reply_markup
      const replyCall = mockCtx.reply.mock.calls[0] as unknown[] | undefined;
      expect(replyCall).toBeDefined();
      const options = replyCall![1] as Record<string, unknown>;
      expect(options.reply_markup).toEqual({ inline_keyboard: [] });
    });
  });

  // ======================================================================
  // handleStatus — /status Command Handler Tests
  // ======================================================================
  describe("handleStatus", () => {
    let mockCtx: ReturnType<typeof createMockContext>;
    let mockStatusFrom: Mock;

    /** Default queue job counts for all 3 queues. */
    const defaultCounts = {
      waiting: 0,
      active: 0,
      completed: 100,
      failed: 0,
      delayed: 0,
    };

    /** Default API sources for the status display. */
    const defaultSources = [
      { name: "Finnhub", isActive: true, errorCount: 0 },
      { name: "CoinGecko", isActive: true, errorCount: 3 },
      { name: "NSE India", isActive: false, errorCount: 10 },
    ];

    beforeEach(() => {
      vi.clearAllMocks();
      mockCtx = createMockContext({ chatId: 123456789 });

      // Setup queue mocks with default job counts
      (newsPollingQueue.getJobCounts as Mock).mockResolvedValue({
        ...defaultCounts,
      });
      (analysisQueue.getJobCounts as Mock).mockResolvedValue({
        ...defaultCounts,
      });
      (notificationsQueue.getJobCounts as Mock).mockResolvedValue({
        ...defaultCounts,
      });

      // Setup db.select for api_sources:
      // db.select({ name, isActive, errorCount }).from(apiSources)
      mockStatusFrom = vi.fn().mockResolvedValue([...defaultSources]);
      (db.select as Mock).mockReturnValue({ from: mockStatusFrom });
    });

    it("should display system status with queue counts", async () => {
      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      // Verify MarkdownV2 reply was sent
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parse_mode: "MarkdownV2" }),
      );

      // Verify all 3 queues were queried
      expect(newsPollingQueue.getJobCounts).toHaveBeenCalled();
      expect(analysisQueue.getJobCounts).toHaveBeenCalled();
      expect(notificationsQueue.getJobCounts).toHaveBeenCalled();
    });

    it("should show queue job counts in the status message", async () => {
      // Set distinguishable queue counts for verification
      (newsPollingQueue.getJobCounts as Mock).mockResolvedValue({
        waiting: 5,
        active: 1,
        completed: 200,
        failed: 2,
        delayed: 0,
      });
      (analysisQueue.getJobCounts as Mock).mockResolvedValue({
        waiting: 10,
        active: 3,
        completed: 150,
        failed: 0,
        delayed: 0,
      });
      (notificationsQueue.getJobCounts as Mock).mockResolvedValue({
        waiting: 0,
        active: 0,
        completed: 50,
        failed: 1,
        delayed: 0,
      });

      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      const replyCall = mockCtx.reply.mock.calls[0] as unknown[] | undefined;
      expect(replyCall).toBeDefined();
      const messageText = replyCall![0] as string;

      // Verify specific count values are present in the message
      // (numbers have no MarkdownV2 special chars, so they appear as-is)
      expect(messageText).toContain("5");   // news waiting
      expect(messageText).toContain("200"); // news completed
      expect(messageText).toContain("10");  // analysis waiting
      expect(messageText).toContain("150"); // analysis completed
      expect(messageText).toContain("50");  // notifications completed
    });

    it("should show API source status with health indicators", async () => {
      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      const replyCall = mockCtx.reply.mock.calls[0] as unknown[] | undefined;
      expect(replyCall).toBeDefined();
      const messageText = replyCall![0] as string;

      // Verify source names are present
      expect(messageText).toContain("Finnhub");
      expect(messageText).toContain("CoinGecko");

      // Verify health indicator emojis:
      // 🟢 Finnhub (enabled, errorCount=0 ≤ 5 threshold)
      // 🟢 CoinGecko (enabled, errorCount=3 ≤ 5 threshold)
      // 🔴 NSE India (disabled — isActive=false)
      expect(messageText).toContain("🟢");
      expect(messageText).toContain("🔴");
    });

    it("should use concurrent data fetching with Promise.all", async () => {
      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      // All 4 async operations should have been called (3 queues + 1 DB query)
      expect(newsPollingQueue.getJobCounts).toHaveBeenCalledTimes(1);
      expect(analysisQueue.getJobCounts).toHaveBeenCalledTimes(1);
      expect(notificationsQueue.getJobCounts).toHaveBeenCalledTimes(1);
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it("should handle queue errors gracefully (return zeros)", async () => {
      // Make one queue fail — handler should still succeed via getQueueCounts
      // internal try/catch returning zeros
      (newsPollingQueue.getJobCounts as Mock).mockRejectedValue(
        new Error("Redis connection lost"),
      );

      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      // Handler should NOT throw — it gracefully degrades with zeroed counts
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parse_mode: "MarkdownV2" }),
      );

      // Status message should still contain the header
      const messageText = mockCtx.reply.mock.calls[0]?.[0] as string;
      expect(messageText).toBeDefined();
      expect(messageText).toContain("System Status");
    });

    it("should handle database errors gracefully (empty sources)", async () => {
      // Make db.select chain reject — getApiSourceStatus catches and returns []
      mockStatusFrom.mockRejectedValue(
        new Error("Database unavailable"),
      );

      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      // Handler should still reply with partial status
      expect(mockCtx.reply).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ parse_mode: "MarkdownV2" }),
      );

      // Message should contain the "unable to fetch" warning for empty sources
      const messageText = mockCtx.reply.mock.calls[0]?.[0] as string;
      expect(messageText).toBeDefined();
      expect(messageText).toContain("Unable to fetch API source status");
    });

    it("should handle missing chat ID gracefully", async () => {
      const noChatCtx = createMockContext({ noChatId: true });

      await handleStatus(
        noChatCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      expect(noChatCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Unable to identify"),
      );

      // No queue or DB queries should be made when chat ID is missing
      expect(newsPollingQueue.getJobCounts).not.toHaveBeenCalled();
      expect(analysisQueue.getJobCounts).not.toHaveBeenCalled();
      expect(notificationsQueue.getJobCounts).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it("should escape all dynamic content for MarkdownV2 compliance", async () => {
      // Set source names with MarkdownV2 special characters
      mockStatusFrom.mockResolvedValue([
        { name: "Alpha.Vantage", isActive: true, errorCount: 0 },
        { name: "NSE_India (v2)", isActive: true, errorCount: 1 },
      ]);

      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      const messageText = mockCtx.reply.mock.calls[0]?.[0] as string;
      expect(messageText).toBeDefined();

      // The handler's escapeMarkdownV2() should escape . and _ and ( and )
      expect(messageText).toContain("Alpha\\.Vantage");
      expect(messageText).toContain("NSE\\_India");
    });

    it("should show yellow indicator for sources with high error count", async () => {
      // Set an API source with isActive=true but errorCount > 5 (threshold)
      mockStatusFrom.mockResolvedValue([
        { name: "Degraded API", isActive: true, errorCount: 10 },
      ]);

      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      const messageText = mockCtx.reply.mock.calls[0]?.[0] as string;
      expect(messageText).toBeDefined();

      // 🟡 indicator for enabled source with high error count (>5)
      expect(messageText).toContain("🟡");
    });

    it("should handle complete system failure gracefully", async () => {
      // Make ALL queue getJobCounts reject
      (newsPollingQueue.getJobCounts as Mock).mockRejectedValue(
        new Error("Redis down"),
      );
      (analysisQueue.getJobCounts as Mock).mockRejectedValue(
        new Error("Redis down"),
      );
      (notificationsQueue.getJobCounts as Mock).mockRejectedValue(
        new Error("Redis down"),
      );

      // Make DB reject
      mockStatusFrom.mockRejectedValue(new Error("DB down"));

      // Make the FIRST ctx.reply fail (MarkdownV2 status reply) to trigger
      // the top-level catch block. The second call (plain error reply) succeeds.
      // Note: individual helpers catch their own errors and return defaults,
      // so Promise.all still resolves. The top-level catch only fires when
      // ctx.reply itself throws.
      mockCtx.reply
        .mockRejectedValueOnce(new Error("Telegram API failure"))
        .mockResolvedValueOnce(undefined);

      await handleStatus(
        mockCtx as unknown as Parameters<typeof handleStatus>[0],
      );

      // Handler should have called reply twice:
      // 1st: MarkdownV2 status (rejected) → 2nd: plain error fallback (resolved)
      expect(mockCtx.reply).toHaveBeenCalledTimes(2);

      // The second (fallback) reply should contain the error message
      const fallbackCallArgs = mockCtx.reply.mock.calls[1] as unknown[];
      expect(fallbackCallArgs).toBeDefined();
      expect(fallbackCallArgs[0]).toContain("error occurred");
    });
  });
});
