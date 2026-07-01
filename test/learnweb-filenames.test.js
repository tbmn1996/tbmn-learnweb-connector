const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { buildRecordingFilename } = require(path.join(ROOT, "dist/learnweb/filenames"));

function recording(overrides) {
  return {
    cmid: 501,
    title: "Vorlesung 1",
    episode_id: "04d797da-9f60-4a3d-9a97-690d75014983",
    media_url: "https://ele-cdn.example.com/x/concat.mp4",
    recorded_at: null,
    source_url: "https://learnweb.example.com/mod/opencast/view.php?id=501",
    ...overrides,
  };
}

test("buildRecordingFilename: Normalfall — Slug + .mp4, keine Kollision", () => {
  const name = buildRecordingFilename(recording(), new Set());
  assert.equal(name, "vorlesung-1.mp4");
});

test("buildRecordingFilename: Slugifiziert Sonderzeichen/Leerzeichen/Umlaute", () => {
  const name = buildRecordingFilename(
    recording({ title: "Vorlesung 1 — Einführung!! & Übung??" }),
    new Set()
  );
  assert.match(name, /^[a-z0-9-]+\.mp4$/);
  assert.ok(!name.includes("--"));
  assert.ok(!name.startsWith("-"));
  assert.equal(name.startsWith("vorlesung-1"), true);
});

test("buildRecordingFilename: Kollision → episode_id-Diskriminator (erste 8 Zeichen)", () => {
  const used = new Set(["vorlesung-1.mp4"]);
  const name = buildRecordingFilename(
    recording({ episode_id: "04d797da-9f60-4a3d-9a97-690d75014983" }),
    used
  );
  assert.equal(name, "vorlesung-1-04d797da.mp4");
});

test("buildRecordingFilename: Kollision ohne episode_id → numerischer Zähler", () => {
  const used = new Set(["vorlesung-1.mp4"]);
  const name = buildRecordingFilename(recording({ episode_id: null }), used);
  assert.equal(name, "vorlesung-1-2.mp4");
});

test("buildRecordingFilename: Kollision auch mit episode_id-Diskriminator belegt → Zähler-Fallback", () => {
  const used = new Set(["vorlesung-1.mp4", "vorlesung-1-04d797da.mp4"]);
  const name = buildRecordingFilename(
    recording({ episode_id: "04d797da-9f60-4a3d-9a97-690d75014983" }),
    used
  );
  assert.equal(name, "vorlesung-1-2.mp4");
});

test("buildRecordingFilename: Zähler zählt hoch bis freier Name gefunden wird", () => {
  const used = new Set(["vorlesung-1.mp4", "vorlesung-1-2.mp4", "vorlesung-1-3.mp4"]);
  const name = buildRecordingFilename(recording({ episode_id: null }), used);
  assert.equal(name, "vorlesung-1-4.mp4");
});

test("buildRecordingFilename: leerer Titel → cmid-Fallback", () => {
  const name = buildRecordingFilename(recording({ title: "", cmid: 4076395 }), new Set());
  assert.equal(name, "recording-4076395.mp4");
});

test("buildRecordingFilename: Titel nur aus Sonderzeichen → cmid-Fallback", () => {
  const name = buildRecordingFilename(recording({ title: "!!!???", cmid: 42 }), new Set());
  assert.equal(name, "recording-42.mp4");
});

test("buildRecordingFilename: liest usedNames nur, fügt selbst nichts hinzu", () => {
  const used = new Set();
  buildRecordingFilename(recording(), used);
  assert.equal(used.size, 0);
});
