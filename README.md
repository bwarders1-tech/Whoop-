# WHOOP for Claude

An MCP server that connects your [WHOOP](https://www.whoop.com) data to Claude, packaged as a
Claude Desktop Extension (`.mcpb`). Ask Claude how you slept, what your recovery trend looks like,
or whether today is a good day for a hard session — it reads the answer straight from the WHOOP API.

```
You:    How did I sleep last night, and should I train hard today?
Claude: (calls whoop_daily_summary → whoop_summarize_range)
        You slept 7h 02m (81% of your need) with a 64% recovery…
```

## What Claude can read

| Tool | What it does |
| --- | --- |
| `whoop_auth_status` | Whether the account is connected, token expiry, login progress |
| `whoop_login` / `whoop_logout` | Start the OAuth login; delete (and optionally revoke) the tokens |
| `whoop_daily_summary` | One call: cycle, recovery, sleep and workouts for a day |
| `whoop_summarize_range` | Averages, totals, best/worst days over a window |
| `whoop_list_recoveries` / `whoop_get_cycle_recovery` | Recovery %, HRV (rMSSD), resting HR, SpO2, skin temp |
| `whoop_list_sleep` / `whoop_get_sleep` / `whoop_get_cycle_sleep` | Sleep and naps, stages, performance, efficiency, consistency, respiratory rate |
| `whoop_list_cycles` / `whoop_get_cycle` | Day strain, average/max heart rate, calories |
| `whoop_list_workouts` / `whoop_get_workout` | Sport, duration, strain, heart-rate zones, distance |
| `whoop_get_profile` / `whoop_get_body_measurement` | Name, email, height, weight, max heart rate |

There is also a `whoop_morning_briefing` prompt that chains the summary tools into a short daily readout.

Everything is read-only apart from `whoop_login` and `whoop_logout`. The server talks to
`api.prod.whoop.com` and nothing else.

## 1. Create a WHOOP app

1. Sign in at [developer-dashboard.whoop.com](https://developer-dashboard.whoop.com) and create an app.
2. Add the redirect URL **`http://localhost:8788/callback`** (or any loopback URL you prefer — it has
   to match the extension's `WHOOP_REDIRECT_URI` exactly).
3. Request the scopes `offline`, `read:profile`, `read:body_measurement`, `read:cycles`,
   `read:recovery`, `read:sleep`, `read:workout`.
4. Copy the **client ID** and **client secret**.

`offline` is what makes WHOOP issue a refresh token — without it the connection stops working an
hour after you log in.

## 2. Install

### Claude Desktop (extension bundle)

```bash
npm install
npm run build
npm run bundle      # writes build/whoop.mcpb
```

Open `build/whoop.mcpb` with Claude Desktop (or drag it into **Settings → Extensions**), then paste
your client ID, client secret and — if you changed it — your redirect URL into the extension's
settings.

### Claude Code

```bash
npm install && npm run build

claude mcp add whoop -- node "$PWD/dist/src/index.js" \
  -e WHOOP_CLIENT_ID=your-client-id \
  -e WHOOP_CLIENT_SECRET=your-client-secret
```

### Any other MCP client

```json
{
  "mcpServers": {
    "whoop": {
      "command": "node",
      "args": ["/absolute/path/to/dist/src/index.js"],
      "env": {
        "WHOOP_CLIENT_ID": "your-client-id",
        "WHOOP_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

## 3. Connect your account

Either ask Claude to run `whoop_login` and open the URL it returns, or do it once from a terminal:

```bash
WHOOP_CLIENT_ID=... WHOOP_CLIENT_SECRET=... node dist/src/cli.js login
```

Both routes open the WHOOP consent screen, catch the redirect on the loopback listener and write the
tokens to `~/.whoop-mcp/tokens.json` (mode `0600`). Access tokens are refreshed automatically, so
this is a one-time step.

```bash
node dist/src/cli.js status     # show the connection
node dist/src/cli.js logout     # forget the tokens (--revoke also revokes the grant)
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WHOOP_CLIENT_ID` | — | WHOOP app client ID (required) |
| `WHOOP_CLIENT_SECRET` | — | WHOOP app client secret (required) |
| `WHOOP_REDIRECT_URI` | `http://localhost:8788/callback` | Must match a redirect URL on the WHOOP app |
| `WHOOP_TOKEN_FILE` | `~/.whoop-mcp/tokens.json` | Where tokens are stored |
| `WHOOP_SCOPES` | all read scopes + `offline` | Space or comma separated; `offline` is always added |
| `WHOOP_API_BASE_URL` | `https://api.prod.whoop.com/developer` | API root (v2 paths are appended) |
| `WHOOP_AUTHORIZE_URL` / `WHOOP_TOKEN_URL` | WHOOP production OAuth endpoints | Override for testing |
| `WHOOP_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |
| `WHOOP_MAX_RETRIES` | `3` | Retries for 429/5xx and network errors (honours `Retry-After`) |
| `WHOOP_LOGIN_TIMEOUT_MS` | `300000` | How long the callback listener waits |
| `WHOOP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` — always to stderr |
| `WHOOP_ACCESS_TOKEN` / `WHOOP_REFRESH_TOKEN` | — | Use tokens you already have instead of logging in |

## Things worth knowing

- **Dates.** Tools accept `YYYY-MM-DD` or full ISO-8601 timestamps, or a `days` lookback. A bare end
  date covers that whole day. WHOOP timestamps are UTC.
- **Pagination.** WHOOP pages at 25 records; the list tools follow `next_token` for you up to the
  `limit` you ask for (default 10, max 200) and hand back a cursor if more remain.
- **Rate limits.** WHOOP allows roughly 100 requests/minute. 429s and 5xx responses are retried with
  exponential backoff and the `Retry-After` header.
- **Privacy.** Tokens and data stay on your machine; the only outbound host is `api.prod.whoop.com`.
  `whoop_logout --revoke` removes the grant at WHOOP's end too.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Port 8788 is already in use` | Something else holds the port. Free it, or set `WHOOP_REDIRECT_URI` to another port and register that URL in the WHOOP dashboard. |
| `invalid_grant` on login | The authorization code was reused or expired — run `whoop_login` again. |
| `invalid_grant` on refresh | The refresh token was rotated away or revoked; log in again. |
| HTTP 403 from a data tool | The account was connected without that scope. Log out and log in again, approving everything. |
| Redirect mismatch on the consent screen | `WHOOP_REDIRECT_URI` and the URL registered on the WHOOP app must be byte-identical. |
| Browser cannot reach the callback | Use `http://127.0.0.1:8788/callback` on both sides. |
| Claude says it is not connected | Run `whoop_auth_status`; if `connected` is false, run `whoop_login`. |

## Development

```bash
npm install
npm run typecheck
npm test          # 115 tests: unit, OAuth, API client, MCP tools, stdio + CLI end to end
npm run bundle    # build/whoop.mcpb
```

The test suite runs the real server against an in-process stand-in for the WHOOP API
(`test/helpers/mockWhoop.ts`), including a full OAuth round trip through the loopback listener, token
refresh, pagination, retry/backoff and every tool's output — no WHOOP account or network needed.

Built against **WHOOP API v2** (`/v2/...`, UUID sleep and workout ids). If WHOOP moves an endpoint,
`WHOOP_API_BASE_URL` lets you point the client elsewhere without a code change.

## License

MIT — see [LICENSE](LICENSE).
