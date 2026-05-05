const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

process.env.LEARNWEB_URL = "https://www.uni-muenster.de/LearnWeb/learnweb2";
process.env.LEARNWEB_USERNAME = "test-user";
process.env.LEARNWEB_PASSWORD = "test-password";

const ROOT = path.resolve(__dirname, "..");
const { registerLearnwebTools } = require(path.join(ROOT, "dist/tools/learnweb"));
const {
  LearnwebFileTooLargeError,
  LearnwebSession,
} = require(path.join(ROOT, "dist/learnweb/session"));

const BASE_URL = "https://www.uni-muenster.de/LearnWeb/learnweb2";
const VALID_URL = `${BASE_URL}/pluginfile.php/123/mod_resource/content/1/script.pdf`;

function captureDownloadTool(fakeSession) {
  const originalGetInstance = LearnwebSession.getInstance;
  const tools = {};
  const server = {
    registerTool(name, config, handler) {
      tools[name] = { config, handler };
    },
  };

  LearnwebSession.getInstance = () => fakeSession;
  registerLearnwebTools(server, "learnweb");

  return {
    tool: tools["learnweb-download-resource"],
    restore() {
      LearnwebSession.getInstance = originalGetInstance;
    },
  };
}

function fakeSession(baseUrl = BASE_URL) {
  const calls = [];
  return {
    calls,
    getBaseUrl: () => baseUrl,
    async downloadFile(url, options) {
      calls.push({ url, options });
      return {
        status: 200,
        contentType: "application/pdf",
        filename: "script.pdf",
        bytes: Buffer.from("hello-file"),
      };
    },
  };
}

test("download tool: gültige Subpath-URL liefert MCP Resource-Blob und Metadata", async () => {
  const session = fakeSession();
  const { tool, restore } = captureDownloadTool(session);
  try {
    assert.ok(tool, "download tool must be registered");
    assert.ok(tool.config.outputSchema, "download tool should expose outputSchema");

    const result = await tool.handler({ url: VALID_URL });

    assert.equal(result.content[0].type, "resource");
    assert.equal(result.content[0].resource.uri, VALID_URL);
    assert.equal(result.content[0].resource.mimeType, "application/pdf");
    assert.equal(result.content[0].resource.blob, Buffer.from("hello-file").toString("base64"));
    assert.equal(result.content[1].type, "text");
    assert.deepEqual(result.structuredContent, {
      filename: "script.pdf",
      size: Buffer.from("hello-file").length,
      content_type: "application/pdf",
    });
    assert.deepEqual(session.calls, [
      { url: VALID_URL, options: { maxBytes: 3 * 1024 * 1024 } },
    ]);
  } finally {
    restore();
  }
});

for (const [label, url] of [
  ["fremder Host", "https://example.com/LearnWeb/learnweb2/pluginfile.php/123/file.pdf"],
  ["Protocol-Downgrade", "http://www.uni-muenster.de/LearnWeb/learnweb2/pluginfile.php/123/file.pdf"],
  ["ausserhalb des Base-Pfads", "https://www.uni-muenster.de/foo/pluginfile.php/123/file.pdf"],
  ["Base-Pfad ohne Pluginfile-Suffix", `${BASE_URL}/`],
]) {
  test(`download tool: ${label} wird als invalid_url abgelehnt`, async () => {
    const session = fakeSession();
    const { tool, restore } = captureDownloadTool(session);
    try {
      const result = await tool.handler({ url });

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error, true);
      assert.equal(result.structuredContent.code, "invalid_url");
      assert.equal(session.calls.length, 0);
    } finally {
      restore();
    }
  });
}

test("download tool: tokenpluginfile und webservice/pluginfile werden akzeptiert", async () => {
  const session = fakeSession();
  const { tool, restore } = captureDownloadTool(session);
  try {
    const tokenUrl = `${BASE_URL}/tokenpluginfile.php/123/file.pdf`;
    const webserviceUrl = `${BASE_URL}/webservice/pluginfile.php/123/file.pdf`;

    await tool.handler({ url: tokenUrl });
    await tool.handler({ url: webserviceUrl, max_bytes: 4096 });

    assert.deepEqual(session.calls, [
      { url: tokenUrl, options: { maxBytes: 3 * 1024 * 1024 } },
      { url: webserviceUrl, options: { maxBytes: 4096 } },
    ]);
  } finally {
    restore();
  }
});

test("download tool: file_too_large wird ohne wrapHandler gemappt", async () => {
  const session = fakeSession();
  session.downloadFile = async () => {
    throw new LearnwebFileTooLargeError();
  };
  const { tool, restore } = captureDownloadTool(session);
  try {
    const result = await tool.handler({ url: VALID_URL });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "file_too_large");
    assert.equal(result.content[0].type, "text");
  } finally {
    restore();
  }
});
