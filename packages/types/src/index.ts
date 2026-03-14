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
 * - `news.ts`  — Market enum, NewsArticle, NewsSource interfaces
 * - `api.ts`   — ApiResponse, PaginatedResponse, PaginationParams, ApiErrorResponse
 * - `trade.ts` — Direction, Timeframe, OpportunityStatus enums; TradeOpportunity, TradePerformance
 * - `user.ts`  — UserSettings, NotificationPreference interfaces
 * - `queue.ts` — QueueName, *JobData, *JobResult types for all 3 BullMQ queues
 *
 * @module @trading-intelligence/types
 */

export * from './news.js';
export * from './api.js';
export * from './trade.js';
export * from './user.js';
export * from './queue.js';
