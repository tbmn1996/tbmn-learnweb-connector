# TBMN LearnWeb Connector

MCP-Server (Model Context Protocol) als **claude.ai Custom Connector** für das
[Learnweb der Universität Münster](https://www.uni-muenster.de/LearnWeb/learnweb2)
(Moodle-Installation der WWU).

Liefert fünf Read-only-Tools, mit denen Claude auf Kurse, Kursstruktur,
Aktivitäten und die persönliche Timeline zugreifen kann — ohne dass der Nutzer
manuell Inhalte copy-pasten muss.

## Tools

| Tool | Zweck |
|---|---|
| `learnweb-get-courses` | Listet alle Kurse auf dem Dashboard des eingeloggten Users. |
| `learnweb-get-course-overview` | Gibt Abschnitte + Aktivitäten eines einzelnen Kurses zurück. |
| `learnweb-read-activity` | Liest eine Aktivität strukturiert aus (resource, url, page, forum, assign, quiz, ratingallocate, folder, workshop, lesson, choice, feedback). |
| `learnweb-get-timeline` | Listet anstehende Aktivitäten (Deadlines, Quizze) kursübergreifend, sortiert nach Fälligkeit. |
| `learnweb-search-courses` | Durchsucht den globalen Learnweb-Kurskatalog über `/course/search.php` und liefert paginierte Treffer. |

Alle Tools sind **strikt read-only** — der Connector schreibt nichts ins Moodle.
Dateien werden nie heruntergeladen, sondern nur als `download_url` zurückgegeben.

## Tool: `learnweb-search-courses`

Input:

- `query` — Pflichtfeld, 2–200 Zeichen
- `page` — optional, 0-basiert, Default `0`, max `20`
- `limit` — optionales Trefferlimit für die Response, Default `25`, max `50`

Output:

- `results[]` mit `course_id`, `fullname`, optional `category`, optional `summary_snippet`, `url`, `enrol_url`
- `page` — die angefragte 0-basierte Seite
- `has_more` — einzig belastbares Pagination-Signal
- `effective_perpage` — wie viele Treffer Moodle auf dieser Seite tatsächlich gerendert hat

Limitations:

- `limit` ist nur ein Upper Bound. Wenn Moodle serverseitig weniger Treffer pro Seite rendert, ist das kein Ende der Trefferliste.
- Für Pagination darf **nur** `has_more` verwendet werden, niemals `results.length < limit`.
- Das Tool hat ein in-memory Rate-Limit von 15 Aufrufen pro 30 Sekunden. Nach einem Railway-Redeploy startet dieser Zähler neu.
- Für die Suche gilt intern ein längerer Request-Timeout von 30 Sekunden. Wenn Learnweb selbst zu langsam antwortet, liefert das Tool gezielt `learnweb_timeout` statt eines generischen `learnweb_error`.
- Das Output-Format enthält bewusst **kein** `shortname`, weil Klammer-Inhalte im Suchergebnis semantisch nicht stabil genug sind.

## Setup (lokal, stdio-Modus)

Für lokale Tests mit Claude Desktop oder direktem MCP-Client.

```bash
npm install
cp .env.example .env     # Werte eintragen: LEARNWEB_URL, LEARNWEB_USERNAME, LEARNWEB_PASSWORD
npm run build
MCP_TRANSPORT=stdio npm start
```

Im stdio-Modus ist **keine OAuth-Konfiguration** nötig — der Connector läuft
direkt mit den Moodle-Credentials aus `.env`.

## Setup (HTTP-Modus, Production / Railway)

Für den Betrieb hinter claude.ai als Custom Connector. OAuth 2.0 (Authorization
Code + PKCE) schützt den `/mcp/learnweb`-Endpoint.

Zusätzlich zu den LW-Credentials müssen gesetzt sein:

- `MCP_TRANSPORT=http`
- `MCP_PUBLIC_BASE_URL` — öffentliche Base-URL des Servers (ohne Pfad)
- `MCP_OAUTH_STATIC_CLIENTS` — JSON-Mapping mit `client_id` + `redirect_uris`
  für den claude.ai-Connector
- `MCP_OAUTH_COOKIE_SECRET`, `MCP_OAUTH_JWT_SECRET` — je ein 256-Bit-Secret
  (`openssl rand -hex 32`)
- Entweder **Local-Provider** (Single-User, `MCP_OAUTH_LOCAL_LOGIN_*`) oder
  **OIDC-Provider** (z.B. Google, `OIDC_*` + `MCP_OAUTH_ALLOWED_EMAILS`)
- `REDIS_URL` — wird in Production dringend empfohlen, sonst verlieren
  Auth-Codes und Refresh-Tokens bei jedem Redeploy ihren State.
  Opt-in-Fallback via `MCP_OAUTH_ALLOW_IN_MEMORY_STORE=true`.

Alle Variablen sind in [`.env.example`](.env.example) dokumentiert.

## Endpoints

| Pfad | Beschreibung |
|---|---|
| `GET /health` | Healthcheck ohne Auth (für Railway) |
| `POST /mcp/learnweb` | MCP-Streamable-HTTP-Endpoint, OAuth-geschützt |
| `GET /.well-known/oauth-authorization-server` | OAuth-Discovery-Metadaten |
| `GET /.well-known/oauth-protected-resource/mcp/learnweb` | Resource-Metadaten |

Einen globalen `/mcp`-Endpoint gibt es **bewusst nicht** — der Connector hat
genau einen Tool-Scope, und das Fehlen eines ungeschützten Endpoints macht es
unmöglich, Tools versehentlich ohne OAuth zu exponieren.

## Deployment (Railway)

Der Service läuft auf Railway mit RAILPACK-Builder. `railway.toml` ist
vorkonfiguriert. Nach dem Setup auf Railway muss nur:

1. Das GitHub-Repo verbinden
2. Alle Env-Vars aus `.env.example` setzen
3. Eine Domain binden und als `MCP_PUBLIC_BASE_URL` eintragen
4. Die Domain in `MCP_ALLOWED_HOSTS` und `MCP_ALLOWED_ORIGINS` aufnehmen

## Tests

```bash
npm test
```

Parser- und Validation-Tests laufen gegen HTML-Fixtures in
[`test/fixtures/learnweb/`](test/fixtures/learnweb/). Keine Netzwerkaufrufe.

## Architektur

```
src/
├── mcp-server.ts           Einstiegspunkt (stdio + HTTP)
├── config.ts               Env-Variablen + Validierung
├── config-utils.ts         Generische Parser
├── learnweb/
│   ├── session.ts          Moodle-Login + Cookie-Management
│   └── parsers/            13 Activity-Parser + Overview, Courses, Timeline, Course Search
├── oauth/                  OAuth-2.0-Server (JWT, Redis/In-Memory-Store, OIDC)
└── tools/
    ├── shared.ts           Tool-Result-Helfer, Annotations
    └── learnweb.ts         Tool-Registrierung + Dispatch
```

## Sicherheits-Hinweise

- **Nie** `.env` oder Secrets committen — `.gitignore` deckt das ab.
- Im stdio-Modus gibt es keine Auth-Schicht; der Connector darf ausschließlich
  lokal vom User selbst gestartet werden.
- Im HTTP-Modus sind alle Tool-Endpoints OAuth-Bearer-geschützt. Der
  `/health`-Endpoint und die Discovery-Metadaten sind bewusst public.
- Fehler-Responses enthalten **nie** Cookie- oder Credential-Details — der
  `wrapHandler`-Try/Catch in `tools/learnweb.ts` liefert immer generische
  Messages.

## Historie

Dieser Connector wurde im April 2026 aus dem Mono-Repo `notion-proxy`
ausgegliedert (Phase B des Split-Projekts). Ziel: klare Trennung zwischen
Notion-Connector und LearnWeb-Connector — zwei eigenständige, parallel
gepflegte Tools.
