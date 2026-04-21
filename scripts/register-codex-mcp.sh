#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_SERVER_NAME="tbmnLearnweb"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
launcher_path="$repo_dir/scripts/start-stdio-keychain.sh"
server_name="$DEFAULT_SERVER_NAME"

usage() {
  cat <<'EOF'
Nutzung:
  scripts/register-codex-mcp.sh [--name SERVER_NAME]

Registriert den lokalen Learnweb-Connector als stdio-MCP-Server in Codex.
Bestehende Eintraege mit demselben Namen werden ersetzt.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      server_name="${2:-}"
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

if [[ -z "$server_name" ]]; then
  echo "Der Codex-MCP-Name darf nicht leer sein." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Die Codex-CLI wurde nicht gefunden." >&2
  exit 1
fi

if [[ ! -x "$launcher_path" ]]; then
  echo "Der lokale Launcher ist nicht ausfuehrbar: $launcher_path" >&2
  exit 1
fi

if codex mcp get "$server_name" >/dev/null 2>&1; then
  codex mcp remove "$server_name" >/dev/null
fi

codex mcp add "$server_name" -- "$launcher_path" >/dev/null
codex mcp get "$server_name"

echo "Hinweis: Eine neue Codex-Session kann noetig sein, damit die neuen Tools sichtbar werden."
