const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "test/fixtures/learnweb");
const { _testing } = require(path.join(ROOT, "dist/tools/learnweb"));

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

test("search-courses: buildCourseSearchPath lässt page=0 weg", () => {
  const pathValue = _testing.buildCourseSearchPath("Data Science", 0, 25);
  const params = new URL(pathValue, "https://learnweb.example.com").searchParams;
  assert.ok(pathValue.startsWith("/course/search.php?"));
  assert.equal(params.get("search"), "Data Science");
  assert.equal(params.get("perpage"), "25");
  assert.equal(params.has("page"), false);
});

test("search-courses: buildCourseSearchPath ergänzt page > 0", () => {
  const pathValue = _testing.buildCourseSearchPath("Wirtschaftsinformatik", 2, 10);
  const params = new URL(pathValue, "https://learnweb.example.com").searchParams;
  assert.equal(params.get("search"), "Wirtschaftsinformatik");
  assert.equal(params.get("perpage"), "10");
  assert.equal(params.get("page"), "2");
});

test("search-courses: legitimer Empty State wird erkannt", () => {
  const analysis = _testing.analyzeCourseSearchHtml(
    readFixture("course-search-no-results.html")
  );

  assert.equal(analysis.hasRegionMain, true);
  assert.equal(analysis.hasNoResultsMarker, true);
  assert.equal(analysis.isValidEmptyState, true);
});

test("search-courses: Drift ohne Marker wird erkannt", () => {
  const analysis = _testing.analyzeCourseSearchHtml(`
    <html><body>
      <section id="region-main">
        <div id="region-main-body">
          <h2>Suchergebnisse: 0</h2>
          <p>Unbekannte Struktur ohne Ergebniscontainer.</p>
        </div>
      </section>
    </body></html>
  `);

  assert.equal(analysis.hasRegionMain, true);
  assert.equal(analysis.hasNoResultsMarker, false);
  assert.equal(analysis.isValidEmptyState, false);
});

test("search-courses: 16. Aufruf im Window blockiert, danach Recovery", () => {
  _testing.resetSearchRateLimitForTests();

  for (let i = 0; i < 15; i++) {
    const result = _testing.checkSearchRateLimit(0);
    assert.equal(result.ok, true);
  }

  const blocked = _testing.checkSearchRateLimit(0);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSeconds, 30);

  const recovered = _testing.checkSearchRateLimit(30_001);
  assert.equal(recovered.ok, true);

  _testing.resetSearchRateLimitForTests();
});
