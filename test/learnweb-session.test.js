const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

process.env.LEARNWEB_URL = "https://learnweb.example.com";
process.env.LEARNWEB_USERNAME = "test-user";
process.env.LEARNWEB_PASSWORD = "test-password";

const ROOT = path.resolve(__dirname, "..");
const {
  LearnwebSession,
  LearnwebTimeoutError,
} = require(path.join(ROOT, "dist/learnweb/session"));

function fakeAxiosResponse(url) {
  return {
    status: 200,
    request: { res: { responseUrl: url } },
    headers: {},
    data: "<html></html>",
  };
}

test.beforeEach(() => {
  LearnwebSession.resetForTests();
});

test.after(() => {
  LearnwebSession.resetForTests();
});

test("session: rawGet nutzt Default-Timeout und respektiert Override", async () => {
  const session = LearnwebSession.getInstance();
  const calls = [];

  session.client.get = async (target, config = {}) => {
    calls.push({ target, config });
    return fakeAxiosResponse(`https://learnweb.example.com${target}`);
  };

  await session.rawGet("/my/index.php");
  await session.rawGet("/course/search.php?search=test", 30_000);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].config.timeout, 15_000);
  assert.equal(calls[1].config.timeout, 30_000);
});

test("session: rawGet mappt ECONNABORTED auf LearnwebTimeoutError", async () => {
  const session = LearnwebSession.getInstance();
  session.client.get = async () => {
    const error = new Error("timeout");
    error.code = "ECONNABORTED";
    error.isAxiosError = true;
    throw error;
  };

  await assert.rejects(session.rawGet("/slow"), LearnwebTimeoutError);
});

test("session: rawGet mappt ETIMEDOUT auf LearnwebTimeoutError", async () => {
  const session = LearnwebSession.getInstance();
  session.client.get = async () => {
    const error = new Error("timeout");
    error.code = "ETIMEDOUT";
    error.isAxiosError = true;
    throw error;
  };

  await assert.rejects(session.rawGet("/slow"), LearnwebTimeoutError);
});
