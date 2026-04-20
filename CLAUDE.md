# Instruktionen für Claude Code — TBMN LearnWeb Connector

## Was ist dieses Repo

MCP-Server, der dem claude.ai-Client Zugriff auf das Learnweb (Moodle-Instanz
der WWU Münster) gibt. Nur Lesen, keine Mutationen. Zwei Transports: stdio
(lokal) und HTTP+OAuth (Railway-Production).

**Wichtig:** Keine Notion-Abhängigkeiten. Dieses Repo wurde bewusst vom
`notion-proxy`-Mono-Repo abgespalten. Falls irgendwo noch `@notionhq/client`,
`NOTION_WORKSPACES`, `notionRouter` o.ä. auftaucht — das ist ein Bug und muss
raus.

## Arbeitsweise in diesem Repo

- Antworten immer auf Deutsch.
- Für Änderungen mit mehr als 3 Schritten erst planen, dann umsetzen.
- Parser-Änderungen in `src/learnweb/parsers/` **immer** mit zugehörigen Tests
  in `test/` mitführen. Fixtures liegen unter `test/fixtures/learnweb/`.
- Bei neuen Moodle-Activity-Typen: Parser anlegen, in `dispatchActivity`
  eintragen, Fixtures + Test ergänzen.
- Nach Code-Änderungen `npm run build` + `npm test` ausführen und den Ausgang
  ehrlich berichten.

## Sicherheitsgrenzen

- `.env` niemals committen oder ausgeben.
- Moodle-Credentials (`LEARNWEB_USERNAME`, `LEARNWEB_PASSWORD`) sind
  besonders sensibel — auch nicht in Log-Statements oder Fehler-Messages.
- `wrapHandler` in [src/tools/learnweb.ts](src/tools/learnweb.ts) liefert
  bewusst generische Fehler-Messages — nicht „hilfreicher" machen, indem
  Details durchgereicht werden.

## Deployment / Infrastruktur

- Railway-Service: `learnweb-mcp` (Service-ID
  `1e50f1a0-b633-4c68-89bb-af0e848c958f`).
- Domain: `learnweb-mcp-production.up.railway.app`.
- Vor Änderungen an `railway.toml`, Env-Vars oder Launchd-Plists **immer
  fragen**, bevor Aktionen ausgeführt werden.
- Vor `git push` den Commit-Inhalt erklären und bestätigen lassen.

## Offene Punkte (Stand April 2026)

- Redis-URL setzen, sobald Burn-In-Phase erfolgreich abgeschlossen ist —
  aktuell läuft der OAuth-Store in-memory
  (`MCP_OAUTH_ALLOW_IN_MEMORY_STORE=true`). Bei jedem Redeploy muss man sich
  in claude.ai neu authentifizieren.
- Race-Condition-Hinweis in [src/learnweb/session.ts](src/learnweb/session.ts):
  Paralleler Re-Login bei mehreren gleichzeitigen Requests wäre möglich. In
  der Praxis irrelevant (ein User, serialisierte Tool-Calls), aber bei
  Bedarf mit einer Login-Promise absichern.

## Stilregeln

- Kommentare im Code auf Deutsch, nur wenn sie das **Warum** erklären — nicht
  das Was.
- Keine neuen NPM-Pakete ohne Bestätigung installieren.
- Bevorzugt kleinere, nachvollziehbare Änderungen statt großer Refactorings.
