import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../logger.js";

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds at which the access token expires. */
  expires_at: number;
  token_type: string;
  scope?: string;
  /** Epoch milliseconds of the last successful write. */
  obtained_at: number;
}

/**
 * Persists WHOOP tokens as a 0600 JSON file so the connection survives restarts
 * of the MCP server.
 */
export class TokenStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<StoredTokens | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      logger.warn("Could not read the WHOOP token file", { path: this.filePath, error: String(error) });
      return null;
    }

    try {
      return normalize(JSON.parse(raw));
    } catch (error) {
      logger.warn("The WHOOP token file is unreadable and will be ignored", {
        path: this.filePath,
        error: String(error),
      });
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write cannot leave a half-written file.
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    // rename() keeps the temp file's mode, but be explicit in case it already existed.
    await fs.chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

function normalize(value: unknown): StoredTokens {
  if (typeof value !== "object" || value === null) {
    throw new Error("token file does not contain an object");
  }
  const record = value as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("token file has no access_token");
  }
  const expiresAt = record.expires_at;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("token file has no usable expires_at");
  }
  const refreshToken = typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : undefined;
  const scope = typeof record.scope === "string" && record.scope ? record.scope : undefined;
  const obtainedAt = typeof record.obtained_at === "number" && Number.isFinite(record.obtained_at)
    ? record.obtained_at
    : Date.now();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    token_type: typeof record.token_type === "string" && record.token_type ? record.token_type : "bearer",
    scope,
    obtained_at: obtainedAt,
  };
}
