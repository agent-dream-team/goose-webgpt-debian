#!/usr/bin/env bash
# DreamBook qualification wrapper: keep the rebuild connector bearer out of argv while
# preserving native tunnel-client managed-runtime supervision.
set -euo pipefail

DEFAULT_ROOT="${CODEX_CHATGPT_WEB_HOME:-${HOME}/.local/share/goose-chatgpt-web-rebuild}"
DEFAULT_REAL="${DEFAULT_ROOT}/tunnel/tunnel-client"
DEFAULT_AUTH="${DEFAULT_ROOT}/secrets/connector-authorization.txt"
TESTING="${CGW_REBUILD_TUNNEL_WRAPPER_TESTING:-}"
REAL_OVERRIDE="${CGW_REBUILD_TUNNEL_CLIENT_REAL:-}"
AUTH_OVERRIDE="${CGW_REBUILD_CONNECTOR_AUTHORIZATION_FILE:-}"

if [[ -n "$REAL_OVERRIDE" || -n "$AUTH_OVERRIDE" ]]; then
  if [[ "$TESTING" != "1" ]]; then
    echo "dreambook-rebuild-tunnel-client-auth-wrapper: path overrides require CGW_REBUILD_TUNNEL_WRAPPER_TESTING=1" >&2
    exit 1
  fi
fi

REAL="${REAL_OVERRIDE:-$DEFAULT_REAL}"
AUTH_FILE="${AUTH_OVERRIDE:-$DEFAULT_AUTH}"

require_absolute() {
  local value="$1" label="$2"
  [[ "$value" = /* ]] || {
    echo "dreambook-rebuild-tunnel-client-auth-wrapper: ${label} must be absolute" >&2
    exit 1
  }
}

require_absolute "$DEFAULT_ROOT" "rebuild home"
require_absolute "$REAL" "tunnel-client path"
require_absolute "$AUTH_FILE" "connector authorization path"

if [[ ! -f "$REAL" || -L "$REAL" || ! -x "$REAL" ]]; then
  echo "dreambook-rebuild-tunnel-client-auth-wrapper: real tunnel-client is missing, non-regular, symlinked, or not executable" >&2
  exit 1
fi
if [[ ! -f "$AUTH_FILE" || -L "$AUTH_FILE" || ! -r "$AUTH_FILE" ]]; then
  echo "dreambook-rebuild-tunnel-client-auth-wrapper: connector authorization file is missing, non-regular, symlinked, or unreadable" >&2
  exit 1
fi

if [[ "$(stat -c %u "$AUTH_FILE")" != "$(id -u)" || "$(stat -c %a "$AUTH_FILE")" != "600" ]]; then
  echo "dreambook-rebuild-tunnel-client-auth-wrapper: connector authorization file must be owned by the current user and mode 0600" >&2
  exit 1
fi

CGW_REBUILD_CONNECTOR_AUTHORIZATION="$(cat "$AUTH_FILE")"
if [[ ${#CGW_REBUILD_CONNECTOR_AUTHORIZATION} -lt 32 \
  || ${#CGW_REBUILD_CONNECTOR_AUTHORIZATION} -gt 4096 \
  || ! "$CGW_REBUILD_CONNECTOR_AUTHORIZATION" =~ ^Bearer[[:space:]][^[:space:]]+$ ]]; then
  unset CGW_REBUILD_CONNECTOR_AUTHORIZATION
  echo "dreambook-rebuild-tunnel-client-auth-wrapper: connector authorization file has invalid content" >&2
  exit 1
fi
export CGW_REBUILD_CONNECTOR_AUTHORIZATION

if [[ "${1:-}" == "runtimes" && "${2:-}" == "connect" ]]; then
  export MCP_EXTRA_HEADERS='Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION'
  export MCP_DISCOVERY_EXTRA_HEADERS='Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION'
  exec "$REAL" "$@"
fi

exec "$REAL" "$@" \
  --mcp.extra-headers 'Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION' \
  --mcp.discovery-extra-headers 'Authorization: env:CGW_REBUILD_CONNECTOR_AUTHORIZATION'
