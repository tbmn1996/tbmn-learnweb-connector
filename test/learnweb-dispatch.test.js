const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { _testing } = require(path.join(ROOT, "dist/tools/learnweb"));
const {
  LearnwebAuthError,
  LearnwebParseError,
  LearnwebTimeoutError,
  LearnwebUpstreamError,
} = require(path.join(ROOT, "dist/learnweb/session"));

const BASE_URL = "https://learnweb.example.com";

function withMutedConsole(fn) {
  const originalError = console.error;
  console.error = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = originalError;
    });
}

test("dispatchActivity: LearnwebParseError fällt auf raw_text-Fallback zurück", async () => {
  await withMutedConsole(async () => {
    const calls = [];
    const session = {
      getBaseUrl: () => BASE_URL,
      async get(p) {
        calls.push(p);
        return {
          status: 200,
          url: BASE_URL + p,
          headers: {},
          data: `
            <html><body>
              <main>
                <h1>Ratingallocate Live Drift</h1>
                <p>Fallback text from protected page.</p>
              </main>
            </body></html>
          `,
        };
      },
    };

    const result = await _testing.dispatchActivity(session, {
      cmid: 7777,
      modtype: "ratingallocate",
    });

    assert.equal(result.modtype, "ratingallocate");
    assert.equal(result.parser_degraded, true);
    assert.equal(result.parser_error.code, "learnweb_parse_error");
    assert.equal(result.parser_error.parser, "ratingallocate");
    assert.ok(result.content.raw_text.includes("Fallback text"));
    assert.deepEqual(calls, [
      "/mod/ratingallocate/view.php?id=7777",
      "/mod/ratingallocate/view.php?id=7777",
    ]);
  });
});

for (const [name, error, code] of [
  ["Timeout", new LearnwebTimeoutError(), "learnweb_timeout"],
  ["Upstream", new LearnwebUpstreamError(503, "/mod/resource/view.php", "upstream failed"), "learnweb_upstream_error"],
  ["Auth", new LearnwebAuthError(), "learnweb_auth_error"],
  ["Generisch", new Error("boom"), "learnweb_error"],
]) {
  test(`dispatchActivity: ${name}-Fehler wird ohne Fallback durchgereicht`, async () => {
    await withMutedConsole(async () => {
      let callCount = 0;
      const session = {
        getBaseUrl: () => BASE_URL,
        async get() {
          callCount++;
          throw error;
        },
      };

      await assert.rejects(
        () => _testing.dispatchActivity(session, { cmid: 1001, modtype: "resource" }),
        (err) => err === error
      );
      assert.equal(callCount, 1);

      const wrapped = await _testing.wrapHandler(async () => {
        throw error;
      });
      assert.equal(wrapped.isError, true);
      assert.equal(wrapped.structuredContent.code, code);
      assert.match(wrapped.structuredContent.request_id, /^req_[a-f0-9]{22}$/);
      assert.equal(typeof wrapped.structuredContent.context, "object");
    });
  });
}

test("wrapHandler: Parse- und Upstream-Kontext bleibt whitelisted", async () => {
  await withMutedConsole(async () => {
    const parseResult = await _testing.wrapHandler(async () => {
      throw new LearnwebParseError("timeline", "ajax:method", "bad shape");
    });
    assert.deepEqual(parseResult.structuredContent.context, {
      parser: "timeline",
      selector: "ajax:method",
    });

    const upstreamResult = await _testing.wrapHandler(async () => {
      throw new LearnwebUpstreamError(400, "/mod/../admin/config.php", "rejected");
    });
    assert.deepEqual(upstreamResult.structuredContent.context, {
      status: 400,
      path: "/mod/../admin/config.php",
    });
  });
});
