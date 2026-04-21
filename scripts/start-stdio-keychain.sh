#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_SERVICE="tbmn-learnweb-connector"
readonly SECURITY_BIN="/usr/bin/security"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
service_name="${LEARNWEB_KEYCHAIN_SERVICE:-$DEFAULT_SERVICE}"

read_secret() {
  local account_name="$1"

  "$SECURITY_BIN" find-generic-password \
    -s "$service_name" \
    -a "$account_name" \
    -w \
    2>/dev/null
}

missing_secret_error() {
  cat >&2 <<EOF
Learnweb-Credentials wurden in der macOS-Keychain nicht gefunden.
Erwartet wird der Service '$service_name' mit den Accounts
'LEARNWEB_URL', 'LEARNWEB_USERNAME' und 'LEARNWEB_PASSWORD'.
Fuehre zuerst 'scripts/bootstrap-keychain.sh' in diesem Repo aus.
EOF
  exit 1
}

if [[ ! -f "$repo_dir/dist/mcp-server.js" ]]; then
  echo "Build-Artefakt fehlt. Fuehre zuerst 'npm run build' in '$repo_dir' aus." >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "Node.js wurde nicht gefunden." >&2
  exit 1
fi

learnweb_url="$(read_secret "LEARNWEB_URL" || true)"
learnweb_username="$(read_secret "LEARNWEB_USERNAME" || true)"
learnweb_password="$(read_secret "LEARNWEB_PASSWORD" || true)"

if [[ -z "$learnweb_url" || -z "$learnweb_username" || -z "$learnweb_password" ]]; then
  missing_secret_error
fi

cd "$repo_dir"

exec env \
  MCP_TRANSPORT=stdio \
  LEARNWEB_URL="$learnweb_url" \
  LEARNWEB_USERNAME="$learnweb_username" \
  LEARNWEB_PASSWORD="$learnweb_password" \
  "$node_bin" "$repo_dir/dist/mcp-server.js"
