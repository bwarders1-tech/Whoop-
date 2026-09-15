import type { AuthManager } from "../auth/authManager.js";
import type { WhoopConfig } from "../config.js";
import { WhoopApiError, WhoopError, truncate } from "../errors.js";
import { logger } from "../logger.js";
import type {
  BodyMeasurement,
  Cycle,
  Paginated,
  Recovery,
  Sleep,
  UserProfile,
  Workout,
} from "./types.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 20_000;
/** WHOOP rejects `limit` above 25. */
export const MAX_PAGE_LIMIT = 25;

export interface CollectionParams {
  limit?: number;
  start?: string;
  end?: string;
  nextToken?: string;
}

export interface RequestOptions {
  method?: "GET" | "DELETE";
  query?: Record<string, string | number | undefined>;
  /** Set for endpoints that legitimately answer with an empty body. */
  expectEmptyBody?: boolean;
}

export class WhoopClient {
  constructor(
    private readonly config: WhoopConfig,
    private readonly auth: AuthManager,
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    let refreshed = false;

    for (let attempt = 0; ; attempt += 1) {
      const token = await this.auth.getAccessToken();
      let response: Response;
      try {
        response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": "whoop-mcp-extension/1.0",
          },
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (error) {
        if (attempt < this.config.maxRetries) {
          const delay = backoffDelay(attempt);
          logger.warn("WHOOP request failed, retrying", { url, attempt: attempt + 1, delay, error: String(error) });
          await sleep(delay);
          continue;
        }
        throw new WhoopError(`Could not reach the WHOOP API (${url}): ${String(error)}`, { cause: error });
      }

      if (response.status === 401 && !refreshed) {
        // The token may have been revoked or expired early; try once with a fresh one.
        refreshed = true;
        await response.text().catch(() => undefined);
        logger.debug("WHOOP returned 401, forcing a token refresh");
        await this.auth.getAccessToken({ forceRefresh: true });
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
          const delay = retryAfterDelay(response.headers.get("retry-after")) ?? backoffDelay(attempt);
          logger.warn("WHOOP request throttled or unavailable, retrying", {
            url,
            status: response.status,
            attempt: attempt + 1,
            delay,
          });
          await sleep(delay);
          continue;
        }
        throw new WhoopApiError({ status: response.status, url, body });
      }

      if (options.expectEmptyBody || response.status === 204) {
        await response.text().catch(() => undefined);
        return undefined as T;
      }

      const text = await response.text();
      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new WhoopError(`WHOOP returned a non-JSON response for ${url}: ${truncate(text)}`, { cause: error });
      }
    }
  }

  async getCollection<T>(path: string, params: CollectionParams = {}): Promise<Paginated<T>> {
    const payload = await this.request<Paginated<T>>(path, {
      query: {
        limit: params.limit,
        start: params.start,
        end: params.end,
        nextToken: params.nextToken,
      },
    });
    return {
      records: Array.isArray(payload?.records) ? payload.records : [],
      next_token: payload?.next_token ?? undefined,
    };
  }

  /** Follows `next_token` until `maxRecords` is reached or WHOOP runs out of pages. */
  async collectAll<T>(
    path: string,
    params: CollectionParams & { maxRecords: number },
  ): Promise<{ records: T[]; next_token?: string }> {
    const records: T[] = [];
    let nextToken = params.nextToken;
    let pages = 0;

    while (records.length < params.maxRecords) {
      const remaining = params.maxRecords - records.length;
      const page = await this.getCollection<T>(path, {
        limit: Math.min(params.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT, remaining),
        start: params.start,
        end: params.end,
        nextToken,
      });
      records.push(...page.records);
      pages += 1;
      nextToken = page.next_token ?? undefined;
      if (!nextToken || page.records.length === 0) break;
      if (pages >= 200) {
        logger.warn("Stopped paginating after 200 pages", { path });
        break;
      }
    }

    return { records: records.slice(0, params.maxRecords), next_token: nextToken };
  }

  getProfile(): Promise<UserProfile> {
    return this.request<UserProfile>("/v2/user/profile/basic");
  }

  getBodyMeasurement(): Promise<BodyMeasurement> {
    return this.request<BodyMeasurement>("/v2/user/measurement/body");
  }

  getCycles(params: CollectionParams): Promise<Paginated<Cycle>> {
    return this.getCollection<Cycle>("/v2/cycle", params);
  }

  getCycle(cycleId: number | string): Promise<Cycle> {
    return this.request<Cycle>(`/v2/cycle/${encodeURIComponent(String(cycleId))}`);
  }

  getCycleSleep(cycleId: number | string): Promise<Sleep> {
    return this.request<Sleep>(`/v2/cycle/${encodeURIComponent(String(cycleId))}/sleep`);
  }

  getCycleRecovery(cycleId: number | string): Promise<Recovery> {
    return this.request<Recovery>(`/v2/cycle/${encodeURIComponent(String(cycleId))}/recovery`);
  }

  getRecoveries(params: CollectionParams): Promise<Paginated<Recovery>> {
    return this.getCollection<Recovery>("/v2/recovery", params);
  }

  getSleepCollection(params: CollectionParams): Promise<Paginated<Sleep>> {
    return this.getCollection<Sleep>("/v2/activity/sleep", params);
  }

  getSleep(sleepId: string): Promise<Sleep> {
    return this.request<Sleep>(`/v2/activity/sleep/${encodeURIComponent(sleepId)}`);
  }

  getWorkouts(params: CollectionParams): Promise<Paginated<Workout>> {
    return this.getCollection<Workout>("/v2/activity/workout", params);
  }

  getWorkout(workoutId: string): Promise<Workout> {
    return this.request<Workout>(`/v2/activity/workout/${encodeURIComponent(workoutId)}`);
  }

  /** Revokes the OAuth grant for the connected user. */
  revokeAccess(): Promise<void> {
    return this.request<void>("/v2/user/access", { method: "DELETE", expectEmptyBody: true });
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.apiBaseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function backoffDelay(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(base + Math.random() * 250);
}

export function retryAfterDelay(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  // Deliberately not unref'd: the retry must keep the process alive.
  return new Promise((resolve) => setTimeout(resolve, ms));
}
