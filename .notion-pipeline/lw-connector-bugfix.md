# LW Connector Bugfix
> Quelle: Notion Coding Pipeline – 2026-04-20
> Repo: https://github.com/tbmn1996/tbmn-learnweb-connector
> Notion-Seite: https://www.notion.so/LW-Connector-Bugfix

## Kontext
- Projekt: TBMN LearnWeb Connector – MCP-Server für die WWU-Münster-Moodle-Instanz (`https://www.uni-muenster.de/LearnWeb/learnweb2`)
- Repo: `tbmn1996/tbmn-learnweb-connector` (Default-Branch, SHA `110fffbf`)
- Deployment: Railway-Service `learnweb-mcp`, Endpoint `https://learnweb-mcp-production.up.railway.app/mcp/learnweb`
- Relevante Dateien:
  - `src/tools/learnweb.ts` – Tool-Registrierung (5 Tools), `wrapHandler`, `dispatchActivity`. Zentrale Baustelle für Fehler-Kontext + neues Tool 6 (SSO-Proxy).
  - `src/learnweb/parsers/ratingallocate.ts` – Parser existiert + in `dispatchActivity` registriert; wirft Exception, die `wrapHandler` zu `learnweb_error` generalisiert.
  - `src/learnweb/parsers/timeline.ts` – setzt `parser_degraded:true` wenn beide Selektoren (`li[data-region="event-list-item"]`, `li[data-region="event-item"]`) 0 Events liefern.
  - `src/learnweb/parsers/fallback.ts` – liefert `raw_text` via `#region-main`/`[role='main']`/`main`/`body`.
  - `src/learnweb/session.ts` – Session/Auth-Layer mit `LearnwebAuthError`, `LearnwebTimeoutError`, `LearnwebNotConfiguredError`.
  - `src/learnweb/parsers/common.ts` – `normalizeText`, `truncate`, `parseMoodleDate`, `cmidFromUrl`, `absoluteUrl`.
- Abhängigkeiten: axios `^1.15.0`, cheerio `^1.1.2`, zod `^3.25.76`, `@modelcontextprotocol/sdk` `^1.29.0`, Node `>=20.19.0`. Keine neuen NPM-Pakete ohne Bestätigung.
- Architektur-Entscheidungen:
  - Keine neuen Dependencies. Logging via `console.error` (Railway captured stdout/stderr).
  - Sicherheitsgrenze `wrapHandler` bleibt: generische Messages, aber `request_id` + `context` ergänzen. Niemals `err.stack`, Cookies, Session-Daten oder Credentials loggen.
  - Zwei neue Error-Klassen in `session.ts`: `LearnwebParseError` (parser, selector) + `LearnwebUpstreamError` (status, path).
  - Parser-Fallback-Pfad in `dispatchActivity`: nur `LearnwebParseError` → `parseFallback` (Whitelist). Auth/NotConfigured/Timeout/Upstream werden durchgereicht – kein Doppel-HTTP-Call gegen kaputten Upstream.
  - Neues Tool `learnweb-get-page` als SSO-Proxy: Pfad-Whitelist `/^/(mod|course|calendar|my|blocks)(/|$)/` + zweistufige Path-Normalisierung gegen SSRF-Bypass via `..` / `%2e%2e` (vgl. CVE-2021-41773).
  - `pluginfile.php` bewusst out-of-scope → Folge-Ticket (Binary-Streaming + Caching).
  - Timeline-Debug-Logging nur bei 0 Events, reine Strukturmetriken, kein HTML-Content.
  - Dritte Selektor-Passage `.block_calendar_upcoming li a[href*='/mod/']` + vierte Pass-Stufe via Moodle-AJAX `core_calendar_get_calendar_upcoming_view`.
  - Sondierung in `docs/auth-alternatives.md` (Option A: WS REST API, Option B: AJAX, Option C: SSO-Scraping).
  - Tests Pflicht: jede Parser-/Dispatcher-Änderung braucht Fixture + `node --test`-Case.

## Implementierungsschritte

### Schritt 1: Live-Fixtures beschaffen (Voraussetzung)
- Ziel-Pfad: `test/fixtures/learnweb/`
- Änderung: HTML-Dumps ablegen:
  - `ratingallocate_live.html` – Live-Response für `cmid=3970722`
  - `ratingallocate_prerating.html` – nur falls abweichende Pre-Rating-View auftaucht
  - `timeline_upcoming_sose2026.html` – voller Response von `/calendar/view.php?view=upcoming`
- Abbruch: wenn Fixtures nicht beschaffbar → Status auf „Blockiert", kein Code-Commit.

### Schritt 2: Neue Fehlerklassen exportieren
- Datei: `src/learnweb/session.ts`
- Änderung: Zwei zusätzliche Exportklassen.
- Code-Snippet:
```typescript
export class LearnwebParseError extends Error {
	constructor(
		public readonly parser: string,
		public readonly selector: string,
		message: string,
	) {
		super(message);
		this.name = "LearnwebParseError";
	}
}

export class LearnwebUpstreamError extends Error {
	constructor(
		public readonly status: number,
		public readonly path: string,
		message: string,
	) {
		super(message);
		this.name = "LearnwebUpstreamError";
	}
}
```

### Schritt 3: `wrapHandler` kontextualisieren
- Datei: `src/tools/learnweb.ts`
- Änderung: `request_id` via `randomUUID()`, neue Codes mappen, `context`-Objekt mit Fallback-sicheren Metadaten, `console.error` mit `[request_id] code: message`. Generische User-facing Messages beibehalten.
- CRITICAL: kein `err.stack`, keine Cookies, keine Raw-Session-Daten, kein Response-Body im Output.
- Code-Snippet:
```typescript
import { randomUUID } from "node:crypto";

async function wrapHandler<T>(fn: () => Promise<T>) {
	const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
	try {
		const value = await fn();
		return ok(value as unknown);
	} catch (err) {
		const code =
			err instanceof LearnwebNotConfiguredError ? "learnweb_not_configured" :
			err instanceof LearnwebAuthError          ? "learnweb_auth_error" :
			err instanceof LearnwebTimeoutError       ? "learnweb_timeout" :
			err instanceof LearnwebParseError         ? "learnweb_parse_error" :
			err instanceof LearnwebUpstreamError      ? "learnweb_upstream_error" :
			                                            "learnweb_error";
		const message =
			err instanceof LearnwebNotConfiguredError ? "Learnweb is not configured on this server." :
			err instanceof LearnwebAuthError          ? "Learnweb authentication failed." :
			err instanceof LearnwebTimeoutError       ? "Learnweb request timed out." :
			                                            "Learnweb request failed.";
		const context: Record<string, unknown> = {};
		if (err instanceof LearnwebParseError)    { context.parser = err.parser; context.selector = err.selector; }
		if (err instanceof LearnwebUpstreamError) { context.status = err.status; context.path = err.path; }
		console.error(`[${requestId}] ${code}: ${(err as Error).message}`);
		const payload = { error: true, code, message, request_id: requestId, context };
		return ok(payload, { text: JSON.stringify(payload), structuredContent: payload, isError: true });
	}
}
```

### Schritt 4: `dispatchActivity` mit Parser-Fallback (Whitelist)
- Datei: `src/tools/learnweb.ts`
- Änderung: Nur `LearnwebParseError` → `parseFallback`. Alle anderen Fehler durchreichen.
- Code-Snippet:
```typescript
async function dispatchActivity(
	session: LearnwebSession,
	args: { cmid: number; modtype: string; limit?: number; offset?: number },
) {
	const { cmid, modtype, limit, offset } = args;
	try {
		switch (modtype) {
			// ...bestehende cases unverändert...
			default:
				return { modtype, ...(await parseFallback(session, cmid, modtype)) };
		}
	} catch (err) {
		if (!(err instanceof LearnwebParseError)) throw err;
		console.error(`[dispatchActivity] parser_fail modtype=${modtype} cmid=${cmid}: ${err.message}`);
		const fb = await parseFallback(session, cmid, modtype);
		return {
			modtype,
			...fb,
			parser_error: {
				code: "learnweb_parse_error",
				parser: err.parser,
				message: String(err.message ?? "").slice(0, 200),
			},
		};
	}
}
```

### Schritt 5: ratingallocate-Parser – explizite Parse-Fehler
- Datei: `src/learnweb/parsers/ratingallocate.ts`
- 5.0 (Pre-Coding): Plugin-Source `learnweb/moodle-mod_ratingallocate` als authoritative Selektor-Quelle prüfen (`templates/*.mustache`, `classes/renderer.php`, `classes/output/*.php`). Verifizierte Selektoren als Kommentar im Parser-Diff dokumentieren. Primärquelle: https://github.com/learnweb/moodle-mod_ratingallocate
- 5a: Wenn nach DOM-Traversal `content` leer bleibt UND weder `.choicestatustable` noch `.choicesummarytable` im DOM existieren (2xx Response) → `throw new LearnwebParseError("ratingallocate", ".choicestatustable", "no status table found")`.
- 5b: Pre-Rating-View-Support: wenn `table.ratingallocate_choices_table` vorhanden → `title` aus `td.c0`, optional `max_size` aus `td.c2`. `user_rating` bleibt `undefined`. Nur wenn Live-Fixture diese Struktur zeigt.
- 5c: Bestehende Post-Rating-View-Logik unverändert.

### Schritt 6: Timeline – dritte + vierte Pass-Stufe + Debug-Logging
- Datei: `src/learnweb/parsers/timeline.ts`
- 6a: Helper `extractCalendarBlock($, baseUrl)` mit Selektor `.block_calendar_upcoming li a[href*='/mod/']`. Titel aus `a.textContent`, `modtype` aus URL-Match, `cmid` via `cmidFromUrl`. Datum optional.
- 6b: Pass-Kette + Logging:
```typescript
let events = extractEventItems($, baseUrl);
if (events.length === 0) events = extractCalendarMonthEvents($, baseUrl);
if (events.length === 0) events = extractCalendarBlock($, baseUrl);
if (events.length === 0) events = await extractViaCalendarAjax(session, window_days);
if (events.length === 0) {
	console.error("[timeline-degraded] " + JSON.stringify({
		html_len: resp.data.length,
		sel_event_list_item: $('li[data-region="event-list-item"]').length,
		sel_event_item: $('li[data-region="event-item"]').length,
		sel_calendar_block: $(".block_calendar_upcoming").length,
		sel_mod_links: $("a[href*='/mod/']").length,
		ajax_attempted: true,
	}));
}
```
- 6c: `extractViaCalendarAjax(session, windowDays)` – POST `/lib/ajax/service.php?sesskey=<sesskey>` mit Payload `[{"index":0,"methodname":"core_calendar_get_calendar_upcoming_view","args":{...}}]`.
  - sesskey-Handling: `session.ts` auf Cache prüfen. Falls nicht gecached → lazy-Fetch per cheerio aus Dashboard-HTML (`input[name="sesskey"]`), sekundär Regex auf inline `M.cfg = {"sesskey":"..."}`; im `LearnwebSession`-Singleton cachen (gleiche TTL wie Session-Cookie).
  - Response-Mapping: `data.events[]` → `TimelineEvent[]` (`name`→Title, `modulename`→modtype, `instance`/`cmid`→cmid, `timestart`→Datum).
  - Fehlerfall:
    - non-2xx → `throw new LearnwebUpstreamError(resp.status, "/lib/ajax/service.php", msg)`.
    - 2xx mit `exception`/`errorcode` ODER fehlendem `data.events[]` → `throw new LearnwebParseError("timeline", "ajax:core_calendar_get_calendar_upcoming_view", msg)`.
  - Primärquelle: https://docs.moodle.org/dev/Web_service_API_functions

### Schritt 7: Neues Tool `learnweb-get-page` (SSO-Proxy)
- Datei: `src/tools/learnweb.ts`
- Änderung: Sechste `registerTool`-Registration nach `learnweb-search-courses`. Zweistufige Path-Validierung (Zod-Regex + Handler-interne `normalizeLearnwebPath`) gegen SSRF-Bypass.
- Code-Snippet:
```typescript
import path from "node:path";

const SAFE_PATH_RE = /^\/(mod|course|calendar|my|blocks)(\/|$)/;

function normalizeLearnwebPath(input: string): string {
	if (/%2e/i.test(input) || /(^|\/)\.\.(\/|$)/.test(input)) {
		throw new LearnwebUpstreamError(400, input, "path traversal rejected");
	}
	const qIdx = input.indexOf("?");
	const rawPath = qIdx === -1 ? input : input.slice(0, qIdx);
	const query = qIdx === -1 ? "" : input.slice(qIdx);
	const decoded = decodeURIComponent(rawPath);
	const normalized = path.posix.normalize(decoded);
	if (!SAFE_PATH_RE.test(normalized) || normalized.includes("..")) {
		throw new LearnwebUpstreamError(400, input, "path not in whitelist after normalize");
	}
	return normalized + query;
}

registerTool(
	"learnweb-get-page",
	{
		title: "Learnweb: Get Page (SSO Proxy)",
		description:
			"Return bereinigten Seitentext einer SSO-geschützten Learnweb-Seite. " +
			"Nur Pfade unter /mod, /course, /calendar, /my, /blocks.",
		inputSchema: {
			path: z
				.string()
				.regex(SAFE_PATH_RE, "path must be under /mod, /course, /calendar, /my or /blocks")
				.max(500),
		} as ToolInputSchema,
		annotations: READ_ONLY_TOOL_ANNOTATIONS,
	},
	async ({ path: rawPath }: { path: string }) =>
		wrapHandler(async () => {
			const safePath = normalizeLearnwebPath(rawPath);
			const session = LearnwebSession.getInstance();
			const resp = await session.get(safePath);
			if (resp.status < 200 || resp.status >= 300) {
				throw new LearnwebUpstreamError(resp.status, rawPath, "upstream non-2xx");
			}
			const $ = cheerio.load(resp.data);
			$("nav, header, footer, .navbar, #nav-drawer, [role='navigation'], script, style, noscript").remove();
			const title = normalizeText($("h1, h2").first().text()) || rawPath;
			const text = normalizeText(
				$("#region-main, [role='main'], main, body").first().text(),
			);
			return {
				path: rawPath,
				title,
				text: truncate(text, 20000),
				length: text.length,
				fetched_at: new Date().toISOString(),
				// TODO: Redis-Cache (TTL 60s) wenn REDIS_URL gesetzt; Design im Folge-Ticket.
			};
		}),
);
```

### Schritt 8: Fixtures committen
- Datei: `test/fixtures/learnweb/`
- Änderung: In Schritt 1 beschaffte HTML-Dumps committen. Zusätzlich minimaler synthetischer `timeline_calendar_block.html` (~30 Zeilen) als Sanity-Fixture für `extractCalendarBlock`.

### Schritt 9: Test-Cases ergänzen
- 9a `test/ratingallocate.test.ts`: Case mit Live-Fixture – erwarte entweder `content.choices.length > 0` oder geworfenen `LearnwebParseError`.
- 9b `test/timeline.test.ts`: Case für `extractCalendarBlock` (Sanity-Fixture). `console.error`-Stub: leeres HTML → genau eine `[timeline-degraded]`-Zeile mit allen Keys (inkl. `ajax_attempted: true`). AJAX-Cases: Session-Stub `{ status: 500 }` → `LearnwebUpstreamError`; `{ status: 200, data: [{ error: true, exception: { message: "invalid sesskey" } }] }` → `LearnwebParseError` mit Selektor `ajax:core_calendar_get_calendar_upcoming_view`. Fehlender `sesskey` → Fallback aus Dashboard-HTML-Stub (`input[name="sesskey"]`).
- 9c `test/dispatchActivity.test.ts` (NEU): Parser wirft `LearnwebParseError` → Ergebnis enthält `parser_error.code === "learnweb_parse_error"` + nicht-leeren `raw_text`. Whitelist-Cases: Parser wirft `LearnwebTimeoutError` / `LearnwebUpstreamError` / `LearnwebAuthError` / generischer `Error` → durchgereicht (Spy-Counter bleibt bei 1), landet im `wrapHandler` mit korrektem Code. Kein `parser_error`-Feld bei Nicht-Parse-Fehlern.
- 9d `test/getPage.test.ts` (NEU): Zod-Regex lehnt `/admin/foo`, `/user/profile.php` ab; akzeptiert `/mod/forum/view.php?id=123`, `/calendar/view.php?view=upcoming`. Traversal-Cases: `/mod/../admin/config.php`, `/mod/%2e%2e/admin/config.php`, `/mod/%2E%2E%2Fadmin/config.php`, `/mod/foo/..%2F..%2Fadmin` → `LearnwebUpstreamError(400, …)` vor Session-Call (Spy → `callCount === 0`). Positiv: `/mod/forum/view.php?id=123/..` → Query-String bleibt nach Normalisierung erhalten.
- Abschluss: `npm run build && npm test` zwingend grün vor Commit.

### Schritt 10: Sondierungs-Notiz `docs/auth-alternatives.md` (NEU)
- Option A – Moodle Web Service REST API (`/webservice/rest/server.php`): Voraussetzungen, Token-Workflow, typische WWU-Rechtebeschränkung. Primärquelle: Moodle-Docs „Using web services".
- Option B – Plugin-AJAX-Endpunkte (`lib/ajax/service.php`, `core_calendar_get_calendar_upcoming_view`): sessionauthentifiziert, kein separater Token. Primärquelle: Moodle Developer Docs „AJAX / Web services".
- Option C – Status-quo SSO-Scraping: Vor-/Nachteile, Logging-Strategie für Feature-Ableitung.
- Empfehlung: Option B direkt als 4. Pass in Schritt 6 eingebaut. Weitere AJAX-Endpunkte (z. B. `core_course_get_enrolled_courses_by_timeline_classification`) als Folge-Sondierung. Option A erst nach IT-Ticket für Service-Token.
- Pflicht: je Option mind. eine Primärquelle gemäß Dreischritt-Protokoll.

### Schritt 11: README.md aktualisieren
- Abschnitt „Tools" um sechstes Tool `learnweb-get-page` erweitern (Input-Schema, Beispiel-Call, Begründung Path-Whitelist).
- Hinweis auf neue `request_id` + `context`-Felder in Fehler-Responses.
- Expliziter Hinweis: `/pluginfile.php/...` bewusst nicht in Whitelist → separates Folge-Ticket.

### Schritt 12: Build & Deployment
- Security-Check: `npm audit` nach `npm install`. axios 1.15.0 clean gegen CVE-2026-40175, aber CVE-2025-62718 via transitives `follow-redirects@1.15.11`. Upgrade auf axios 1.16.0 als Folge-Ticket, nicht in dieser Runde.
- `npm run build && npm test` lokal grün.
- Commit-Message:
```
fix(learnweb): ratingallocate-Fallback, timeline-Debug-Logging, sso-proxy, kontextualisierte Fehler

- session.ts: LearnwebParseError + LearnwebUpstreamError
- wrapHandler: request_id + context, generische Messages beibehalten
- dispatchActivity: Parser-Exception → parseFallback + parser_error
- timeline: 3. Selektor (.block_calendar_upcoming) + 4. Pass (AJAX) + Debug-Logging
- learnweb-get-page: SSO-Proxy mit Path-Whitelist + Traversal-Schutz
- docs/auth-alternatives.md: Sondierung Option A/B/C
```
- Vor `git push` oder Railway-Redeploy: Commit-Inhalt zusammenfassen + Bestätigung abwarten. Ausnahme: expliziter Go-Live-Befehl durch @Thomas.

## Testkriterien
- [ ] `npm run build` läuft ohne TypeScript-Fehler durch.
- [ ] `npm test` grün – inkl. neuer Tests für `dispatchActivity`-Fallback, `extractCalendarBlock`, Debug-Logging, `SAFE_PATH_RE`, AJAX-Pass, Traversal-Validierung.
- [ ] `learnweb-read-activity` mit `modtype: "ratingallocate"` + `cmid: 3970722` liefert ENTWEDER strukturierte `content.choices[]` ODER ein Ergebnis mit `raw_text` + `parser_error.code === "learnweb_parse_error"`. Nie wieder blankes `learnweb_error`.
- [ ] `learnweb-read-activity` mit unbekanntem Modtype (z. B. `foobar`) liefert weiterhin `parser_degraded: true` + `raw_text`.
- [ ] `learnweb-get-timeline` bei 0 Events schreibt genau eine `[timeline-degraded] {...}`-Zeile nach `console.error` mit Keys `html_len`, `sel_event_list_item`, `sel_event_item`, `sel_calendar_block`, `sel_mod_links`, `ajax_attempted`. Keine HTML-Snippets, keine Cookies.
- [ ] Alle Fehler-Responses enthalten `request_id` + `context`-Objekt, aber niemals `err.stack`, Cookies, Credentials oder Response-Body.
- [ ] `learnweb-get-page` lehnt `path: "/admin/foo"` mit Zod-Validation-Error ab, lehnt `/mod/../admin/config.php` + `%2e%2e`-Varianten mit `LearnwebUpstreamError(400)` vor Session-Call ab, liefert für `path: "/mod/forum/view.php?id=123"` einen nicht-leeren `text` via SSO-Session.
- [ ] `docs/auth-alternatives.md` existiert, enthält Option A/B/C mit je mindestens einer Primärquelle.
- [ ] `README.md` listet `learnweb-get-page` im Tools-Abschnitt und dokumentiert `request_id`/`context` in Fehler-Responses sowie die `/pluginfile.php`-Lücke.

## Abbruchbedingungen
- Stoppe wenn in Schritt 1 keine Live-Fixture für `ratingallocate_live.html` bzw. `timeline_upcoming_sose2026.html` beschafft werden kann → Status „Blockiert", @Thomas pingen, kein Code-Commit.
- Stoppe wenn eine geplante Änderung ein neues NPM-Paket erfordern würde → Bestätigung einholen.
- Stoppe wenn `npm test` nach Schritt 9 rot bleibt und die Ursache im Session-Layer (`src/learnweb/session.ts`) liegt → aus Scope entfernen, separates Ticket.
- Stoppe wenn Änderungen an `.env`, `railway.toml` oder Railway-Env-Vars nötig würden → Bestätigung einholen.
- Stoppe wenn `git push` oder Railway-Redeploy ansteht → Commit-Inhalt transparent machen + Bestätigung abwarten. Ausnahme: expliziter Go-Live-Befehl durch @Thomas.
- Bei Unklarheit: Nicht eigenmächtig weitermachen, Abweichung als Seitenkommentar dokumentieren.
