import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AuthManager } from "../auth/authManager.js";
import type { WhoopConfig } from "../config.js";
import { ConfigurationError, NotAuthenticatedError, WhoopApiError, WhoopError } from "../errors.js";
import { logger } from "../logger.js";
import type { WhoopClient } from "../whoop/client.js";

export interface ToolContext {
  config: WhoopConfig;
  auth: AuthManager;
  client: WhoopClient;
}

/** Default number of records a list tool returns when the caller does not say. */
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 200;

export const rangeShape = {
  start: z
    .string()
    .optional()
    .describe('Start of the range, "YYYY-MM-DD" or an ISO-8601 timestamp. Defaults to WHOOP\'s own window.'),
  end: z
    .string()
    .optional()
    .describe('End of the range, "YYYY-MM-DD" (inclusive of that whole day) or an ISO-8601 timestamp.'),
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Look back this many days from now (or from `end`). Ignored when both start and end are given."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum number of records to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
  next_token: z.string().optional().describe("Pagination cursor returned by a previous call."),
};

export function ok(summary: string, data?: unknown): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }] };
}

export function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool handler, turning any thrown error into a readable tool error. */
export async function safe(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    logger.debug("Tool call failed", { error: error instanceof Error ? error.message : String(error) });
    return failure(describeError(error));
  }
}

export function describeError(error: unknown): string {
  if (error instanceof NotAuthenticatedError || error instanceof ConfigurationError) {
    return error.message;
  }
  if (error instanceof WhoopApiError || error instanceof WhoopError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** Returns undefined instead of throwing when WHOOP has no record yet. */
export async function optional<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof WhoopApiError && (error.status === 404 || error.status === 204)) {
      return undefined;
    }
    throw error;
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.round(limit), 1), MAX_LIMIT);
}
