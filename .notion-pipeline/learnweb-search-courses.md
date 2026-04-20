# Learnweb Course Search Tool – Globale Kurssuche (learnweb-search-courses)
> Quelle: Notion Coding Pipeline – 2026-04-20
> Repo: https://github.com/tbmn1996/tbmn-learnweb-connector
> Notion-Seite: https://www.notion.so/Learnweb-Course-Search-Tool

## Kontext
- Projekt: tbmn-learnweb-connector (dediziertes MCP-Server-Repo, keine Notion-Deps).
- Relevante Dateien:
  - `CLAUDE.md` – verbindliche Konventionen (Deutsch, Parser+Tests zusammen, `npm run build && npm test` nach Änderungen, keine Notion-Imports, keine neuen NPM-Pakete ohne Bestätigung).
  - `src/tools/learnweb.ts` – Tool-Registrierung mit `registerLearnwebTools(server, scope)` + `shouldRegister`-Guard. Aktuell 4 Tools. Hier wird Tool 5 `learnweb-search-courses` ergänzt. Enthält `wrapHandler`, `dispatchActivity`, `MODTYPE_RE`, `MAX_LIMIT`, `DEFAULT_LIMIT`.
  - `src/tools/shared.ts` – liefert `ok(...)`, `READ_ONLY_TOOL_ANNOTATIONS`, `ToolConfig`, `ToolInputSchema`, `WorkspaceScope`, `validationError`.
  - `src/learnweb/session.ts` – `LearnwebSession` Singleton (Cookie-Jar, Form-Login, Re-Login bei `isLoginRedirect`, Delay 150 ms, Semaphore 3, Timeout 15 s).
  - `src/learnweb/parsers/courses.ts` – Referenz-Parser Dashboard-Kursliste.
  - `src/learnweb/parsers/common.ts` – Helper `absoluteUrl`, `normalizeText`.
  - `test/fixtures/learnweb/` – Fixture-Verzeichnis (synthetisch, keine PII).
  - `test/learnweb-parsers.test.js` – Parser-Tests (importieren aus `dist/...`).
- Abhängigkeiten: keine neuen Packages. cheerio, axios, axios-cookiejar-support, tough-cookie, zod vorhanden.
- Build & Test: `npm run build` (tsc → `dist/`), `npm test` (build, dann `node --test test/**/*.test.js`).
- Architektur-Entscheidungen:
  - Scraping statt Web-Services-API; `/course/search.php?search=…&page=…` (Param `search`, nicht `q`).
  - Session-Wiederverwendung via `LearnwebSession.getInstance()` (SSO-gated).
  - Eigener Parser `parseCourseSearch` neben `parseCourses` (andere Selektoren).
  - Zod-Validierung: `query` 2–200, `page` 0–20, `limit` 1–50 (default 25).
  - `has_more` aus Bootstrap-4-Paginator (`ul.pagination li.page-item.active` + Geschwister, sprachunabhängig).
  - Kein `category_id`-Filter in v1.
  - `shouldRegister`-Guard unverändert; `READ_ONLY_TOOL_ANNOTATIONS`.
  - Kein `shortname`-Feld in v1 (Klammer-Inhalte wären fälschlich Semester/Gruppen).
  - Tool-Level-Rate-Limit (modul-lokal): 15 Calls / 30 s Rolling-Window; bei Überschreitung Fehler mit `retryAfterSeconds`. In-Memory; Limits des Persistenzverlusts bei Railway-Restart im README dokumentieren.
  - Drift-Sanity-Check: 0 Treffer + Text-Marker (`Keine Kurse`/`No courses found`/`Nothing to display`) innerhalb `#region-main` → legitim leer; sonst Fehler „Unexpected HTML structure". `.alert-info` allein reicht NICHT.

## Implementierungsschritte

### Phase 0: Reconnaissance (Pflicht vor Parser)
- Einmaliger HTML-Snapshot (kein Commit) von drei URLs:
  - `${LEARNWEB_URL}/course/search.php?search=Wirtschaftsinformatik&perpage=25`
  - `${LEARNWEB_URL}/course/search.php?search=Wirtschaftsinformatik&perpage=25&page=1`
  - `${LEARNWEB_URL}/course/search.php?search=zzzz_unlikely_match_xyz`
- Sanitisieren (Namen/Matrikelnr/Mails pseudonymisieren).
- Ohne diesen Schritt sind Selektoren in Phase 2 spekulativ.

### Phase 1: Test-Fixtures committen
- Datei: `test/fixtures/learnweb/course-search.html` – Ergebnisseite ≥3 Treffer + aktivem Paginator (gekürzt, `#region-main` erhalten).
- Datei: `test/fixtures/learnweb/course-search-last-page.html` – Letzte Seite, kein Next-Link (`has_more=false`).
- Datei: `test/fixtures/learnweb/course-search-no-results.html` – Leerergebnis mit No-Results-Marker im `#region-main`.

### Phase 2: Parser implementieren
- Datei: `src/learnweb/parsers/courseSearch.ts` – neue Datei.
- Funktion: `parseCourseSearch(html, baseUrl, currentPage): { results, page, has_more }`.
- Typ:
```ts
interface LearnwebSearchResult {
  course_id: number;
  fullname: string;
  category?: string;
  summary_snippet?: string;
  url: string;
  enrol_url: string; // /enrol/index.php?id=<course_id>
}
```
- Selektoren (nach Recon verifizieren):
  - Karten: `div.coursebox[data-courseid]` → `data-courseid` = `course_id`.
  - Titel+URL: `h3.coursename a` (fallback `h3 a[href*="/course/view.php?id="]`).
  - Kategorie: `.coursecat a` (optional).
  - Summary: `.summary` → `normalizeText` + Word-Boundary-Truncate auf 300 Zeichen mit `…`.
  - Kein `shortname` in v1.
  - Paginator: `ul.pagination li.page-item.active` + folgende `li.page-item:not(.disabled)` mit numerischem `a.page-link`.
- Code-Snippet:
```ts
import * as cheerio from "cheerio";
import { absoluteUrl, normalizeText } from "./common";

export interface LearnwebSearchResult {
  course_id: number;
  fullname: string;
  category?: string;
  summary_snippet?: string;
  url: string;
  enrol_url: string;
}
export interface LearnwebSearchPage {
  results: LearnwebSearchResult[];
  page: number;
  has_more: boolean;
}
const SUMMARY_MAX = 300;
export function parseCourseSearch(html: string, baseUrl: string, currentPage: number): LearnwebSearchPage {
  const $ = cheerio.load(html);
  const results: LearnwebSearchResult[] = [];
  const seen = new Set<number>();
  $("div.coursebox[data-courseid]").each((_, el) => {
    const box = $(el);
    const idAttr = box.attr("data-courseid");
    const id = idAttr ? Number.parseInt(idAttr, 10) : NaN;
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);
    const link = box.find("h3.coursename a, h3 a[href*='/course/view.php?id=']").first();
    const href = link.attr("href") ?? "";
    const fullname = normalizeText(link.attr("title") ?? link.text()) || `Course ${id}`;
    const category = normalizeText(box.find(".coursecat a").first().text()) || undefined;
    const rawSummary = normalizeText(box.find(".summary").first().text());
    let summary_snippet: string | undefined;
    if (rawSummary) {
      if (rawSummary.length > SUMMARY_MAX) {
        const cut = rawSummary.slice(0, SUMMARY_MAX);
        const lastSpace = cut.lastIndexOf(" ");
        summary_snippet = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
      } else summary_snippet = rawSummary;
    }
    const enrol_url = absoluteUrl(baseUrl, "/enrol/index.php?id=" + id);
    results.push({ course_id: id, fullname, category, summary_snippet, url: absoluteUrl(baseUrl, href), enrol_url });
  });
  const activeItem = $("ul.pagination li.page-item.active").first();
  const has_more = activeItem.nextAll("li.page-item").toArray().some((el) => {
    const $el = $(el);
    if ($el.hasClass("disabled")) return false;
    const linkText = normalizeText($el.find("a.page-link").text());
    return /^\d+$/.test(linkText);
  });
  return { results, page: currentPage, has_more };
}
```

### Phase 3: Tool registrieren
- Datei: `src/tools/learnweb.ts` – Tool 5 `learnweb-search-courses` ergänzen (keine Änderung an `shouldRegister`/`dispatchActivity`/Tools 1–4).
- Import:
```ts
import * as cheerio from "cheerio";
import { parseCourseSearch } from "../learnweb/parsers/courseSearch";
```
- Konstanten + Rate-Limit-State:
```ts
const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_PAGE = 20;
const SEARCH_RATE_LIMIT_MAX = 15;
const SEARCH_RATE_LIMIT_WINDOW_MS = 30_000;
const searchCallTimestamps: number[] = [];
function checkSearchRateLimit(): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  while (searchCallTimestamps.length > 0 && now - searchCallTimestamps[0] > SEARCH_RATE_LIMIT_WINDOW_MS) searchCallTimestamps.shift();
  if (searchCallTimestamps.length >= SEARCH_RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((SEARCH_RATE_LIMIT_WINDOW_MS - (now - searchCallTimestamps[0])) / 1000);
    return { ok: false, retryAfterSeconds: retryAfter };
  }
  searchCallTimestamps.push(now);
  return { ok: true };
}
```
- Tool-Block (nach `learnweb-get-timeline`):
```ts
registerTool(
  "learnweb-search-courses",
  {
    title: "Learnweb: Search Courses",
    description:
      "Search the global Learnweb course catalogue (Moodle /course/search.php). " +
      "IMPORTANT: `limit` is an UPPER BOUND – Moodle may return fewer results per page if admin `coursesperpage` caps below. " +
      "Use ONLY `has_more` to decide pagination; NEVER infer end-of-results from `results.length < limit`. " +
      "`effective_perpage` reflects what Moodle actually returned.",
    inputSchema: {
      query: z.string().min(2).max(200).describe("Search term (2–200 chars)."),
      page: z.number().int().min(0).max(SEARCH_MAX_PAGE).optional(),
      limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
    } as ToolInputSchema,
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  async (args: { query: string; page?: number; limit?: number }) => {
    return wrapHandler(async () => {
      const rl = checkSearchRateLimit();
      if (!rl.ok) return { error: true, message: `Search rate limit exceeded. Retry in ${rl.retryAfterSeconds} seconds.` };
      const session = LearnwebSession.getInstance();
      const page = args.page ?? 0;
      const limit = args.limit ?? SEARCH_DEFAULT_LIMIT;
      const qs = new URLSearchParams({ search: args.query, page: String(page), perpage: String(limit) });
      const resp = await session.get(`/course/search.php?${qs.toString()}`);
      if (resp.status < 200 || resp.status >= 300) return { error: true, message: "Could not load course search." };
      const html = resp.data as string;
      const hasRegionMain = /id=["']region-main["']/.test(html);
      const hasCoursebox = /class=["'][^"']*coursebox/.test(html);
      if (!hasRegionMain && !hasCoursebox) return { error: true, message: "Course search returned non-authenticated HTML (likely SSO redirect / session expired)." };
      const parsed = parseCourseSearch(html, session.getBaseUrl(), page);
      if (parsed.results.length === 0) {
        const $html = cheerio.load(html);
        const regionMainText = $html("#region-main").text();
        const hasNoResultsMarker = /(Keine\s+Kurse|No\s+courses?(?:\s+were)?\s+found|Nothing\s+to\s+display)/i.test(regionMainText);
        if (!hasNoResultsMarker) return { error: true, message: "Unexpected HTML structure in course search response (possible Moodle upgrade – selectors may be stale)." };
      }
      const hasPaginatorMarker = /class=["'][^"']*pagination[^"']*["']/i.test(html);
      const has_more_safe = parsed.has_more || parsed.results.length > limit || (parsed.results.length === limit && !hasPaginatorMarker);
      const sliced = parsed.results.slice(0, limit);
      return { results: sliced, page: parsed.page, has_more: has_more_safe, effective_perpage: sliced.length };
    });
  }
);
```

### Phase 4: Parser-Tests
- Datei: `test/learnweb-parsers.test.js` – neuer describe/test-Block.
- Prüfpunkte:
  - `course-search.html`: ≥3 Treffer, alle mit numerischer `course_id` + `fullname` + `url`, `has_more===true`, `page===<input>`.
  - `course-search-last-page.html`: `has_more===false`.
  - Deduplizierung doppelter `data-courseid`.
  - Summary >300 → gekürzt, endet mit `…`, Word-Boundary.
  - `course-search-no-results.html`: `results.length===0`; Tool erkennt No-Results-Marker → `{ results: [], has_more: false }` ohne `error`.
  - Struktur-Drift-Fixture (manuell: `#region-main` da, 0 `.coursebox`, kein Text-Marker) → Tool liefert `{ error: true, message: "Unexpected HTML structure…" }`.
  - `shortname`-Feld im Output NICHT enthalten.

### Phase 5: Dokumentation
- Datei: `README.md` – Tool 5 in Liste ergänzen (Beschreibung, Input-Schema, Output inkl. `effective_perpage`, Rate-Limit, keine `shortname`, Drift-Check).
- Limitations-Abschnitt:
  - `limit` ist Upper-Bound; Admin-`coursesperpage` kann unterschreiten → Caller nur `has_more` nutzen.
  - Rate-Limit-State in-memory, überlebt Railway-Restart nicht; Redis/KV out-of-scope.
- Keine neuen Env-Vars, `.env.example` und `package.json` unverändert.

### Phase 6: Deployment
- Railway: kein Änderungsbedarf. Tool automatisch verfügbar nach Merge + Redeploy.

## Testkriterien
- [ ] `npm run build` fehlerfrei.
- [ ] `npm test` grün – bestehende Parser-Tests unverändert.
- [ ] `parseCourseSearch` gegen `course-search.html`: ≥3 Treffer, gültige `course_id`, `fullname`, `has_more=true`.
- [ ] `parseCourseSearch` gegen `course-search-last-page.html`: `has_more=false`.
- [ ] Deduplizierung aktiv.
- [ ] Summary >300 Zeichen gekürzt, endet mit `…`, Word-Boundary (`lastIndexOf(' ')`).
- [ ] Zod: `query` <2 oder >200 abgelehnt; `page<0/>20`, `limit<1/>50` abgelehnt.
- [ ] Tool nur registriert wenn `shouldRegister(scope)`.
- [ ] Smoke-Test lokal: `learnweb-search-courses({ query: "Wirtschaftsinformatik" })` liefert Treffer mit gültiger `course_id` und URL.
- [ ] `query: "zzzz_unlikely_match"`: `{ results: [], has_more: false }`, kein Crash.
- [ ] Credentials nicht in Response/Log.
- [ ] SSO-Redirect-Guard: Response ohne `#region-main` und ohne `.coursebox` → `{ error: true, ... }`.
- [ ] `shortname` NICHT im Output.
- [ ] Pagination sprachunabhängig: DE-Moodle → `has_more=true` via Struktur, nicht `aria-label`.
- [ ] Drift-Sanity: `#region-main` + 0 `.coursebox` + KEIN Text-Marker → `{ error: true, message: "Unexpected HTML structure…" }`.
- [ ] Drift-Sanity: `#region-main` + 0 `.coursebox` + Text-Marker in `#region-main` → `{ results: [], has_more: false }` OHNE Error.
- [ ] `has_more`-Safeguard: `results.length > limit` → `has_more=true`.
- [ ] `has_more`-Sentinel: `results.length === limit` und kein `pagination`-Marker → `has_more=true`.
- [ ] Tool-Rate-Limit: 16. Call in 30 s → `{ error: true, message: "Search rate limit exceeded…" }`; Recovery nach Window.
- [ ] URL-Parameter: Tool + Recon-URLs nutzen `search=<term>`, NICHT `q=`.
- [ ] `enrol_url = /enrol/index.php?id=<course_id>` als absolute URL in jedem Treffer.
- [ ] `effective_perpage = results.length` in jeder Response.
- [ ] Tool-Description warnt explizit vor `results.length < limit`-Heuristik.
- [ ] `.alert-info`-Banner außerhalb `#region-main` ohne Text-Marker → Struktur-Drift-Error (nicht legitim leer).
- [ ] `README.md`-Limitations dokumentiert (a) `limit`-Upper-Bound, (b) ephemerer Rate-Limit-State.

## Abbruchbedingungen
- Reconnaissance scheitert (Login/HTML-Struktur unerwartet) → STOP, Abweichung dokumentieren, keine geratenen Selektoren.
- `/course/search.php` 403/Login-Redirect trotz Session → STOP, `session.ts`-Re-Login prüfen, ggf. `/course/index.php` evaluieren, NICHT ohne Klärung deployen.
- Moodle ignoriert `perpage` (immer 10) → Client-`slice(0, limit)` greift; `has_more`-Signal muss korrekt sein, sonst Parser erneut verifizieren.
- Bestehende Tests brechen → STOP, revert, Ursache analysieren.
- Bei jeder Abweichung vom Plan → STOP, in Änderungsprotokoll der Notion-Seite dokumentieren, nicht eigenmächtig weitermachen.
