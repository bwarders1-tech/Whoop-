#!/usr/bin/env bash
#
# Installs the WHOOP extension for Claude: builds the server, stores your
# credentials, connects your WHOOP account and registers the server with
# whichever Claude app you have.
#
#   bash scripts/install.sh              # interactive
#   bash scripts/install.sh --no-login   # skip the browser login for now
#
# Credentials can also be supplied up front:
#   WHOOP_CLIENT_ID=… WHOOP_CLIENT_SECRET=… bash scripts/install.sh
#
set -euo pipefail

REPO_URL="https://github.com/bwarders1-tech/Whoop-.git"
BRANCH="claude/whoop-claude-extension-eyqib3"
DEFAULT_DIR="$HOME/whoop-claude-extension"
DO_LOGIN=1
DO_BUNDLE=1

for arg in "$@"; do
  case "$arg" in
    --no-login) DO_LOGIN=0 ;;
    --no-bundle) DO_BUNDLE=0 ;;
    --dir=*) DEFAULT_DIR="${arg#--dir=}" ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Node -----------------------------------------------------------------
say "Checking Node.js"
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node 18.17 or newer from https://nodejs.org and run this again."

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 18 ] || { [ "$NODE_MAJOR" -eq 18 ] && [ "$NODE_MINOR" -lt 17 ]; }; then
  fail "Node $NODE_VERSION is too old. Install Node 18.17 or newer from https://nodejs.org."
fi
info "Node $NODE_VERSION"

# --- 2. Source ---------------------------------------------------------------
# Prefer the checkout this script was run from, whatever the working directory,
# so "bash somewhere/scripts/install.sh" never clones a second copy.
is_checkout() { [ -f "$1/package.json" ] && grep -q '"name": "whoop-mcp-extension"' "$1/package.json" 2>/dev/null; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_ROOT="$(dirname "$SCRIPT_DIR")"

if is_checkout "$SCRIPT_ROOT"; then
  APP_DIR="$SCRIPT_ROOT"
  cd "$APP_DIR"
  say "Using the checkout in $APP_DIR"
elif is_checkout "$PWD"; then
  APP_DIR="$PWD"
  say "Using the checkout in $APP_DIR"
else
  APP_DIR="$DEFAULT_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    say "Updating $APP_DIR"
    git -C "$APP_DIR" fetch origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    say "Cloning into $APP_DIR"
    command -v git >/dev/null 2>&1 || fail "git is not installed."
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  cd "$APP_DIR"
fi

# --- 3. Build ----------------------------------------------------------------
say "Installing dependencies and building"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build

# --- 4. Credentials ----------------------------------------------------------
ENV_FILE="$APP_DIR/.env"
say "Configuring WHOOP credentials"
if [ -f "$ENV_FILE" ] && grep -q '^WHOOP_CLIENT_SECRET=.\+' "$ENV_FILE"; then
  info "Keeping the credentials already in $ENV_FILE"
else
  CLIENT_ID="${WHOOP_CLIENT_ID:-}"
  CLIENT_SECRET="${WHOOP_CLIENT_SECRET:-}"
  if [ -z "$CLIENT_ID" ]; then
    printf '  Client ID (from developer-dashboard.whoop.com): '
    read -r CLIENT_ID
  fi
  if [ -z "$CLIENT_SECRET" ]; then
    printf '  Client secret (input hidden): '
    read -rs CLIENT_SECRET
    printf '\n'
  fi
  [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] || fail "Both the client ID and the client secret are required."

  umask 077
  cat > "$ENV_FILE" <<EOF
WHOOP_CLIENT_ID=$CLIENT_ID
WHOOP_CLIENT_SECRET=$CLIENT_SECRET
WHOOP_REDIRECT_URI=${WHOOP_REDIRECT_URI:-http://localhost:8788/callback}
EOF
  chmod 600 "$ENV_FILE"
  info "Wrote $ENV_FILE (mode 600, gitignored)"
fi

REDIRECT_URI="$(grep '^WHOOP_REDIRECT_URI=' "$ENV_FILE" | cut -d= -f2- || true)"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:8788/callback}"
info "Redirect URL: $REDIRECT_URI"
info "This exact URL must be registered on your app at developer-dashboard.whoop.com."

# --- 5. Pre-flight -----------------------------------------------------------
say "Checking the setup"
set +e
node dist/src/cli.js doctor
set -e

# --- 6. Login ----------------------------------------------------------------
if [ "$DO_LOGIN" -eq 1 ]; then
  say "Connecting your WHOOP account"
  info "A browser window will open for the WHOOP consent screen."
  set +e
  node dist/src/cli.js login
  LOGIN_STATUS=$?
  set -e
  if [ "$LOGIN_STATUS" -ne 0 ]; then
    printf '\n\033[33m%s\033[0m\n' "Login did not complete. Fix what the message above reports, then run: node $APP_DIR/dist/src/cli.js login"
  fi
else
  info "Skipping login (--no-login). Run later: node $APP_DIR/dist/src/cli.js login"
fi

# --- 7. Register with Claude -------------------------------------------------
say "Registering with Claude"
REGISTERED=0
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q '^whoop\b'; then
    info "Claude Code already has an MCP server named \"whoop\" — leaving it alone."
    REGISTERED=1
  elif claude mcp add whoop -- node "$APP_DIR/dist/src/index.js"; then
    info "Added the \"whoop\" MCP server to Claude Code."
    REGISTERED=1
  else
    info "Could not add it automatically. Run: claude mcp add whoop -- node \"$APP_DIR/dist/src/index.js\""
  fi
else
  info "The Claude Code CLI was not found on PATH; skipping that step."
fi

if [ "$DO_BUNDLE" -eq 1 ]; then
  set +e
  npm run bundle >/dev/null 2>&1
  BUNDLE_STATUS=$?
  set -e
  if [ "$BUNDLE_STATUS" -eq 0 ] && [ -f "$APP_DIR/build/whoop.mcpb" ]; then
    info "Claude Desktop bundle: $APP_DIR/build/whoop.mcpb"
    info "Open it (or drag it into Settings → Extensions) to install it there."
  fi
fi

# --- 8. Done -----------------------------------------------------------------
say "Done"
info "Check anytime:   node $APP_DIR/dist/src/cli.js doctor"
info "Reconnect:       node $APP_DIR/dist/src/cli.js login"
info "Disconnect:      node $APP_DIR/dist/src/cli.js logout --revoke"
if [ "$REGISTERED" -eq 1 ]; then
  info "Then ask Claude: \"How did I sleep last night?\""
fi
