# Bug: LearnWeb Timeline Parser liefert leere Events-Liste
> Quelle: Notion Coding Pipeline – 2026-04-25
> Repo: https://github.com/tbmn1996/tbmn-learnweb-connector
> Notion-Seite: https://www.notion.so/34dbf244cadc81c4b1f9cd673903a9f2

## Kontext
- Projekt: TBMN LearnWeb Connector — MCP-Server für Moodle (Uni Münster), TypeScript, Read-Only, zwei Transports (stdio + HTTP+OAuth).
- Repo: https://github.com/tbmn1996/tbmn-learnweb-connector (Hotfix-Branch direkt → `main`, dann Railway-Redeploy des Service `learnweb-mcp`, Domain `learnweb-mcp-production.up.railway.app` — der Name `learnweb-mcp-production` ist der Railway-Service/Domain-Name, nicht der GitHub-Repo-Name).
- Relevante Dateien:
  - `src/learnweb/parsers/timeline.ts` — fehlerhafte Parser-Logik, `extractEventItems` + `extractCalendarMonthEvents`, returned aktuell `parser_degraded: true` statt Throw.
  - `src/learnweb/session.ts` — zentraler HTTP-Client + Cookie-Jar; `LearnwebAuthError` / `LearnwebTimeoutError` / `LearnwebNotConfiguredError` existieren bereits, neue Klassen analog.
  - `src/learnweb/parsers/common.ts` — bestehende Helper `cmidFromUrl`, `parseMoodleDate`, `normalizeText`, `truncate`, `absoluteUrl`.
  - `src/tools/learnweb.ts` — `registerLearnwebTools` registriert aktuell 5 Tools, `wrapHandler` mappt Errors auf generische Codes.
  - `test/learnweb-degradation.test.js` + `test/learnweb-parsers.test.js` — bestehende Test-Infrastruktur.
  - `test/fixtures/learnweb/` — Fixture-Verzeichnis.
- Abhängigkeiten: `cheerio ^1.1.2`, `axios ^1.15.0`, `tough-cookie ^6.0.1`, `zod ^3.25.76` — alle bereits installiert. Keine neuen NPM-Pakete ohne Bestätigung (AGENTS.md).
- Architektur-Entscheidungen:
  - Neue Error-Klassen `LearnwebParseError` und `LearnwebUpstreamError` in `session.ts` analog zu `LearnwebAuthError`. Optionales `diagnostics`-Property auf der Klasse, das `wrapHandler` NICHT an den Client durchreicht (Sicherheitsgrenze: keine Cookie-/PII-Details in Tool-Output).
  - Diagnostik-Logging via `console.error` mit strukturiertem JSON. Felder: `event`, `http_status`, `url`, `timestamp`, `body_snippet` (≤2 KB, via `String(resp.data).slice(0, 2048)`), `has_moodle_cookie` (Boolean), `selector_hits` (Map<Selector,count>), `page_hash` (sha1[0:8] über strukturelles Skelett — sortierte Liste aller `[data-region]`-Attributwerte innerhalb des Containers `[data-region="event-list-content"]` für `view=upcoming` bzw. `.calendarwrapper` für `view=month`, NICHT über Container-HTML-String). Niemals Cookie-Werte oder Credentials loggen.
  - Selektor-Erweiterung statt Komplett-Rewrite. Reine HTML-Scraping-Lösung (REST API per Intent Out-of-Scope).
  - Throw statt `parser_degraded: true`: non-2xx → `LearnwebUpstreamError` (Voraussetzung: zentrale axios-Instanz mit `validateStatus: () => true`). 2xx + Container-Selektor vorhanden + 0 Events → `return []` (legitim leerer Kalender). 2xx + Container fehlt → `LearnwebParseError`. `parser_degraded`-Felder werden aus `TimelineContent` und `TimelineResult` entfernt.
  - Filter `course_id` und `event_type` zod-validiert im Tool-Schema, im Parser nach Datum-/Modtype-Filter angewandt. Pass-Through aller Modtypes — keine Whitelist.
  - Neues Tool `learnweb-get-calendar-month` ruft `/calendar/view.php?view=month&time=<unix>` auf.
  - Hotfix-Workflow: Branch `hotfix/timeline-parser-throw-on-empty` → direkter Merge nach `main` ohne PR-Review-Gate; `git push` erst nach Bestätigung des Commit-Inhalts.

## Implementierungsschritte
### Schritt 1: Error-Klassen ergänzen
- Datei: `src/learnweb/session.ts`
- Änderung: Direkt nach `LearnwebTimeoutError` zwei neue exportierte Klassen mit optionalem `diagnostics?: Record<string, unknown>` und gesetztem `name`.
- Code-Snippet:
```typescript
export class LearnwebParseError extends Error {
  constructor(
    message = "Learnweb response could not be parsed.",
    public readonly diagnostics?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LearnwebParseError";
  }
}
export class LearnwebUpstreamError extends Error {
  constructor(
    message = "Learnweb upstream returned non-2xx.",
    public readonly diagnostics?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LearnwebUpstreamError";
  }
}
```

### Schritt 2: Public-Helper `hasMoodleCookie` + axios-Defaults + Re-Auth-Helper
- Datei: `src/learnweb/session.ts`
- Änderung: axios-Defaults in der zentralen Instanz setzen:
  - `validateStatus: () => true` → non-2xx wird NICHT als `AxiosError` geworfen; Status-Check passiert im Parser und mappt auf `LearnwebUpstreamError`.
  - `responseType: "text"` → `resp.data` ist deterministisch ein String.
- Neue Methode `hasMoodleCookie` (nur Boolean, kein Cookie-Wert):
```typescript
public async hasMoodleCookie(): Promise<boolean> {
  const cookies = await this.jar.getCookies(this.baseUrl);
  return cookies.some((c) => c.key.toLowerCase().startsWith("moodlesession"));
}
```
- Neue Methode `reAuthAndRetryGet(path: string)`: triggert SSO-Re-Auth über bestehenden Login-Flow (Shibboleth/SAML), setzt Cookie-Jar neu auf und re-issuet GET. Rückgabe-Shape identisch zu `get()`. Bei fehlgeschlagener Re-Auth → `throw new LearnwebAuthError(...)`. Nur 1× Retry — sonst Infinite-Loop bei dauerhaft kaputter Auth.

### Schritt 3: Helper `courseIdFromUrl`
- Datei: `src/learnweb/parsers/common.ts`
- Änderung: Vor Änderung Datei lesen. Neue exportierte Funktion `courseIdFromUrl(url: string): number | undefined` extrahiert in Reihenfolge `id=` (für `/course/view.php?id=`), `course=` und `courseid=` aus Query-String. Liefert `undefined` bei Miss.

### Schritt 4: Diagnostik-Helper + Throw-Verhalten in Timeline-Parser
- Datei: `src/learnweb/parsers/timeline.ts`
- Änderung: Neuen privaten Helper `buildDiagnostics(session, $, resp, path, containerSelector, extraSelectorHits?)` einführen. Cookie-Presence über `await session.hasMoodleCookie()`. Body-Snippet via `String(resp.data).slice(0, 2048)`. Page-Hash via `createHash("sha1").update(JSON.stringify($(containerSelector).find("[data-region]").map((_, el) => $(el).attr("data-region")).get().sort())).digest("hex").slice(0, 8)`.
- HTTP-Fehler: bei `resp.status < 200 || resp.status >= 300` → `throw new LearnwebUpstreamError(...)` mit Diagnostik.
- Login-Detection vor Container-Discriminator: Marker `$('form[action*="/login/"]').length > 0 || $('body.path-login').length > 0 || $('body.notloggedin').length > 0`. Bei Hit → `session.reAuthAndRetryGet(path)` + 1× Retry; persistiert der Login-Marker → `throw new LearnwebAuthError(...)` statt `LearnwebParseError`.
- Container-Discriminator: Container existiert + 0 Events → `return []`. Container fehlt → `console.error(JSON.stringify({ event: "timeline_parse_degraded", ...diagnostics }))` + `throw new LearnwebParseError(...)`.
- `parser_degraded`-Felder aus `TimelineContent` und `TimelineResult` entfernen.
- Code-Snippet:
```typescript
const CONTAINER = '[data-region="event-list-content"]';
if (resp.status < 200 || resp.status >= 300) {
  throw new LearnwebUpstreamError(
    `Calendar upcoming view returned ${resp.status}.`,
    await buildDiagnostics(session, $, resp, "/calendar/view.php?view=upcoming", CONTAINER)
  );
}
const isLoginRedirect = ($: cheerio.CheerioAPI) =>
  $('form[action*="/login/"]').length > 0 ||
  $('body.path-login').length > 0 ||
  $('body.notloggedin').length > 0;
if (isLoginRedirect($)) {
  resp = await session.reAuthAndRetryGet("/calendar/view.php?view=upcoming");
  $ = cheerio.load(String(resp.data));
  if (isLoginRedirect($)) {
    throw new LearnwebAuthError(
      "Learnweb login redirect persisted after re-auth.",
      await buildDiagnostics(session, $, resp, "/calendar/view.php?view=upcoming", CONTAINER)
    );
  }
}
// ... extract events ...
const containerExists = $(CONTAINER).length > 0;
if (events.length === 0) {
  if (containerExists) {
    return [];
  }
  const diagnostics = await buildDiagnostics(
    session, $, resp, "/calendar/view.php?view=upcoming", CONTAINER,
    {
      "event-list-item": $('li[data-region="event-list-item"]').length,
      "event-item": $('li[data-region="event-item"]').length,
    }
  );
  console.error(JSON.stringify({ event: "timeline_parse_degraded", ...diagnostics }));
  throw new LearnwebParseError(
    "Timeline events could not be extracted from upcoming view (container missing).",
    diagnostics
  );
}
```

### Schritt 5: Selektor-Erweiterung (defensiv)
- Datei: `src/learnweb/parsers/timeline.ts`
- Änderung:
  - `extractEventItems`: zusätzlicher Fallback-Selektor `[data-region="event-list-content"] > li, .upcoming-events-list > li`.
  - `extractCalendarMonthEvents`: zusätzlich `a[data-action="view-event"]` ohne Wrapper-`<li>` unterstützen.
  - Datums-Extraktion: `data-timestamp` zusätzlich auf `<button>`-Elementen prüfen.
- `extractCalendarMonthEvents` bleibt scoped auf den Calendar-Block-Sidebar (in `view=upcoming` als sekundäre Quelle); `view=month` bekommt eigene Funktion `extractCalendarMonthDayEvents` (siehe Schritt 7).

### Schritt 6: Filter `course_id`/`event_type` + `course_id`-Extraktion
- Datei: `src/learnweb/parsers/timeline.ts`
- Änderung: `TimelineOptions` um `course_id?: number` und `event_type?: string` erweitern. In `extractEventItems` und `extractCalendarMonthEvents` `event.course_id` über `courseIdFromUrl(href)` bzw. `data-course-id` setzen.
- Code-Snippet:
```typescript
if (options.course_id != null) {
  events = events.filter((e) => e.course_id === options.course_id);
}
if (options.event_type) {
  events = events.filter((e) => e.event_type === options.event_type);
}
```
- `cmid`, `modtype`, `course_name` werden bereits geschrieben — keine Änderung, nur in Tests assertieren.

### Schritt 7: Neue Funktion `parseCalendarMonth` + `extractCalendarMonthDayEvents`
- Datei: `src/learnweb/parsers/timeline.ts`
- Änderung: Neue Extraction-Funktion `extractCalendarMonthDayEvents($)` mit Selektor `[data-region="day"] a[data-action="view-event"]`. Pro Anker `cmid` via `cmidFromUrl`, `course_id` via `courseIdFromUrl`, `event_type` aus `data-event-type` bzw. URL-Pfad, `course_name` aus umgebenden `<td>`-Tooltip / `aria-label`, `start`-Timestamp aus `data-timestamp`. Filter `course_id` analog Schritt 6.
- Neue exportierte async Function `parseCalendarMonth(session, options: { year?: number; month?: number; course_id?: number })`. Default = aktueller Monat (Europe/Berlin, Tag 1, 00:00 → unix), URL: `/calendar/view.php?view=month&time=<unix-first-of-month>`, optional `&course=<course_id>`.
- Login-Detection: vor Container-Discriminator denselben Login-Marker-Check + Re-Auth-Retry wie in `parseTimeline`.
- Container-Discriminator: `containerSelector = '.calendarwrapper'`. Container vorhanden + 0 Events → `return { content: { events: [], year, month, fetched_at }, year, month }`. Container fehlt → `LearnwebParseError`.
- Returnt `{ content: { events, year, month, fetched_at }, year, month }` — kein `parser_degraded`.

### Schritt 8: Tool-Schemas erweitern + neues Tool registrieren
- Datei: `src/tools/learnweb.ts`
- Änderung: Tool 4 `learnweb-get-timeline` Input-Schema um `course_id: z.number().int().positive().optional()` und `event_type: z.string().regex(/^[a-z_]+$/).optional()` ergänzen, Args 1:1 an `parseTimeline` weiterreichen.
- Neues Tool 6 `learnweb-get-calendar-month` registrieren.
- Code-Snippet:
```typescript
registerTool(
  "learnweb-get-calendar-month",
  {
    title: "Learnweb: Calendar Month View",
    description:
      "Return all calendar events for a given Moodle month (defaults to current month). " +
      "Use this tool when the upcoming-view does not cover far-future deadlines.",
    inputSchema: {
      year: z.number().int().min(2020).max(2100).optional(),
      month: z.number().int().min(1).max(12).optional(),
      course_id: z.number().int().positive().optional(),
    } as ToolInputSchema,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  async (args: { year?: number; month?: number; course_id?: number }) => {
    return wrapHandler(async () => {
      const session = LearnwebSession.getInstance();
      return parseCalendarMonth(session, args);
    });
  }
);
```
- Import von `parseCalendarMonth` aus `../learnweb/parsers/timeline` ergänzen.
- `wrapHandler` erweitern: `LearnwebParseError` → `code: "learnweb_parse_error"`, message `"Learnweb response could not be parsed."`; `LearnwebUpstreamError` → `code: "learnweb_upstream_error"`, message `"Learnweb upstream returned an error."`. Diagnostics NICHT in Response-Payload kopieren — nur generische Message + Code.

### Schritt 9: Neue HTML-Fixtures (anonymisiert)
- Datei: `test/fixtures/learnweb/`
- Änderung: Neue Fixtures:
  - `timeline-empty-degraded.html` — Layout ohne Event-Markup (Trigger für `LearnwebParseError`).
  - `timeline-upcoming-valid.html` — Sample mit `data-region="event-list-item"`-Liste, mind. 2 Events (verschiedene Modtypes).
  - `calendar-month-valid.html` — Sample mit `data-region="event-item"` innerhalb `data-region="day"`.
  - `timeline-login-redirect.html` — Body mit `<form action="/login/index.php">`.
- Inhalt: minimale Snippets ohne reale `course_id`/`cmid`/Klarnamen.

### Schritt 10: Tests für Erfolg & Filter
- Datei: `test/learnweb-parsers.test.js`
- Änderung: Mock-Session-Pattern aus `learnweb-session.test.js` übernehmen (FakeSession mit `get(path)`, `getBaseUrl()`, `hasMoodleCookie() → true`).
- Neue Cases:
  - `parseTimeline returns events for valid HTML`
  - `parseTimeline filters by course_id`
  - `parseTimeline filters by event_type`
  - `parseTimeline events include cmid, modtype, course_name, course_id`
  - `parseCalendarMonth returns events for valid HTML`
  - `parseCalendarMonth filters by course_id`

### Schritt 11: Tests für Throw-Verhalten
- Datei: `test/learnweb-degradation.test.js`
- Änderung: Bestehende Tests, die `content.parser_degraded === true` asserten, auf `assert.rejects(promise, LearnwebParseError)` umstellen.
- Neue Cases:
  - `parseTimeline throws LearnwebParseError on empty events` (Fixture `timeline-empty-degraded.html`).
  - `parseTimeline throws LearnwebUpstreamError on non-2xx response`.
  - `parseTimeline triggers reAuthAndRetryGet on login-redirect-body and returns events on successful re-auth`.
  - `parseTimeline throws LearnwebAuthError when login-redirect persists after re-auth` (NICHT `LearnwebParseError`).
  - `parseCalendarMonth throws LearnwebParseError on empty events`.

### Schritt 12: Build, Tests, Deploy
- Datei: —
- Änderung:
  - `npm run build` (TypeScript-Compile).
  - `npm test` (alle Tests grün).
  - Bei Erfolg: Commit-Inhalt zusammenfassen, Bestätigung des Nutzers einholen, dann `git push origin hotfix/timeline-parser-throw-on-empty:main`.
  - Railway-Redeploy: Service `learnweb-mcp` im Railway-Dashboard neu deployen oder `railway up`. Änderungen an `railway.toml`/Env-Vars nur nach Rückfrage.
  - Nach Live-Schaltung: `learnweb-get-timeline` mit `window_days=14` gegen Live-Moodle aufrufen → OR Level 2 (Deadline 28.04.2026 09:00) muss in der Liste auftauchen.

## Testkriterien
- [ ] `npm run build` läuft fehlerfrei.
- [ ] `npm test` läuft fehlerfrei.
- [ ] `parseTimeline` mit gültiger Fixture liefert `events.length > 0` und kein `parser_degraded`-Feld.
- [ ] `parseTimeline` mit leerer/ungültiger Fixture wirft `LearnwebParseError`.
- [ ] `parseTimeline` mit non-2xx-Response wirft `LearnwebUpstreamError`.
- [ ] `parseTimeline({ course_id: 12345 })` filtert nur Events mit matchender `course_id`.
- [ ] `parseTimeline({ event_type: "due" })` filtert nur Events mit `event_type === "due"`.
- [ ] Timeline-Events enthalten `cmid`, `modtype`, `course_name`, `course_id` wenn im HTML extrahierbar.
- [ ] `parseCalendarMonth()` (Default = aktueller Monat) liefert nicht-leere Events oder wirft `LearnwebParseError`.
- [ ] Tool `learnweb-get-calendar-month` ist in `registerLearnwebTools` registriert.
- [ ] `wrapHandler` mappt `LearnwebParseError` auf `code: "learnweb_parse_error"` und `LearnwebUpstreamError` auf `code: "learnweb_upstream_error"`.
- [ ] `parseTimeline` löst bei Login-Redirect-Body `reAuthAndRetryGet` aus; bei erfolgreichem Re-Auth liefert es Events, bei persistenter Login-Page wirft es `LearnwebAuthError` (nicht `LearnwebParseError`).
- [ ] `console.error`-Logging enthält `event`, `http_status`, `url`, `timestamp`, `body_snippet`, `has_moodle_cookie`, `selector_hits`, `page_hash` — und KEINE Cookie-Werte oder Credentials.
- [ ] Nach Railway-Redeploy: `learnweb-get-timeline` mit `window_days=180` gegen Live-Moodle liefert non-empty Events-Liste mit mindestens einem Event, das `cmid`, `modtype`, `course_name` enthält.
- [ ] Nach Railway-Redeploy: `learnweb-get-calendar-month` liefert für aktuellen Monat eine non-empty Events-Liste.

## Abbruchbedingungen
- Stoppe wenn: Beim Lesen der aktuellen Live-DOM-Struktur kein eindeutiges Pattern für Events erkennbar ist (z. B. komplett dynamisches JS-Rendering ohne SSR). Dann: STOP, Status auf „Blockiert" setzen, Diagnostik-Snapshot dokumentieren.
- Stoppe wenn: Login-Redirect bei jedem GET kommt (Auth grundsätzlich kaputt) — separates Auth-Ticket, nicht Scope dieses Tickets.
- Stoppe wenn: `npm test` nach Code-Änderung fehlschlägt und Ursache unklar bleibt — Abweichung dokumentieren statt eigenmächtig Tests anpassen.
- Stoppe wenn: AGENTS.md-Sicherheitsgrenze verletzt würde (Cookie-Werte / Credentials in Logs/Errors/Responses) — STOP und Abweichung dokumentieren.
- Bei Unklarheit: STOP → Abweichung dokumentieren → nicht fortfahren ohne Rückmeldung.
