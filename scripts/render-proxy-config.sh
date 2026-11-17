#!/bin/sh
# Render only our placeholders, never Nginx runtime variables or credentials.
set -eu

fail() { echo "GovChat proxy configuration: $1" >&2; exit 1; }
case "${GOVCHAT_BLOCK_PASSWORD_AUTH:-false}" in
  true|false) ;;
  *) fail 'GOVCHAT_BLOCK_PASSWORD_AUTH must be true or false' ;;
esac
case "${GOVCHAT_MINIMAL_UI:-false}" in
  true|false) ;;
  *) fail 'GOVCHAT_MINIMAL_UI must be true or false' ;;
esac

case "${GOVCHAT_PROXY_CONFIG:-librechat}" in
  librechat)
    if [ -z "${GOVCHAT_SERVER_NAMES:-}" ]; then
      case "${PUBLIC_BASE_URL:-http://localhost:3080}" in
        http://*|https://*) ;;
        *) fail 'PUBLIC_BASE_URL must be an HTTP(S) URL' ;;
      esac
      host=${PUBLIC_BASE_URL:-http://localhost:3080}
      host=${host#*://}
      host=${host%%/*}
      printf '%s' "$host" | grep -Eq '^[A-Za-z0-9.-]+(:[0-9]+)?$' ||
        fail 'PUBLIC_BASE_URL must contain a plain hostname and optional port, without credentials'
      host=${host%%:*}
      case "$host" in
        localhost|librechat-proxy) GOVCHAT_SERVER_NAMES='localhost librechat-proxy' ;;
        *) GOVCHAT_SERVER_NAMES="$host localhost librechat-proxy" ;;
      esac
    fi
    # Whitespace-separated exact DNS names; reject config injection and wildcards.
    printf '%s' "$GOVCHAT_SERVER_NAMES" | grep -Eq '^[A-Za-z0-9.-]+( [A-Za-z0-9.-]+)*$' ||
      fail 'GOVCHAT_SERVER_NAMES must contain space-separated exact hostnames'
    export GOVCHAT_SERVER_NAMES
    mkdir -p /var/run/govchat
    : > /var/run/govchat/password-auth.conf
    if [ "${GOVCHAT_BLOCK_PASSWORD_AUTH:-false}" = true ]; then
      cat > /var/run/govchat/password-auth.conf <<'EOF'
location ~* ^/api/auth/(login|register|requestPasswordReset|resetPassword)(/|$) {
  return 403;
}
location ~* ^/api/admin/login/local(/|$) { return 403; }
EOF
    fi
    if [ "${GOVCHAT_MINIMAL_UI:-false}" = true ]; then
      GOVCHAT_UI_HEAD='<link rel="stylesheet" href="/govchat-overlay/minimal.css?v=1"/>'
    else
      GOVCHAT_UI_HEAD='<link rel="stylesheet" href="/govchat-overlay/src/custom.css"/><script type="module" src="/govchat-overlay/src/overlay.js"></script>'
    fi
    export GOVCHAT_UI_HEAD
    envsubst '${GOVCHAT_SERVER_NAMES} ${GOVCHAT_UI_HEAD}' < /opt/govchat/nginx/librechat-overlay.conf > /etc/nginx/conf.d/default.conf
    ;;
  management)
    N8N_MANAGEMENT_PATH=${N8N_MANAGEMENT_PATH:-/}
    QDRANT_MANAGEMENT_PATH=${QDRANT_MANAGEMENT_PATH:-/}
    for path in "$N8N_MANAGEMENT_PATH" "$QDRANT_MANAGEMENT_PATH"; do
      printf '%s' "$path" | grep -Eq '^/([A-Za-z0-9_-]+/)*$' ||
        fail 'management paths must start and end with / and contain plain path segments'
    done
    case "${MANAGEMENT_FORWARDED_PROTO:-https}" in
      http|https) ;;
      *) fail 'MANAGEMENT_FORWARDED_PROTO must be http or https' ;;
    esac
    MANAGEMENT_FORWARDED_PROTO=${MANAGEMENT_FORWARDED_PROTO:-https}
    export N8N_MANAGEMENT_PATH QDRANT_MANAGEMENT_PATH MANAGEMENT_FORWARDED_PROTO
    envsubst '${N8N_MANAGEMENT_PATH} ${QDRANT_MANAGEMENT_PATH} ${MANAGEMENT_FORWARDED_PROTO}' \
      < /opt/govchat/nginx/management-proxy.conf > /etc/nginx/conf.d/default.conf
    ;;
  *) fail 'unknown proxy configuration' ;;
esac
