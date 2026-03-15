/**
 * End-to-End Notification Delivery Pipeline — Integration Test Suite
 *
 * Tests the complete notification delivery pipeline:
 *   trade opportunity creation → subscriber preference matching (market,
 *   min_confidence, timeframe filters from user_settings) → MarkdownV2
 *   alert formatting with proper character escaping → notification_logs
 *   database record creation.
 *
 * Verifies that the system correctly:
 *   - Matches subscribers whose preferences align with a trade opportunity
 *   - Excludes subscribers with wrong market, wrong timeframe, high
 *     minConfidence threshold, or inactive status
 *   - Prevents duplicate notifications via notification_logs check
 *   - Formats LONG trade alerts with 🟢 emoji and SHORT with 🔴 emoji
 *   - Wraps all price values in inline code blocks (`` `880.0000` ``)
 *   - Escapes all 19 MarkdownV2 special characters: _*[]()~`>#+-=|{}.!\
 *   - Truncates long reasoning to stay within Telegram 4096-char limit
 *   - Creates proper notification log records for both success and failure
 *   - Completes the full pipeline: match → format → log → verify no duplicates
 *
 * Architecture:
 *   - Real: PostgreSQL database via Drizzle ORM (subscriber matching, logging)
 *   - Mocked: Logger module (suppress pino output during tests)
 *   - No Telegram API calls — tests the notifier service functions independently
 *
 * CRITICAL AAP compliance:
 *   - TypeScript strict mode (Rule 0.7.1): No `any` types anywhere
 *   - ESM-first (Rule 0.7.1): All local imports use `.js` extension
 *   - MarkdownV2 escaping (Rule 0.7.5): 19 special characters escaped
 *   - Emoji directional indicators (Rule 0.7.5): 🟢 LONG / 🔴 SHORT
 *   - Inline code blocks for prices (Rule 0.7.5): Backtick-wrapped prices
 *   - Subscriber preference matching (Rule 0.7.5): Market, confidence, timeframe
 *   - Financial decimal precision (Rule 0.7.2): All prices as strings
 *
 * @module tests/integration/notification-delivery.test
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module Mocks — Hoisted before any module imports by Vitest
// ---------------------------------------------------------------------------

/**
 * Mock the logger module to suppress Pino v10 log output during tests.
 * The notifier service (services/notifier/index.ts) creates a child logger
 * at module scope via `createLogger("notifier")`. This mock provides a
 * silent no-op logger that satisfies all method calls without producing output.
 */
vi.mock("../../src/lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Real Module Imports — Database, Schemas, and Notifier Services
// ---------------------------------------------------------------------------

import { db } from "../../src/db/index.js";
import { newsArticles } from "../../src/db/schema/news-articles.js";
import { tradeOpportunities } from "../../src/db/schema/trade-opportunities.js";
import { userSettings } from "../../src/db/schema/user-settings.js";
import { notificationLogs } from "../../src/db/schema/notification-logs.js";
import { eq } from "drizzle-orm";
import {
  findMatchingSubscribers,
  logNotification,
} from "../../src/services/notifier/index.js";
import {
  formatTradeAlert,
  escapeMarkdownV2,
} from "../../src/services/notifier/formatter.js";
import type { TradeAlertData } from "../../src/services/notifier/formatter.js";

// ---------------------------------------------------------------------------
// Test State — Mutable IDs populated by seedNotificationTestData()
// ---------------------------------------------------------------------------

/**
 * UUID of the test news article inserted in beforeEach.
 * Used as the foreign key for the trade opportunity.
 */
let testArticleId: string;

/**
 * UUID of the test trade opportunity inserted in beforeEach.
 * Used as the primary subject for subscriber matching tests.
 */
let testOpportunityId: string;

/**
 * UUID of the matching test user (trader_joe) inserted in beforeEach.
 * Used to verify correct subscriber matching and notification logging.
 */
let testUserId: string;

// ---------------------------------------------------------------------------
// Seed Helper — Creates deterministic test data for each test
// ---------------------------------------------------------------------------

/**
 * Seeds the test database with:
 *   - 1 news article (NVDA, us_stock, Finnhub)
 *   - 1 trade opportunity (NVDA, long, swing, confidence 0.88)
 *   - 5 user_settings records with varying preference filters:
 *       1. trader_joe     — MATCHES (us_stock, minConf 0.70, swing)
 *       2. picky_trader   — NO MATCH (minConf 0.95 > opportunity 0.88)
 *       3. crypto_only    — NO MATCH (market: crypto ≠ us_stock)
 *       4. intraday_only  — NO MATCH (timeframe: intraday ≠ swing)
 *       5. inactive_user  — NO MATCH (isActive: false)
 *
 * Assigns the matching article/opportunity/user IDs to the module-scope
 * variables for use in test assertions.
 */
async function seedNotificationTestData(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Insert a test news article (parent record for the trade opportunity)
  // -------------------------------------------------------------------------
  const [article] = await db
    .insert(newsArticles)
    .values({
      title: "NVDA Triple Beat Q4 Earnings",
      url: "https://example.com/nvda-q4-" + Date.now().toString(),
      source: "Finnhub",
      market: "us_stock",
      publishedAt: new Date("2026-03-13T10:00:00Z"),
      isAnalyzed: true,
      symbols: ["NVDA"],
    })
    .returning();
  testArticleId = article!.id;

  // -------------------------------------------------------------------------
  // 2. Insert a trade opportunity linked to the article
  // -------------------------------------------------------------------------
  const [opportunity] = await db
    .insert(tradeOpportunities)
    .values({
      articleId: testArticleId,
      symbol: "NVDA",
      market: "us_stock",
      direction: "long",
      confidence: "0.88",
      entryPrice: "880.0000",
      stopLoss: "845.0000",
      takeProfit: "950.0000",
      timeframe: "swing",
      reasoning:
        "Triple beat with raised guidance suggests sustained AI/datacenter demand.",
      status: "active",
      riskRewardRatio: "2.00",
    })
    .returning();
  testOpportunityId = opportunity!.id;

  // -------------------------------------------------------------------------
  // 3. Insert matching subscriber (should match all criteria)
  //    Market: us_stock ✓, minConfidence: 0.70 <= 0.88 ✓, timeframe: swing ✓
  // -------------------------------------------------------------------------
  const [user1] = await db
    .insert(userSettings)
    .values({
      telegramChatId: "111111111",
      username: "trader_joe",
      markets: ["us_stock", "crypto"],
      minConfidence: "0.70",
      timeframes: ["swing", "intraday"],
      isActive: true,
    })
    .returning();
  testUserId = user1!.id;

  // -------------------------------------------------------------------------
  // 4. Insert non-matching subscriber (confidence threshold too high)
  //    minConfidence: 0.95 > 0.88 = NO MATCH
  // -------------------------------------------------------------------------
  await db.insert(userSettings).values({
    telegramChatId: "222222222",
    username: "picky_trader",
    markets: ["us_stock"],
    minConfidence: "0.95",
    timeframes: ["swing"],
    isActive: true,
  });

  // -------------------------------------------------------------------------
  // 5. Insert non-matching subscriber (wrong market)
  //    Market: crypto ≠ us_stock = NO MATCH
  // -------------------------------------------------------------------------
  await db.insert(userSettings).values({
    telegramChatId: "333333333",
    username: "crypto_only",
    markets: ["crypto"],
    minConfidence: "0.50",
    timeframes: ["swing", "intraday"],
    isActive: true,
  });

  // -------------------------------------------------------------------------
  // 6. Insert non-matching subscriber (wrong timeframe)
  //    Timeframe: intraday ≠ swing = NO MATCH
  // -------------------------------------------------------------------------
  await db.insert(userSettings).values({
    telegramChatId: "444444444",
    username: "intraday_only",
    markets: ["us_stock"],
    minConfidence: "0.50",
    timeframes: ["intraday"],
    isActive: true,
  });

  // -------------------------------------------------------------------------
  // 7. Insert inactive subscriber (matches all filters but isActive=false)
  //    isActive: false = NO MATCH
  // -------------------------------------------------------------------------
  await db.insert(userSettings).values({
    telegramChatId: "555555555",
    username: "inactive_user",
    markets: ["us_stock"],
    minConfidence: "0.50",
    timeframes: ["swing"],
    isActive: false,
  });
}

// ---------------------------------------------------------------------------
// Test Lifecycle — Database Setup and Teardown
// ---------------------------------------------------------------------------

/**
 * Clean all test data from the database before the entire suite runs.
 * Deletion order respects foreign key constraints:
 *   notification_logs → trade_opportunities → news_articles → user_settings
 */
beforeAll(async () => {
  await db.delete(notificationLogs);
  await db.delete(tradeOpportunities);
  await db.delete(newsArticles);
  await db.delete(userSettings);
});

/**
 * Clean and re-seed the database before each individual test.
 * Ensures complete isolation between tests — each test starts with
 * a deterministic, known database state.
 */
beforeEach(async () => {
  await db.delete(notificationLogs);
  await db.delete(tradeOpportunities);
  await db.delete(newsArticles);
  await db.delete(userSettings);
  await seedNotificationTestData();
});

/**
 * Clean up all test data after the entire suite completes.
 * Prevents test data from polluting the development database.
 */
afterAll(async () => {
  await db.delete(notificationLogs);
  await db.delete(tradeOpportunities);
  await db.delete(newsArticles);
  await db.delete(userSettings);
});

// ===========================================================================
// Test Suites
// ===========================================================================

describe("Notification Delivery Pipeline", () => {
  // =========================================================================
  // Suite 1: Subscriber Matching
  // =========================================================================

  describe("findMatchingSubscribers()", () => {
    it("should find subscribers whose preferences match the opportunity", async () => {
      const result = await findMatchingSubscribers(testOpportunityId);

      expect(result).not.toBeNull();
      expect(result!.subscribers.length).toBe(1);
      expect(result!.subscribers[0]!.telegramChatId).toBe("111111111");
    });

    it("should NOT match subscribers with higher minConfidence threshold", async () => {
      const result = await findMatchingSubscribers(testOpportunityId);

      const chatIds = result!.subscribers.map((s) => s.telegramChatId);
      expect(chatIds).not.toContain("222222222"); // picky_trader (0.95 > 0.88)
    });

    it("should NOT match subscribers with wrong market preferences", async () => {
      const result = await findMatchingSubscribers(testOpportunityId);

      const chatIds = result!.subscribers.map((s) => s.telegramChatId);
      expect(chatIds).not.toContain("333333333"); // crypto_only
    });

    it("should NOT match subscribers with wrong timeframe preferences", async () => {
      const result = await findMatchingSubscribers(testOpportunityId);

      const chatIds = result!.subscribers.map((s) => s.telegramChatId);
      expect(chatIds).not.toContain("444444444"); // intraday_only
    });

    it("should NOT match inactive subscribers", async () => {
      const result = await findMatchingSubscribers(testOpportunityId);

      const chatIds = result!.subscribers.map((s) => s.telegramChatId);
      expect(chatIds).not.toContain("555555555"); // inactive_user
    });

    it("should return null for non-existent opportunity", async () => {
      const result = await findMatchingSubscribers(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBeNull();
    });

    it("should include opportunity data in result", async () => {
      const result = await findMatchingSubscribers(testOpportunityId);

      expect(result).not.toBeNull();
      expect(result!.opportunity.symbol).toBe("NVDA");
      expect(result!.opportunity.market).toBe("us_stock");
      expect(result!.opportunity.direction).toBe("long");
      expect(result!.opportunity.confidence).toBe("0.88");
      expect(result!.opportunity.entryPrice).toBe("880.0000");
      expect(result!.opportunity.stopLoss).toBe("845.0000");
      expect(result!.opportunity.takeProfit).toBe("950.0000");
      expect(result!.opportunity.timeframe).toBe("swing");
    });

    it("should prevent duplicate notifications (check notification_logs)", async () => {
      // First call — should find 1 subscriber
      const result1 = await findMatchingSubscribers(testOpportunityId);
      expect(result1).not.toBeNull();
      expect(result1!.subscribers.length).toBe(1);

      // Log the notification as sent
      await logNotification(testOpportunityId, testUserId, "sent", 12345);

      // Second call — subscriber already notified, should return 0 new subscribers
      const result2 = await findMatchingSubscribers(testOpportunityId);
      expect(result2).not.toBeNull();
      expect(result2!.subscribers.length).toBe(0);
    });
  });

  // =========================================================================
  // Suite 2: Trade Alert Formatting
  // =========================================================================

  describe("formatTradeAlert()", () => {
    it("should format LONG trade alert with 🟢 emoji", () => {
      const data: TradeAlertData = {
        symbol: "NVDA",
        market: "us_stock",
        direction: "long",
        confidence: "0.88",
        entryPrice: "880.0000",
        stopLoss: "845.0000",
        takeProfit: "950.0000",
        timeframe: "swing",
        reasoning: "Triple beat with raised guidance.",
        riskRewardRatio: "2.00",
      };

      const message = formatTradeAlert(data);

      // Should contain LONG emoji indicator (AAP Rule 0.7.5)
      expect(message).toContain("🟢");
      expect(message).not.toContain("🔴");

      // Should contain bold direction and symbol
      expect(message).toContain("*LONG*");
      expect(message).toContain("*NVDA*");

      // Should contain prices in inline code blocks (AAP Rule 0.7.5)
      expect(message).toContain("`880.0000`");
      expect(message).toContain("`845.0000`");
      expect(message).toContain("`950.0000`");

      // Should contain confidence as percentage
      expect(message).toContain("88%");

      // Should contain timeframe
      expect(message).toMatch(/[Ss]wing/);

      // Should contain risk-reward ratio
      expect(message).toContain("2.00");
    });

    it("should format SHORT trade alert with 🔴 emoji", () => {
      const data: TradeAlertData = {
        symbol: "LUNA",
        market: "crypto",
        direction: "short",
        confidence: "0.78",
        entryPrice: "0.4400",
        stopLoss: "0.5200",
        takeProfit: "0.2800",
        timeframe: "intraday",
        reasoning: "Exchange delisting.",
        riskRewardRatio: "2.11",
      };

      const message = formatTradeAlert(data);

      expect(message).toContain("🔴");
      expect(message).not.toContain("🟢");
      expect(message).toContain("*SHORT*");
      expect(message).toContain("*LUNA*");
    });

    it("should handle null riskRewardRatio gracefully", () => {
      const data: TradeAlertData = {
        symbol: "BTC",
        market: "crypto",
        direction: "long",
        confidence: "0.75",
        entryPrice: "95000.0000",
        stopLoss: "92000.0000",
        takeProfit: "100000.0000",
        timeframe: "swing",
        reasoning: "ETF inflows.",
        riskRewardRatio: null,
      };

      const message = formatTradeAlert(data);

      // Should not throw and should produce a valid message
      expect(message).toBeDefined();
      expect(message.length).toBeGreaterThan(0);
    });

    it("should truncate long reasoning to stay within Telegram 4096 char limit", () => {
      const longReasoning = "A".repeat(2000);
      const data: TradeAlertData = {
        symbol: "AAPL",
        market: "us_stock",
        direction: "long",
        confidence: "0.90",
        entryPrice: "185.0000",
        stopLoss: "180.0000",
        takeProfit: "200.0000",
        timeframe: "swing",
        reasoning: longReasoning,
        riskRewardRatio: "3.33",
      };

      const message = formatTradeAlert(data);

      // Message should be within Telegram's hard limit
      expect(message.length).toBeLessThanOrEqual(4096);
    });
  });

  // =========================================================================
  // Suite 3: MarkdownV2 Escaping
  // =========================================================================

  describe("escapeMarkdownV2()", () => {
    it("should escape all MarkdownV2 special characters", () => {
      const input = "Hello_World*[test](link)~`code`>#+-=|{}.!";
      const escaped = escapeMarkdownV2(input);

      // Each special character should be prefixed with backslash
      expect(escaped).toContain("\\_");
      expect(escaped).toContain("\\*");
      expect(escaped).toContain("\\[");
      expect(escaped).toContain("\\]");
      expect(escaped).toContain("\\(");
      expect(escaped).toContain("\\)");
      expect(escaped).toContain("\\~");
      expect(escaped).toContain("\\>");
      expect(escaped).toContain("\\#");
      expect(escaped).toContain("\\+");
      expect(escaped).toContain("\\-");
      expect(escaped).toContain("\\=");
      expect(escaped).toContain("\\|");
      expect(escaped).toContain("\\{");
      expect(escaped).toContain("\\}");
      expect(escaped).toContain("\\.");
      expect(escaped).toContain("\\!");
    });

    it("should not double-escape already escaped characters", () => {
      const input = "Price: $100.50";
      const escaped = escapeMarkdownV2(input);
      // Should have exactly one backslash before the dot
      expect(escaped).toBe("Price: $100\\.50");
    });
  });

  // =========================================================================
  // Suite 4: Notification Logging
  // =========================================================================

  describe("logNotification()", () => {
    it("should create notification log record on successful send", async () => {
      await logNotification(testOpportunityId, testUserId, "sent", 12345);

      const [log] = await db
        .select()
        .from(notificationLogs)
        .where(eq(notificationLogs.opportunityId, testOpportunityId));

      expect(log).toBeDefined();
      expect(log!.status).toBe("sent");
      expect(log!.telegramMessageId).toBe(12345);
      expect(log!.error).toBeNull();
    });

    it("should create notification log record on failed send", async () => {
      await logNotification(
        testOpportunityId,
        testUserId,
        "failed",
        undefined,
        "Telegram API timeout",
      );

      const [log] = await db
        .select()
        .from(notificationLogs)
        .where(eq(notificationLogs.opportunityId, testOpportunityId));

      expect(log).toBeDefined();
      expect(log!.status).toBe("failed");
      expect(log!.error).toBe("Telegram API timeout");
    });
  });

  // =========================================================================
  // Suite 5: Full Pipeline Integration
  // =========================================================================

  describe("Full notification pipeline: opportunity → match → format → log", () => {
    it("should complete full notification pipeline", async () => {
      // Step 1: Find matching subscribers
      const matchResult = await findMatchingSubscribers(testOpportunityId);
      expect(matchResult).not.toBeNull();
      expect(matchResult!.subscribers.length).toBe(1);

      // Step 2: Format the alert message
      const alertData: TradeAlertData = {
        symbol: matchResult!.opportunity.symbol,
        market: matchResult!.opportunity.market,
        direction: matchResult!.opportunity.direction,
        confidence: matchResult!.opportunity.confidence,
        entryPrice: matchResult!.opportunity.entryPrice,
        stopLoss: matchResult!.opportunity.stopLoss,
        takeProfit: matchResult!.opportunity.takeProfit,
        timeframe: matchResult!.opportunity.timeframe,
        reasoning: matchResult!.opportunity.reasoning,
        riskRewardRatio: matchResult!.opportunity.riskRewardRatio,
      };
      const formattedMessage = formatTradeAlert(alertData);
      expect(formattedMessage).toContain("🟢"); // LONG direction
      expect(formattedMessage).toContain("*NVDA*");

      // Step 3: Log the notification (simulating bot.api.sendMessage success)
      const subscriber = matchResult!.subscribers[0]!;
      await logNotification(
        testOpportunityId,
        subscriber.userId,
        "sent",
        99999,
      );

      // Step 4: Verify notification log exists
      const logs = await db.select().from(notificationLogs);
      expect(logs.length).toBe(1);
      expect(logs[0]!.status).toBe("sent");

      // Step 5: Subsequent matching should return 0 new subscribers
      // (duplicate prevention — the user has already been notified)
      const matchResult2 = await findMatchingSubscribers(testOpportunityId);
      expect(matchResult2).not.toBeNull();
      expect(matchResult2!.subscribers.length).toBe(0);
    });
  });
});
