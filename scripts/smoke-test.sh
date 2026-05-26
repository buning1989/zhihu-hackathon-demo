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

printf "Checking replay search fixture without real Zhihu API: %s/api/search\n" "$BACKEND_URL"
search_status="$(
  curl -sS -o "$search_body" -w "%{http_code}" \
    "$BACKEND_URL/api/search?query=%E4%B8%8D%E5%B7%A5%E4%BD%9C%E4%BA%86%E8%83%BD%E5%8E%BB%E5%93%AA%E5%84%BF&count=1&dataMode=replay"
)"

if [ "$search_status" -lt 200 ] || [ "$search_status" -ge 600 ]; then
  printf "Unexpected search HTTP status: %s\n" "$search_status" >&2
  cat "$search_body" >&2
  exit 1
fi

if ! grep -q '"success"[[:space:]]*:[[:space:]]*true' "$search_body"; then
  printf "Replay search response did not contain success=true.\n" >&2
  cat "$search_body" >&2
  exit 1
fi

if ! grep -q '本地回放' "$search_body"; then
  printf "Replay search response did not contain fixture content.\n" >&2
  cat "$search_body" >&2
  exit 1
fi

printf "Checking frontend homepage: %s/\n" "$FRONTEND_URL"
curl -fsS "$FRONTEND_URL/" >/dev/null

printf "Smoke test passed.\n"
