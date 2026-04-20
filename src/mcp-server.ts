// LearnWeb-MCP-Connector — Haupteinstiegspunkt.
// Unterstützt zwei Transports:
//   - stdio: lokaler Dev-Modus, für direkte Tool-Nutzung im Terminal / Claude Desktop
//   - http:  Production-Modus auf Railway, mit OAuth-geschütztem /mcp/learnweb-Endpoint
//
// Der globale /mcp-Endpoint wird im HTTP-Modus NICHT mehr gemountet — der LearnWeb-Connector
// hat nur genau einen Tool-Scope. Damit entfällt auch jede Möglichkeit, Learnweb-Tools
// versehentlich ohne OAuth zu exponieren.

import crypto from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { RequestHandler, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_ALLOWED_HOSTS,
  MCP_ALLOWED_ORIGINS,
  MCP_HTTP_HOST,
  MCP_HTTP_PORT,
  MCP_LEARNWEB_ENDPOINT_ENABLED,
  MCP_OAUTH_ACCESS_TTL_SECONDS,
  MCP_OAUTH_ALLOWED_EMAILS,
  MCP_OAUTH_COOKIE_SECRET,
  MCP_OAUTH_IDENTITY_PROVIDER,
  MCP_OAUTH_JWT_SECRET,
  MCP_OAUTH_LOCAL_LOGIN_EMAIL,
  MCP_OAUTH_LOCAL_LOGIN_PASSWORD,
  MCP_OAUTH_LOCAL_LOGIN_SUB,
  MCP_OAUTH_LOCAL_LOGIN_USERNAME,
  MCP_OAUTH_REFRESH_TTL_SECONDS,
  MCP_OAUTH_STATIC_CLIENTS,
  MCP_PUBLIC_BASE_URL,
  MCP_TRANSPORT,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_ISSUER_URL,
  REDIS_URL,
} from "./config";
import { OAuthManager } from "./oauth/server";
import { registerLearnwebTools } from "./tools/learnweb";

type MountedEndpoint = {
  closeAllSessions: () => Promise<void>;
};

type EndpointOptions = {
  authMiddleware?: RequestHandler;
  path: string;
  probeName?: string;
  scope?: string;
  serverFactory: () => McpServer;
};

/**
 * Erzeugt einen MCP-Server und registriert die LearnWeb-Tools.
 * Im stdio-Modus wird die Funktion ohne scope aufgerufen; im HTTP-Modus
 * mit scope="learnweb" (damit die Sicherheitsregel in registerLearnwebTools greift).
 */
export function createServer(scope?: string) {
  const server = new McpServer({
    name: scope ? `mcp-${scope}` : "mcp-learnweb",
    version: "1.0.0",
  });

  registerLearnwebTools(server, scope);

  return server;
}

function sendJsonRpcError(res: Response, status: number, message: string, code = -32000) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function sendSessionNotFoundError(res: Response) {
  sendJsonRpcError(res, 404, "Session not found. Please re-initialize.", -32001);
}

/**
 * Hängt einen MCP-HTTP-Endpoint mit POST/GET/DELETE an die Express-App.
 * Jede Session bekommt einen eigenen StreamableHTTPServerTransport + McpServer.
 */
function mountMcpEndpoint(app: ReturnType<typeof createMcpExpressApp>, options: EndpointOptions): MountedEndpoint {
  const { authMiddleware, path, probeName, serverFactory } = options;
  const endpointAuthMiddleware =
    authMiddleware ??
    ((_: Parameters<RequestHandler>[0], __: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) =>
      next());
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  app.post(path, endpointAuthMiddleware, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId) {
        const existingSession = sessions.get(sessionId);
        if (!existingSession) {
          sendSessionNotFoundError(res);
          return;
        }
        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (isInitializeRequest(req.body) || isSingleInitializeBatch(req.body)) {
        const sessionServer = serverFactory();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: sessionServer });
          },
        });
        await sessionServer.connect(transport);
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
          }
        };
        await transport.handleRequest(req, res, req.body);
        return;
      }

      sendJsonRpcError(res, 400, "Bad Request: No session ID provided for non-initialize request");
    } catch (error) {
      console.error(`Error handling POST ${path}:`, error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  if (probeName) {
    app.head(path, endpointAuthMiddleware, (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId) {
        sendJsonRpcError(res, 400, "Bad Request: HEAD probe does not use MCP sessions");
        return;
      }
      res
        .set("Cache-Control", "no-cache, no-store")
        .set("X-MCP-Server", probeName)
        .status(204)
        .end();
    });
  }

  app.get(path, endpointAuthMiddleware, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const accept = typeof req.headers.accept === "string" ? req.headers.accept : "";

      if (probeName && !sessionId && !accept.includes("text/event-stream")) {
        res.set("Cache-Control", "no-cache, no-store").status(200).json({
          name: probeName,
          protocol: "mcp",
          status: "ok",
        });
        return;
      }

      if (!sessionId) {
        sendJsonRpcError(res, 400, "Bad Request: No session ID provided");
        return;
      }

      const existingSession = sessions.get(sessionId);
      if (!existingSession) {
        sendSessionNotFoundError(res);
        return;
      }

      await existingSession.transport.handleRequest(req, res);
    } catch (error) {
      console.error(`Error handling GET ${path}:`, error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  app.delete(path, endpointAuthMiddleware, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        sendJsonRpcError(res, 400, "Bad Request: No session ID provided");
        return;
      }
      const existingSession = sessions.get(sessionId);
      if (!existingSession) {
        sendSessionNotFoundError(res);
        return;
      }
      await existingSession.transport.close();
      sessions.delete(sessionId);
      res.status(200).end();
    } catch (error) {
      console.error(`Error handling DELETE ${path}:`, error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  return {
    async closeAllSessions() {
      for (const [, session] of sessions) {
        await session.transport.close();
      }
      sessions.clear();
    },
  };
}

export function createHttpApp(serverFactory: (scope?: string) => McpServer = createServer) {
  const corsAllowedHeaders = [
    "Content-Type",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
    "Authorization",
  ];
  const corsExposedHeaders = ["mcp-session-id", "mcp-protocol-version"];
  const app = createMcpExpressApp({
    host: MCP_HTTP_HOST,
    ...(MCP_ALLOWED_HOSTS.length > 0 ? { allowedHosts: MCP_ALLOWED_HOSTS } : {}),
  });
  app.set("trust proxy", 1);

  // CORS — claude.ai/chatgpt verlangen exakte Origin-Allowlist.
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (!origin) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    if (!MCP_ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({ error: "Forbidden origin" });
      return;
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", corsAllowedHeaders.join(", "));
    res.setHeader("Access-Control-Expose-Headers", corsExposedHeaders.join(", "));

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  // Health-Endpoint ohne Auth — Railway-Healthchecks schicken keinen Authorization-Header.
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "learnweb-mcp",
      time: new Date().toISOString(),
    });
  });

  const oauthManager = MCP_LEARNWEB_ENDPOINT_ENABLED
    ? new OAuthManager({
        accessTtlSeconds: MCP_OAUTH_ACCESS_TTL_SECONDS,
        cookieSecret: MCP_OAUTH_COOKIE_SECRET!,
        jwtSecret: MCP_OAUTH_JWT_SECRET!,
        identityProvider:
          MCP_OAUTH_IDENTITY_PROVIDER === "local"
            ? {
                mode: "local",
                username: MCP_OAUTH_LOCAL_LOGIN_USERNAME!,
                password: MCP_OAUTH_LOCAL_LOGIN_PASSWORD!,
                ...(MCP_OAUTH_LOCAL_LOGIN_SUB ? { subject: MCP_OAUTH_LOCAL_LOGIN_SUB } : {}),
                ...(MCP_OAUTH_LOCAL_LOGIN_EMAIL ? { email: MCP_OAUTH_LOCAL_LOGIN_EMAIL } : {}),
              }
            : {
                mode: "oidc",
                allowedEmails: MCP_OAUTH_ALLOWED_EMAILS,
                oidcClientId: OIDC_CLIENT_ID!,
                oidcClientSecret: OIDC_CLIENT_SECRET!,
                oidcIssuerUrl: OIDC_ISSUER_URL!.toString(),
              },
        publicBaseUrl: MCP_PUBLIC_BASE_URL!,
        redisUrl: REDIS_URL,
        refreshTtlSeconds: MCP_OAUTH_REFRESH_TTL_SECONDS,
        staticClients: MCP_OAUTH_STATIC_CLIENTS,
        // Keine Workspace-IDs mehr — der Learnweb-Connector hat nur eine generische Ressource.
        workspaceIds: [],
      })
    : undefined;

  // Learnweb-Ressource vor mount() registrieren, damit der /.well-known-Endpoint
  // beim Aufruf von mount() bereits in der Ressourcen-Map vorhanden ist.
  if (oauthManager) {
    oauthManager.registerGenericResource("learnweb", "/mcp/learnweb");
    oauthManager.mount(app);
  }

  const mountedEndpoints: MountedEndpoint[] = [];

  // Dedizierter OAuth-geschützter Learnweb-Endpoint.
  if (MCP_LEARNWEB_ENDPOINT_ENABLED) {
    if (!oauthManager) {
      throw new Error("MCP_LEARNWEB_ENDPOINT_ENABLED requires OAuth to be configured.");
    }
    mountedEndpoints.push(
      mountMcpEndpoint(app, {
        path: "/mcp/learnweb",
        authMiddleware: oauthManager.createGenericAuthMiddleware("learnweb"),
        probeName: "mcp-learnweb",
        serverFactory: () => serverFactory("learnweb"),
      })
    );
  }

  if (oauthManager) {
    mountedEndpoints.push({
      async closeAllSessions() {
        await oauthManager.close();
      },
    });
  }

  return { app, mountedEndpoints };
}

function isSingleInitializeBatch(body: unknown): boolean {
  return (
    Array.isArray(body) &&
    body.length === 1 &&
    body[0] != null &&
    typeof body[0] === "object" &&
    isInitializeRequest(body[0])
  );
}

async function startHttpTransport(serverFactory: (scope?: string) => McpServer = createServer) {
  const { app, mountedEndpoints } = createHttpApp(serverFactory);
  const httpServer = app.listen(MCP_HTTP_PORT, MCP_HTTP_HOST, () => {
    console.log(`LearnWeb MCP HTTP server listening on ${MCP_HTTP_HOST}:${MCP_HTTP_PORT}`);
  });

  function shutdown(exitCode: number) {
    console.log("Shutting down...");
    void Promise.all(mountedEndpoints.map((endpoint) => endpoint.closeAllSessions())).finally(() => {
      httpServer.close(() => process.exit(exitCode));
      setTimeout(() => process.exit(1), 5000);
    });
  }

  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
}

export async function main() {
  if (MCP_TRANSPORT === "http") {
    await startHttpTransport(createServer);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("LearnWeb MCP server failed to start:", err);
    process.exit(1);
  });
}
