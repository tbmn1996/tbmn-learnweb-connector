import crypto from "node:crypto";
import { TextEncoder } from "node:util";
import { urlencoded, type Request, type RequestHandler, type Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthServerProvider, OAuthTokenVerifier, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SignJWT, jwtVerify } from "jose";
import type { StaticOAuthClients } from "../config-utils";
import { OidcClient } from "./oidc";
import {
  createOpaqueToken,
  OAuthStore,
  type AuthorizationCodeRecord,
  type AuthorizationRequestRecord,
  type BrowserSessionRecord,
  type RefreshTokenRecord,
} from "./store";

const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const LOGIN_REQUEST_TTL_SECONDS = 10 * 60;
const BROWSER_SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_SCOPE = "mcp:tools";
const SUPPORTED_SCOPES = new Set([DEFAULT_SCOPE]);
const BROWSER_SESSION_COOKIE = "mcp_oauth_session";

type OAuthManagerOptions = {
  accessTtlSeconds: number;
  cookieSecret: string;
  identityProvider:
    | {
        mode: "local";
        username: string;
        password: string;
        subject?: string;
        email?: string;
      }
    | {
        mode: "oidc";
        allowedEmails: string[];
        oidcClientId: string;
        oidcClientSecret: string;
        oidcIssuerUrl: string;
      };
  jwtSecret: string;
  publicBaseUrl: URL;
  redisUrl?: string;
  refreshTtlSeconds: number;
  staticClients: StaticOAuthClients;
  workspaceIds: string[];
};

type ResourceEntry = {
  metadataUrl: string;
  resourceUrl: URL;
  workspaceId: string;
};

function canonicalizeUrl(url: string | URL): string {
  const normalized = typeof url === "string" ? new URL(url) : new URL(url.toString());
  normalized.hash = "";
  if (normalized.pathname !== "/" && normalized.pathname.endsWith("/")) {
    normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  }
  return normalized.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signCookieValue(value: string, secret: string): string {
  const signature = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${signature}`;
}

function unsignCookieValue(value: string, secret: string): string | null {
  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }
  const rawValue = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expectedSignature = crypto.createHmac("sha256", secret).update(rawValue).digest("base64url");
  return timingSafeEqual(signature, expectedSignature) ? rawValue : null;
}

class StaticClientsStore implements OAuthRegisteredClientsStore {
  private readonly byClientId = new Map<string, OAuthClientInformationFull>();

  constructor(clients: StaticOAuthClients) {
    const issuedAt = Math.floor(Date.now() / 1000);
    for (const config of Object.values(clients)) {
      this.byClientId.set(config.client_id, {
        client_id: config.client_id,
        ...(config.client_secret ? { client_secret: config.client_secret } : {}),
        client_id_issued_at: issuedAt,
        redirect_uris: config.redirect_uris,
        token_endpoint_auth_method: config.client_secret ? "client_secret_post" : "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(config.client_name ? { client_name: config.client_name } : {}),
        ...(config.scope ? { scope: config.scope } : {}),
      });
    }
  }

  async getClient(clientId: string) {
    return this.byClientId.get(clientId);
  }
}

export class OAuthManager implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  readonly revokeToken = async (_client: OAuthClientInformationFull, request: { token: string }) => {
    await this.store.revokeRefreshToken(request.token);
  };

  private readonly store: OAuthStore;

  private readonly oidcClient?: OidcClient;

  private readonly issuerUrl: URL;

  private readonly callbackUrl: string;

  private readonly jwtKey: Uint8Array;

  private readonly allowedEmails = new Set<string>();

  private readonly resourcesByWorkspaceId = new Map<string, ResourceEntry>();

  private readonly workspaceIdByResource = new Map<string, string>();

  readonly oauthMetadata: OAuthMetadata;

  constructor(private readonly options: OAuthManagerOptions) {
    this.clientsStore = new StaticClientsStore(options.staticClients);
    this.store = new OAuthStore(options.redisUrl);
    this.issuerUrl = new URL(options.publicBaseUrl.toString());
    this.callbackUrl = new URL("/oauth/callback", this.issuerUrl).toString();
    this.jwtKey = new TextEncoder().encode(options.jwtSecret);
    if (options.identityProvider.mode === "oidc") {
      this.oidcClient = new OidcClient(
        options.identityProvider.oidcIssuerUrl,
        options.identityProvider.oidcClientId,
        options.identityProvider.oidcClientSecret
      );
      for (const email of options.identityProvider.allowedEmails) {
        this.allowedEmails.add(email.toLowerCase());
      }
    }

    for (const workspaceId of options.workspaceIds) {
      const resourceUrl = new URL(`/mcp/workspaces/${encodeURIComponent(workspaceId)}`, this.issuerUrl);
      const entry = {
        workspaceId,
        resourceUrl,
        metadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
      };
      this.resourcesByWorkspaceId.set(workspaceId, entry);
      this.workspaceIdByResource.set(canonicalizeUrl(resourceUrl), workspaceId);
    }

    this.oauthMetadata = createOAuthMetadata({
      provider: this,
      issuerUrl: this.issuerUrl,
      baseUrl: this.issuerUrl,
      scopesSupported: [DEFAULT_SCOPE],
    });
  }

  async close() {
    await this.store.close();
  }

  mount(app: any) {
    app.use("/authorize", authorizationHandler({ provider: this }));
    app.use("/token", tokenHandler({ provider: this }));
    app.use("/revoke", revocationHandler({ provider: this }));
    app.use("/.well-known/oauth-authorization-server", metadataHandler(this.oauthMetadata));

    for (const entry of this.resourcesByWorkspaceId.values()) {
      app.use(
        `/.well-known/oauth-protected-resource${entry.resourceUrl.pathname}`,
        metadataHandler({
          resource: entry.resourceUrl.toString(),
          authorization_servers: [this.oauthMetadata.issuer],
          scopes_supported: [DEFAULT_SCOPE],
          resource_name: `notion-workspace-${entry.workspaceId}`,
        })
      );
    }

    app.get("/oauth/login", this.handleBrowserLogin);
    app.post("/oauth/login", urlencoded({ extended: false }), this.handleLocalLoginSubmit);
    app.use("/oauth/callback", this.handleOidcCallback);
  }

  createWorkspaceAuthMiddleware(workspaceId: string): RequestHandler {
    const entry = this.requireWorkspaceResource(workspaceId);
    return requireBearerAuth({
      verifier: {
        verifyAccessToken: async (token: string) => this.verifyWorkspaceAccessToken(token, entry),
      },
      requiredScopes: [DEFAULT_SCOPE],
      resourceMetadataUrl: entry.metadataUrl,
    });
  }

  // Registriert eine generische OAuth-geschützte Ressource (kein Notion-Workspace).
  // Muss VOR mount() aufgerufen werden, damit der /.well-known-Endpoint eingehängt wird.
  registerGenericResource(resourceId: string, resourcePath: string): void {
    const resourceUrl = new URL(resourcePath, this.issuerUrl);
    const entry: ResourceEntry = {
      workspaceId: resourceId,
      resourceUrl,
      metadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    };
    this.resourcesByWorkspaceId.set(resourceId, entry);
    this.workspaceIdByResource.set(canonicalizeUrl(resourceUrl), resourceId);
  }

  // Auth-Middleware für eine generisch registrierte Ressource.
  createGenericAuthMiddleware(resourceId: string): RequestHandler {
    return this.createWorkspaceAuthMiddleware(resourceId);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const workspaceEntry = this.resolveResource(params.resource);
    const scopes = this.resolveScopes(params.scopes);
    const authorizationRequestId = createOpaqueToken(24);
    const record: AuthorizationRequestRecord = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      ...(params.state ? { state: params.state } : {}),
      codeChallenge: params.codeChallenge,
      resource: workspaceEntry.resourceUrl.toString(),
      workspaceId: workspaceEntry.workspaceId,
      scopes,
      createdAt: Date.now(),
    };

    await this.store.storeAuthorizationRequest(
      authorizationRequestId,
      record,
      AUTHORIZATION_REQUEST_TTL_SECONDS
    );

    const loginUrl = new URL("/oauth/login", this.issuerUrl);
    loginUrl.searchParams.set("request", authorizationRequestId);
    res.redirect(302, loginUrl.toString());
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string) {
    const record = await this.store.getAuthorizationCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Unknown authorization code.");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ) {
    const record = await this.store.consumeAuthorizationCode(authorizationCode);
    if (!record) {
      throw new InvalidGrantError("Unknown authorization code.");
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to another client.");
    }
    if (!redirectUri || redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (!resource) {
      throw new InvalidTargetError("resource is required.");
    }

    const normalizedResource = canonicalizeUrl(resource);
    if (normalizedResource !== canonicalizeUrl(record.resource)) {
      throw new InvalidGrantError("resource does not match the authorization request.");
    }

    return this.issueTokens({
      clientId: record.clientId,
      sub: record.sub,
      ...(record.email ? { email: record.email } : {}),
      resource: record.resource,
      workspaceId: record.workspaceId,
      scopes: record.scopes,
      expiresAt: 0,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ) {
    const record = await this.store.consumeRefreshToken(refreshToken);
    if (!record) {
      throw new InvalidGrantError("Unknown refresh token.");
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was issued to another client.");
    }
    if (record.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Refresh token has expired.");
    }

    const requestedScopes = scopes?.length ? this.resolveScopes(scopes) : record.scopes;
    for (const scope of requestedScopes) {
      if (!record.scopes.includes(scope)) {
        throw new InvalidScopeError("Requested scope exceeds the original grant.");
      }
    }

    if (!resource) {
      throw new InvalidTargetError("resource is required.");
    }

    const normalizedResource = canonicalizeUrl(resource);
    if (normalizedResource !== canonicalizeUrl(record.resource)) {
      throw new InvalidGrantError("resource does not match the refresh token.");
    }

    return this.issueTokens({
      ...record,
      scopes: requestedScopes,
    });
  }

  async verifyAccessToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: this.oauthMetadata.issuer,
      });
      return this.toAuthInfo(token, payload);
    } catch (error) {
      throw this.toInvalidTokenError(error);
    }
  }

  private readonly handleBrowserLogin: RequestHandler = async (req, res, next) => {
    try {
      const requestId = typeof req.query.request === "string" ? req.query.request : null;
      if (!requestId) {
        res.status(400).json({ error: "Missing request parameter." });
        return;
      }

      const authorizationRequest = await this.store.getAuthorizationRequest(requestId);
      if (!authorizationRequest) {
        res.status(400).json({ error: "Authorization request not found or expired." });
        return;
      }

      const existingSession = await this.getBrowserSession(req);
      if (existingSession) {
        await this.completeAuthorizationRequest(res, requestId, authorizationRequest, existingSession);
        return;
      }

      if (this.options.identityProvider.mode === "local") {
        this.renderLocalLoginPage(res, requestId);
        return;
      }

      const loginRequestId = createOpaqueToken(24);
      const nonce = createOpaqueToken(24);
      await this.store.storeLoginRequest(loginRequestId, {
        authorizationRequestId: requestId,
        nonce,
        createdAt: Date.now(),
      }, LOGIN_REQUEST_TTL_SECONDS);

      const authorizationUrl = await this.oidcClient!.createAuthorizationUrl({
        redirectUri: this.callbackUrl,
        state: loginRequestId,
        nonce,
      });
      res.redirect(302, authorizationUrl);
    } catch (error) {
      next(error);
    }
  };

  private readonly handleLocalLoginSubmit: RequestHandler = async (req, res, next) => {
    try {
      if (this.options.identityProvider.mode !== "local") {
        res.status(405).json({ error: "Local login is not enabled." });
        return;
      }

      const requestId = typeof req.body?.request === "string" ? req.body.request : null;
      if (!requestId) {
        res.status(400).json({ error: "Missing request parameter." });
        return;
      }

      const authorizationRequest = await this.store.getAuthorizationRequest(requestId);
      if (!authorizationRequest) {
        res.status(400).json({ error: "Authorization request not found or expired." });
        return;
      }

      const existingSession = await this.getBrowserSession(req);
      if (existingSession) {
        await this.completeAuthorizationRequest(res, requestId, authorizationRequest, existingSession);
        return;
      }

      const submittedUsername = typeof req.body?.username === "string" ? req.body.username.trim() : "";
      const submittedPassword = typeof req.body?.password === "string" ? req.body.password : "";
      const localIdentity = this.options.identityProvider;
      const isValidUsername = timingSafeEqual(submittedUsername, localIdentity.username);
      const isValidPassword = timingSafeEqual(submittedPassword, localIdentity.password);
      if (!isValidUsername || !isValidPassword) {
        this.renderLocalLoginPage(res.status(401), requestId, "Invalid username or password.");
        return;
      }

      const browserSessionId = createOpaqueToken(24);
      const expiresAt = Math.floor(Date.now() / 1000) + BROWSER_SESSION_TTL_SECONDS;
      const sessionRecord: BrowserSessionRecord = {
        sub: localIdentity.subject ?? localIdentity.username,
        ...(localIdentity.email ? { email: localIdentity.email } : {}),
        createdAt: Date.now(),
        expiresAt,
      };

      await this.store.storeBrowserSession(browserSessionId, sessionRecord, BROWSER_SESSION_TTL_SECONDS);
      this.setBrowserSessionCookie(res, browserSessionId);
      await this.completeAuthorizationRequest(res, requestId, authorizationRequest, sessionRecord);
    } catch (error) {
      next(error);
    }
  };

  private readonly handleOidcCallback: RequestHandler = async (req, res, next) => {
    try {
      if (this.options.identityProvider.mode !== "oidc") {
        res.status(405).json({ error: "OIDC callback is not enabled." });
        return;
      }

      const loginRequestId = typeof req.query.state === "string" ? req.query.state : null;
      if (!loginRequestId) {
        res.status(400).json({ error: "Missing state parameter." });
        return;
      }

      const loginRequest = await this.store.getLoginRequest(loginRequestId);
      if (!loginRequest) {
        res.status(400).json({ error: "Login request not found or expired." });
        return;
      }

      const authorizationRequest = await this.store.getAuthorizationRequest(loginRequest.authorizationRequestId);
      if (!authorizationRequest) {
        await this.store.deleteLoginRequest(loginRequestId);
        res.status(400).json({ error: "Authorization request not found or expired." });
        return;
      }

      const providerError = typeof req.query.error === "string" ? req.query.error : null;
      if (providerError) {
        await this.store.deleteLoginRequest(loginRequestId);
        this.redirectAuthorizationError(
          res,
          authorizationRequest,
          "access_denied",
          typeof req.query.error_description === "string"
            ? req.query.error_description
            : "External identity provider denied the request."
        );
        return;
      }

      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!code) {
        await this.store.deleteLoginRequest(loginRequestId);
        this.redirectAuthorizationError(
          res,
          authorizationRequest,
          "access_denied",
          "External identity provider did not return an authorization code."
        );
        return;
      }

      const oidcUser = await this.oidcClient!.exchangeCode({
        code,
        redirectUri: this.callbackUrl,
        nonce: loginRequest.nonce,
      });

      if (!oidcUser.email || !this.allowedEmails.has(oidcUser.email.toLowerCase())) {
        await this.store.deleteLoginRequest(loginRequestId);
        this.redirectAuthorizationError(
          res,
          authorizationRequest,
          "access_denied",
          "Authenticated email is not allowed for this MCP server."
        );
        return;
      }

      const browserSessionId = createOpaqueToken(24);
      const expiresAt = Math.floor(Date.now() / 1000) + BROWSER_SESSION_TTL_SECONDS;
      const sessionRecord: BrowserSessionRecord = {
        sub: oidcUser.sub,
        email: oidcUser.email,
        createdAt: Date.now(),
        expiresAt,
      };

      await this.store.storeBrowserSession(browserSessionId, sessionRecord, BROWSER_SESSION_TTL_SECONDS);
      await this.store.deleteLoginRequest(loginRequestId);
      this.setBrowserSessionCookie(res, browserSessionId);
      await this.completeAuthorizationRequest(
        res,
        loginRequest.authorizationRequestId,
        authorizationRequest,
        sessionRecord
      );
    } catch (error) {
      next(error);
    }
  };

  private async completeAuthorizationRequest(
    res: Response,
    requestId: string,
    authorizationRequest: AuthorizationRequestRecord,
    session: BrowserSessionRecord
  ) {
    const code = createOpaqueToken(32);
    const codeRecord: AuthorizationCodeRecord = {
      ...authorizationRequest,
      sub: session.sub,
      ...(session.email ? { email: session.email } : {}),
      expiresAt: Math.floor(Date.now() / 1000) + AUTHORIZATION_CODE_TTL_SECONDS,
    };

    await this.store.storeAuthorizationCode(code, codeRecord, AUTHORIZATION_CODE_TTL_SECONDS);
    await this.store.deleteAuthorizationRequest(requestId);

    const redirectUrl = new URL(authorizationRequest.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (authorizationRequest.state) {
      redirectUrl.searchParams.set("state", authorizationRequest.state);
    }
    res.redirect(302, redirectUrl.toString());
  }

  private redirectAuthorizationError(
    res: Response,
    authorizationRequest: AuthorizationRequestRecord,
    error: string,
    description: string
  ) {
    const redirectUrl = new URL(authorizationRequest.redirectUri);
    redirectUrl.searchParams.set("error", error);
    redirectUrl.searchParams.set("error_description", description);
    if (authorizationRequest.state) {
      redirectUrl.searchParams.set("state", authorizationRequest.state);
    }
    res.redirect(302, redirectUrl.toString());
  }

  private renderLocalLoginPage(res: Response, requestId: string, error?: string) {
    const escapedRequestId = escapeHtml(requestId);
    const escapedError = error ? escapeHtml(error) : "";
    const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP Login</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111827;
        color: #f9fafb;
      }
      .panel {
        width: min(28rem, calc(100vw - 2rem));
        padding: 2rem;
        border-radius: 1rem;
        background: rgba(17, 24, 39, 0.92);
        box-shadow: 0 30px 60px rgba(0, 0, 0, 0.35);
      }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; }
      p { margin: 0 0 1.5rem; color: #d1d5db; }
      label { display: block; margin: 0 0 0.35rem; font-weight: 600; }
      input {
        width: 100%;
        box-sizing: border-box;
        margin: 0 0 1rem;
        padding: 0.75rem 0.875rem;
        border: 1px solid #374151;
        border-radius: 0.75rem;
        background: #0f172a;
        color: inherit;
      }
      button {
        width: 100%;
        border: 0;
        border-radius: 0.75rem;
        padding: 0.85rem 1rem;
        font: inherit;
        font-weight: 700;
        background: #2563eb;
        color: white;
        cursor: pointer;
      }
      .error {
        margin: 0 0 1rem;
        padding: 0.75rem 0.875rem;
        border-radius: 0.75rem;
        background: rgba(220, 38, 38, 0.18);
        color: #fecaca;
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>Sign in to continue</h1>
      <p>This MCP server requires a scoped login before Claude can access the workspace tools.</p>
      ${error ? `<div class="error">${escapedError}</div>` : ""}
      <form method="post" action="/oauth/login">
        <input type="hidden" name="request" value="${escapedRequestId}" />
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`;

    res
      .status(res.statusCode >= 400 ? res.statusCode : 200)
      .type("html")
      .send(body);
  }

  private setBrowserSessionCookie(res: Response, sessionId: string) {
    res.cookie(BROWSER_SESSION_COOKIE, signCookieValue(sessionId, this.options.cookieSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: this.issuerUrl.protocol === "https:",
      path: "/",
      maxAge: BROWSER_SESSION_TTL_SECONDS * 1000,
    });
  }

  private clearBrowserSessionCookie(res: Response) {
    res.clearCookie(BROWSER_SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.issuerUrl.protocol === "https:",
      path: "/",
    });
  }

  private async getBrowserSession(req: Request) {
    const cookies = parseCookies(req.headers.cookie);
    const signedSessionId = cookies[BROWSER_SESSION_COOKIE];
    if (!signedSessionId) {
      return null;
    }

    const sessionId = unsignCookieValue(signedSessionId, this.options.cookieSecret);
    if (!sessionId) {
      this.clearBrowserSessionCookie(req.res!);
      return null;
    }

    const session = await this.store.getBrowserSession(sessionId);
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
      await this.store.deleteBrowserSession(sessionId);
      this.clearBrowserSessionCookie(req.res!);
      return null;
    }

    if (session.email && !this.allowedEmails.has(session.email.toLowerCase())) {
      await this.store.deleteBrowserSession(sessionId);
      this.clearBrowserSessionCookie(req.res!);
      return null;
    }

    return session;
  }

  private resolveScopes(requestedScopes?: string[]) {
    if (!requestedScopes || requestedScopes.length === 0) {
      return [DEFAULT_SCOPE];
    }

    const uniqueScopes = [...new Set(requestedScopes.filter(Boolean))];
    if (!uniqueScopes.includes(DEFAULT_SCOPE)) {
      throw new InvalidScopeError(`Requested scopes must include '${DEFAULT_SCOPE}'.`);
    }

    for (const scope of uniqueScopes) {
      if (!SUPPORTED_SCOPES.has(scope)) {
        throw new InvalidScopeError(`Unsupported scope '${scope}'.`);
      }
    }

    return uniqueScopes;
  }

  private resolveResource(resource?: URL) {
    if (!resource) {
      throw new InvalidTargetError("resource is required.");
    }

    const normalized = canonicalizeUrl(resource);
    const workspaceId = this.workspaceIdByResource.get(normalized);
    if (!workspaceId) {
      throw new InvalidTargetError("resource must reference an OAuth-enabled scoped MCP endpoint.");
    }
    return this.requireWorkspaceResource(workspaceId);
  }

  private requireWorkspaceResource(workspaceId: string) {
    const entry = this.resourcesByWorkspaceId.get(workspaceId);
    if (!entry) {
      throw new InvalidTargetError(`Workspace '${workspaceId}' is not OAuth-enabled.`);
    }
    return entry;
  }

  private async verifyWorkspaceAccessToken(token: string, entry: ResourceEntry): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: this.oauthMetadata.issuer,
        audience: entry.resourceUrl.toString(),
      });
      const authInfo = this.toAuthInfo(token, payload);
      if (authInfo.extra?.workspaceId !== entry.workspaceId) {
        throw new InvalidTokenError("workspace_id does not match the scoped endpoint.");
      }
      if (authInfo.resource?.toString() !== entry.resourceUrl.toString()) {
        throw new InvalidTokenError("Token audience does not match the scoped endpoint.");
      }
      return authInfo;
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw error;
      }
      throw this.toInvalidTokenError(error);
    }
  }

  private toInvalidTokenError(error: unknown) {
    const message = error instanceof Error ? error.message : "Access token validation failed.";
    return new InvalidTokenError(message);
  }

  private toAuthInfo(token: string, payload: Record<string, unknown>): AuthInfo {
    const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : null;
    const audience =
      typeof payload.aud === "string"
        ? payload.aud
        : Array.isArray(payload.aud) && typeof payload.aud[0] === "string"
          ? payload.aud[0]
          : null;

    if (!clientId || !workspaceId || !audience) {
      throw new InvalidTokenError("Token is missing required claims.");
    }

    return {
      token,
      clientId,
      scopes: scope.split(" ").filter(Boolean),
      expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
      resource: new URL(audience),
      extra: {
        workspaceId,
        ...(typeof payload.sub === "string" ? { sub: payload.sub } : {}),
        ...(typeof payload.email === "string" ? { email: payload.email } : {}),
      },
    };
  }

  private async issueTokens(record: RefreshTokenRecord): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({
      client_id: record.clientId,
      workspace_id: record.workspaceId,
      scope: record.scopes.join(" "),
      ...(record.email ? { email: record.email } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.oauthMetadata.issuer)
      .setSubject(record.sub)
      .setAudience(record.resource)
      .setIssuedAt(now)
      .setExpirationTime(now + this.options.accessTtlSeconds)
      .sign(this.jwtKey);

    const refreshToken = createOpaqueToken(32);
    const refreshExpiresAt = now + this.options.refreshTtlSeconds;
    await this.store.storeRefreshToken(
      refreshToken,
      {
        clientId: record.clientId,
        sub: record.sub,
        ...(record.email ? { email: record.email } : {}),
        resource: record.resource,
        workspaceId: record.workspaceId,
        scopes: record.scopes,
        expiresAt: refreshExpiresAt,
      },
      this.options.refreshTtlSeconds
    );

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.options.accessTtlSeconds,
      scope: record.scopes.join(" "),
      refresh_token: refreshToken,
    };
  }
}
