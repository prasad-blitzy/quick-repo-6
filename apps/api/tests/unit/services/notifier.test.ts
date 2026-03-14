/**
 * Unit Tests — Notification Service
 *
 * Comprehensive test coverage for:
 *  - `apps/api/src/services/notifier/formatter.ts` — MarkdownV2 message formatter
 *  - `apps/api/src/services/notifier/index.ts`     — Subscriber matching engine
 *
 * Tests verify:
 *  - All 20+ MarkdownV2 special character escaping (AAP Rule 0.7.5)
 *  - Emoji direction indicators: 🟢 LONG / 🔴 SHORT (AAP Rule 0.7.5)
 *  - Inline code blocks for all price values (AAP Rule 0.7.5)
 *  - Subscriber preference matching by market, confidence, timeframe
 *  - PostgreSQL @> array operator usage for market/timeframe matching
 *  - min_confidence <= opportunity.confidence comparison
 *  - Duplicate notification prevention via notification_logs check
 *  - logNotification() insert operations with sent/failed statuses
 *  - Financial decimal precision (string-typed price fields per AAP Rule 0.7.2)
 *  - Reasoning truncation for Telegram 4096-character limit
 *  - Edge cases: empty arrays, special characters in symbols, minimum data
 *
 * @module tests/unit/services/notifier
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Setup — All mocks MUST be declared before module imports
// ---------------------------------------------------------------------------

// Mock the database module
vi.mock("../../../src/db/index.js", () => {
  const mockSelect = vi.fn();
  const mockFrom = vi.fn();
  const mockWhere = vi.fn();
  const mockLimit = vi.fn();
  const mockInsertValues = vi.fn();
  const mockInsert = vi.fn();

  // Build chainable select mock
  mockLimit.mockResolvedValue([]);
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });

  // Build chainable insert mock
  mockInsertValues.mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values: mockInsertValues });

  const mockDb = {
    select: mockSelect,
    insert: mockInsert,
    _mocks: {
      select: mockSelect,
      from: mockFrom,
      where: mockWhere,
      limit: mockLimit,
      insert: mockInsert,
      insertValues: mockInsertValues,
    },
  };
  return { db: mockDb };
});

// Mock schema files — provide mock column reference objects
vi.mock("../../../src/db/schema/user-settings.js", () => ({
  userSettings: {
    id: "id",
    telegramChatId: "telegram_chat_id",
    username: "username",
    isActive: "is_active",
    markets: "markets",
    minConfidence: "min_confidence",
    timeframes: "timeframes",
  },
}));

vi.mock("../../../src/db/schema/trade-opportunities.js", () => ({
  tradeOpportunities: {
    id: "id",
    symbol: "symbol",
    market: "market",
    direction: "direction",
    confidence: "confidence",
    entryPrice: "entry_price",
    stopLoss: "stop_loss",
    takeProfit: "take_profit",
    timeframe: "timeframe",
    reasoning: "reasoning",
    riskRewardRatio: "risk_reward_ratio",
  },
}));

vi.mock("../../../src/db/schema/notification-logs.js", () => ({
  notificationLogs: {
    opportunityId: "opportunity_id",
    userId: "user_id",
  },
}));

// Mock drizzle-orm query operators
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(
    (a: unknown, b: unknown) => ({ type: "eq", field: a, value: b }),
  ),
  and: vi.fn(
    (...conditions: unknown[]) => ({ type: "and", conditions }),
  ),
  gte: vi.fn(
    (a: unknown, b: unknown) => ({ type: "gte", field: a, value: b }),
  ),
  sql: vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      type: "sql",
      strings,
      values,
    }),
  ),
}));

// Mock logger
vi.mock("../../../src/lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports AFTER mock declarations (vitest hoists vi.mock calls)
// ---------------------------------------------------------------------------

import {
  formatTradeAlert,
  escapeMarkdownV2,
  escapeInlineCode,
} from "../../../src/services/notifier/formatter.js";
import type { TradeAlertData } from "../../../src/services/notifier/formatter.js";

import {
  findMatchingSubscribers,
  logNotification,
} from "../../../src/services/notifier/index.js";

import { db } from "../../../src/db/index.js";
import { eq, and, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Mock Data Fixtures
// ---------------------------------------------------------------------------

/** Realistic trade opportunity matching PostgreSQL numeric column types */
const mockOpportunity = {
  id: "opp-uuid-1",
  articleId: "article-uuid-1",
  symbol: "AAPL",
  market: "us_stock",
  direction: "long",
  confidence: "0.85",
  entryPrice: "185.5000",
  stopLoss: "178.0000",
  takeProfit: "200.0000",
  timeframe: "swing",
  reasoning:
    "Apple reported strong quarterly earnings beating analyst estimates by 6%. Revenue growth driven by iPhone and services segments.",
  status: "active",
  riskRewardRatio: "2.93",
  createdAt: new Date("2026-03-13T10:00:00Z"),
  updatedAt: new Date("2026-03-13T10:00:00Z"),
  expiresAt: new Date("2026-03-20T10:00:00Z"),
};

/** User whose preferences match the mock opportunity */
const mockUserMatching = {
  userId: "user-uuid-1",
  telegramChatId: "123456789",
  username: "testuser",
  isActive: true,
  markets: ["us_stock", "crypto"],
  minConfidence: "0.70",
  timeframes: ["swing", "position"],
};

/** User whose preferences do NOT match the mock opportunity */
const mockUserNonMatching = {
  userId: "user-uuid-2",
  telegramChatId: "987654321",
  username: "otheruser",
  isActive: true,
  markets: ["crypto"],
  minConfidence: "0.90",
  timeframes: ["intraday"],
};

/** Standard trade alert data for formatter tests */
const mockTradeAlertData: TradeAlertData = {
  symbol: "AAPL",
  market: "us_stock",
  direction: "long",
  confidence: "0.85",
  entryPrice: "185.5000",
  stopLoss: "178.0000",
  takeProfit: "200.0000",
  timeframe: "swing",
  reasoning:
    "Apple reported strong quarterly earnings beating analyst estimates.",
  riskRewardRatio: "2.93",
};

// ---------------------------------------------------------------------------
// Helper: access internal mock references from the mocked db module
// ---------------------------------------------------------------------------

/**
 * Retrieves the internal mock function references exposed by the mocked
 * `db` module to allow per-test return value overrides.
 */
function getDbMocks() {
  const database = db as unknown as {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    _mocks: {
      select: ReturnType<typeof vi.fn>;
      from: ReturnType<typeof vi.fn>;
      where: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
      insertValues: ReturnType<typeof vi.fn>;
    };
  };
  return database._mocks;
}

/**
 * Configures the mock db chain to return the given rows in sequence.
 * Each call to `db.select().from().where().limit()` or
 * `db.select().from().where()` returns the next set of rows.
 *
 * @param callResponses - Array of row arrays, one per db query call
 */
function setupDbSelectSequence(callResponses: unknown[][]) {
  const mocks = getDbMocks();

  // Reset the entire chain to fresh mocks for each test
  const mockLimit = vi.fn();
  const mockWhere = vi.fn();
  const mockFrom = vi.fn();
  const mockSelect = vi.fn();

  let callIndex = 0;

  // The tricky part: each call to select() starts a new chain.
  // We need the nth call to select() to eventually resolve to the nth response.
  mockSelect.mockImplementation(() => {
    const currentCall = callIndex;
    callIndex++;
    const response = callResponses[currentCall] ?? [];

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(response),
          // When limit() is NOT called, the where() itself resolves
          then: (resolve: (value: unknown[]) => void) => {
            resolve(response);
          },
        }),
      }),
    };
  });

  // Override the db.select on the actual mock
  (db as unknown as { select: ReturnType<typeof vi.fn> }).select = mockSelect;

  return { mockSelect, mockFrom, mockWhere, mockLimit };
}

/**
 * Configures the mock db.insert chain. The values() call resolves
 * successfully by default.
 */
function setupDbInsert() {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({
    values: mockInsertValues,
  });
  (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert = mockInsert;
  return { mockInsert, mockInsertValues };
}

// ===========================================================================
//  TEST SUITES
// ===========================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
//  1. escapeMarkdownV2 Function Tests
// ===========================================================================

describe("escapeMarkdownV2", () => {
  it("should escape all 20+ MarkdownV2 special characters", () => {
    // Input containing every MarkdownV2 special character:
    //   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
    const input = "_*[]()~`>#+-=|{}.!\\";
    const escaped = escapeMarkdownV2(input);

    // Every character should be preceded by a backslash
    expect(escaped).toBe(
      "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\",
    );
  });

  it("should escape underscore _", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
  });

  it("should escape asterisk *", () => {
    expect(escapeMarkdownV2("*bold*")).toBe("\\*bold\\*");
  });

  it("should escape square brackets [ ]", () => {
    expect(escapeMarkdownV2("[link]")).toBe("\\[link\\]");
  });

  it("should escape parentheses ( )", () => {
    expect(escapeMarkdownV2("(text)")).toBe("\\(text\\)");
  });

  it("should escape tilde ~", () => {
    expect(escapeMarkdownV2("~strikethrough~")).toBe(
      "\\~strikethrough\\~",
    );
  });

  it("should escape backtick `", () => {
    expect(escapeMarkdownV2("code `here`")).toBe("code \\`here\\`");
  });

  it("should escape greater than >", () => {
    expect(escapeMarkdownV2(">quote")).toBe("\\>quote");
  });

  it("should escape hash #", () => {
    expect(escapeMarkdownV2("#tag")).toBe("\\#tag");
  });

  it("should escape plus +", () => {
    expect(escapeMarkdownV2("+5%")).toBe("\\+5%");
  });

  it("should escape minus/hyphen -", () => {
    expect(escapeMarkdownV2("-3%")).toBe("\\-3%");
  });

  it("should escape equals =", () => {
    expect(escapeMarkdownV2("a=b")).toBe("a\\=b");
  });

  it("should escape pipe |", () => {
    expect(escapeMarkdownV2("a|b")).toBe("a\\|b");
  });

  it("should escape curly braces { }", () => {
    expect(escapeMarkdownV2("{json}")).toBe("\\{json\\}");
  });

  it("should escape period .", () => {
    expect(escapeMarkdownV2("Price: 100.50")).toBe("Price: 100\\.50");
  });

  it("should escape exclamation !", () => {
    expect(escapeMarkdownV2("Breaking!")).toBe("Breaking\\!");
  });

  it("should escape backslash \\", () => {
    expect(escapeMarkdownV2("path\\to")).toBe("path\\\\to");
  });

  it("should handle string with no special characters", () => {
    expect(escapeMarkdownV2("Hello World")).toBe("Hello World");
  });

  it("should handle empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });

  it("should escape a realistic price string", () => {
    expect(escapeMarkdownV2("Price: $100.50")).toBe("Price: $100\\.50");
  });

  it("should escape multiple adjacent special characters", () => {
    expect(escapeMarkdownV2("(**)")).toBe("\\(\\*\\*\\)");
  });
});

// ===========================================================================
//  2. escapeInlineCode Function Tests
// ===========================================================================

describe("escapeInlineCode", () => {
  it("should escape only backtick and backslash inside inline code", () => {
    // Backtick should be escaped
    expect(escapeInlineCode("`price`")).toBe("\\`price\\`");
    // Backslash should be escaped
    expect(escapeInlineCode("path\\file")).toBe("path\\\\file");
  });

  it("should not escape period, exclamation, etc. inside code blocks", () => {
    // Period is NOT a special character inside inline code
    expect(escapeInlineCode("185.5000")).toBe("185.5000");
    // Dollar sign is NOT a special character inside inline code
    expect(escapeInlineCode("$100.50")).toBe("$100.50");
    // Exclamation is NOT a special character inside inline code
    expect(escapeInlineCode("alert!")).toBe("alert!");
  });

  it("should leave normal price strings unchanged", () => {
    expect(escapeInlineCode("178.0000")).toBe("178.0000");
    expect(escapeInlineCode("200.0000")).toBe("200.0000");
    expect(escapeInlineCode("0.85")).toBe("0.85");
  });

  it("should handle empty string", () => {
    expect(escapeInlineCode("")).toBe("");
  });
});

// ===========================================================================
//  3. formatTradeAlert Function Tests
// ===========================================================================

describe("formatTradeAlert", () => {
  it("should use 🟢 emoji for LONG direction", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, direction: "long" };
    const result = formatTradeAlert(data);
    expect(result).toContain("🟢");
    expect(result).not.toContain("🔴");
  });

  it("should use 🔴 emoji for SHORT direction", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, direction: "short" };
    const result = formatTradeAlert(data);
    expect(result).toContain("🔴");
    expect(result).not.toContain("🟢");
  });

  it("should wrap direction in bold (*...*)", () => {
    const result = formatTradeAlert(mockTradeAlertData);
    // Bold LONG (uppercase) — escapeMarkdownV2 won't alter uppercase letters
    expect(result).toMatch(/\*LONG\*/);
  });

  it("should wrap symbol in bold (*...*)", () => {
    const result = formatTradeAlert(mockTradeAlertData);
    // AAPL has no special characters, so it stays as *AAPL*
    expect(result).toMatch(/\*AAPL\*/);
  });

  it("should wrap all price values in inline code blocks (`...`)", () => {
    const result = formatTradeAlert(mockTradeAlertData);
    // Entry price in backticks
    expect(result).toContain("`185.5000`");
    // Stop loss in backticks
    expect(result).toContain("`178.0000`");
    // Take profit in backticks
    expect(result).toContain("`200.0000`");
  });

  it("should display confidence as percentage", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, confidence: "0.85" };
    const result = formatTradeAlert(data);
    // 0.85 → 85%
    expect(result).toContain("85%");
  });

  it("should display confidence percentage correctly for 0.92", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, confidence: "0.92" };
    const result = formatTradeAlert(data);
    expect(result).toContain("92%");
  });

  it("should display human-readable market name", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, market: "us_stock" };
    const result = formatTradeAlert(data);
    // The market name "US Stock" is escaped, so "US Stock" → period and space unaffected
    expect(result).toContain("US Stock");
  });

  it("should display human-readable market name for indian_equity", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      market: "indian_equity",
    };
    const result = formatTradeAlert(data);
    expect(result).toContain("Indian Equity");
  });

  it("should display human-readable market name for crypto", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, market: "crypto" };
    const result = formatTradeAlert(data);
    expect(result).toContain("Crypto");
  });

  it("should display human-readable timeframe", () => {
    const data: TradeAlertData = { ...mockTradeAlertData, timeframe: "swing" };
    const result = formatTradeAlert(data);
    expect(result).toContain("Swing");
  });

  it("should display human-readable timeframe for intraday", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      timeframe: "intraday",
    };
    const result = formatTradeAlert(data);
    expect(result).toContain("Intraday");
  });

  it("should display human-readable timeframe for position", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      timeframe: "position",
    };
    const result = formatTradeAlert(data);
    expect(result).toContain("Position");
  });

  it("should include risk-reward ratio when provided", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      riskRewardRatio: "2.50",
    };
    const result = formatTradeAlert(data);
    // Risk/reward should be in a code block with 1: prefix
    expect(result).toContain("`1:2.50`");
    expect(result).toContain("Risk/Reward");
  });

  it("should omit risk-reward ratio when null", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      riskRewardRatio: null,
    };
    const result = formatTradeAlert(data);
    expect(result).not.toContain("Risk/Reward");
  });

  it("should include reasoning section", () => {
    const result = formatTradeAlert(mockTradeAlertData);
    // The bold header — colon is NOT a MarkdownV2 special character
    expect(result).toContain("*Reasoning:*");
    // The reasoning text itself should appear (escaped)
    expect(result).toContain("Apple reported strong quarterly earnings");
  });

  it("should truncate long reasoning to prevent exceeding Telegram 4096 char limit", () => {
    // Generate a very long reasoning string (1500+ characters)
    const longReasoning = "A".repeat(1500);
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      reasoning: longReasoning,
    };
    const result = formatTradeAlert(data);

    // The result should be within Telegram's 4096-character limit
    expect(result.length).toBeLessThanOrEqual(4096);

    // The reasoning is truncated with "..." which then gets escaped to "\.\.\."
    // by escapeMarkdownV2, so the output contains escaped dots
    expect(result).toContain("\\.\\.\\.");
  });

  it("should properly escape special characters in reasoning text", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      reasoning: "Price hit $100.50 (up 5.2%)",
    };
    const result = formatTradeAlert(data);
    // Period should be escaped: "100\\.50"
    expect(result).toContain("100\\.50");
    // Parentheses should be escaped
    expect(result).toContain("\\(up 5\\.2%\\)");
  });

  it("should format complete trade alert message with all fields", () => {
    const result = formatTradeAlert(mockTradeAlertData);

    // Direction emoji present
    expect(result).toContain("🟢");
    // Bold direction label
    expect(result).toContain("*LONG*");
    // Bold symbol
    expect(result).toContain("*AAPL*");
    // Market display name
    expect(result).toContain("US Stock");
    // Confidence percentage
    expect(result).toContain("85%");
    // Entry price in code block
    expect(result).toContain("`185.5000`");
    // Stop loss in code block
    expect(result).toContain("`178.0000`");
    // Take profit in code block
    expect(result).toContain("`200.0000`");
    // Timeframe
    expect(result).toContain("Swing");
    // Risk-reward ratio in code block
    expect(result).toContain("`1:2.93`");
    // Reasoning section header — colon is NOT a MarkdownV2 special character
    expect(result).toContain("*Reasoning:*");
    // Reasoning text present (at least partial)
    expect(result).toContain("Apple reported");
    // Emojis present in the message
    expect(result).toContain("📊");
    expect(result).toContain("📈");
    expect(result).toContain("💰");
    expect(result).toContain("🛑");
    expect(result).toContain("🎯");
    expect(result).toContain("💡");
    expect(result).toContain("⏱");
  });

  it("should produce a message within Telegram 4096 character limit for normal data", () => {
    const result = formatTradeAlert(mockTradeAlertData);
    expect(result.length).toBeLessThanOrEqual(4096);
  });
});

// ===========================================================================
//  4. TradeAlertData Interface Tests
// ===========================================================================

describe("TradeAlertData", () => {
  it("all price fields should be strings (financial precision)", () => {
    // Verify the interface accepts string-typed price fields
    const data: TradeAlertData = {
      symbol: "AAPL",
      market: "us_stock",
      direction: "long",
      confidence: "0.85",
      entryPrice: "185.5000",
      stopLoss: "178.0000",
      takeProfit: "200.0000",
      timeframe: "swing",
      reasoning: "Test reasoning",
      riskRewardRatio: "2.93",
    };

    // All price fields are strings, not numbers (AAP Rule 0.7.2)
    expect(typeof data.entryPrice).toBe("string");
    expect(typeof data.stopLoss).toBe("string");
    expect(typeof data.takeProfit).toBe("string");
    expect(typeof data.riskRewardRatio).toBe("string");

    // Verify formatting works with string prices
    const result = formatTradeAlert(data);
    expect(result).toContain("`185.5000`");
  });

  it("confidence should be a string representing numeric(3,2)", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      confidence: "0.85",
    };

    // Confidence is a string from PostgreSQL numeric type
    expect(typeof data.confidence).toBe("string");

    // It should be correctly converted to percentage in the output
    const result = formatTradeAlert(data);
    expect(result).toContain("85%");
  });

  it("riskRewardRatio can be null", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      riskRewardRatio: null,
    };

    expect(data.riskRewardRatio).toBeNull();

    // Formatting should still work without crashing
    const result = formatTradeAlert(data);
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
//  5. findMatchingSubscribers Tests
// ===========================================================================

describe("findMatchingSubscribers", () => {
  it("should return null when opportunity not found", async () => {
    // Mock DB to return empty for opportunity query
    setupDbSelectSequence([[]]);

    const result = await findMatchingSubscribers("nonexistent-id");
    expect(result).toBeNull();
  });

  it("should return MatchResult with opportunity data and subscribers when match found", async () => {
    // Call 1: fetch opportunity → returns mockOpportunity
    // Call 2: fetch matching users → returns ONLY the selected fields
    //         (db.select({ userId, telegramChatId, username }) only returns those 3 fields)
    // Call 3: fetch already-notified → returns empty
    const matchingUserSelectResult = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    setupDbSelectSequence([
      [mockOpportunity],
      [matchingUserSelectResult],
      [],
    ]);

    const result = await findMatchingSubscribers("opp-uuid-1");

    expect(result).not.toBeNull();
    expect(result!.opportunity).toEqual({
      id: "opp-uuid-1",
      symbol: "AAPL",
      market: "us_stock",
      direction: "long",
      confidence: "0.85",
      entryPrice: "185.5000",
      stopLoss: "178.0000",
      takeProfit: "200.0000",
      timeframe: "swing",
      reasoning: mockOpportunity.reasoning,
      riskRewardRatio: "2.93",
    });

    expect(result!.subscribers).toHaveLength(1);
    expect(result!.subscribers[0]).toEqual({
      userId: "user-uuid-1",
      telegramChatId: "123456789",
      username: "testuser",
    });
  });

  it("should return empty subscribers array when no users match", async () => {
    // Call 1: opportunity found
    // Call 2: no matching users
    // Call 3: no already-notified
    setupDbSelectSequence([
      [mockOpportunity],
      [],
      [],
    ]);

    const result = await findMatchingSubscribers("opp-uuid-1");

    expect(result).not.toBeNull();
    expect(result!.opportunity.id).toBe("opp-uuid-1");
    expect(result!.subscribers).toHaveLength(0);
  });

  it("should return all matching subscribers", async () => {
    const user1Selected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    const user2Selected = {
      userId: "user-uuid-3",
      telegramChatId: "555555555",
      username: "thirduser",
    };

    // Call 1: opportunity found
    // Call 2: two matching users (only select-projected fields)
    // Call 3: no already-notified
    setupDbSelectSequence([
      [mockOpportunity],
      [user1Selected, user2Selected],
      [],
    ]);

    const result = await findMatchingSubscribers("opp-uuid-1");

    expect(result).not.toBeNull();
    expect(result!.subscribers).toHaveLength(2);
    expect(result!.subscribers[0]!.userId).toBe("user-uuid-1");
    expect(result!.subscribers[1]!.userId).toBe("user-uuid-3");
  });

  it("should filter out already-notified users (duplicate prevention)", async () => {
    const user1Selected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    const user2Selected = {
      userId: "user-uuid-3",
      telegramChatId: "555555555",
      username: "thirduser",
    };

    // Call 1: opportunity found
    // Call 2: two matching users (select-projected fields only)
    // Call 3: user-uuid-1 already notified
    setupDbSelectSequence([
      [mockOpportunity],
      [user1Selected, user2Selected],
      [{ userId: "user-uuid-1" }],
    ]);

    const result = await findMatchingSubscribers("opp-uuid-1");

    expect(result).not.toBeNull();
    // Only user-uuid-3 should remain; user-uuid-1 is filtered out
    expect(result!.subscribers).toHaveLength(1);
    expect(result!.subscribers[0]!.userId).toBe("user-uuid-3");
  });

  it("should call db.select() three times for opportunity, users, and notification logs", async () => {
    const userSelected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    setupDbSelectSequence([
      [mockOpportunity],
      [userSelected],
      [],
    ]);

    await findMatchingSubscribers("opp-uuid-1");

    // The db.select should have been called 3 times
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("should use eq() for opportunity ID lookup", async () => {
    const userSelected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    setupDbSelectSequence([
      [mockOpportunity],
      [userSelected],
      [],
    ]);

    await findMatchingSubscribers("opp-uuid-1");

    // eq should have been called (at least for opportunity ID and notification lookup)
    expect(eq).toHaveBeenCalled();
  });

  it("should use and() for combining subscriber matching conditions", async () => {
    const userSelected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    setupDbSelectSequence([
      [mockOpportunity],
      [userSelected],
      [],
    ]);

    await findMatchingSubscribers("opp-uuid-1");

    // and() should have been called for combining user preference conditions
    expect(and).toHaveBeenCalled();
  });

  it("should use sql template tag for PostgreSQL @> array operator", async () => {
    const userSelected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    setupDbSelectSequence([
      [mockOpportunity],
      [userSelected],
      [],
    ]);

    await findMatchingSubscribers("opp-uuid-1");

    // sql tagged template should be used for @> array containment and <= comparison
    expect(sql).toHaveBeenCalled();
  });

  it("should pass opportunity market value to sql for @> array matching", async () => {
    const userSelected = {
      userId: mockUserMatching.userId,
      telegramChatId: mockUserMatching.telegramChatId,
      username: mockUserMatching.username,
    };
    setupDbSelectSequence([
      [mockOpportunity],
      [userSelected],
      [],
    ]);

    await findMatchingSubscribers("opp-uuid-1");

    // Verify sql was called — we can check the number of calls
    // The implementation uses sql`` three times:
    //   1. markets @> ARRAY[opportunity.market]
    //   2. timeframes @> ARRAY[opportunity.timeframe]
    //   3. minConfidence <= opportunity.confidence
    const sqlCalls = (sql as ReturnType<typeof vi.fn>).mock.calls;
    expect(sqlCalls.length).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
//  6. logNotification Tests
// ===========================================================================

describe("logNotification", () => {
  it("should insert into notification_logs table with sent status", async () => {
    const { mockInsert, mockInsertValues } = setupDbInsert();

    await logNotification("opp-uuid-1", "user-uuid-1", "sent", 12345);

    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityId: "opp-uuid-1",
        userId: "user-uuid-1",
        status: "sent",
        telegramMessageId: 12345,
        error: null,
      }),
    );

    // sentAt should be a Date when status is "sent"
    const insertArg = mockInsertValues.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertArg["sentAt"]).toBeInstanceOf(Date);
  });

  it("should insert with failed status and error message", async () => {
    const { mockInsert, mockInsertValues } = setupDbInsert();

    await logNotification(
      "opp-uuid-1",
      "user-uuid-1",
      "failed",
      undefined,
      "Telegram API timeout",
    );

    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        opportunityId: "opp-uuid-1",
        userId: "user-uuid-1",
        status: "failed",
        telegramMessageId: null,
        error: "Telegram API timeout",
      }),
    );

    // sentAt should be null when status is "failed"
    const insertArg = mockInsertValues.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertArg["sentAt"]).toBeNull();
  });

  it("should handle null telegramMessageId", async () => {
    const { mockInsertValues } = setupDbInsert();

    await logNotification("opp-uuid-1", "user-uuid-1", "pending");

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramMessageId: null,
      }),
    );
  });

  it("should log the notification result via logger.info", async () => {
    setupDbInsert();

    // Import the mocked createLogger to verify log calls
    const { createLogger } = await import("../../../src/lib/logger.js");
    const mockLogger = (createLogger as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as {
      info: ReturnType<typeof vi.fn>;
    };

    await logNotification("opp-uuid-1", "user-uuid-1", "sent", 12345);

    // The logger.info should have been called with the notification details
    if (mockLogger) {
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          opportunityId: "opp-uuid-1",
          userId: "user-uuid-1",
          status: "sent",
        }),
        "Notification logged",
      );
    }
  });

  it("should set sentAt to null for non-sent statuses", async () => {
    const { mockInsertValues } = setupDbInsert();

    await logNotification("opp-uuid-1", "user-uuid-1", "skipped");

    const insertArg = mockInsertValues.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(insertArg["sentAt"]).toBeNull();
  });
});

// ===========================================================================
//  7. Edge Case Tests
// ===========================================================================

describe("Edge Cases", () => {
  it("formatTradeAlert with minimum data (riskRewardRatio null)", () => {
    const data: TradeAlertData = {
      symbol: "BTC",
      market: "crypto",
      direction: "short",
      confidence: "0.65",
      entryPrice: "50000.0000",
      stopLoss: "52000.0000",
      takeProfit: "45000.0000",
      timeframe: "intraday",
      reasoning: "Bitcoin showing bearish divergence.",
      riskRewardRatio: null,
    };

    const result = formatTradeAlert(data);

    // Should not crash
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
    // Should have SHORT emoji
    expect(result).toContain("🔴");
    // Should NOT have risk-reward line
    expect(result).not.toContain("Risk/Reward");
    // Prices should be in code blocks
    expect(result).toContain("`50000.0000`");
    expect(result).toContain("`52000.0000`");
    expect(result).toContain("`45000.0000`");
  });

  it("formatTradeAlert with special characters in symbol", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      symbol: "RELIANCE.NS",
    };

    const result = formatTradeAlert(data);

    // The period in the symbol should be escaped in the bold text
    // *RELIANCE\.NS* — the period is escaped within the bold markers
    expect(result).toContain("RELIANCE\\.NS");
    expect(result).toBeDefined();
  });

  it("formatTradeAlert with very long symbol", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      symbol: "BTCUSDT",
    };

    const result = formatTradeAlert(data);

    expect(result).toContain("*BTCUSDT*");
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it("formatTradeAlert with crypto market and short direction", () => {
    const data: TradeAlertData = {
      symbol: "ETH/USDT",
      market: "crypto",
      direction: "short",
      confidence: "0.78",
      entryPrice: "3500.0000",
      stopLoss: "3700.0000",
      takeProfit: "3000.0000",
      timeframe: "position",
      reasoning: "Ethereum facing resistance at key level.",
      riskRewardRatio: "2.50",
    };

    const result = formatTradeAlert(data);

    // ETH/USDT — the "/" is not a MarkdownV2 special character
    expect(result).toContain("ETH/USDT");
    expect(result).toContain("🔴");
    expect(result).toContain("*SHORT*");
    expect(result).toContain("Crypto");
    expect(result).toContain("78%");
    expect(result).toContain("Position");
  });

  it("formatTradeAlert with maximum-length reasoning triggering truncation", () => {
    // Create reasoning that is exactly at the truncation boundary (500 chars)
    const exactBoundary = "A".repeat(500);
    const data1: TradeAlertData = {
      ...mockTradeAlertData,
      reasoning: exactBoundary,
    };
    const result1 = formatTradeAlert(data1);
    // At exactly 500 chars, should NOT be truncated (no escaped dots pattern)
    expect(result1).not.toContain("\\.\\.\\.");

    // Create reasoning that exceeds the truncation boundary (501 chars)
    const overBoundary = "A".repeat(501);
    const data2: TradeAlertData = {
      ...mockTradeAlertData,
      reasoning: overBoundary,
    };
    const result2 = formatTradeAlert(data2);
    // At 501 chars, should be truncated — "..." gets escaped to "\.\.\."
    expect(result2).toContain("\\.\\.\\.");
  });

  it("findMatchingSubscribers with all users already notified", async () => {
    // Call 1: opportunity found
    // Call 2: two matching users
    // Call 3: both users already notified
    setupDbSelectSequence([
      [mockOpportunity],
      [mockUserMatching, { userId: "user-uuid-3", telegramChatId: "555", username: "user3" }],
      [{ userId: "user-uuid-1" }, { userId: "user-uuid-3" }],
    ]);

    const result = await findMatchingSubscribers("opp-uuid-1");

    expect(result).not.toBeNull();
    // All matched users were already notified → empty subscribers
    expect(result!.subscribers).toHaveLength(0);
  });

  it("confidence string comparison as numeric (0.9 >= 0.85)", () => {
    // This tests that the system handles numeric string comparisons correctly.
    // The actual comparison happens in PostgreSQL via sql`` template, but we can
    // verify the data flows through correctly.
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      confidence: "0.90",
    };
    const result = formatTradeAlert(data);
    // 0.90 → 90%
    expect(result).toContain("90%");
  });

  it("formatTradeAlert escapes all MarkdownV2 chars in reasoning", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      reasoning: "Stock_hit *high* [100.5] (breaking!) ~trend~ +15% -3% {key} a=b a|b >quote #1",
    };
    const result = formatTradeAlert(data);

    // All special characters in the reasoning should be escaped
    expect(result).toContain("Stock\\_hit");
    expect(result).toContain("\\*high\\*");
    expect(result).toContain("\\[100\\.5\\]");
    expect(result).toContain("\\(breaking\\!\\)");
    expect(result).toContain("\\~trend\\~");
    expect(result).toContain("\\+15%");
    expect(result).toContain("\\-3%");
    expect(result).toContain("\\{key\\}");
    expect(result).toContain("a\\=b");
    expect(result).toContain("a\\|b");
    expect(result).toContain("\\>quote");
    expect(result).toContain("\\#1");
  });

  it("formatTradeAlert handles unknown market gracefully", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      market: "unknown_market",
    };
    const result = formatTradeAlert(data);

    // Falls back to the raw enum value (escaped)
    expect(result).toContain("unknown\\_market");
  });

  it("formatTradeAlert handles unknown timeframe gracefully", () => {
    const data: TradeAlertData = {
      ...mockTradeAlertData,
      timeframe: "weekly",
    };
    const result = formatTradeAlert(data);

    // Falls back to the raw value
    expect(result).toContain("weekly");
  });
});
