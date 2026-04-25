/**
 * Degradation-Tests: wenn eine Fixture keine der erwarteten Selektoren
 * matcht, sollen die Parser weder crashen noch eine leere Struktur liefern,
 * sondern parser_degraded:true + (wenn möglich) raw_text setzen.
 *
 * Timeline-spezifisch: parseTimeline und parseCalendarMonth werfen jetzt
 * LearnwebParseError / LearnwebUpstreamError statt parser_degraded:true zu setzen.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "test/fixtures/learnweb");

const { parseCourseOverview } = require(path.join(ROOT, "dist/learnweb/parsers/overview"));
const { parseForum } = require(path.join(ROOT, "dist/learnweb/parsers/forum"));
const { parseAssign } = require(path.join(ROOT, "dist/learnweb/parsers/assign"));
const { parseQuiz } = require(path.join(ROOT, "dist/learnweb/parsers/quiz"));
const { parseRatingAllocate } = require(path.join(ROOT, "dist/learnweb/parsers/ratingallocate"));
const { parseFallback } = require(path.join(ROOT, "dist/learnweb/parsers/fallback"));
const { parseTimeline, parseCalendarMonth } = require(path.join(ROOT, "dist/learnweb/parsers/timeline"));
const { LearnwebParseError, LearnwebUpstreamError } = require(path.join(ROOT, "dist/learnweb/session"));

const BASE_URL = "https://learnweb.example.com";

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function fakeSession(html, requestedPath) {
  return {
    getBaseUrl: () => BASE_URL,
    async hasMoodleCookie() { return true; },
    async get(p) {
      if (requestedPath && p !== requestedPath) {
        throw new Error(`FakeSession: unerwarteter Pfad ${p}`);
      }
      return { status: 200, url: BASE_URL + p, headers: {}, data: html };
    },
  };
}

function fakeSessionWithStatus(status, html = "") {
  return {
    getBaseUrl: () => BASE_URL,
    async hasMoodleCookie() { return false; },
    async get(p) {
      return { status, url: BASE_URL + p, headers: {}, data: html };
    },
  };
}

test("course-overview: fehlende data-activityname → leere activities, kein crash", () => {
  const html = `
    <html><body><section id="region-main">
      <li class="section course-section" data-sectionname="Broken">
        <ul data-for="cmlist">
          <li data-for="cmitem" data-id="7777" class="activity resource modtype_resource">
            <!-- Kein div[data-activityname] und kein aalink -->
          </li>
        </ul>
      </li>
    </section></body></html>
  `;
  const overview = parseCourseOverview(html, 999, BASE_URL);
  // Section sollte vorhanden sein, aber keine usable activity haben
  // (oder mit fallback-Name "activity 7777"). Wir verlangen zumindest
  // kein undefined/crash.
  assert.equal(overview.course_id, 999);
  assert.ok(Array.isArray(overview.sections));
});

test("forum: ohne discussion-list-Tabelle → parser_degraded:true", async () => {
  const html = `<html><body><h1>Leeres Forum</h1><p>Keine Diskussionen.</p></body></html>`;
  const session = fakeSession(html, "/mod/forum/view.php?id=1234");
  const result = await parseForum(session, 1234);
  assert.equal(result.parser_degraded, true);
  assert.equal(result.content.discussions.length, 0);
  assert.equal(result.content.total_on_page, 0);
});

test("assign: ohne submissionstatustable und ohne description → parser_degraded:true", async () => {
  const html = `<html><body><h1>Assignment ohne alles</h1></body></html>`;
  const session = fakeSession(html, "/mod/assign/view.php?id=5555");
  const result = await parseAssign(session, 5555);
  assert.equal(result.parser_degraded, true);
});

test("quiz: leere Info-Seite → parser_degraded:true", async () => {
  const html = `<html><body><h1>Quiz ohne Metadaten</h1></body></html>`;
  const session = fakeSession(html, "/mod/quiz/view.php?id=6666");
  const result = await parseQuiz(session, 6666);
  assert.equal(result.parser_degraded, true);
});

test("ratingallocate: leere Fixture → parser_degraded:true", async () => {
  const html = `<html><body><h1>Nichts da</h1></body></html>`;
  const session = fakeSession(html, "/mod/ratingallocate/view.php?id=7777");
  const result = await parseRatingAllocate(session, 7777);
  assert.equal(result.parser_degraded, true);
});

test("fallback: liefert immer parser_degraded:true, auch für bekannte Seiten", async () => {
  const html = `<html><body><main><h1>Irgendein Modtype</h1><p>Text</p></main></body></html>`;
  const session = fakeSession(html, "/mod/unknownmod/view.php?id=4242");
  const result = await parseFallback(session, 4242, "unknownmod");
  assert.equal(result.parser_degraded, true);
  assert.ok(result.content.raw_text.length > 0);
});

// ------------------------------------------------------------------
// parseTimeline: Throw-Verhalten
// ------------------------------------------------------------------
test("parseTimeline: wirft LearnwebParseError wenn Container fehlt", async () => {
  const session = fakeSession(
    readFixture("timeline-empty-degraded.html"),
    "/calendar/view.php?view=upcoming"
  );
  await assert.rejects(
    () => parseTimeline(session, {}),
    (err) => {
      assert.ok(err instanceof LearnwebParseError, `Erwartet LearnwebParseError, bekam ${err?.name}`);
      return true;
    }
  );
});

test("parseTimeline: wirft LearnwebUpstreamError bei non-2xx Response", async () => {
  const session = fakeSessionWithStatus(503);
  await assert.rejects(
    () => parseTimeline(session, {}),
    (err) => {
      assert.ok(err instanceof LearnwebUpstreamError, `Erwartet LearnwebUpstreamError, bekam ${err?.name}`);
      return true;
    }
  );
});

// ------------------------------------------------------------------
// parseCalendarMonth: Throw-Verhalten
// ------------------------------------------------------------------
test("parseCalendarMonth: wirft LearnwebParseError wenn Container fehlt", async () => {
  const session = {
    getBaseUrl: () => BASE_URL,
    async hasMoodleCookie() { return true; },
    async get() {
      return {
        status: 200,
        url: BASE_URL + "/calendar/view.php?view=month&time=123",
        headers: {},
        data: readFixture("timeline-empty-degraded.html"),
      };
    },
  };
  await assert.rejects(
    () => parseCalendarMonth(session, { year: 2026, month: 5 }),
    (err) => {
      assert.ok(err instanceof LearnwebParseError, `Erwartet LearnwebParseError, bekam ${err?.name}`);
      return true;
    }
  );
});
