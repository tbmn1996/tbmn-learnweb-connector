#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_SERVICE="tbmn-learnweb-connector"
readonly SECURITY_BIN="/usr/bin/security"

service_name="${LEARNWEB_KEYCHAIN_SERVICE:-$DEFAULT_SERVICE}"
learnweb_url="${LEARNWEB_URL:-}"
learnweb_username="${LEARNWEB_USERNAME:-}"
learnweb_password="${LEARNWEB_PASSWORD:-}"

usage() {
  cat <<'EOF'
Nutzung:
  scripts/bootstrap-keychain.sh [--service NAME] [--url URL] [--username USER] [--password PASS]

Optional koennen LEARNWEB_URL, LEARNWEB_USERNAME und LEARNWEB_PASSWORD
bereits als Umgebungsvariablen gesetzt sein. Fehlende Werte werden interaktiv
abgefragt.
EOF
}

prompt_if_missing() {
  local variable_name="$1"
  local prompt_label="$2"
  local is_secret="${3:-false}"
  local current_value="$4"

  if [[ -n "$current_value" ]]; then
    printf '%s' "$current_value"
    return 0
  fi

  if [[ "$is_secret" == "true" ]]; then
    local secret_value=""
    read -r -s -p "$prompt_label: " secret_value
    printf '\n' >&2
    printf '%s' "$secret_value"
    return 0
  fi

  local plain_value=""
  read -r -p "$prompt_label: " plain_value
  printf '%s' "$plain_value"
}

upsert_secret() {
  local account_name="$1"
  local value="$2"

  "$SECURITY_BIN" add-generic-password \
    -U \
    -s "$service_name" \
    -a "$account_name" \
    -D "application password" \
    -j "TBMN LearnWeb Connector local MCP credential" \
    -T "$SECURITY_BIN" \
    -w "$value" \
    >/dev/null
}

verify_secret_exists() {
  local account_name="$1"

  "$SECURITY_BIN" find-generic-password \
    -s "$service_name" \
    -a "$account_name" \
    >/dev/null 2>&1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      service_name="${2:-}"
      shift 2
      ;;
    --url)
      learnweb_url="${2:-}"
      shift 2
      ;;
    --username)
      learnweb_username="${2:-}"
      shift 2
      ;;
    --password)
      learnweb_password="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unbekanntes Argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$service_name" ]]; then
  echo "Der Keychain-Service darf nicht leer sein." >&2
  exit 1
fi

learnweb_url="$(prompt_if_missing "LEARNWEB_URL" "Learnweb-URL" "false" "$learnweb_url")"
learnweb_username="$(prompt_if_missing "LEARNWEB_USERNAME" "Learnweb-Benutzername" "false" "$learnweb_username")"
learnweb_password="$(prompt_if_missing "LEARNWEB_PASSWORD" "Learnweb-Passwort" "true" "$learnweb_password")"

if [[ -z "$learnweb_url" || -z "$learnweb_username" || -z "$learnweb_password" ]]; then
  echo "Alle drei Learnweb-Werte muessen gesetzt sein." >&2
  exit 1
fi

upsert_secret "LEARNWEB_URL" "$learnweb_url"
upsert_secret "LEARNWEB_USERNAME" "$learnweb_username"
upsert_secret "LEARNWEB_PASSWORD" "$learnweb_password"

verify_secret_exists "LEARNWEB_URL"
verify_secret_exists "LEARNWEB_USERNAME"
verify_secret_exists "LEARNWEB_PASSWORD"

echo "Die Learnweb-Credentials wurden in der macOS-Keychain unter '$service_name' aktualisiert."
