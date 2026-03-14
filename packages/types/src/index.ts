/**
 * @trading-intelligence/types — Barrel Export
 *
 * Re-exports all shared type definitions consumed across the monorepo.
 * This file serves as the single entry point for the `@trading-intelligence/types`
 * workspace package. All imports of shared types should use:
 *
 * ```typescript
 * import { Market, NewsArticle, TradeOpportunity } from '@trading-intelligence/types';
 * ```
 *
 * Module inventory:
 * - `news.ts`  — Market enum, NewsArticle interface, NewsSource interface
 * - `trade.ts` — Direction, Timeframe, OpportunityStatus enums; TradeOpportunity, TradePerformance interfaces
 * - `user.ts`  — UserSettings, NotificationPreference interfaces
 * - `api.ts`   — ApiResponse, PaginatedResponse, PaginationMeta, PaginationParams, ApiErrorResponse
 * - `queue.ts` — NewsPollingPayload, AnalysisPayload, NotificationPayload interfaces
 *
 * @module @trading-intelligence/types
 */

export * from './news.js';
export * from './trade.js';
export * from './user.js';
export * from './api.js';
export * from './queue.js';
