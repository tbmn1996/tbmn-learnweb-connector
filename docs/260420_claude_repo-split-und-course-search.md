# Session Summary: tbmn-learnweb-connector – Repo-Split + Course-Search-Tool

**Datum:** 2026-04-20  
**Modell:** Claude Sonnet 4.6  
**Primärdatei:** `src/tools/learnweb.ts` (495 Zeilen, 9 Funktionen/Tool-Registrierungen)

---

## Ausgangslage

Das Mono-Repo `notion-proxy` (GitHub: `tbmn1996/notion-mcp-server`) betrieb
zwei Railway-Services aus einer gemeinsamen Codebase — gesteuert über das
`MCP_SERVER_PROFILE`-Flag (`notion | learnweb | all`). Der Code war bereits
split-ready: Learnweb-Logik lag in `src/learnweb/` und `src/tools/learnweb.ts`,
Notion-Code in eigenen Tool-Dateien und `src/notionRouter.ts`.

Ziel dieser Session war **Phase B des Split-Projekts**: Ausgliederung des
LearnWeb-Connectors in ein eigenständiges, frisches Repo
`tbmn1996/tbmn-learnweb-connector` — ohne Notion-Code, ohne gemeinsame Lib,
mit unveränderter Railway-Domain und OAuth-Konfiguration. Der bestehende
Railway-Service `learnweb-mcp` sollte auf das neue Repo umgehängt werden, ohne
Downtime und ohne den claude.ai-Connector neu einrichten zu müssen.

Zusätzlich wurde in derselben Session (in Commits nach dem Initial-Commit) ein
fünftes Tool `learnweb-search-courses` implementiert, das den globalen
Moodle-Kurskatalog über `/course/search.php` durchsucht.

---

## Implementierte Änderungen

### 1. Repo-Struktur kuratiert kopiert (Schritt 1–2)

Aus `notion-proxy` wurden gezielt die LW-relevanten Dateien übernommen:
`src/learnweb/` (komplett), `src/oauth/` (komplett), `src/tools/learnweb.ts`,
`src/mcp-server.ts`, `src/config.ts`, `src/config-utils.ts`,
`src/tools/shared.ts`, alle LW-Test-Fixtures und -Tests,
`tsconfig.json`, `railway.toml`.

Nicht kopiert: `src/notionRouter.ts`, `src/server.ts`, alle Notion-Tool-Dateien,
`.mcp.json`, Notion-Test-Fixtures, `.git/`.

`package.json` wurde neu geschrieben: `name: "tbmn-learnweb-connector"`,
`@notionhq/client` entfernt.

### 2. Notion-Fingerabdruck vollständig entfernt (Schritt 3)

Alle fünf geteilten Dateien wurden bereinigt:

**`src/mcp-server.ts`** — `MCP_SERVER_PROFILE`-Verzweigung, alle Notion-Tool-
Registrierungen, globaler `/mcp`-Endpoint und Workspace-Scoped-Endpoints
entfernt. Nur noch: `/health`, `/mcp/learnweb` (OAuth-geschützt),
OAuth-Discovery. `OAuthManager.registerGenericResource("learnweb", "/mcp/learnweb")`
statt workspace-basierter Ressourcen.

**`src/config.ts`** — `WORKSPACES`, `NOTION_WORKSPACES`, `MCP_WORKSPACE_TOKENS`,
`MCP_SERVER_PROFILE`, `SCOPED_WORKSPACE_AUTH`, `OAUTH_ENABLED_WORKSPACES`
entfernt. `MCP_LEARNWEB_ENDPOINT_ENABLED` Default von `false` auf `true` gehoben
(im neuen Repo ist der LW-Endpoint der Kernzweck). Validierungsbedingung:
`const OAUTH_REQUIRED = MCP_TRANSPORT === "http" && MCP_LEARNWEB_ENDPOINT_ENABLED`.

**`src/config-utils.ts`** — `parseWorkspaces`, `parseWorkspaceAuthModes`,
`WorkspaceTokens`, `WorkspaceAuthModes` entfernt.

**`src/tools/shared.ts`** — alle Notion-spezifischen Helfer entfernt:
`fetchAllBlocks`, `sanitizeBlocksForCreate`, `blocksToPlainText`,
`extractTitle`, `parseOpaquePageId`, `buildOpaquePageId`, `resolveDataSourceId`,
`resolvePageParent`, `notionError`, `resolveWorkspace`, `scopedToolInputSchema`.
Behalten: `ok()`, `validationError()`, `jsonPreprocess()`, alle
`*_TOOL_ANNOTATIONS`, `ToolConfig`-Typ.

**`src/tools/learnweb.ts`** — `shouldRegister()`-Kommentar aktualisiert,
Sicherheitslogik unverändert.

Verifikation: `grep -r "notionhq|NOTION_WORKSPACES|notionRouter" src/` → null Treffer.

### 3. `.env.example` neu geschrieben (Schritt 4)

Nur noch LW- + Infrastructure-Variablen dokumentiert. Entfernt: alle
`NOTION_*`, `MCP_WORKSPACE_*`, `MCP_SERVER_PROFILE`, Legacy-`API_KEY`.
Strukturiert in Sections: Transport, LW-Credentials, LW-Endpoint-Flag,
OAuth-Config, Identity-Provider (local/oidc), Persistence (Redis/In-Memory).

### 4. README.md + CLAUDE.md neu geschrieben (Schritt 5)

README: Architektur-Übersicht, alle 4 (später 5) Tools, Setup für stdio und
HTTP-Modus, Endpoint-Tabelle, Sicherheitshinweise, Deployment-Anleitung.

CLAUDE.md: Projektinstruktionen für zukünftige Claude-Code-Sessions — kein
Notion, Parser-Änderungen immer mit Tests, Railway-Hinweise, offene Punkte.

### 5. Build + Tests verifiziert (Schritt 6)

```bash
npm install    # 244 Pakete, 0 Vulnerabilities
npm run build  # TypeScript fehlerfrei
npm test       # 35/35 Tests grün
```

### 6. GitHub-Repo angelegt + Initial-Commit gepusht (Schritt 7)

```bash
git init && git add . && git commit -m "Initial commit: LearnWeb MCP Connector (extracted from notion-proxy)"
gh repo create tbmn1996/tbmn-learnweb-connector --private --source=. --remote=origin --push
```

Commit `aa472b7`: 54 Dateien, 10.159 Insertions.

### 7. Railway-Service umgehängt + End-to-End verifiziert (Schritt 8–9)

Im Railway-Dashboard: Service `learnweb-mcp` → Settings → Source → auf
`tbmn1996/tbmn-learnweb-connector@main` umgestellt. Manuelles Redeploy
ausgelöst. Verifikation:

- `GET /health` → `{"status":"ok","service":"learnweb-mcp",...}` (altes Format
  hatte `"profile":"learnweb"` — der Formatunterschied diente als Deployment-Signal)
- `GET /mcp/learnweb` ohne Token → `401 invalid_token` (OAuth-Schutz aktiv)
- `GET /.well-known/oauth-authorization-server` → OAuth Discovery antwortet korrekt

### 8. Fünftes Tool: `learnweb-search-courses` (Post-Split-Commits)

Neuer Parser `src/learnweb/parsers/courseSearch.ts` (109 Zeilen):

```typescript
export function parseCourseSearch(
  html: string,
  baseUrl: string,
  currentPage: number
): LearnwebSearchPage {
  // Scrapt div.coursebox[data-courseid] Elemente
  // Pagination via ul.pagination li.page-item.active → has_more
}
```

Output-Felder pro Treffer: `course_id`, `fullname`, optional `category`,
optional `summary_snippet` (max 300 Zeichen), `url`, `enrol_url`.
`has_more` ist das einzig belastbare Pagination-Signal — `results.length < limit`
ist bei Moodle kein verlässlicher Indikator.

In `src/learnweb/session.ts` ergänzt: `searchCourses()`-Methode mit
30-Sekunden-Timeout (statt Standard), In-Memory-Rate-Limit (15 Aufrufe /
30 Sekunden), und `LearnwebTimeoutError` für gezieltes Timeout-Signalling.

In `src/tools/learnweb.ts` ergänzt: Tool 5 mit Input-Validation
(`query` 2–200 Zeichen, `page` 0–20, `limit` 1–50). Drei neue Test-Fixtures +
Tests in `test/learnweb-search-courses.test.js` und
`test/learnweb-session.test.js`.

---

## Konfiguration / Infrastruktur

| Variable | Zweck | Pflicht für |
|---|---|---|
| `LEARNWEB_URL` | Moodle-Base-URL | stdio + HTTP |
| `LEARNWEB_USERNAME` | Moodle-Login | stdio + HTTP |
| `LEARNWEB_PASSWORD` | Moodle-Passwort | stdio + HTTP |
| `MCP_TRANSPORT` | `stdio` oder `http` | beide |
| `MCP_PUBLIC_BASE_URL` | Öffentliche Server-URL | nur HTTP |
| `MCP_OAUTH_STATIC_CLIENTS` | claude.ai-Client-Config | nur HTTP |
| `MCP_OAUTH_COOKIE_SECRET` | Cookie-Signing | nur HTTP |
| `MCP_OAUTH_JWT_SECRET` | JWT-Signing | nur HTTP |
| `MCP_OAUTH_LOCAL_LOGIN_*` | Single-User-Auth | nur HTTP (local-Provider) |
| `REDIS_URL` | OAuth-Session-Persistenz | Production empfohlen |
| `MCP_OAUTH_ALLOW_IN_MEMORY_STORE` | Opt-in-Fallback | optional |

- **Lokales Repo:** `/Users/thomasniermann/Scripts/tbmn-learnweb-connector/`
- **GitHub:** `https://github.com/tbmn1996/tbmn-learnweb-connector` (privat)
- **Railway:** `learnweb-mcp-production.up.railway.app`, Service-ID `1e50f1a0-b633-4c68-89bb-af0e848c958f`
- **Node.js:** `>=20.19.0` (`.nvmrc` im Repo)
- **Build-Output:** `dist/` (TypeScript → CommonJS)

---

## Typische Verwendung

```bash
# Lokaler stdio-Modus (kein OAuth nötig)
cd /Users/thomasniermann/Scripts/tbmn-learnweb-connector
cp .env.example .env   # LEARNWEB_* ausfüllen
npm run build
MCP_TRANSPORT=stdio npm start

# Build + Tests
npm run build && npm test

# Nach Code-Änderung deployen
git add . && git commit -m "feat: ..." && git push
# → Railway deployt automatisch aus main
```

---

## Bekannte Eigenheiten / Lessons Learned

| Verhalten | Details |
|---|---|
| Railway: Kein Auto-Deploy bei Source-Wechsel | Wenn nur die Source-Repo-Referenz im Dashboard geändert wird (nicht ein neuer Commit), löst Railway kein Deployment aus — manuelles Redeploy nötig. |
| Health-Endpoint als Deployment-Signal | Das alte Format `{"profile":"learnweb"}` vs. neues `{"service":"learnweb-mcp"}` ist ein zuverlässiger Indikator dafür, ob der alte oder neue Code läuft. |
| OAuth In-Memory-Store verliert State bei Redeploy | Bei jedem Railway-Redeploy muss man sich in claude.ai neu authentifizieren, solange kein Redis konfiguriert ist. `MCP_OAUTH_ALLOW_IN_MEMORY_STORE=true` ist das nötige Opt-in. |
| Moodle-Suche: `results.length < limit` ist kein Pagination-Stopp | Moodle rendert je nach Konfiguration weniger Treffer pro Seite als `perpage` erlaubt. Nur `has_more` (aus Pagination-Nav) ist verlässlich. |
| Moodle-Suche: Längerer Timeout nötig | `/course/search.php` antwortet teils sehr langsam. Separater 30s-Timeout in `session.searchCourses()` verhindert False-Positive-Timeouts vom Standard-Timeout. |
| Race-Condition bei parallelem Re-Login | `LearnwebSession.getInstance()` ist ein Singleton. Bei mehreren gleichzeitigen Requests könnte ein paralleler Re-Login ausgelöst werden. In der Praxis irrelevant (ein User, serialisierte Tool-Calls), aber bei Bedarf mit einer Login-Promise absichern. |
| `test/mcp-http.test.js` bewusst gelöscht | War stark Notion-Workspace-gekoppelt. Parser-Tests + Phase-A-Produktion liefern ausreichende Abdeckung. |

---

## GitHub-Status

**Vollständig synchronisiert:** Branch `main` ist identisch mit `origin/main`.
Alle Commits gepusht.

Commits in dieser Session (chronologisch):

| Hash | Message |
|---|---|
| `aa472b7` | Initial commit: LearnWeb MCP Connector (extracted from notion-proxy) |
| `c16c25c` | docs: add implementation plan for learnweb-search-courses |
| `1159d69` | feat: add learnweb course search tool |
| `f23b9ca` | docs: clarify live-deploy authorization |
| `110fffb` | fix: handle slow learnweb course searches |

---

## Offene Punkte / Folgearbeiten

1. **Redis-URL konfigurieren (Railway):** Aktuell läuft OAuth mit In-Memory-Store
   (`MCP_OAUTH_ALLOW_IN_MEMORY_STORE=true`). Bei jedem Redeploy verlieren alle
   Refresh-Tokens ihren State. Redis-Add-on in Railway aktivieren und `REDIS_URL`
   Env-Var setzen — dann entfällt der Zwangs-Reauth nach jedem Deploy.

2. **Alten claude.ai-Connector „TBM Cloud + LW" prüfen/löschen:** Der
   ursprüngliche kombinierte Connector existiert möglicherweise noch im
   claude.ai-Account. Nach erfolgreichem Betrieb des neuen Standalone-Connectors
   löschen oder umbenennen.

3. **Phase C: Notion-Connector-Split:** Das Mono-Repo `notion-proxy` ist weiterhin
   in Betrieb. Der nächste Split-Schritt wäre `tbmn-notion-connector` als eigenes
   Repo — analog zu diesem Plan, aber mit den Notion-Tool-Dateien + Multi-Workspace-
   OAuth-Logik.

4. **`learnweb-search-courses` Rate-Limit testen:** Das In-Memory-Rate-Limit
   (15 Aufrufe / 30 Sekunden) wurde implementiert, aber noch nicht unter Last
   getestet. Bei einem Redeploy startet der Zähler neu — das ist dokumentiert,
   aber ggf. mittelfristig durch Redis-backed Rate-Limiting ersetzen.
