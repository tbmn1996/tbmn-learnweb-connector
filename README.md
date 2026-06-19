# TBMN LearnWeb Connector

MCP-Server (Model Context Protocol) als **claude.ai Custom Connector** für das
[Learnweb der Universität Münster](https://www.uni-muenster.de/LearnWeb/learnweb2)
(Moodle-Installation der WWU).

Liefert acht Read-only-Tools, mit denen Claude auf Kurse, Kursstruktur,
Aktivitäten, die persönliche Timeline und geschützte Dateien zugreifen kann — ohne dass der Nutzer
manuell Inhalte copy-pasten muss.

## Tools

| Tool | Zweck |
|---|---|
| `learnweb-get-courses` | Listet alle Kurse auf dem Dashboard des eingeloggten Users. |
| `learnweb-get-course-overview` | Gibt Abschnitte + Aktivitäten eines einzelnen Kurses zurück. |
| `learnweb-read-activity` | Liest eine Aktivität strukturiert aus (resource, url, page, forum, assign, quiz, ratingallocate, folder, workshop, lesson, choice, feedback). |
| `learnweb-get-timeline` | Listet anstehende Aktivitäten (Deadlines, Quizze) kursübergreifend, sortiert nach Fälligkeit. |
| `learnweb-search-courses` | Durchsucht den globalen Learnweb-Kurskatalog über `/course/search.php` und liefert paginierte Treffer. |
| `learnweb-get-page` | Gibt bereinigten Text einer SSO-geschützten Learnweb-Seite zurück. Nur Pfade unter `/mod`, `/course`, `/calendar`, `/my`, `/blocks`. |
| `learnweb-get-calendar-month` | Gibt Kalender-Events für einen bestimmten Monat zurück. |
| `learnweb-download-resource` | Lädt eine authentifizierte `pluginfile.php`-Datei aus einer vorherigen `download_url` als MCP-Resource-Blob herunter. |

Alle Tools sind **strikt read-only** — der Connector schreibt nichts ins Moodle.
Activity- und Folder-Parser liefern Datei-Links nur als `download_url`; Dateiinhalt
wird nur explizit über `learnweb-download-resource` geladen (Standardlimit 3 MB,
opt-in Hard-Cap 25 MB). `learnweb-get-page` deckt `/pluginfile.php/...` bewusst
nicht ab — authentifizierte Datei-Downloads laufen ausschließlich über
`learnweb-download-resource`.

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

## Tool: `learnweb-get-page`

Input:

- `path` — Pflichtfeld, max. 500 Zeichen, muss unter `/mod`, `/course`,
  `/calendar`, `/my` oder `/blocks` liegen.

Beispiel:

```json
{
  "path": "/mod/forum/view.php?id=123"
}
```

Output:

- `path` — der angefragte Pfad
- `title` — erster Seitentitel aus `h1`/`h2` oder der Pfad als Fallback
- `text` — bereinigter Haupttext ohne Navigation, Header, Footer und Scripts
- `length` — Länge des ungekürzten bereinigten Texts
- `fetched_at` — ISO-Zeitpunkt des Abrufs

Sicherheit:

- Der Pfad wird erst per Regex eingeschränkt und danach intern normalisiert.
- `..` und `%2e`-Varianten werden vor dem Upstream-Call abgelehnt, damit die
  SSO-Session nicht für Admin- oder Nutzerprofilbereiche missbraucht werden kann.
- Query-Strings bleiben erhalten, werden aber nicht zur Pfadnormalisierung genutzt.

## Setup (lokal, stdio-Modus, bevorzugt via macOS-Keychain)

Für lokale Codex-/Claude-Setups ist die **macOS-Keychain der bevorzugte
Credential-Speicher**. Neue lokale Integrationen in diesem Repo sollen die
Learnweb-Credentials aus der Keychain lesen, nicht aus einer dauerhaft
gepflegten `.env`.

Schnellstart für Codex lokal:

```bash
npm install
npm run build
npm run keychain:bootstrap
npm run codex:mcp:register
```

Danach eine neue Codex-Session starten. Der registrierte MCP-Server heißt
standardmäßig `tbmnLearnweb` und startet intern
`scripts/start-stdio-keychain.sh`.

Kanonische Keychain-Konvention:

- Service: `tbmn-learnweb-connector`
- Accounts: `LEARNWEB_URL`, `LEARNWEB_USERNAME`, `LEARNWEB_PASSWORD`

Im stdio-Modus ist **keine OAuth-Konfiguration** nötig — der Connector läuft
direkt mit den Moodle-Credentials aus der Keychain.

Fallback für lokale Dev-Setups:

```bash
cp .env.example .env
npm run build
MCP_TRANSPORT=stdio npm start
```

Die ausführliche lokale Anleitung inklusive exakter `security`-Kommandos liegt
unter [docs/local-codex-keychain-setup.md](docs/local-codex-keychain-setup.md).

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
- Fehler-Responses enthalten eine `request_id` und ein whitelisted `context`-Objekt
  mit sicheren Feldern wie `parser`, `selector`, `status` oder `path`. Stacks,
  Cookies, Credentials, Session-Daten, HTML und Response-Bodies werden nicht
  ausgegeben.

## Historie

Dieser Connector wurde im April 2026 aus dem Mono-Repo `notion-proxy`
ausgegliedert (Phase B des Split-Projekts). Ziel: klare Trennung zwischen
Notion-Connector und LearnWeb-Connector — zwei eigenständige, parallel
gepflegte Tools.
