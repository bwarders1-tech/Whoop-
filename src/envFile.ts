import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "./logger.js";

/**
 * Minimal .env support so credentials can live in one gitignored file instead
 * of a shell profile or an MCP client config. Values already present in the
 * environment always win.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      // An unquoted value ends at an inline comment introduced by whitespace.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }

    result[key] = value;
  }

  return result;
}

export function envFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.WHOOP_ENV_FILE?.trim();
  if (explicit) return [path.resolve(explicit)];
  return [path.resolve(process.cwd(), ".env"), path.join(os.homedir(), ".whoop-mcp", ".env")];
}

/**
 * Loads the first .env file that exists into `target`, without overwriting
 * anything already set. Returns the file used, if any.
 */
export function loadEnvFile(target: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of envFileCandidates(target)) {
    let contents: string;
    try {
      contents = fs.readFileSync(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      logger.warn("Could not read the env file", { path: candidate, error: String(error) });
      continue;
    }

    const parsed = parseEnvFile(contents);
    const applied: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (target[key] === undefined || target[key] === "") {
        target[key] = value;
        applied.push(key);
      }
    }
    logger.debug("Loaded settings from an env file", { path: candidate, keys: applied });
    return candidate;
  }
  return undefined;
}
