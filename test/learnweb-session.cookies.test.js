const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.LEARNWEB_URL = "https://learnweb.example.com";
process.env.LEARNWEB_USERNAME = "test-user";
process.env.LEARNWEB_PASSWORD = "test-password";

const ROOT = path.resolve(__dirname, "..");
const { LearnwebSession } = require(path.join(ROOT, "dist/learnweb/session"));

const BASE_URL = "https://learnweb.example.com";

// Setzt ein realistisches Session-Cookie, damit exportCookieFile()'s
// ensureLoggedIn() keinen echten Login-Request auslöst.
async function markLoggedIn(session) {
  await session.jar.setCookie("MoodleSession=sess-token-xyz; Path=/; Secure; HttpOnly", BASE_URL);
}

async function tmpCookiePath() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lw-cookies-"));
  return path.join(dir, "cookies.txt");
}

test.beforeEach(() => {
  LearnwebSession.resetForTests();
});

test.after(() => {
  LearnwebSession.resetForTests();
});

test("exportCookieFile: Netscape-Header + httpOnly/secure Session-Cookie korrekt", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);
  const target = await tmpCookiePath();

  await session.exportCookieFile(target);
  const content = fs.readFileSync(target, "utf8");

  assert.match(content, /^# Netscape HTTP Cookie File/);

  const line = content.split("\n").find((l) => l.includes("MoodleSession"));
  assert.ok(line, "MoodleSession-Zeile fehlt");
  // httpOnly → #HttpOnly_-Präfix (curl/yt-dlp-Konvention).
  assert.ok(line.startsWith("#HttpOnly_learnweb.example.com\t"), `unerwartetes Präfix: ${line}`);

  const cols = line.replace(/^#HttpOnly_/, "").split("\t");
  // domain, includeSubdomains, path, secure, expiry, name, value
  assert.equal(cols[0], "learnweb.example.com");
  assert.equal(cols[1], "FALSE"); // host-only
  assert.equal(cols[2], "/");
  assert.equal(cols[3], "TRUE"); // secure
  assert.ok(Number(cols[4]) > Math.floor(Date.now() / 1000)); // Session-Cookie → Zukunft
  assert.equal(cols[5], "MoodleSession");
  assert.equal(cols[6], "sess-token-xyz");

  fs.rmSync(path.dirname(target), { recursive: true, force: true });
});

test("exportCookieFile: Domain-Cookie ohne httpOnly bekommt Punkt-Präfix, kein #HttpOnly_", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);
  await session.jar.setCookie("PREF=de; Domain=learnweb.example.com; Path=/", BASE_URL);
  const target = await tmpCookiePath();

  await session.exportCookieFile(target);
  const content = fs.readFileSync(target, "utf8");

  const line = content.split("\n").find((l) => l.includes("\tPREF\t"));
  assert.ok(line, "PREF-Zeile fehlt");
  assert.ok(!line.startsWith("#HttpOnly_"), "PREF ist nicht httpOnly");

  const cols = line.split("\t");
  assert.equal(cols[0], ".learnweb.example.com"); // Domain-Cookie → führender Punkt
  assert.equal(cols[1], "TRUE"); // gilt für Subdomains
  assert.equal(cols[3], "FALSE"); // nicht secure

  fs.rmSync(path.dirname(target), { recursive: true, force: true });
});
