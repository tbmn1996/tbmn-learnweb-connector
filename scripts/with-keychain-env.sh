#!/usr/bin/env bash

# Generischer Wrapper: liest die Learnweb-Credentials aus der macOS-Keychain und
# fuehrt das uebergebene Kommando mit gesetzten LEARNWEB_*-Env-Vars aus.
#
# Nutzung:
#   scripts/with-keychain-env.sh npx tsx scripts/transcribe-recordings.ts [...]
#   scripts/with-keychain-env.sh npx tsx scripts/capture-recording-fixtures.ts
#
# Muster aus start-stdio-keychain.sh. Der Keychain-Zugriff laeuft bewusst nur
# ueber /usr/bin/security; Secrets werden nie geloggt.

set -euo pipefail

readonly DEFAULT_SERVICE="tbmn-learnweb-connector"
readonly SECURITY_BIN="/usr/bin/security"

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
Fuehre zuerst 'npm run keychain:bootstrap' (scripts/bootstrap-keychain.sh) aus.
EOF
  exit 1
}

if [[ $# -eq 0 ]]; then
  echo "Nutzung: scripts/with-keychain-env.sh <kommando> [argumente...]" >&2
  exit 1
fi

learnweb_url="$(read_secret "LEARNWEB_URL" || true)"
learnweb_username="$(read_secret "LEARNWEB_USERNAME" || true)"
learnweb_password="$(read_secret "LEARNWEB_PASSWORD" || true)"

if [[ -z "$learnweb_url" || -z "$learnweb_username" || -z "$learnweb_password" ]]; then
  missing_secret_error
fi

exec env \
  LEARNWEB_URL="$learnweb_url" \
  LEARNWEB_USERNAME="$learnweb_username" \
  LEARNWEB_PASSWORD="$learnweb_password" \
  "$@"
