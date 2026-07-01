const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "test/fixtures/learnweb");
const {
  parseWindowEpisode,
  parseLegacyEpisodeList,
  parseOpencastEpisodes,
  discoverActivityRecordings,
  discoverCourseRecordings,
} = require(path.join(ROOT, "dist/learnweb/parsers/recordings"));

const BASE_URL = "https://learnweb.example.com";

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

function withMutedConsole(fn) {
  const originalError = console.error;
  console.error = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = originalError;
    });
}

// Stand-in für LearnwebSession (nur get + getBaseUrl werden genutzt).
// `pathToResponse` mappt Pfad/URL → HTML-String ODER eine Funktion, die
// (bei Aufruf) entweder einen String zurückgibt oder wirft (für Fehlerpfade).
function fakeSession(pathToResponse) {
  return {
    getBaseUrl: () => BASE_URL,
    async get(p) {
      const entry = pathToResponse[p];
      if (entry === undefined) throw new Error(`FakeSession: no fixture for ${p}`);
      if (typeof entry === "function") return entry();
      if (entry.status !== undefined) return entry;
      return { status: 200, url: BASE_URL + p, headers: {}, data: entry };
    },
  };
}

// ── parseWindowEpisode ─────────────────────────────────────────────────
test("parseWindowEpisode: erkennt window.episode-Objektliteral (direkte Episode)", () => {
  const episodes = parseWindowEpisode(readFixture("opencast-direct-episode.html"), BASE_URL);
  assert.equal(episodes.length, 1);
  const ep = episodes[0];
  assert.equal(ep.episodeId, "28308471-10a0-444b-b5c3-d5572f570161");
  assert.equal(ep.title, "Rechnungswesen SoSe 2026 (BWL2) - Vorlesung 1");
  assert.ok(ep.mediaUrl.startsWith("https://ele-cdn.example.com/"));
  assert.ok(ep.mediaUrl.endsWith("concat.mp4"));
  assert.ok(!ep.mediaUrl.includes("\\"));
  // Fixture enthält keinen created/start-Zeitstempel — recordedAt darf NICHT geraten werden.
  assert.equal(ep.recordedAt, null);
});

test("parseWindowEpisode: Titel-/ID-Fallback bei minimalem window.episode", () => {
  const episodes = parseWindowEpisode(
    readFixture("opencast-direct-episode-minimal.html"),
    BASE_URL
  );
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].title, null);
  assert.equal(episodes[0].episodeId, null);
  assert.ok(episodes[0].mediaUrl.endsWith("concat.mp4"));
});

test("parseWindowEpisode: liefert [] wenn kein window.episode vorhanden (altes amd.init-Format)", () => {
  assert.deepEqual(parseWindowEpisode(readFixture("opencast-episode.html"), BASE_URL), []);
});

test("parseWindowEpisode: liefert [] auf einer reinen Episodenlisten-Seite", () => {
  assert.deepEqual(parseWindowEpisode(readFixture("opencast-list.html"), BASE_URL), []);
});

// ── parseLegacyEpisodeList ───────────────────────────────────────────────
test("parseLegacyEpisodeList: Episoden mit UUID/Titel, Sprach-Switch-Duplikate dedupliziert", () => {
  const episodes = parseLegacyEpisodeList(readFixture("opencast-list.html"), BASE_URL);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].episodeId, "04d797da-9f60-4a3d-9a97-690d75014983");
  assert.equal(episodes[0].title, "Vorlesung 1 — Einführung");
  assert.equal(episodes[0].mediaUrl, null);
  assert.match(episodes[0].sourceUrl, /e=04d797da-9f60-4a3d-9a97-690d75014983/);
  assert.equal(episodes[1].episodeId, "443e9f31-481f-4ce8-88a3-ec456d1c0847");
  assert.equal(episodes[1].title, "Vorlesung 2 — Grundlagen");
});

test("parseLegacyEpisodeList: liefert [] auf einer direkten window.episode-Seite", () => {
  assert.deepEqual(parseLegacyEpisodeList(readFixture("opencast-direct-episode.html"), BASE_URL), []);
});

// ── parseOpencastEpisodes (Format-Erkennung) ─────────────────────────────
test("parseOpencastEpisodes: nutzt window.episode wenn vorhanden", () => {
  const episodes = parseOpencastEpisodes(readFixture("opencast-direct-episode.html"), BASE_URL);
  assert.equal(episodes.length, 1);
  assert.ok(episodes[0].mediaUrl);
});

test("parseOpencastEpisodes: fällt auf Legacy-Liste zurück wenn kein window.episode da ist", () => {
  const episodes = parseOpencastEpisodes(readFixture("opencast-list.html"), BASE_URL);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].mediaUrl, null);
});

// ── discoverActivityRecordings ───────────────────────────────────────────
test("discoverActivityRecordings: direkte Episode (window.episode) liefert 1 Recording", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=4076395": readFixture("opencast-direct-episode.html"),
  });
  const recordings = await discoverActivityRecordings(
    session,
    4076395,
    "/mod/opencast/view.php?id=4076395"
  );
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].cmid, 4076395);
  assert.equal(recordings[0].title, "Rechnungswesen SoSe 2026 (BWL2) - Vorlesung 1");
  assert.equal(recordings[0].episode_id, "28308471-10a0-444b-b5c3-d5572f570161");
  assert.ok(recordings[0].media_url.endsWith("concat.mp4"));
  assert.equal(recordings[0].recorded_at, null);
});

test("discoverActivityRecordings: minimale Episode nutzt Titel-Fallback `Recording <cmid>`", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=999": readFixture("opencast-direct-episode-minimal.html"),
  });
  const recordings = await discoverActivityRecordings(session, 999, "/mod/opencast/view.php?id=999");
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].title, "Recording 999");
  assert.equal(recordings[0].episode_id, null);
});

// Hinweis: opencast-list.html hardcodet "id=99" in den Episoden-Hrefs — das
// ist unabhängig vom cmid der Listen-Aktivität selbst, daher hier cmid=99
// verwenden, damit die sourceUrl-Keys im FakeSession-Mock treffen.
test("discoverActivityRecordings: Legacy-Liste lädt Detailseiten nach (amd.init-Fallback via mp4-Regex)", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=99": readFixture("opencast-list.html"),
    "https://learnweb.example.com/mod/opencast/view.php?id=99&e=04d797da-9f60-4a3d-9a97-690d75014983":
      readFixture("opencast-episode.html"),
    "https://learnweb.example.com/mod/opencast/view.php?id=99&e=443e9f31-481f-4ce8-88a3-ec456d1c0847":
      readFixture("opencast-episode.html"),
  });
  const recordings = await discoverActivityRecordings(session, 99, "/mod/opencast/view.php?id=99");
  assert.equal(recordings.length, 2);
  assert.equal(recordings[0].episode_id, "04d797da-9f60-4a3d-9a97-690d75014983");
  assert.equal(recordings[0].title, "Vorlesung 1 — Einführung");
  assert.ok(recordings[0].media_url.startsWith("https://ele-cdn.example.com/"));
  assert.ok(recordings[0].media_url.endsWith("concat.mp4"));
  assert.ok(!recordings[0].media_url.includes("\\"));
  assert.equal(recordings[0].recorded_at, null);
  assert.match(recordings[0].source_url, /e=04d797da/);
});

test("discoverActivityRecordings: Episoden ohne auflösbare mediaUrl werden ausgelassen", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=99": readFixture("opencast-list.html"),
    "https://learnweb.example.com/mod/opencast/view.php?id=99&e=04d797da-9f60-4a3d-9a97-690d75014983":
      "<html><body>keine Medien hier</body></html>",
    "https://learnweb.example.com/mod/opencast/view.php?id=99&e=443e9f31-481f-4ce8-88a3-ec456d1c0847":
      readFixture("opencast-episode.html"),
  });
  const recordings = await discoverActivityRecordings(session, 99, "/mod/opencast/view.php?id=99");
  // Nur die zweite Episode hat eine auflösbare mp4-URL.
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].episode_id, "443e9f31-481f-4ce8-88a3-ec456d1c0847");
});

test("discoverActivityRecordings: fehlschlagende Detailseite wird übersprungen, Rest bleibt", async () => {
  await withMutedConsole(async () => {
    const session = fakeSession({
      "/mod/opencast/view.php?id=99": readFixture("opencast-list.html"),
      "https://learnweb.example.com/mod/opencast/view.php?id=99&e=04d797da-9f60-4a3d-9a97-690d75014983":
        () => {
          throw new Error("network boom");
        },
      "https://learnweb.example.com/mod/opencast/view.php?id=99&e=443e9f31-481f-4ce8-88a3-ec456d1c0847":
        readFixture("opencast-episode.html"),
    });
    const recordings = await discoverActivityRecordings(session, 99, "/mod/opencast/view.php?id=99");
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].episode_id, "443e9f31-481f-4ce8-88a3-ec456d1c0847");
  });
});

test("discoverActivityRecordings: Non-2xx auf der Übersichtsseite liefert []", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=1": { status: 404, url: BASE_URL, headers: {}, data: "" },
  });
  const recordings = await discoverActivityRecordings(session, 1, "/mod/opencast/view.php?id=1");
  assert.deepEqual(recordings, []);
});

// ── discoverCourseRecordings ─────────────────────────────────────────────
test("discoverCourseRecordings: Non-2xx-Kursstatus liefert { error: true, message }", async () => {
  const session = fakeSession({
    "/course/view.php?id=42": { status: 404, url: BASE_URL, headers: {}, data: "" },
  });
  const outcome = await discoverCourseRecordings(session, 42);
  assert.deepEqual(outcome, { error: true, message: "Could not load course 42." });
});

test("discoverCourseRecordings: filtert nur modtype_opencast (resource wird ignoriert)", async () => {
  // parseCourseOverview löst activity.url bereits absolut auf — Keys müssen matchen.
  const session = fakeSession({
    "/course/view.php?id=777": readFixture("course-with-opencast.html"),
    "https://learnweb.example.com/mod/opencast/view.php?id=501": readFixture("opencast-direct-episode.html"),
    "https://learnweb.example.com/mod/opencast/view.php?id=502": readFixture(
      "opencast-direct-episode-minimal.html"
    ),
  });
  const outcome = await discoverCourseRecordings(session, 777);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.course_id, 777);
  assert.equal(outcome.course_name, "BWL2 Rechnungswesen");
  assert.equal(outcome.opencast_activities_found, 2);
  assert.equal(outcome.recordings.length, 2);
  assert.equal(outcome.parser_degraded, undefined);
  // Aktivität 503 (modtype_resource) darf nirgends als Recording auftauchen.
  assert.ok(outcome.recordings.every((r) => r.cmid === 501 || r.cmid === 502));
});

test("discoverCourseRecordings: fehlschlagende Aktivität setzt parser_degraded, Rest bleibt erhalten", async () => {
  await withMutedConsole(async () => {
    const session = fakeSession({
      "/course/view.php?id=777": readFixture("course-with-opencast.html"),
      "https://learnweb.example.com/mod/opencast/view.php?id=501": () => {
        throw new Error("upstream boom");
      },
      "https://learnweb.example.com/mod/opencast/view.php?id=502": readFixture(
        "opencast-direct-episode-minimal.html"
      ),
    });
    const outcome = await discoverCourseRecordings(session, 777);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.opencast_activities_found, 2);
    assert.equal(outcome.parser_degraded, true);
    assert.equal(outcome.recordings.length, 1);
    assert.equal(outcome.recordings[0].cmid, 502);
  });
});
