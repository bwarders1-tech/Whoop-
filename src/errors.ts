/** Error types shared by the OAuth layer, the API client and the tools. */

export class WhoopError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** No usable credentials: the user has to run the login flow first. */
export class NotAuthenticatedError extends WhoopError {
  constructor(message = "Not connected to WHOOP.") {
    super(
      `${message} Run the "whoop_login" tool (or \`whoop-mcp login\` on the command line) ` +
        `to connect your WHOOP account.`,
    );
  }
}

/** The extension is missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET or similar. */
export class ConfigurationError extends WhoopError {}

/** A non-2xx response from the WHOOP API. */
export class WhoopApiError extends WhoopError {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(params: { status: number; url: string; body: string; message?: string }) {
    super(params.message ?? describeStatus(params.status, params.body));
    this.status = params.status;
    this.url = params.url;
    this.body = params.body;
  }
}

/** A non-2xx response from the WHOOP OAuth token endpoint. */
export class OAuthError extends WhoopError {
  readonly status: number;
  readonly body: string;

  constructor(params: { status: number; body: string; message?: string }) {
    super(params.message ?? `WHOOP OAuth request failed with HTTP ${params.status}: ${truncate(params.body)}`);
    this.status = params.status;
    this.body = params.body;
  }
}

function describeStatus(status: number, body: string): string {
  const detail = truncate(body);
  switch (status) {
    case 400:
      return `WHOOP rejected the request (HTTP 400). Check the date range and identifiers. ${detail}`;
    case 401:
      return `WHOOP rejected the access token (HTTP 401). Reconnect with the "whoop_login" tool. ${detail}`;
    case 403:
      return (
        `WHOOP denied access (HTTP 403). The connected account is most likely missing an OAuth scope ` +
        `for this data type; reconnect with "whoop_login" and approve every requested permission. ${detail}`
      );
    case 404:
      return `WHOOP has no record with that identifier (HTTP 404). ${detail}`;
    case 429:
      return `WHOOP rate limit reached (HTTP 429). Wait a moment and try again. ${detail}`;
    default:
      if (status >= 500) {
        return `WHOOP API is unavailable (HTTP ${status}). ${detail}`;
      }
      return `WHOOP API request failed (HTTP ${status}). ${detail}`;
  }
}

export function truncate(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}
