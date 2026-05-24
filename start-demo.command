#!/bin/zsh
set -u

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_HEALTH_URL="http://127.0.0.1:${BACKEND_PORT}/health"
DEMO_URL="http://127.0.0.1:${FRONTEND_PORT}/?dataMode=cache_first"
LEGACY_DEMO_URL="http://127.0.0.1:${FRONTEND_PORT}/frontend/index.html?dataMode=cache_first"

backend_job=""
frontend_job=""

log() {
  printf '[start-demo] %s\n' "$1"
}

port_in_use() {
  local port="$1"

  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "${port}" >/dev/null 2>&1
    return $?
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP@127.0.0.1:"${port}" -sTCP:LISTEN -t >/dev/null 2>&1
    return $?
  fi

  return 1
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempts="${3:-30}"
  local delay_seconds="${4:-1}"
  local attempt=1

  log "Waiting for ${label}: ${url}"
  while [ "${attempt}" -le "${attempts}" ]; do
    if curl -fsS --max-time 2 "${url}" >/dev/null 2>&1; then
      log "${label} is ready."
      return 0
    fi

    sleep "${delay_seconds}"
    attempt=$((attempt + 1))
  done

  log "Warning: ${label} did not respond before timeout."
  return 1
}

url_serves_demo() {
  local url="$1"

  curl -fsS --max-time 2 "${url}" 2>/dev/null | grep -q 'LIFE_PATH_API_BASE'
}

cd "${PROJECT_ROOT}" || exit 1

log "Project root: ${PROJECT_ROOT}"
log "Backend port: ${BACKEND_PORT}"
log "Frontend port: ${FRONTEND_PORT}"

if port_in_use "${BACKEND_PORT}"; then
  log "Backend port ${BACKEND_PORT} is already in use; skipping backend startup."
else
  log "Starting backend: npm run dev -w backend"
  (npm run dev -w backend 2>&1 | sed 's/^/[backend] /') &
  backend_job="$!"
fi

if port_in_use "${FRONTEND_PORT}"; then
  log "Frontend port ${FRONTEND_PORT} is already in use; skipping frontend startup."
  if ! url_serves_demo "${DEMO_URL}" && url_serves_demo "${LEGACY_DEMO_URL}"; then
    log "Existing frontend server is serving the project root; using legacy demo path."
    DEMO_URL="${LEGACY_DEMO_URL}"
  fi
else
  log "Starting frontend static server: python3 -m http.server --bind 127.0.0.1 ${FRONTEND_PORT} --directory frontend"
  (python3 -m http.server --bind 127.0.0.1 "${FRONTEND_PORT}" --directory frontend 2>&1 | sed 's/^/[frontend] /') &
  frontend_job="$!"
fi

wait_for_url "backend" "${BACKEND_HEALTH_URL}" 30 1
wait_for_url "frontend" "${DEMO_URL}" 30 1

log "Opening demo: ${DEMO_URL}"
open "${DEMO_URL}"

if [ -n "${backend_job}${frontend_job}" ]; then
  log "Demo is running. Keep this Terminal window open to keep services started here alive."
  log "Press Ctrl+C in this window when you are finished."
  wait
else
  log "Both ports were already in use. Browser opened; no new service was started by this script."
fi
