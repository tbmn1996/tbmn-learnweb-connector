const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

process.env.LEARNWEB_URL = "https://learnweb.example.com";
process.env.LEARNWEB_USERNAME = "test-user";
process.env.LEARNWEB_PASSWORD = "test-password";

const ROOT = path.resolve(__dirname, "..");
const {
  LearnwebAuthError,
  LearnwebFileTooLargeError,
  LearnwebSession,
} = require(path.join(ROOT, "dist/learnweb/session"));

const BASE_URL = "https://learnweb.example.com";
const FILE_URL = `${BASE_URL}/pluginfile.php/123/mod_resource/content/1/script.pdf`;

function response(status, headers, data) {
  return {
    status,
    headers,
    data,
  };
}

async function markLoggedIn(session) {
  await session.jar.setCookie("MoodleSession=test-session; Path=/", BASE_URL);
}

function loginPage() {
  return response(
    200,
    {},
    '<html><body><form action="/login/index.php"><input name="logintoken" value="token-123"></form></body></html>'
  );
}

function loginSuccess() {
  return response(302, { location: "/my/" }, "");
}

test.beforeEach(() => {
  LearnwebSession.resetForTests();
});

test.after(() => {
  LearnwebSession.resetForTests();
});

test("downloadFile: liefert Bytes, Content-Type und Filename", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);
  const calls = [];

  session.client.get = async (target, config = {}) => {
    calls.push({ target, config });
    return response(
      200,
      {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="script.pdf"',
      },
      Buffer.from("%PDF-test")
    );
  };

  const result = await session.downloadFile(FILE_URL, { maxBytes: 1024, timeoutMs: 10_000 });

  assert.equal(result.status, 200);
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.filename, "script.pdf");
  assert.equal(result.bytes.toString(), "%PDF-test");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, FILE_URL);
  assert.equal(calls[0].config.responseType, "arraybuffer");
  assert.equal(calls[0].config.maxRedirects, 5);
  assert.equal(calls[0].config.maxContentLength, 1024);
  assert.equal(calls[0].config.maxBodyLength, 1024);
  assert.equal(calls[0].config.timeout, 10_000);
});

for (const [label, html] of [
  [
    "englische",
    '<html><body><form action="/login/index.php"><button>Log in</button></form></body></html>',
  ],
  [
    "deutsche",
    '<html><body><form action="/login/index.php?lang=de"><button>Anmelden</button></form></body></html>',
  ],
]) {
  test(`downloadFile: ${label} Login-Form triggert genau einen Re-Login-Retry`, async () => {
    const session = LearnwebSession.getInstance();
    await markLoggedIn(session);
    let downloadCalls = 0;
    let loginGetCalls = 0;
    let loginPostCalls = 0;

    session.client.get = async (target) => {
      if (target === "/login/index.php") {
        loginGetCalls++;
        return loginPage();
      }
      downloadCalls++;
      if (downloadCalls === 1) {
        return response(200, { "content-type": "text/html; charset=utf-8" }, Buffer.from(html));
      }
      return response(200, { "content-type": "application/pdf" }, Buffer.from("file-after-login"));
    };
    session.client.post = async () => {
      loginPostCalls++;
      return loginSuccess();
    };

    const result = await session.downloadFile(FILE_URL);

    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.bytes.toString(), "file-after-login");
    assert.equal(downloadCalls, 2);
    assert.equal(loginGetCalls, 1);
    assert.equal(loginPostCalls, 1);
  });
}

test("downloadFile: persistenter Login-Redirect wird LearnwebAuthError", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);
  let downloadCalls = 0;

  session.client.get = async (target) => {
    if (target === "/login/index.php") {
      return loginPage();
    }
    downloadCalls++;
    return response(
      200,
      { "content-type": "text/html; charset=utf-8" },
      Buffer.from('<html><body><form action="/login/index.php"><button>Log in</button></form></body></html>')
    );
  };
  session.client.post = async () => loginSuccess();

  await assert.rejects(
    () => session.downloadFile(FILE_URL),
    LearnwebAuthError
  );
  assert.equal(downloadCalls, 2);
});

test("downloadFile: Axios maxContentLength wird LearnwebFileTooLargeError", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);

  session.client.get = async () => {
    const error = new Error("maxContentLength size of 1024 exceeded");
    error.code = "ERR_BAD_RESPONSE";
    error.isAxiosError = true;
    throw error;
  };

  await assert.rejects(
    () => session.downloadFile(FILE_URL, { maxBytes: 1024 }),
    LearnwebFileTooLargeError
  );
});

test("downloadFile: RFC-5987 Filename wird decodiert", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);

  session.client.get = async () => response(
    200,
    {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename*=UTF-8''%C3%9Cbung%201.pdf",
    },
    Buffer.from("pdf")
  );

  const result = await session.downloadFile(FILE_URL);
  assert.equal(result.filename, "Übung 1.pdf");
});

test("downloadFile: filename* gewinnt vor filename", async () => {
  const session = LearnwebSession.getInstance();
  await markLoggedIn(session);

  session.client.get = async () => response(
    200,
    {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=fallback.pdf; filename*=UTF-8''%C3%9Cbung.pdf",
    },
    Buffer.from("pdf")
  );

  const result = await session.downloadFile(FILE_URL);
  assert.equal(result.filename, "Übung.pdf");
});
