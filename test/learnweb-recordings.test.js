const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(ROOT, "test/fixtures/learnweb");
const {
  isMediaUrl,
  parseDurationText,
  parseOpencastList,
  parseOpencastEpisode,
  extractRecordings,
} = require(path.join(ROOT, "dist/learnweb/parsers/recordings"));

const BASE_URL = "https://learnweb.example.com";

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

// Stand-in für LearnwebSession (nur get + getBaseUrl werden genutzt).
function fakeSession(pathToHtml) {
  return {
    getBaseUrl: () => BASE_URL,
    async hasMoodleCookie() {
      return true;
    },
    async get(p) {
      const html = pathToHtml[p];
      if (html === undefined) throw new Error(`FakeSession: no fixture for ${p}`);
      return { status: 200, url: BASE_URL + p, headers: {}, data: html };
    },
  };
}

// ── reine Helfer ─────────────────────────────────────────────────────────
test("isMediaUrl: erkennt Video/Audio, lehnt Dokumente ab", () => {
  assert.ok(isMediaUrl("https://x/y/Vorlesung.mp4"));
  assert.ok(isMediaUrl("https://x/y/Aufnahme.mp3?forcedownload=1"));
  assert.ok(isMediaUrl("https://x/y/a.m4a"));
  assert.ok(!isMediaUrl("https://x/y/Folien.pdf"));
  assert.ok(!isMediaUrl("https://x/y/code.ipynb"));
});

test("parseDurationText: hh:mm:ss / mm:ss / s", () => {
  assert.equal(parseDurationText("1:50:00"), 6600);
  assert.equal(parseDurationText("45:30"), 2730);
  assert.equal(parseDurationText("90"), 90);
  assert.equal(parseDurationText(undefined), undefined);
  assert.equal(parseDurationText("abc"), undefined);
});

test("parseOpencastList: Episoden mit UUID/Titel/Dauer, Lang-Links dedupliziert", () => {
  const eps = parseOpencastList(readFixture("opencast-list.html"), BASE_URL);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].episodeId, "04d797da-9f60-4a3d-9a97-690d75014983");
  assert.equal(eps[0].title, "Vorlesung 1 — Einführung");
  assert.equal(eps[0].durationText, "1:50:00");
  assert.match(eps[0].detailUrl, /e=04d797da/);
});

test("parseOpencastEpisode: extrahiert JSON-escaped mp4-URLs + Dauer", () => {
  const { mp4Urls, durationSeconds } = parseOpencastEpisode(readFixture("opencast-episode.html"));
  assert.equal(mp4Urls.length, 2);
  assert.ok(mp4Urls[0].startsWith("https://ele-cdn.example.com/"));
  assert.ok(mp4Urls[0].endsWith("concat.mp4"));
  assert.ok(!mp4Urls[0].includes("\\")); // entescaped
  assert.equal(durationSeconds, 2166);
});

test("parseOpencastEpisode: erkennt direkte window.episode-Metadaten", () => {
  const parsed = parseOpencastEpisode(readFixture("opencast-direct-episode.html"));
  assert.equal(parsed.mp4Urls.length, 1);
  assert.equal(parsed.episodeId, "28308471-10a0-444b-b5c3-d5572f570161");
  assert.equal(parsed.title, "Rechnungswesen SoSe 2026 (BWL2) - Vorlesung 1");
  assert.equal(parsed.durationSeconds, 7977);
});

// ── extractRecordings ──────────────────────────────────────────────────────
test("extractRecordings (opencast): eine Quelle je Episode, ele-cdn, kein Auth", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=99": readFixture("opencast-list.html"),
    "/mod/opencast/view.php?id=99&e=04d797da-9f60-4a3d-9a97-690d75014983": readFixture("opencast-episode.html"),
    "/mod/opencast/view.php?id=99&e=443e9f31-481f-4ce8-88a3-ec456d1c0847": readFixture("opencast-episode.html"),
  });
  const sources = await extractRecordings(session, { cmid: 99, modtype: "opencast", name: "eLectures Videos", url: "" });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].kind, "opencast");
  assert.equal(sources[0].needsAuth, false);
  assert.equal(sources[0].episodeId, "04d797da-9f60-4a3d-9a97-690d75014983");
  assert.equal(sources[0].discriminator, "04d797da-9f60-4a3d-9a97-690d75014983");
  assert.equal(sources[0].durationSeconds, 2166);
  assert.match(sources[0].mediaUrl, /ele-cdn.*concat\.mp4$/);
});

test("extractRecordings (opencast): direkte Episode ohne &e=-Liste", async () => {
  const session = fakeSession({
    "/mod/opencast/view.php?id=4076395": readFixture("opencast-direct-episode.html"),
  });
  const sources = await extractRecordings(session, {
    cmid: 4076395,
    modtype: "opencast",
    name: "Rechnungswesen SoSe 2026 (BWL2) - Vorlesung 1",
    url: "",
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].episodeId, "28308471-10a0-444b-b5c3-d5572f570161");
  assert.equal(sources[0].discriminator, "28308471-10a0-444b-b5c3-d5572f570161");
  assert.equal(sources[0].durationSeconds, 7977);
  assert.equal(sources[0].needsAuth, false);
  assert.match(sources[0].mediaUrl, /ele-cdn.*concat\.mp4$/);
});

test("extractRecordings (resource mp4): file-Quelle mit Auth", async () => {
  const session = fakeSession({ "/mod/resource/view.php?id=456": readFixture("resource-video.html") });
  const sources = await extractRecordings(session, { cmid: 456, modtype: "resource", name: "31.10.2025 Recording", url: "" });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "file");
  assert.equal(sources[0].needsAuth, true);
  assert.match(sources[0].mediaUrl, /\.mp4$/);
  assert.equal(sources[0].title, "31.10.2025 Recording");
});

test("extractRecordings (folder): nur Medien, PDFs gefiltert", async () => {
  const session = fakeSession({ "/mod/folder/view.php?id=789": readFixture("folder-recordings.html") });
  const sources = await extractRecordings(session, { cmid: 789, modtype: "folder", name: "Audio Recordings 2025", url: "" });
  assert.equal(sources.length, 2);
  assert.ok(sources.every((s) => /\.mp3/.test(s.mediaUrl)));
  assert.ok(sources.every((s) => s.kind === "file" && s.needsAuth));
});

test("extractRecordings (unbekannter modtype): keine Quelle", async () => {
  const sources = await extractRecordings(fakeSession({}), { cmid: 1, modtype: "quiz", name: "Test", url: "" });
  assert.deepEqual(sources, []);
});
