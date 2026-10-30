#!/usr/bin/env bash
# One command for the whole local stack: the backend on :8791 (plus Postgres with DB=postgres), and the app/.env
# lines that point the app at it. See docs/running.md.
#
#   scripts/dev-up.sh                         # free: AGENT=scripted, SEARCH=fixtures, JSON store
#   SEARCH=claude scripts/dev-up.sh           # real page search (~US$0.30 a search, needs the Anthropic key)
#   AGENT=claude_code scripts/dev-up.sh       # real scraper builds by headless Claude Code (~US$1-3 a build)
#   AGENT=devin SEARCH=devin scripts/dev-up.sh  # Devin (needs DEVIN_API_KEY and DEVIN_ORG_ID in your shell)
#   DB=postgres scripts/dev-up.sh             # Homebrew postgresql@16 on :5433 instead of JSON files
#
# Keys are never printed or written to the repo. ANTHROPIC_API_KEY comes from your shell, or else from
# EXPO_PUBLIC_ANTHROPIC_API_KEY in the main checkout's app/.env (ENV_FILE overrides that path).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_CHECKOUT="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)/.." && pwd)"
ENV_FILE="${ENV_FILE:-$MAIN_CHECKOUT/app/.env}"

export AGENT="${AGENT:-scripted}"
export SEARCH="${SEARCH:-fixtures}"
export PORT="${PORT:-8791}"
export DATA_DIR="${DATA_DIR:-$ROOT/backend/data}"
DB="${DB:-json}"
mkdir -p "$DATA_DIR"

# The team token: kept in DATA_DIR (gitignored) so the app's .env stays valid across restarts.
TOKEN_FILE="$DATA_DIR/.api-token"
if [ -z "${API_TOKEN:-}" ]; then
  [ -s "$TOKEN_FILE" ] || (umask 077; openssl rand -hex 16 > "$TOKEN_FILE")
  API_TOKEN="$(cat "$TOKEN_FILE")"
fi
export API_TOKEN

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  key="$(sed -n 's/^EXPO_PUBLIC_ANTHROPIC_API_KEY=//p' "$ENV_FILE" | tail -1 | tr -d '"'"'"'\r')"
  [ -n "$key" ] && export ANTHROPIC_API_KEY="$key"
fi
if [ "$SEARCH" = "claude" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SEARCH=claude needs ANTHROPIC_API_KEY (shell) or EXPO_PUBLIC_ANTHROPIC_API_KEY in $ENV_FILE" >&2
  exit 1
fi
if [ "$AGENT" = "devin" ] || [ "$SEARCH" = "devin" ]; then
  if [ -z "${DEVIN_API_KEY:-}" ] || [ -z "${DEVIN_ORG_ID:-}" ]; then
    echo "AGENT/SEARCH=devin needs DEVIN_API_KEY and DEVIN_ORG_ID in your shell" >&2
    exit 1
  fi
fi

if [ "$DB" = "postgres" ]; then
  PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
  PG_DATA="${PG_DATA:-$DATA_DIR/postgres}"
  PG_PORT="${PG_PORT:-5433}"
  if [ ! -x "$PG_BIN/pg_ctl" ]; then
    echo "DB=postgres needs Homebrew postgresql@16: brew install postgresql@16" >&2
    exit 1
  fi
  # Postgres on macOS refuses to start without a valid locale ("postmaster became multithreaded during startup").
  export LC_ALL="${PG_LC_ALL:-en_US.UTF-8}" LANG="${PG_LC_ALL:-en_US.UTF-8}"
  [ -d "$PG_DATA" ] || "$PG_BIN/initdb" -D "$PG_DATA" -U scanner --auth=trust --no-locale -E UTF8 >/dev/null
  if ! "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
    "$PG_BIN/pg_ctl" -D "$PG_DATA" -o "-p $PG_PORT -k /tmp" -l "$DATA_DIR/postgres.log" -w start >/dev/null
  fi
  "$PG_BIN/psql" -h localhost -p "$PG_PORT" -U scanner -d postgres -tAc "select 1 from pg_database where datname='scanner'" | grep -q 1 \
    || "$PG_BIN/createdb" -h localhost -p "$PG_PORT" -U scanner scanner
  export DATABASE_URL="postgresql://scanner@localhost:$PG_PORT/scanner"
  echo "Postgres 16 on localhost:$PG_PORT (data $PG_DATA; stop: $PG_BIN/pg_ctl -D $PG_DATA stop)"
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
LAN_IP="${LAN_IP:-127.0.0.1}"

cat <<EOF

Backend: AGENT=$AGENT SEARCH=$SEARCH DB=$DB on http://$LAN_IP:$PORT (data in $DATA_DIR)
Anthropic key: $([ -n "${ANTHROPIC_API_KEY:-}" ] && echo "loaded (not shown)" || echo "none")

Put these in app/.env, then restart Expo (npx expo start -c):

EXPO_PUBLIC_API_MODE=live
EXPO_PUBLIC_API_BASE_URL=http://$LAN_IP:$PORT
EXPO_PUBLIC_API_TOKEN=$API_TOKEN

Check it: (cd tools/contract-check && BASE_URL=http://127.0.0.1:$PORT TOKEN=\$(cat $TOKEN_FILE) npm run check)

EOF

cd "$ROOT/backend"
exec uv run python -m server
