const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { _testing } = require(path.join(ROOT, "dist/tools/learnweb"));
const { LearnwebUpstreamError } = require(path.join(ROOT, "dist/learnweb/session"));

const BASE_URL = "https://learnweb.example.com";

test("get-page: SAFE_PATH_RE akzeptiert nur freigegebene Bereiche", () => {
  assert.equal(_testing.SAFE_PATH_RE.test("/mod/forum/view.php?id=123"), true);
  assert.equal(_testing.SAFE_PATH_RE.test("/calendar/view.php?view=upcoming"), true);
  assert.equal(_testing.SAFE_PATH_RE.test("/course/view.php?id=42"), true);
  assert.equal(_testing.SAFE_PATH_RE.test("/admin/foo"), false);
  assert.equal(_testing.SAFE_PATH_RE.test("/user/profile.php"), false);
});

test("get-page: Traversal wird vor Session-Call abgelehnt", async () => {
  for (const unsafePath of [
    "/mod/../admin/config.php",
    "/mod/%2e%2e/admin/config.php",
    "/mod/%2E%2E%2Fadmin/config.php",
    "/mod/foo/..%2F..%2Fadmin",
  ]) {
    let callCount = 0;
    const session = {
      async get() {
        callCount++;
        throw new Error("Session must not be called");
      },
    };

    await assert.rejects(
      () => _testing.getPageViaSession(session, unsafePath),
      (err) => {
        assert.ok(err instanceof LearnwebUpstreamError, `Erwartet LearnwebUpstreamError, bekam ${err?.name}`);
        assert.equal(err.status, 400);
        return true;
      }
    );
    assert.equal(callCount, 0, unsafePath);
  }
});

test("get-page: Query-String bleibt nach Normalisierung erhalten", async () => {
  const seenPaths = [];
  const session = {
    async get(p) {
      seenPaths.push(p);
      return {
        status: 200,
        url: BASE_URL + p,
        headers: {},
        data: `
          <html><body>
            <nav>Navigation</nav>
            <main><h1>Forum</h1><p>Diskussionstext</p></main>
          </body></html>
        `,
      };
    },
  };

  const result = await _testing.getPageViaSession(
    session,
    "/mod/forum/view.php?id=123/.."
  );

  assert.deepEqual(seenPaths, ["/mod/forum/view.php?id=123/.."]);
  assert.equal(result.path, "/mod/forum/view.php?id=123/..");
  assert.equal(result.title, "Forum");
  assert.ok(result.text.includes("Diskussionstext"));
  assert.ok(!result.text.includes("Navigation"));
});
