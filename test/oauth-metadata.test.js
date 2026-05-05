const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const ROOT = path.resolve(__dirname, "..");
const { OAuthManager } = require(path.join(ROOT, "dist/oauth/server"));

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("oauth metadata: generische LearnWeb-Ressource nutzt LearnWeb-Namen", async () => {
  const app = express();
  const manager = new OAuthManager({
    accessTtlSeconds: 60,
    cookieSecret: "test-cookie-secret",
    identityProvider: {
      mode: "local",
      username: "user",
      password: "password",
    },
    jwtSecret: "test-jwt-secret",
    publicBaseUrl: new URL("https://learnweb.example.com"),
    redisUrl: undefined,
    refreshTtlSeconds: 60,
    staticClients: {
      test: {
        client_id: "test-client",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      },
    },
    workspaceIds: [],
  });

  manager.registerGenericResource("learnweb", "/mcp/learnweb");
  manager.mount(app);

  const server = await listen(app);
  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/.well-known/oauth-protected-resource/mcp/learnweb`
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.resource_name, "learnweb");
    assert.equal(body.resource, "https://learnweb.example.com/mcp/learnweb");
    assert.ok(!JSON.stringify(body).includes("notion"));
  } finally {
    await close(server);
    await manager.close();
  }
});
