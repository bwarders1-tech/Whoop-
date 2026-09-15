import http from "node:http";
import { AddressInfo } from "node:net";

import { BODY_MEASUREMENT, PROFILE, buildCycles, buildRecoveries, buildSleeps, buildWorkouts } from "./fixtures.js";
import type { Cycle, Recovery, Sleep, Workout } from "../../src/whoop/types.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  body?: string;
}

export type QueuedResponse = {
  status: number;
  body?: unknown;
  /** Sent verbatim instead of `body`, for testing non-JSON responses. */
  raw?: string;
  headers?: Record<string, string>;
};

/**
 * An in-process stand-in for the WHOOP OAuth and REST API, good enough to drive
 * the client, the auth manager and the MCP tools end to end.
 */
export class MockWhoop {
  readonly requests: RecordedRequest[] = [];
  accessToken = "access-token-1";
  refreshToken = "refresh-token-1";
  expiresIn = 3600;
  authorizationCode = "test-auth-code";
  tokenIssueCount = 0;
  private readonly queued = new Map<string, QueuedResponse[]>();
  private server!: http.Server;
  private port = 0;

  cycles: Cycle[] = buildCycles();
  recoveries: Recovery[] = buildRecoveries();
  sleeps: Sleep[] = buildSleeps();
  workouts: Workout[] = buildWorkouts();

  static async start(): Promise<MockWhoop> {
    const mock = new MockWhoop();
    await mock.listen();
    return mock;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get apiBaseUrl(): string {
    return `${this.origin}/developer`;
  }

  get tokenUrl(): string {
    return `${this.origin}/oauth/oauth2/token`;
  }

  get authorizeUrl(): string {
    return `${this.origin}/oauth/oauth2/auth`;
  }

  /** Queue a one-off response for the next request to `METHOD /path`. */
  enqueue(key: string, response: QueuedResponse): void {
    const existing = this.queued.get(key) ?? [];
    existing.push(response);
    this.queued.set(key, existing);
  }

  requestsFor(pathSuffix: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path.endsWith(pathSuffix));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }

  private async listen(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    const body = await readBody(req);
    const query = Object.fromEntries(url.searchParams.entries());
    this.requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query,
      authorization: req.headers.authorization,
      body,
    });

    const key = `${req.method} ${url.pathname}`;
    const queued = this.queued.get(key);
    if (queued && queued.length > 0) {
      const next = queued.shift()!;
      if (next.raw !== undefined) {
        res.writeHead(next.status, { "Content-Type": "text/html", ...next.headers });
        res.end(next.raw);
        return;
      }
      return sendJson(res, next.status, next.body, next.headers);
    }

    if (url.pathname === "/oauth/oauth2/token" && req.method === "POST") {
      return this.handleToken(res, body ?? "");
    }

    if (!url.pathname.startsWith("/developer/")) {
      return sendJson(res, 404, { error: "not_found" });
    }

    if (req.headers.authorization !== `Bearer ${this.accessToken}`) {
      return sendJson(res, 401, { error: "unauthorized", message: "access token expired" });
    }

    const path = url.pathname.slice("/developer".length);
    return this.handleApi(res, req.method ?? "GET", path, url.searchParams);
  }

  private handleToken(res: http.ServerResponse, body: string): void {
    const params = new URLSearchParams(body);
    const grantType = params.get("grant_type");

    if (!params.get("client_id") || !params.get("client_secret")) {
      return sendJson(res, 401, { error: "invalid_client" });
    }

    if (grantType === "authorization_code") {
      if (params.get("code") !== this.authorizationCode) {
        return sendJson(res, 400, { error: "invalid_grant", error_description: "unknown code" });
      }
    } else if (grantType === "refresh_token") {
      if (params.get("refresh_token") !== this.refreshToken) {
        return sendJson(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
      }
    } else {
      return sendJson(res, 400, { error: "unsupported_grant_type" });
    }

    this.tokenIssueCount += 1;
    this.accessToken = `access-token-${this.tokenIssueCount + 1}`;
    this.refreshToken = `refresh-token-${this.tokenIssueCount + 1}`;
    return sendJson(res, 200, {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_in: this.expiresIn,
      token_type: "bearer",
      scope: "offline read:profile read:cycles read:recovery read:sleep read:workout read:body_measurement",
    });
  }

  private handleApi(res: http.ServerResponse, method: string, path: string, query: URLSearchParams): void {
    if (method === "DELETE" && path === "/v2/user/access") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === "/v2/user/profile/basic") return sendJson(res, 200, PROFILE);
    if (path === "/v2/user/measurement/body") return sendJson(res, 200, BODY_MEASUREMENT);
    if (path === "/v2/cycle") return sendJson(res, 200, paginate(this.cycles, query, (item) => item.start));
    if (path === "/v2/recovery") {
      return sendJson(
        res,
        200,
        paginate(this.recoveries, query, (item) => this.cycles.find((cycle) => cycle.id === item.cycle_id)?.start ?? ""),
      );
    }
    if (path === "/v2/activity/sleep") return sendJson(res, 200, paginate(this.sleeps, query, (item) => item.end));
    if (path === "/v2/activity/workout") return sendJson(res, 200, paginate(this.workouts, query, (item) => item.start));

    const cycleMatch = /^\/v2\/cycle\/(\d+)(\/(recovery|sleep))?$/.exec(path);
    if (cycleMatch) {
      const cycleId = Number(cycleMatch[1]);
      const cycle = this.cycles.find((item) => item.id === cycleId);
      if (!cycle) return sendJson(res, 404, { error: "not_found" });
      if (cycleMatch[3] === "recovery") {
        const recovery = this.recoveries.find((item) => item.cycle_id === cycleId);
        return recovery ? sendJson(res, 200, recovery) : sendJson(res, 404, { error: "not_found" });
      }
      if (cycleMatch[3] === "sleep") {
        const recovery = this.recoveries.find((item) => item.cycle_id === cycleId);
        const sleep = this.sleeps.find((item) => item.id === recovery?.sleep_id);
        return sleep ? sendJson(res, 200, sleep) : sendJson(res, 404, { error: "not_found" });
      }
      return sendJson(res, 200, cycle);
    }

    const sleepMatch = /^\/v2\/activity\/sleep\/([^/]+)$/.exec(path);
    if (sleepMatch) {
      const sleep = this.sleeps.find((item) => item.id === decodeURIComponent(sleepMatch[1] ?? ""));
      return sleep ? sendJson(res, 200, sleep) : sendJson(res, 404, { error: "not_found" });
    }

    const workoutMatch = /^\/v2\/activity\/workout\/([^/]+)$/.exec(path);
    if (workoutMatch) {
      const workout = this.workouts.find((item) => item.id === decodeURIComponent(workoutMatch[1] ?? ""));
      return workout ? sendJson(res, 200, workout) : sendJson(res, 404, { error: "not_found" });
    }

    return sendJson(res, 404, { error: "not_found", path });
  }
}

function paginate<T>(records: T[], query: URLSearchParams, timestampOf: (record: T) => string): unknown {
  const start = query.get("start");
  const end = query.get("end");
  const filtered = records.filter((record) => {
    const timestamp = Date.parse(timestampOf(record));
    if (Number.isNaN(timestamp)) return true;
    if (start && timestamp < Date.parse(start)) return false;
    if (end && timestamp > Date.parse(end)) return false;
    return true;
  });

  const limitParam = Number(query.get("limit") ?? "10");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 25) : 10;
  const offset = Number(query.get("nextToken") ?? "0") || 0;
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    records: page,
    next_token: nextOffset < filtered.length ? String(nextOffset) : null,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
