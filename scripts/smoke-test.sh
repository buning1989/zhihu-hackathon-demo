#!/usr/bin/env sh
set -eu

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT}}"
FRONTEND_URL="${FRONTEND_URL:-http://localhost:${FRONTEND_PORT}}"

printf "Checking backend health: %s/health\n" "$BACKEND_URL"
curl -fsS "$BACKEND_URL/health" >/dev/null

printf "Checking frontend homepage: %s/\n" "$FRONTEND_URL"
curl -fsS "$FRONTEND_URL/" >/dev/null

printf "Smoke test passed.\n"
