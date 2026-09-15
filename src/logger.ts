/**
 * Logging for a stdio MCP server.
 *
 * stdout carries the JSON-RPC stream, so every diagnostic message must go to
 * stderr. Never use console.log anywhere in this project.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): LogLevel {
  const raw = (process.env.WHOOP_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error" || raw === "silent") {
    return raw;
  }
  return "info";
}

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  const configured = currentLevel();
  if (configured === "silent") return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configured];
}

function write(level: Exclude<LogLevel, "silent">, message: string, meta?: unknown): void {
  if (!enabled(level)) return;
  const stamp = new Date().toISOString();
  let line = `${stamp} [whoop-mcp] ${level.toUpperCase()} ${message}`;
  if (meta !== undefined) {
    line += ` ${safeStringify(meta)}`;
  }
  process.stderr.write(`${line}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val)) ?? String(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};
