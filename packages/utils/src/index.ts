/**
 * @trading-intelligence/utils — Barrel Export
 *
 * Re-exports all shared utility functions and Zod validation schemas consumed
 * across the monorepo. This file serves as the single entry point for the
 * `@trading-intelligence/utils` workspace package. All imports should use:
 *
 * ```typescript
 * import { formatCurrency, paginationSchema } from '@trading-intelligence/utils';
 * ```
 *
 * Module inventory:
 * - `formatting.ts`  — Currency, percentage, date, number, and sentiment formatters
 * - `validation.ts`  — Zod schemas for pagination, filters, enums, financial strings
 *
 * @module @trading-intelligence/utils
 */

export * from './formatting.js';
export * from './validation.js';
