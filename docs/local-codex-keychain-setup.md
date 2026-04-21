# Lokaler Codex-Setup ueber macOS-Keychain

Diese Repo-Variante nutzt lokal bevorzugt die macOS-Keychain als Credential-Quelle.
Neue lokale MCP-/CLI-Anbindungen sollen die Learnweb-Credentials aus der Keychain
lesen und nicht aus einer dauerhaft gepflegten `.env`.

## Kanonische Keychain-Konvention

- Service: `tbmn-learnweb-connector`
- Accounts: `LEARNWEB_URL`, `LEARNWEB_USERNAME`, `LEARNWEB_PASSWORD`
- Zugriffsweg: `/usr/bin/security`

Der Zugriff wird bewusst auf `/usr/bin/security` beschraenkt. Es wird **nicht**
`-A` verwendet.

## Schnellster Weg im Repo

```bash
npm run build
npm run keychain:bootstrap
npm run codex:mcp:register
```

Danach eine neue Codex-Session starten. Der MCP-Server wird ueber
`scripts/start-stdio-keychain.sh` gestartet und zieht seine Learnweb-Werte aus
der Keychain.

## Keychain-Eintraege manuell per CLI anlegen

Die folgenden Kommandos legen oder aktualisieren die drei Eintraege mit
`security add-generic-password -U`:

```bash
security add-generic-password -U -s tbmn-learnweb-connector -a LEARNWEB_URL -T /usr/bin/security -w 'https://www.uni-muenster.de/LearnWeb/learnweb2'
security add-generic-password -U -s tbmn-learnweb-connector -a LEARNWEB_USERNAME -T /usr/bin/security -w 'dein-benutzername'
security add-generic-password -U -s tbmn-learnweb-connector -a LEARNWEB_PASSWORD -T /usr/bin/security -w 'dein-passwort'
```

Alternativ ueber das Repo-Skript:

```bash
scripts/bootstrap-keychain.sh
```

Das Skript akzeptiert optional `--url`, `--username`, `--password` oder liest
fehlende Werte interaktiv ein.

## Eintraege ohne Secret-Output pruefen

```bash
security find-generic-password -s tbmn-learnweb-connector -a LEARNWEB_URL >/dev/null
security find-generic-password -s tbmn-learnweb-connector -a LEARNWEB_USERNAME >/dev/null
security find-generic-password -s tbmn-learnweb-connector -a LEARNWEB_PASSWORD >/dev/null
```

Wenn alle drei Kommandos mit Exit-Code `0` enden, sind die Eintraege vorhanden.

## Lokalen MCP-Server starten

```bash
scripts/start-stdio-keychain.sh
```

Das Skript:

- wechselt selbst ins Repo,
- liest die drei Learnweb-Werte aus der Keychain,
- setzt `MCP_TRANSPORT=stdio`,
- startet `node dist/mcp-server.js`.

Wenn Eintraege fehlen, kommt nur eine generische Fehlermeldung ohne Secret-Details.

## Codex-Registrierung

```bash
scripts/register-codex-mcp.sh
```

Standardname fuer den MCP-Server in Codex ist `tbmnLearnweb`. Bestehende
Eintraege mit demselben Namen werden ersetzt.

Pruefen:

```bash
codex mcp get tbmnLearnweb
```

## Fallback fuer Entwicklung

`.env` bleibt moeglich, aber nur als Dev-/Fallback-Pfad. Fuer den lokalen
Regelbetrieb und fuer kuenftige Integrationen in diesem Repo ist die macOS-Keychain
der bevorzugte Credential-Speicher.
