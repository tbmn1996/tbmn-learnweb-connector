# Session Summary: tbmn-learnweb-connector – Timeline-Parser auf Moodle-AJAX-API

**Datum:** 2026-04-26
**Modell:** Claude Sonnet 4.6
**Primärdatei:** `src/learnweb/parsers/timeline.ts` (600 Zeilen, 15 Funktionen)
**Sekundärdatei:** `src/learnweb/session.ts` (467 Zeilen, 4 Funktionen)
**Branch:** `hotfix/timeline-ajax-api` (gemerged in `main` via Direct-Push)
**Notion-Ticket:** [Hotfix v2: Timeline-Parser auf Moodle-AJAX-API umstellen](https://www.notion.so/Hotfix-v2-Timeline-Parser-auf-Moodle-AJAX-API-umstellen-34dbf244cadc81dbb67eed33d3bc4a42)

---

## Ausgangslage

Hotfix v1 (Commit `92baf03`) hatte bereits `parser_degraded:true` durch `LearnwebParseError` ersetzt und alle Error-Klassen, sechs Tools, `hasMoodleCookie()` sowie `buildDiagnostics()` ergänzt. Das eigentliche Problem blieb aber bestehen: das Tool `learnweb-get-timeline` lieferte konsistent leere Events oder einen `learnweb_parse_error`, obwohl im Live-Moodle nachweislich Deadlines existierten (z.B. „Beantwortung Begleitprojekt 2 endet" am 28.04.2026 09:00 CEST im Kurs Operations Research).

Der Notion-Ticket-Summary identifizierte die Ursache: **Moodle 4.x rendert die Upcoming-Events per JavaScript** — der Server liefert das Container-Skeleton ganz oder gar nicht, das tatsächliche Event-Markup wird erst clientseitig nachgeladen. HTML-Scraping ist damit strukturell unmöglich. Die Lösung: Moodles internes AJAX-Endpoint `/lib/ajax/service.php` (session-authentifiziert via Cookie + sesskey, kein Admin-Setup nötig).

Im Verlauf der Session waren sechs aufeinanderfolgende Hotfixes notwendig — jeder davon adressierte eine konkrete Annahme, die sich erst durch Live-Diagnostik als falsch herausstellte.

---

## Implementierte Änderungen

### 1. session.ts: sesskey + wwwroot Cache + postJson() (Commit 2ddc91f, 3b1d608)

Erweiterung der `LearnwebSession`-Klasse um drei neue öffentliche Methoden plus zwei private Cache-Felder. Beide Cache-Felder werden bei `performLogin(force=true)` invalidiert, damit nach Session-Expiry frisch geholt wird.

```typescript
// Gecachter sesskey + Moodle-wwwroot — werden bei Re-Auth invalidiert.
private sesskey: string | null = null;
private moodleWwwroot: string | null = null;

public async getSesskey(): Promise<string> {
  if (this.sesskey) return this.sesskey;
  const resp = await this.get("/my/index.php");
  const $ = cheerio.load(resp.data);
  let key = $('input[name="sesskey"]').first().attr("value") ?? "";
  if (!key) {
    const match = /"sesskey":"([^"]+)"/.exec(resp.data);
    if (match) key = match[1];
  }
  if (!key) throw new LearnwebAuthError("Could not extract sesskey from Moodle dashboard.");

  // wwwroot cachen — nötig für korrekte AJAX-URLs wenn baseURL nur den Domain-Root hat.
  const wwwrootMatch = /"wwwroot":"([^"]+)"/.exec(resp.data);
  if (wwwrootMatch) {
    this.moodleWwwroot = wwwrootMatch[1].replace(/\\\//g, "/");
  }
  this.sesskey = key;
  return key;
}

public getMoodleWwwroot(): string {
  return this.moodleWwwroot ?? this.baseUrl;
}

public async postJson(path: string, body: unknown): Promise<LearnwebResponse> {
  const resp = await this.client.post(path, JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
  // ... LearnwebResponse-Mapping
}
```

### 2. timeline.ts: extractViaCalendarAjax() (Commit 2ddc91f, ee9e1e6, ebc3b24)

Neue private Funktion, die Moodles `core_calendar_get_action_events_by_timesort`-API aufruft. Mehrfach iteriert:

- Erst Methodenname `core_calendar_get_calendar_upcoming_view` mit `limitnum/offset` → Moodle gab `"Invalid parameter value detected"`
- Dann `core_calendar_get_action_events_by_timesort` mit `limitnum=window_days*3` → Moodle gab `"Limit must be between 1 and 50 (inclusive)"`
- Schließlich `limitnum=50` (hartes Moodle-API-Limit), `timesortfrom`/`timesortto` für Zeitfenster, `limittononsuspendedevents=true` für Filterung

```typescript
const sesskey = await session.getSesskey();
const wwwroot = session.getMoodleWwwroot();
const limitnum = 50;
const nowUnix = Math.floor(Date.now() / 1000);
const cutoffUnix = nowUnix + window_days * 86400;
const payload = [{
  index: 0,
  methodname: "core_calendar_get_action_events_by_timesort",
  args: {
    limitnum,
    timesortfrom: nowUnix,
    timesortto: cutoffUnix,
    limittononsuspendedevents: true,
  },
}];
const ajaxUrl = `${wwwroot}/lib/ajax/service.php?sesskey=${encodeURIComponent(sesskey)}`;
const resp = await session.postJson(ajaxUrl, payload);
```

### 3. timeline.ts: parseTimeline() AJAX-Fallback (Commit 2ddc91f, 160262d)

Erste Iteration ging davon aus dass der Container vorhanden aber leer ist. Live-Logs zeigten: der Container ist komplett absent (`selector_hits: 0`). Zweiter Commit nutzt AJAX **immer** wenn HTML keine Events liefert, unabhängig von Container-Präsenz.

```typescript
if (events.length === 0) {
  // HTML liefert keine Events — Moodle 4.x rendert sie per JavaScript.
  events = await extractViaCalendarAjax(session, window_days);
  if (events.length === 0) {
    const diagnostics = await buildDiagnostics(session, $, resp, UPCOMING_CONTAINER, {
      container_present: $(UPCOMING_CONTAINER).length,
    });
    console.error(JSON.stringify({ event: "timeline_ajax_empty", ...diagnostics }));
    return { content: { events: [], window_days, fetched_at } };
  }
}
```

### 4. timeline.ts: Event-Mapping aus AJAX-Response (Commit ee9e1e6)

Die API `core_calendar_get_action_events_by_timesort` liefert Events mit Activity-URL unter `action.url`, **nicht** unter `e.url` (das ist die Calendar-View-URL). `cmid` muss aus der URL extrahiert werden, nicht aus `e.instance` (das ist die Activity-Instance-ID, nicht die Course-Module-ID).

```typescript
return rawEvents.map((raw: unknown): TimelineEvent => {
  const e = raw as Record<string, unknown>;
  const event: TimelineEvent = {};
  if (e["name"]) event.title = truncate(String(e["name"]), 300);
  if (e["modulename"]) event.modtype = String(e["modulename"]);
  if (e["eventtype"]) event.event_type = String(e["eventtype"]);
  if (e["id"]) event.event_id = Number(e["id"]);
  if (e["timestart"]) event.due_at_unix = Number(e["timestart"]);
  const course = e["course"] as Record<string, unknown> | undefined;
  if (course?.["id"]) event.course_id = Number(course["id"]);
  if (course?.["fullname"]) event.course_name = truncate(String(course["fullname"]), 200);

  const action = e["action"] as Record<string, unknown> | undefined;
  const rawUrl = (action?.["url"] as string | undefined) ?? (e["url"] as string | undefined);
  if (rawUrl) {
    event.url = absoluteUrl(baseUrl, rawUrl);
    const cmid = cmidFromUrl(rawUrl);
    if (cmid) event.cmid = cmid;
  }
  return event;
});
```

### 5. timeline.ts: Diagnostik-Logging (Commit 0f4fe67)

Ohne Diagnose-Output war live nicht erkennbar, an welcher Stelle der Throw passierte. Jeder `throw`-Pfad in `extractViaCalendarAjax` wird jetzt mit `console.error` und strukturierter JSON-Diagnose geloggt — sesskey wird per Regex aus der URL redacted.

```typescript
const logCtx = (extra: Record<string, unknown>) =>
  JSON.stringify({
    event: "timeline_ajax_diagnostic",
    url: ajaxUrl.replace(/sesskey=[^&]+/, "sesskey=REDACTED"),
    http_status: resp.status,
    content_type: resp.headers["content-type"],
    body_length: resp.data?.length,
    body_snippet: String(resp.data ?? "").slice(0, 500),
    ...extra,
  });
```

### 6. Tests + Fixtures

`test/fixtures/learnweb/timeline-container-empty.html` (Moodle-4.x-Skeleton mit leerem Container) und `test/fixtures/learnweb/ajax-calendar-upcoming-valid.json` (valide AJAX-Response mit 2 Events) ergänzt. Fünf neue Test-Cases in `test/learnweb-degradation.test.js`:

- AJAX liefert valide Events → Mapping verifiziert
- AJAX liefert `[]` → `{ events: [] }` zurückgegeben (legitim leer)
- AJAX non-2xx → wirft `LearnwebUpstreamError`
- AJAX `error: true` mit exception → wirft `LearnwebParseError`
- AJAX fehlendes `data.events` → wirft `LearnwebParseError`

Alle 65 Tests grün.

---

## Konfiguration / Infrastruktur

| Komponente | Wert |
|---|---|
| Repo | `tbmn1996/tbmn-learnweb-connector` |
| Branch | `main` (alle Hotfixes direkt gepusht, kein PR) |
| Railway-Service | `learnweb-mcp` (Service-ID `1e50f1a0-b633-4c68-89bb-af0e848c958f`) |
| Domain | `learnweb-mcp-production.up.railway.app` |
| Live-MCP-Endpoint | `https://learnweb-mcp-production.up.railway.app/mcp/learnweb` |
| Moodle-Instanz | `https://www.uni-muenster.de/LearnWeb/learnweb2` (extrahiert aus `M.cfg.wwwroot`) |
| `LEARNWEB_URL` env | `https://www.uni-muenster.de` (nur Domain-Root, **nicht** mit Sub-Path!) |
| Genutzte Moodle-API | `core_calendar_get_action_events_by_timesort` (max `limitnum=50`) |
| OAuth-Store | In-Memory (`MCP_OAUTH_ALLOW_IN_MEMORY_STORE=true`) — bei jedem Redeploy muss in claude.ai neu authentifiziert werden |
| Node-Runtime | `>=20.19.0` |
| Dependencies | axios `^1.15.0`, cheerio `^1.1.2`, tough-cookie `^6.0.1`, zod `^3.25.76` (alle bereits installiert, **keine neuen**) |

---

## Typische Verwendung

```bash
# Build + Tests lokal
npm run build && npm test

# Single-Test laufen lassen (Node Test-Runner)
node --test test/learnweb-degradation.test.js

# Railway-Logs als JSON streamen (für Diagnostik)
railway logs --service learnweb-mcp --json | tail -20

# Spezifisch nach AJAX-Diagnostik filtern
railway logs --service learnweb-mcp --json | grep timeline_ajax_diagnostic

# Redeploy nach Code-Änderungen
railway up --service learnweb-mcp --detach

# Live-Tool aufrufen (über claude.ai MCP-Connector — nicht per CLI möglich)
# Tool: learnweb-get-timeline
# Args: { "window_days": 30 }
```

---

## Bekannte Eigenheiten / Lessons Learned

| Verhalten | Details |
|-----------|---------|
| Axios `baseURL` mit Sub-Path + Pfad mit `/` | Wenn `baseURL = https://x.de/A/B` und Pfad `/lib/...`, resolved zu `https://x.de/lib/...` (Sub-Path wird ignoriert!). Workaround: `wwwroot` aus `M.cfg` extrahieren und absolute URL bauen. |
| Moodle 4.x liefert kein Skeleton | Anders als im ursprünglichen Pipeline-Plan vermutet, ist `[data-region="event-list-content"]` **gar nicht** im HTML — der ganze Container fehlt. AJAX muss daher unabhängig von Container-Präsenz greifen. |
| `core_calendar_get_calendar_upcoming_view` ≠ Event-API | Diese Methode liefert **gerendertes HTML** und nimmt `courseid`/`categoryid` als Parameter. Für strukturierte Events: `core_calendar_get_action_events_by_timesort`. |
| `limitnum` hartes Limit 50 | `core_calendar_get_action_events_by_timesort` akzeptiert max. 50. Größere Werte → `"Limit must be between 1 and 50 (inclusive)"`. |
| `e.instance` ist nicht `cmid` | Im AJAX-Response ist `instance` die Activity-Instance-ID (z.B. quiz_id), **nicht** die Course-Module-ID. `cmid` muss via `cmidFromUrl(action.url)` extrahiert werden. |
| `e.url` ≠ Activity-URL | Bei `action_events_by_timesort` zeigt `e.url` auf die Calendar-Event-View (`/calendar/view.php?view=day...`), die richtige Activity-URL liegt unter `e.action.url`. |
| sesskey-Cache + Re-Auth | sesskey ist session-gebunden. Bei `performLogin(force=true)` wird der Cache invalidiert, damit nach Session-Expiry nicht ein veralteter sesskey weiter benutzt wird. |
| OAuth-Session-Verlust bei Redeploy | Jeder `railway up` löst Re-Authentifizierung in claude.ai aus. Bekannt, dokumentiert in CLAUDE.md unter „Offene Punkte". Folge-Ticket: Redis-URL setzen. |
| Diagnostik-Logging als Pflicht | Ohne `console.error` an jedem Throw-Punkt waren Live-Probleme nicht debuggbar. Gilt auch für zukünftige API-Erweiterungen. |

---

## GitHub-Status

**Vollständig synchronisiert:** Branch `main` enthält alle 6 Hotfix-Commits. Branch `hotfix/timeline-ajax-api` ist lokal noch ausgecheckt, aber auf demselben Stand wie `origin/main`.

Gepushte Commits (chronologisch):

| Hash | Message |
|---|---|
| `2ddc91f` | fix(timeline): AJAX-Fallback für Moodle-4.x-JS-Rendering |
| `160262d` | fix(timeline): AJAX immer nutzen wenn HTML keine Events liefert |
| `3b1d608` | fix(timeline): wwwroot für AJAX-URL aus Moodle M.cfg extrahieren |
| `0f4fe67` | debug(timeline): Diagnostik-Logging in extractViaCalendarAjax |
| `ee9e1e6` | fix(timeline): Methodenname auf core_calendar_get_action_events_by_timesort |
| `ebc3b24` | fix(timeline): limitnum auf 50 beschränken (Moodle API-Limit) |

Lokale Änderungen außerhalb der Hotfix-Logik (nicht zu committen):
```
 M CLAUDE.md                                              (Bearbeitung von früherer Session)
?? docs/260420_claude_repo-split-und-course-search.md     (Untracked, von früherer Session)
?? docs/260426_claude_hotfix-v2-timeline-ajax.md          (Diese Session-Summary)
```

---

## Live-Verifikation

Tool-Call: `learnweb-get-timeline { window_days: 30 }` → 4 Events korrekt zurückgegeben:

1. **„Beantwortung Begleitprojekt 2 endet"** — Operations Research SoSe 2026 — `due_at_unix: 1777359600` = **2026-04-28 09:00 CEST** ✓ (das im Notion-Ticket genannte „OR Level 2"-Deadline)
2. „Elektronische Abgabe AT01 (Funktionen und lineare Funktionen) endet" — Mathematik für Wirtschaftswissenschaftler
3. „Upload Folien Gruppenarbeit 2 ist fällig" — Operations Research SoSe 2026
4. „Studienleistung (1) - Ethik-Debatte (6er-Gruppe) ist fällig" — Wissenschaftliches Arbeiten/Ethik

Alle Events haben korrekte `cmid`, `course_id`, `course_name`, `event_type`, `modtype` und absolute Activity-URLs.

---

## Offene Punkte / Folgearbeiten

1. **Diagnostik-Logging in 2 Wochen aufräumen:** Wenn keine `timeline_ajax_diagnostic`-Errors in den Railway-Logs aufgetaucht sind, das Logging auf reine `error`-Stage-Information reduzieren (`body_snippet` entfernen, sonst zu verbose). Geplant via `/schedule` Agent für 2026-05-10.

2. **`parseCalendarMonth` bekommt keinen AJAX-Fallback:** Die Monatsansicht-Funktion nutzt weiterhin nur HTML-Scraping. Falls auch dort der Container fehlt, würde `LearnwebParseError` geworfen. Empfehlung: separates Ticket öffnen wenn `learnweb-get-calendar-month` Probleme zeigt — analoge AJAX-Methode wäre `core_calendar_get_calendar_monthly_view`.

3. **`limitnum=50` Hardcoded:** Bei Kursen mit mehr als 50 anstehenden Deadlines würde die Liste abgeschnitten. Aktuell unkritisch (typischer Student hat <50 offene Deadlines), aber bei Bedarf via `aftereventid`-Pagination erweiterbar.

4. **Notion-Status auf „Fertig" setzen:** Manuell in der [Coding Pipeline DB](https://www.notion.so/8be7de77bfe54bdda9063eb1d2f54423) — laut CLAUDE.md ausdrücklich nicht zu automatisieren.

5. **Burn-In-Phase abwarten und Redis-URL setzen:** OAuth-Store ist weiterhin in-memory; jeder Redeploy zwingt zu Re-Auth in claude.ai. Folge-Ticket existiert bereits im Backlog (siehe Repo-`CLAUDE.md` → „Offene Punkte").
