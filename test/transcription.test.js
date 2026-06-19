const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { slugify, buildTranscriptMarkdown } = require(path.join(ROOT, "dist/transcription/markdown"));
const {
  recordingKey,
  loadManifest,
  saveManifest,
  isDone,
  putEntry,
} = require(path.join(ROOT, "dist/transcription/manifest"));
const { parseWhisperJson, parseMlxWhisperJson, extractAudio, transcribeWav } = require(
  path.join(ROOT, "dist/transcription/transcriber")
);
const { downloadWithYtDlp } = require(path.join(ROOT, "dist/transcription/downloader"));

async function tmpDir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "lw-transcribe-"));
}

// ── markdown ────────────────────────────────────────────────────────────
test("slugify: transliteriert Umlaute/Akzente, säubert Sonderzeichen", () => {
  assert.equal(slugify("Vorlesung 1: Café & Größe"), "vorlesung-1-cafe-groesse");
  assert.equal(slugify("   "), "untitled");
});

test("buildTranscriptMarkdown: Frontmatter + Zeitstempel-Absatz", () => {
  const meta = {
    title: "Vorlesung 1",
    courseId: 101,
    courseName: "Analysis",
    cmid: 555,
    sourceUrl: "https://learnweb.example.com/x",
    model: "ggml-large-v3-turbo",
    durationSeconds: 42.7,
  };
  const segments = [
    { fromMs: 0, toMs: 5000, text: "Hallo." },
    { fromMs: 5000, toMs: 40000, text: "Welt." },
  ];
  const md = buildTranscriptMarkdown(meta, segments);

  assert.match(md, /^---\n/);
  assert.match(md, /title: "Vorlesung 1"/);
  assert.match(md, /course_id: 101/);
  assert.match(md, /cmid: 555/);
  assert.match(md, /duration_seconds: 43/);
  assert.match(md, /# Vorlesung 1/);
  assert.match(md, /\*\*\[00:00\]\*\* Hallo\. Welt\./);
});

test("buildTranscriptMarkdown: leere Segmente → Hinweis statt Absturz", () => {
  const md = buildTranscriptMarkdown(
    { title: "Leer", courseId: 1, courseName: "K", cmid: 2, sourceUrl: "u", model: "m" },
    []
  );
  assert.match(md, /Keine Transkriptionssegmente/);
});

// ── manifest ────────────────────────────────────────────────────────────
test("recordingKey: deterministisch, cmid-prefixed", () => {
  const a = recordingKey(123, "episode-abc");
  const b = recordingKey(123, "episode-abc");
  assert.equal(a, b);
  assert.match(a, /^123-[0-9a-f]{12}$/);
  assert.notEqual(recordingKey(123, "episode-abc"), recordingKey(123, "episode-xyz"));
});

test("manifest: load (fehlend) → leer, save/load roundtrip, isDone", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "manifest.json");

  const empty = await loadManifest(file);
  assert.deepEqual(empty, { version: 1, entries: {} });

  const entry = {
    key: "5-abc",
    course_id: 1,
    course_name: "K",
    cmid: 5,
    title: "T",
    source_url: "u",
    status: "done",
    model: "m",
    updated_at: new Date().toISOString(),
  };
  putEntry(empty, entry);
  await saveManifest(file, empty);

  const reloaded = await loadManifest(file);
  assert.equal(reloaded.entries["5-abc"].title, "T");
  assert.ok(isDone(reloaded, "5-abc"));
  assert.ok(!isDone(reloaded, "nope"));

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── transcriber ─────────────────────────────────────────────────────────
test("parseWhisperJson: extrahiert Offsets/Text, filtert Leeres", () => {
  const segs = parseWhisperJson({
    transcription: [
      { offsets: { from: 0, to: 1500 }, text: " Hallo " },
      { offsets: { from: 1500, to: 3000 }, text: "  " },
      { offsets: { from: 3000, to: 4000 }, text: "Welt" },
    ],
  });
  assert.deepEqual(segs, [
    { fromMs: 0, toMs: 1500, text: "Hallo" },
    { fromMs: 3000, toMs: 4000, text: "Welt" },
  ]);
  assert.deepEqual(parseWhisperJson({}), []);
  assert.deepEqual(parseWhisperJson(null), []);
});

test("parseMlxWhisperJson: konvertiert Sekunden in Millisekunden", () => {
  const segs = parseMlxWhisperJson({
    segments: [
      { start: 0, end: 1.25, text: " Hallo " },
      { start: 1.25, end: 2, text: "  " },
      { start: 2, end: 3.004, text: "Welt" },
    ],
  });
  assert.deepEqual(segs, [
    { fromMs: 0, toMs: 1250, text: "Hallo" },
    { fromMs: 2000, toMs: 3004, text: "Welt" },
  ]);
  assert.deepEqual(parseMlxWhisperJson({}), []);
});

test("extractAudio: ruft ffmpeg mit 16kHz-mono-PCM-Args", async () => {
  const calls = [];
  const fakeRun = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };
  const out = await extractAudio("/in/video.mp4", "/out/audio.wav", fakeRun);
  assert.equal(out, "/out/audio.wav");
  assert.equal(calls[0].file, "ffmpeg");
  assert.ok(calls[0].args.includes("16000"));
  assert.ok(calls[0].args.includes("-ac") && calls[0].args.includes("1"));
  assert.equal(calls[0].args.at(-1), "/out/audio.wav");
});

test("transcribeWav: ruft whisper-cli und parst die JSON-Ausgabe", async () => {
  const dir = await tmpDir();
  const wav = path.join(dir, "audio.wav");
  fs.writeFileSync(wav, "fake");
  // whisper-cli würde dies schreiben; wir legen es vorab an.
  fs.writeFileSync(
    path.join(dir, "audio.json"),
    JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: "Test" }] })
  );

  const calls = [];
  const fakeRun = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: "", stderr: "" };
  };
  const segs = await transcribeWav(wav, { backend: "whisper.cpp", model: "/m.bin", language: "de" }, fakeRun);

  assert.equal(calls[0].file, "whisper-cli");
  assert.ok(calls[0].args.includes("-oj"));
  assert.ok(calls[0].args.includes("de"));
  assert.deepEqual(segs, [{ fromMs: 0, toMs: 1000, text: "Test" }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("transcribeWav: nutzt vorhandenes MLX-Modell über uvx", async () => {
  const dir = await tmpDir();
  const wav = path.join(dir, "audio.wav");
  fs.writeFileSync(wav, "fake");
  fs.writeFileSync(
    path.join(dir, "audio.json"),
    JSON.stringify({ segments: [{ start: 0.5, end: 1.5, text: "MLX Test" }] })
  );

  const calls = [];
  const progress = [];
  const fakeRun = async (file, args, opts) => {
    calls.push({ file, args });
    opts.onProgress(" 40%|████      | 20/50");
    return { code: 0, stdout: "", stderr: "" };
  };
  const segs = await transcribeWav(
    wav,
    {
      backend: "mlx",
      model: "mlx-community/whisper-large-v3-turbo",
      language: "auto",
      onProgress: (pct) => progress.push(pct),
    },
    fakeRun
  );

  assert.equal(calls[0].file, "uvx");
  assert.deepEqual(calls[0].args.slice(0, 3), ["--from", "mlx-whisper", "mlx_whisper"]);
  assert.ok(calls[0].args.includes("mlx-community/whisper-large-v3-turbo"));
  assert.ok(!calls[0].args.includes("--language"));
  assert.deepEqual(progress, [40]);
  assert.deepEqual(segs, [{ fromMs: 500, toMs: 1500, text: "MLX Test" }]);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── downloader ──────────────────────────────────────────────────────────
test("downloadWithYtDlp: nutzt Cookie-Datei, findet Output, räumt Cookies auf", async () => {
  const dir = await tmpDir();
  let exportedTo = null;
  const fakeSession = {
    async exportCookieFile(p) {
      exportedTo = p;
      fs.writeFileSync(p, "# Netscape HTTP Cookie File\n");
    },
  };

  const calls = [];
  const fakeRun = async (file, args) => {
    calls.push({ file, args });
    // yt-dlp legt die Mediendatei an.
    fs.writeFileSync(path.join(dir, "999.m4a"), "audio-bytes");
    return { code: 0, stdout: "", stderr: "" };
  };

  const result = await downloadWithYtDlp(
    fakeSession,
    { url: "https://host/stream.m3u8", outDir: dir, baseName: "999" },
    fakeRun
  );

  assert.equal(result, path.join(dir, "999.m4a"));
  assert.equal(calls[0].file, "yt-dlp");
  const cookieIdx = calls[0].args.indexOf("--cookies");
  assert.ok(cookieIdx >= 0);
  assert.equal(calls[0].args[cookieIdx + 1], exportedTo);
  // Cookie-Datei (Session-Token) muss nach dem Lauf gelöscht sein.
  assert.ok(!fs.existsSync(exportedTo));

  fs.rmSync(dir, { recursive: true, force: true });
});
