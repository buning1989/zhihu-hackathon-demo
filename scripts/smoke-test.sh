#!/usr/bin/env sh
set -eu

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT}}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:${FRONTEND_PORT}}"

printf "Checking backend health: %s/health\n" "$BACKEND_URL"
curl -fsS "$BACKEND_URL/health" >/dev/null

printf "Checking API health: %s/api/health\n" "$BACKEND_URL"
curl -fsS "$BACKEND_URL/api/health" >/dev/null

search_body="$(mktemp)"
cleanup() {
  rm -f "$search_body"
}
trap cleanup EXIT

printf "Checking search error handling without Zhihu key: %s/api/search\n" "$BACKEND_URL"
search_status="$(
  curl -sS -o "$search_body" -w "%{http_code}" \
    "$BACKEND_URL/api/search?query=%E4%B8%8D%E5%B7%A5%E4%BD%9C%E4%BA%86%E8%83%BD%E5%8E%BB%E5%93%AA%E5%84%BF&count=1"
)"

if [ "$search_status" -lt 200 ] || [ "$search_status" -ge 600 ]; then
  printf "Unexpected search HTTP status: %s\n" "$search_status" >&2
  cat "$search_body" >&2
  exit 1
fi

if grep -q '"success"[[:space:]]*:[[:space:]]*false' "$search_body"; then
  if ! grep -q '"code"[[:space:]]*:[[:space:]]*"ZHIHU_AUTH_FAILED"' "$search_body"; then
    printf "Search error response did not contain ZHIHU_AUTH_FAILED.\n" >&2
    cat "$search_body" >&2
    exit 1
  fi
elif grep -q '"success"[[:space:]]*:[[:space:]]*true' "$search_body"; then
  if ! grep -q '"items"[[:space:]]*:' "$search_body"; then
    printf "Search success response did not contain data.items array.\n" >&2
    cat "$search_body" >&2
    exit 1
  fi
else
  printf "Search response was neither success=true nor expected success=false JSON.\n" >&2
  cat "$search_body" >&2
  exit 1
fi

printf "Checking frontend homepage: %s/\n" "$FRONTEND_URL"
curl -fsS "$FRONTEND_URL/" >/dev/null

printf "Checking Agent Phase 1 production task flow: %s/api/agent/tasks\n" "$BACKEND_URL"
BACKEND_URL="$BACKEND_URL" node backend/scripts/smoke-agent-production.mjs

printf "Smoke test passed.\n"
