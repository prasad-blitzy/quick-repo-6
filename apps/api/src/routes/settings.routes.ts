/**
 * User Settings Route Handlers
 *
 * Express route handlers for `GET/PUT /api/settings/:chatId` — User preference
 * management by Telegram chat ID. GET fetches current preferences. PUT updates
 * preferences (markets, min_confidence, timeframes, is_active). Validates
 * input with Zod schemas imported from `@trading-intelligence/utils`.
 *
 * Integration:
 *  - Consumed by `apps/api/src/routes/index.ts` — mounted as `/api/settings`
 *  - Frontend consumer: `apps/web/src/pages/Settings.tsx`
 *  - Bot integration: `/settings` Telegram command reads/writes the same table
 *
 * AAP Compliance:
 *  - TypeScript strict mode (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
 *  - ESM-first: all local imports use `.js` extension (NodeNext resolution)
 *  - Named exports only — no default exports
 *  - Confidence scores validated as numeric(3,2) range 0.00–1.00 (AAP Rule §0.7.2)
 *  - No `any` types — all error handling uses `unknown` (AAP Rule §0.7.1)
 *
 * @module routes/settings
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/index.js";
import { userSettings } from "../db/schema/index.js";
import { createLogger } from "../lib/logger.js";
import {
  marketSchema,
  timeframeSchema,
  confidenceSchema,
} from "@trading-intelligence/utils";

// ---------------------------------------------------------------------------
// Module Logger
// ---------------------------------------------------------------------------

/**
 * Child logger bound with `{ module: "routes:settings" }` context.
 * Used for structured logging of user settings operations:
 *  - `debug` level: GET fetches (high frequency, low importance)
 *  - `info` level: PUT updates (audit trail for preference changes)
 */
const logger = createLogger("routes:settings");

// ---------------------------------------------------------------------------
// Router Instance
// ---------------------------------------------------------------------------

/**
 * Express Router for user settings endpoints.
 *
 * Mounted at `/api` by the route aggregator in `routes/index.ts`, making
 * the full paths:
 *  - `GET  /api/settings/:chatId` — Fetch user preferences
 *  - `PUT  /api/settings/:chatId` — Update user preferences
 */
export const settingsRouter: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// Validation Schema — PUT Request Body
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating PUT `/settings/:chatId` request bodies.
 * All fields are optional to support partial updates — only provided fields
 * are written to the database.
 *
 * Field validation:
 *  - `markets`: Array of market enum values (`us_stock`, `indian_equity`,
 *    `crypto`, `social`) validated by the shared `marketSchema` from
 *    `@trading-intelligence/utils`
 *  - `minConfidence`: Number 0.00–1.00 coerced from string or number input,
 *    validated by the shared `confidenceSchema`. Stored as string in the
 *    database for `numeric(3,2)` precision (AAP Rule §0.7.2).
 *  - `timeframes`: Array of timeframe enum values (`intraday`, `swing`,
 *    `position`) validated by the shared `timeframeSchema`
 *  - `isActive`: Boolean toggle for enabling/disabling notification delivery
 */
const updateSettingsSchema = z.object({
  markets: z.array(marketSchema).optional(),
  minConfidence: confidenceSchema.optional(),
  timeframes: z.array(timeframeSchema).optional(),
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET /settings/:chatId — Fetch User Settings
// ---------------------------------------------------------------------------

/**
 * Retrieves the full user settings record for a given Telegram chat ID.
 *
 * Response format:
 *  - 200: `{ data: UserSettings }` — The complete user settings record
 *  - 400: `{ error: { message, code } }` — Missing or invalid chat ID
 *  - 404: `{ error: { message, code } }` — No user found for the chat ID
 *
 * The `telegramChatId` column has a UNIQUE constraint in the database,
 * ensuring at most one result per query. Uses `.limit(1)` for explicitness.
 */
settingsRouter.get(
  "/settings/:chatId",
  async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // Extract chatId from route params — @types/express v5 types params
      // as string | string[], so we narrow to string with typeof guard
      const chatIdParam = req.params["chatId"];

      if (typeof chatIdParam !== "string" || chatIdParam.length === 0) {
        res.status(400).json({
          success: false,
          error: "Chat ID is required",
        });
        return;
      }

      const chatId: string = chatIdParam;

      // Query user settings by Telegram chat ID using the UNIQUE index
      const results = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.telegramChatId, chatId))
        .limit(1);

      // With noUncheckedIndexedAccess, results[0] is T | undefined
      const user = results[0];

      if (!user) {
        res.status(404).json({
          success: false,
          error: "User settings not found",
          message: "No user settings found for the given Telegram chat ID",
        });
        return;
      }

      logger.debug({ chatId }, "User settings fetched");
      res.json({ success: true, data: user });
    } catch (error: unknown) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /settings/:chatId — Update User Settings
// ---------------------------------------------------------------------------

/**
 * Updates user preference settings for a given Telegram chat ID.
 *
 * Supports partial updates — only fields included in the request body are
 * written to the database. The `updatedAt` timestamp is always refreshed.
 *
 * Request body validation:
 *  - Parsed with `updateSettingsSchema.safeParse()` for error-safe validation
 *  - Invalid bodies return 400 with flattened Zod error details
 *
 * Value transformations:
 *  - `minConfidence`: Numeric value is converted to string for PostgreSQL
 *    `numeric(3,2)` storage to preserve decimal precision (AAP Rule §0.7.2)
 *  - `markets` and `timeframes`: Already validated as lowercase DB enum values
 *    by the shared Zod schemas — no additional transformation needed
 *
 * Response format:
 *  - 200: `{ data: UserSettings }` — The updated user settings record
 *  - 400: `{ error: { message, code, details? } }` — Validation failure
 *  - 404: `{ error: { message, code } }` — No user found for the chat ID
 */
settingsRouter.put(
  "/settings/:chatId",
  async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // Extract chatId from route params — @types/express v5 types params
      // as string | string[], so we narrow to string with typeof guard
      const chatIdParam = req.params["chatId"];

      if (typeof chatIdParam !== "string" || chatIdParam.length === 0) {
        res.status(400).json({
          success: false,
          error: "Chat ID is required",
        });
        return;
      }

      const chatId: string = chatIdParam;

      // Validate request body against the update schema
      const parsed = updateSettingsSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: "Invalid settings data",
          message: JSON.stringify(parsed.error.flatten()),
        });
        return;
      }

      // Build the partial update object — only include fields that were
      // explicitly provided in the request to support true partial updates.
      // Conditional spreads ensure absent fields are not set to undefined,
      // which satisfies exactOptionalPropertyTypes.
      const updateValues = {
        // Markets: already validated as lowercase DB enum values by marketSchema
        ...(parsed.data.markets !== undefined
          ? { markets: parsed.data.markets }
          : {}),
        // Min confidence: convert number to string for numeric(3,2) precision
        // per AAP Rule §0.7.2 — database column uses string-based decimals
        ...(parsed.data.minConfidence !== undefined
          ? { minConfidence: String(parsed.data.minConfidence) }
          : {}),
        // Timeframes: already validated as lowercase DB enum values by timeframeSchema
        ...(parsed.data.timeframes !== undefined
          ? { timeframes: parsed.data.timeframes }
          : {}),
        // isActive: boolean toggle for notification delivery
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
        // Always refresh the updatedAt timestamp on any preference change
        updatedAt: new Date(),
      };

      // Atomic update with returning — Drizzle's .returning() retrieves
      // the full updated row in a single round-trip to the database
      const results = await db
        .update(userSettings)
        .set(updateValues)
        .where(eq(userSettings.telegramChatId, chatId))
        .returning();

      // With noUncheckedIndexedAccess, results[0] is T | undefined
      const updated = results[0];

      if (!updated) {
        res.status(404).json({
          success: false,
          error: "User settings not found",
          message: "No user settings found for the given Telegram chat ID",
        });
        return;
      }

      // Log the update with audit context: which chat ID and which fields changed
      logger.info(
        { chatId, updatedFields: Object.keys(parsed.data) },
        "User settings updated",
      );
      res.json({ success: true, data: updated });
    } catch (error: unknown) {
      next(error);
    }
  },
);
