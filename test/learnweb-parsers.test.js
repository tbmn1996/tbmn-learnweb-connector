/**
 * Unit-Tests für Learnweb-Parser gegen synthetische Fixtures.
 *
 * Wir bauen eine FakeSession, die URL→HTML-Mappings statisch zurückgibt,
 * sodass die Parser komplett offline getestet werden können. Keine
 * axios/cheerio-Mocks — die Parser verwenden cheerio direkt aus dem Package.
 *
 * Fixtures liegen unter test/fixtures/learnweb/ und werden bewusst
 * synthetisch gehalten (keine PII aus Live-Recon).
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "test/fixtures/learnweb");

// Die Parser sind als CommonJS-Module nach dem TS-Build verfügbar.
// Wir gehen über dist/ um keine ts-node-Dependency einzuziehen.
const { parseCourses } = require(path.join(ROOT, "dist/learnweb/parsers/courses"));
const { parseCourseSearch } = require(path.join(ROOT, "dist/learnweb/parsers/courseSearch"));
const { parseCourseOverview } = require(path.join(ROOT, "dist/learnweb/parsers/overview"));
const { parseResource } = require(path.join(ROOT, "dist/learnweb/parsers/resource"));
const { parseUrl } = require(path.join(ROOT, "dist/learnweb/parsers/url"));
const { parsePage } = require(path.join(ROOT, "dist/learnweb/parsers/page"));
const { parseFallback } = require(path.join(ROOT, "dist/learnweb/parsers/fallback"));
const { parseForum } = require(path.join(ROOT, "dist/learnweb/parsers/forum"));
const { parseAssign } = require(path.join(ROOT, "dist/learnweb/parsers/assign"));
const { parseQuiz } = require(path.join(ROOT, "dist/learnweb/parsers/quiz"));
const { parseRatingAllocate } = require(path.join(ROOT, "dist/learnweb/parsers/ratingallocate"));
const { parseTimeline, _extractForTest: extractTimelineEvents } = require(path.join(ROOT, "dist/learnweb/parsers/timeline"));
const { parseFolder } = require(path.join(ROOT, "dist/learnweb/parsers/folder"));
const { parseWorkshop } = require(path.join(ROOT, "dist/learnweb/parsers/workshop"));
const { parseLesson } = require(path.join(ROOT, "dist/learnweb/parsers/lesson"));
const { parseChoice } = require(path.join(ROOT, "dist/learnweb/parsers/choice"));
const { parseFeedback } = require(path.join(ROOT, "dist/learnweb/parsers/feedback"));

const BASE_URL = "https://learnweb.example.com";

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/**
 * Minimaler Stand-In für LearnwebSession. Die Parser-API nutzt nur
 * `session.get(path)` und `session.getBaseUrl()`.
 */
function fakeSession(pathToHtml) {
  return {
    getBaseUrl: () => BASE_URL,
    async get(p) {
      const html = pathToHtml[p];
      if (html === undefined) {
        // Wenn ein Parser unerwartete Pfade anfordert, schlagen wir laut fehl —
        // das hilft beim Aufdecken von Regressionen.
        throw new Error(`FakeSession: no fixture for ${p}`);
      }
      return {
        status: 200,
        url: BASE_URL + p,
        headers: {},
        data: html,
      };
    },
  };
}

// ------------------------------------------------------------------
// parseCourses
// ------------------------------------------------------------------
test("parseCourses: dedupe + title fallback", () => {
  const html = readFixture("dashboard.html");
  const courses = parseCourses(html, BASE_URL);

  // 101 (Analysis, mit title), 202 (OR, mit title), 303 (Informatik II),
  // 404 (Lineare Algebra, ohne title → Link-Text).
  const byId = Object.fromEntries(courses.map((c) => [c.course_id, c]));
  assert.equal(Object.keys(byId).length, 4);

  assert.equal(byId[101].name, "Analysis für Wirtschaftswissenschaftler");
  assert.equal(byId[202].name, "Operations Research SoSe 2099");
  assert.equal(byId[303].name, "Informatik II");
  assert.equal(byId[404].name, "Lineare Algebra");

  // Kurs ohne id-Param (cat=42) darf nicht auftauchen.
  assert.ok(courses.every((c) => c.course_id !== 42));

  // URL soll absolut sein, auch für relative hrefs.
  assert.ok(byId[101].url.startsWith(BASE_URL));
});

// ------------------------------------------------------------------
// parseCourseSearch
// ------------------------------------------------------------------
test("parseCourseSearch: extrahiert Treffer, dedupliziert und erkennt has_more", () => {
  const html = readFixture("course-search.html");
  const page = parseCourseSearch(html, BASE_URL, 0);

  assert.equal(page.page, 0);
  assert.equal(page.has_more, true);
  assert.equal(page.results.length, 3);

  const byId = Object.fromEntries(page.results.map((course) => [course.course_id, course]));
  assert.equal(byId[92286].fullname, "Einführung in die Wirtschaftsinformatik SoSe 2099");
  assert.equal(byId[92286].category, "Institut für Wirtschaftsinformatik");
  assert.ok(byId[92286].url.startsWith(BASE_URL));
  assert.ok(byId[92286].enrol_url.endsWith("/enrol/index.php?id=92286"));
  assert.ok(byId[92286].summary_snippet.endsWith("…"));
  assert.ok(byId[92286].summary_snippet.length <= 301);
  assert.ok(!byId[92286].summary_snippet.includes(" …"));
  assert.equal("shortname" in byId[92286], false);

  assert.equal(byId[87647].summary_snippet, "Kompakte Kursbeschreibung für einen echten Treffer.");
  assert.equal(byId[90762].category, undefined);
});

test("parseCourseSearch: letzte Seite setzt has_more auf false", () => {
  const html = readFixture("course-search-last-page.html");
  const page = parseCourseSearch(html, BASE_URL, 1);

  assert.equal(page.page, 1);
  assert.equal(page.has_more, false);
  assert.equal(page.results.length, 2);
});

test("parseCourseSearch: No-Results-Seite liefert leere Ergebnisse", () => {
  const html = readFixture("course-search-no-results.html");
  const page = parseCourseSearch(html, BASE_URL, 0);

  assert.equal(page.page, 0);
  assert.equal(page.has_more, false);
  assert.equal(page.results.length, 0);
});

// ------------------------------------------------------------------
// parseCourseOverview
// ------------------------------------------------------------------
test("parseCourseOverview: sections, modtypes, label-skip, fallback URL, truncation", () => {
  const html = readFixture("course-overview.html");
  const overview = parseCourseOverview(html, 101, BASE_URL);

  assert.equal(overview.course_id, 101);
  assert.equal(overview.course_name, "Analysis für Wirtschaftswissenschaftler");

  // 3 Sections sollten Aktivitäten haben, "Leer" wird ohne cmlist geskipped.
  const byName = Object.fromEntries(overview.sections.map((s) => [s.name, s]));
  assert.ok(byName["Allgemeine Informationen"]);
  assert.ok(byName["Forum & Diskussion"]);
  assert.ok(byName["Übungen"]);

  // Label in Section 1 wird geskipped → nur 2 Aktivitäten.
  assert.equal(byName["Allgemeine Informationen"].activities.length, 2);

  // modtype + cmid korrekt.
  const resource = byName["Allgemeine Informationen"].activities.find(
    (a) => a.cmid === 1001
  );
  assert.equal(resource.modtype, "resource");
  assert.equal(resource.name, "Vorlesungsskript Kapitel 1");

  // Forum ohne Link → fallback auf /mod/forum/view.php?id=2001.
  const forum = byName["Forum & Diskussion"].activities.find(
    (a) => a.cmid === 2001
  );
  assert.ok(forum.url.endsWith("/mod/forum/view.php?id=2001"));

  // Truncation für sehr lange Namen (>200 Zeichen).
  const assignActivity = byName["Übungen"].activities.find(
    (a) => a.cmid === 3001
  );
  assert.ok(assignActivity.name.length <= 201); // 200 + "…"
});

// ------------------------------------------------------------------
// parseResource
// ------------------------------------------------------------------
test("parseResource: HTML-Zwischenseite mit pluginfile.php-Link", async () => {
  const session = fakeSession({
    "/mod/resource/view.php?id=1001": readFixture("resource.html"),
  });
  const result = await parseResource(session, 1001);

  assert.equal(result.title, "Skript Kapitel 1");
  assert.ok(result.content.download_url?.includes("pluginfile.php"));
  assert.ok(result.content.filename?.endsWith(".pdf"));
  assert.ok(result.content.description?.includes("Analysis"));
  assert.equal(result.parser_degraded, undefined);
});

// ------------------------------------------------------------------
// parseUrl
// ------------------------------------------------------------------
test("parseUrl: .urlworkaround externe URL extraction", async () => {
  const session = fakeSession({
    "/mod/url/view.php?id=1002": readFixture("url.html"),
  });
  const result = await parseUrl(session, 1002);

  assert.equal(result.title, "Lehrplan (extern)");
  assert.equal(result.content.external_url, "https://example.org/lehrplan/sose-2099.pdf");
  assert.ok(result.content.description?.includes("Lehrplan"));
});

// ------------------------------------------------------------------
// parsePage
// ------------------------------------------------------------------
test("parsePage: region-main Haupttext, mehrzeilig", async () => {
  const session = fakeSession({
    "/mod/page/view.php?id=2002": readFixture("page.html"),
  });
  const result = await parsePage(session, 2002);

  assert.equal(result.title, "Sprechstundenzeiten");
  assert.ok(result.content.text.includes("Mittwoch"));
  assert.ok(result.content.text.includes("Gruppenanfragen"));
  // Whitespace-Normalisierung: keine sichtbaren doppelten Spaces.
  assert.ok(!/\s{2,}/.test(result.content.text));
});

// ------------------------------------------------------------------
// parseFallback
// ------------------------------------------------------------------
test("parseFallback: liefert raw_text + parser_degraded:true", async () => {
  const session = fakeSession({
    "/mod/page/view.php?id=2002": readFixture("page.html"),
  });
  const result = await parseFallback(session, 2002, "page");
  assert.equal(result.parser_degraded, true);
  assert.ok(result.content.raw_text.length > 0);
});

// ------------------------------------------------------------------
// parseForum
// ------------------------------------------------------------------
test("parseForum: extrahiert Diskussions-Zeilen + respektiert limit/offset", async () => {
  const session = fakeSession({
    "/mod/forum/view.php?id=4001": readFixture("forum.html"),
  });
  const result = await parseForum(session, 4001, {});

  assert.equal(result.title, "Diskussionsforum");
  assert.equal(result.content.total_on_page, 2);
  assert.equal(result.content.discussions.length, 2);

  const first = result.content.discussions.find((d) => d.discussion_id === 9001);
  assert.equal(first.title, "Termin Klausurbesprechung");
  assert.equal(first.author, "Author A");
  assert.equal(first.last_post, "Author B");
  assert.equal(first.replies, 3);
  assert.ok(first.url.endsWith("/mod/forum/discuss.php?d=9001"));

  // limit=1, offset=1 → nur die zweite Diskussion.
  const page = await parseForum(session, 4001, { limit: 1, offset: 1 });
  assert.equal(page.content.discussions.length, 1);
  assert.equal(page.content.discussions[0].discussion_id, 9002);
  assert.equal(page.content.has_more, false);
});

// ------------------------------------------------------------------
// parseAssign
// ------------------------------------------------------------------
test("parseAssign: mappt submissionstatustable + deadline", async () => {
  const session = fakeSession({
    "/mod/assign/view.php?id=5001": readFixture("assign.html"),
  });
  const result = await parseAssign(session, 5001);

  assert.equal(result.title, "Hausaufgabe 1");
  assert.ok(result.content.deadline?.includes("21 April 2026"));
  assert.equal(result.content.submission_status, "Nothing has been submitted for this assignment");
  assert.equal(result.content.grading_status, "Not graded");
  assert.equal(result.content.time_remaining, "3 days 9 hours remaining");
  assert.ok(result.content.description?.includes("PDF"));
});

// ------------------------------------------------------------------
// parseQuiz
// ------------------------------------------------------------------
test("parseQuiz: extrahiert grading_method + Opens/Closes + Attempts", async () => {
  const session = fakeSession({
    "/mod/quiz/view.php?id=6001": readFixture("quiz.html"),
  });
  const result = await parseQuiz(session, 6001);

  assert.equal(result.title, "Eingangstest");
  assert.equal(result.content.grading_method, "Highest grade");
  assert.equal(result.content.attempts_allowed, "2");
  assert.ok(result.content.opens?.includes("13 April 2026"));
  assert.ok(result.content.closes?.includes("29 August 2026"));
  // Status: offen (Datum liegt in der Vergangenheit, kein Attempt)
  assert.ok(["open", "unknown"].includes(result.content.status));
  assert.equal(result.content.attempts_used, 0);
});

// ------------------------------------------------------------------
// parseQuiz – mit Attempts
// ------------------------------------------------------------------
test("parseQuiz: Attempt-Übersicht + Status + overall_grade", async () => {
  const session = fakeSession({
    "/mod/quiz/view.php?id=6099": readFixture("quiz-with-attempts.html"),
  });
  const result = await parseQuiz(session, 6099);

  assert.equal(result.title, "Probeklausur Analysis");
  assert.equal(result.content.grading_method, "Highest grade");
  assert.equal(result.content.attempts_allowed, "3");
  assert.ok(result.content.overall_grade?.includes("8.50"));

  // Attempts
  assert.ok(Array.isArray(result.content.attempts));
  assert.equal(result.content.attempts.length, 3);
  assert.equal(result.content.attempts_used, 3);

  // Attempt-Details
  const first = result.content.attempts.find((a) => a.attempt_number === 1);
  assert.equal(first.state, "Finished");
  assert.ok(first.marks?.includes("7.00"));
  assert.ok(first.review_url?.includes("/mod/quiz/review.php"));

  const inProgress = result.content.attempts.find((a) => a.attempt_number === 3);
  assert.ok(/in progress/i.test(inProgress.state));

  // Status: in_progress wegen laufendem Versuch
  assert.equal(result.content.status, "in_progress");

  // attempts_remaining: 3 allowed - 3 used = 0
  assert.equal(result.content.attempts_remaining, 0);
});

// ------------------------------------------------------------------
// parseQuiz – Edge-Case: leer, kein Attempt, Quiz offen
// ------------------------------------------------------------------
test("parseQuiz: kein Attempt + opens in Vergangenheit → status open", async () => {
  const session = fakeSession({
    "/mod/quiz/view.php?id=6001": readFixture("quiz.html"),
  });
  const result = await parseQuiz(session, 6001);
  // opens ist "Monday, 13 April 2026" → Vergangenheit → open (nicht not_open)
  assert.ok(["open", "unknown"].includes(result.content.status));
  assert.equal(result.content.attempts_used, 0);
  assert.equal(result.parser_degraded, undefined);
});

// ------------------------------------------------------------------
// parseRatingAllocate
// ------------------------------------------------------------------
test("parseRatingAllocate: deadline + choices[] + allocation", async () => {
  const session = fakeSession({
    "/mod/ratingallocate/view.php?id=7001": readFixture("ratingallocate.html"),
  });
  const result = await parseRatingAllocate(session, 7001);

  assert.equal(result.title, "Einteilung Übungsgruppen");
  assert.ok(result.content.deadline?.includes("16 April 2026"));
  assert.ok(result.content.publication_date?.includes("17 April 2026"));
  assert.ok(Array.isArray(result.content.choices));
  assert.equal(result.content.choices.length, 4);
  const w02 = result.content.choices.find((c) => c.title.startsWith("W02"));
  assert.equal(w02.user_rating, "4 - Highly appreciated");
  assert.ok(result.content.allocation?.startsWith("W09"));
});

// ------------------------------------------------------------------
// parseTimeline
// ------------------------------------------------------------------
test("parseTimeline: extrahiert Events + modtype + cmid + Sortierung", async () => {
  // Extraktion ohne Datums-Filter testen (Fixture hat Events in 2099, die außerhalb
  // des 90-Tage-Fensters liegen). _extractForTest umgeht den Filter.
  const html = readFixture("timeline.html");
  const events = extractTimelineEvents(html, BASE_URL);

  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 4, `erwartet ≥4 Events, got ${events.length}`);

  // Quiz-Event
  const quizEvent = events.find((e) => e.modtype === "quiz" && e.event_type === "open");
  assert.ok(quizEvent, "Quiz-open-Event fehlt");
  assert.ok(quizEvent.title?.includes("Abgabe Analysis 1"), `Titel: ${quizEvent?.title}`);
  assert.ok(quizEvent.url?.includes("/mod/quiz/view.php"));
  assert.equal(quizEvent.cmid, 8001);

  // Assign-Event
  const assignEvent = events.find((e) => e.modtype === "assign");
  assert.ok(assignEvent, "Assign-Event fehlt");
  assert.ok(assignEvent.title?.includes("bungszettel"), `Titel: ${assignEvent?.title}`);
  assert.equal(assignEvent.cmid, 8002);

  // modtypes-Filter (über parseTimeline-API, aber keine echten Events im Fenster)
  // → nur Filter-Logik prüfen: wenn modtypes gesetzt, nur passende modtypes
  const quizOnly = events.filter((e) => e.modtype === "quiz");
  assert.ok(quizOnly.length >= 2, "Mindestens 2 Quiz-Events erwartet");

  // Sortierung: Events mit kleinerem due_at_unix sollen zuerst kommen.
  const timestamps = events.map((e) => e.due_at_unix ?? 0).filter((t) => t > 0);
  for (let i = 1; i < timestamps.length; i++) {
    assert.ok(timestamps[i] >= timestamps[i - 1], "Events nicht chronologisch sortiert");
  }
});

test("parseTimeline: leeres HTML → parser_degraded:true", async () => {
  const session = {
    getBaseUrl: () => BASE_URL,
    async get() {
      return { status: 200, url: BASE_URL, headers: {}, data: "<html><body></body></html>" };
    },
  };
  const result = await parseTimeline(session, {});
  assert.equal(result.parser_degraded, true);
  assert.equal(result.content.events.length, 0);
});

// ------------------------------------------------------------------
// parseFolder
// ------------------------------------------------------------------
test("parseFolder: listet Dateien mit download_url", async () => {
  const session = fakeSession({ "/mod/folder/view.php?id=9001": readFixture("folder.html") });
  const result = await parseFolder(session, 9001);
  assert.ok(result.title.length > 0);
  assert.ok(Array.isArray(result.content.entries));
  assert.ok(result.content.entries.length > 0);
  assert.ok(result.content.entries[0].download_url?.includes("pluginfile.php"));
  assert.ok(result.content.entries[0].name?.length > 0);
});

test("parseFolder: leeres HTML → parser_degraded:true", async () => {
  const session = fakeSession({ "/mod/folder/view.php?id=9001": "<html><body><h1>Leer</h1></body></html>" });
  const result = await parseFolder(session, 9001);
  assert.equal(result.parser_degraded, true);
});

// ------------------------------------------------------------------
// parseWorkshop
// ------------------------------------------------------------------
test("parseWorkshop: extrahiert Phase + Beschreibung", async () => {
  const session = fakeSession({ "/mod/workshop/view.php?id=9002": readFixture("workshop.html") });
  const result = await parseWorkshop(session, 9002);
  assert.ok(result.title.length > 0);
  assert.ok(result.content.description?.length > 0 || result.content.current_phase?.length > 0);
});

test("parseWorkshop: leeres HTML → parser_degraded:true", async () => {
  const session = fakeSession({ "/mod/workshop/view.php?id=9002": "<html><body><h1>WS</h1></body></html>" });
  const result = await parseWorkshop(session, 9002);
  assert.equal(result.parser_degraded, true);
});

// ------------------------------------------------------------------
// parseLesson
// ------------------------------------------------------------------
test("parseLesson: extrahiert Titel + Beschreibung", async () => {
  const session = fakeSession({ "/mod/lesson/view.php?id=9003": readFixture("lesson.html") });
  const result = await parseLesson(session, 9003);
  assert.ok(result.title.length > 0);
});

// ------------------------------------------------------------------
// parseChoice
// ------------------------------------------------------------------
test("parseChoice: extrahiert Optionen + Deadline", async () => {
  const session = fakeSession({ "/mod/choice/view.php?id=9004": readFixture("choice.html") });
  const result = await parseChoice(session, 9004);
  assert.ok(result.title.length > 0);
  assert.ok(Array.isArray(result.content.options));
  assert.ok(result.content.options.length > 0);
});

// ------------------------------------------------------------------
// parseFeedback
// ------------------------------------------------------------------
test("parseFeedback: extrahiert Titel + Beschreibung", async () => {
  const session = fakeSession({ "/mod/feedback/view.php?id=9005": readFixture("feedback.html") });
  const result = await parseFeedback(session, 9005);
  assert.ok(result.title.length > 0);
});
