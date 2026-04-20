// Zentrale ENV-Konfiguration für den LearnWeb-MCP-Connector.
// Liest alle relevanten Variablen beim Modul-Import und validiert sie.
// Wirft bei ungültiger Konfiguration direkt einen Fehler — der Server startet dann nicht.

import dotenv from "dotenv";
import {
  parseOAuthIdentityProviderMode,
  parsePositiveInt,
  parseStaticOAuthClients,
  parseStringList,
  type OAuthIdentityProviderMode,
  type ParseResult,
  type StaticOAuthClients,
} from "./config-utils";

dotenv.config();

export type {
  OAuthIdentityProviderMode,
  StaticOAuthClientConfig,
  StaticOAuthClients,
} from "./config-utils";

function unwrapOrThrow<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function parsePositiveIntWithFallback(
  value: string | undefined,
  fallback: number,
  envName: string
): number {
  const result = parsePositiveInt(value, envName);
  if (!result.ok) {
    return fallback;
  }
  return result.value ?? fallback;
}

function parseOptionalUrl(value: string | undefined, envName: string): URL | undefined {
  if (!value || value.trim() === "") {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${envName} must be a valid absolute URL.`);
  }

  // Nur Base-URL akzeptieren — Pfadteile würden OAuth-Metadaten brechen.
  parsed.hash = "";
  parsed.search = "";
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(`${envName} must not include a path component.`);
  }
  parsed.pathname = "/";
  return parsed;
}

// ──────────────────────────────────────────────────────────────────────
// Transport & HTTP
// ──────────────────────────────────────────────────────────────────────

export const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "stdio") as "stdio" | "http";

// Railway setzt PORT automatisch — überschreibt MCP_HTTP_PORT, falls gesetzt.
const MCP_HTTP_PORT_OVERRIDE = parsePositiveIntWithFallback(process.env.PORT, 0, "PORT");
export const MCP_HTTP_PORT =
  MCP_HTTP_PORT_OVERRIDE > 0
    ? MCP_HTTP_PORT_OVERRIDE
    : parsePositiveIntWithFallback(process.env.MCP_HTTP_PORT, 3001, "MCP_HTTP_PORT");

// Default: 0.0.0.0 wenn Railway (PORT gesetzt), sonst 127.0.0.1 für lokale Dev.
export const MCP_HTTP_HOST =
  process.env.MCP_HTTP_HOST?.trim() || (MCP_HTTP_PORT_OVERRIDE > 0 ? "0.0.0.0" : "127.0.0.1");

export const MCP_ALLOWED_HOSTS = unwrapOrThrow(
  parseStringList(process.env.MCP_ALLOWED_HOSTS, [], "MCP_ALLOWED_HOSTS")
);

// Default-CORS-Origins für claude.ai-Connectors — eigene Railway-Domain muss
// zusätzlich gesetzt werden (sonst brechen Login-Formular-POSTs mit 403).
export const MCP_ALLOWED_ORIGINS = unwrapOrThrow(
  parseStringList(
    process.env.MCP_ALLOWED_ORIGINS,
    [
      "https://claude.ai",
      "https://claudeusercontent.com",
      "https://chatgpt.com",
      "https://chat.openai.com",
    ],
    "MCP_ALLOWED_ORIGINS"
  )
);

// ──────────────────────────────────────────────────────────────────────
// Learnweb (Moodle) Zugangsdaten
// Die Tools werden nur registriert, wenn Username UND Passwort gesetzt sind
// UND der Transport stdio oder der Scope 'learnweb' ist (siehe tools/learnweb.ts).
// ──────────────────────────────────────────────────────────────────────

export const LEARNWEB_URL = process.env.LEARNWEB_URL?.trim().replace(/\/+$/, "") || undefined;
export const LEARNWEB_USERNAME = process.env.LEARNWEB_USERNAME?.trim() || undefined;
// Passwort wird bewusst nicht getrimmt — führende/abschließende Leerzeichen dürfen zum Passwort gehören.
export const LEARNWEB_PASSWORD = process.env.LEARNWEB_PASSWORD || undefined;

// ──────────────────────────────────────────────────────────────────────
// OAuth-geschützter /mcp/learnweb-Endpoint
// Im HTTP-Modus sollte das Flag aktiv sein; im stdio-Modus ist es ohne Wirkung.
// Default: true (der Connector wird produktiv nur via HTTP+OAuth betrieben).
// ──────────────────────────────────────────────────────────────────────

export const MCP_LEARNWEB_ENDPOINT_ENABLED =
  process.env.MCP_LEARNWEB_ENDPOINT_ENABLED?.trim().toLowerCase() !== "false";

// ──────────────────────────────────────────────────────────────────────
// OAuth-Server-Konfiguration
// ──────────────────────────────────────────────────────────────────────

export const MCP_PUBLIC_BASE_URL = parseOptionalUrl(process.env.MCP_PUBLIC_BASE_URL, "MCP_PUBLIC_BASE_URL");

export const MCP_OAUTH_STATIC_CLIENTS: StaticOAuthClients = unwrapOrThrow(
  parseStaticOAuthClients(process.env.MCP_OAUTH_STATIC_CLIENTS)
);

export const MCP_OAUTH_COOKIE_SECRET = process.env.MCP_OAUTH_COOKIE_SECRET?.trim() || undefined;
export const MCP_OAUTH_JWT_SECRET = process.env.MCP_OAUTH_JWT_SECRET?.trim() || undefined;

export const MCP_OAUTH_ACCESS_TTL_SECONDS = parsePositiveIntWithFallback(
  process.env.MCP_OAUTH_ACCESS_TTL_SECONDS,
  600,
  "MCP_OAUTH_ACCESS_TTL_SECONDS"
);
export const MCP_OAUTH_REFRESH_TTL_SECONDS = parsePositiveIntWithFallback(
  process.env.MCP_OAUTH_REFRESH_TTL_SECONDS,
  2_592_000,
  "MCP_OAUTH_REFRESH_TTL_SECONDS"
);

export const MCP_OAUTH_ALLOWED_EMAILS = unwrapOrThrow(
  parseStringList(process.env.MCP_OAUTH_ALLOWED_EMAILS, [], "MCP_OAUTH_ALLOWED_EMAILS")
);

// Default-Provider: local, wenn LOCAL_LOGIN-Credentials gesetzt sind, sonst oidc.
const DEFAULT_OAUTH_IDENTITY_PROVIDER: OAuthIdentityProviderMode =
  process.env.MCP_OAUTH_LOCAL_LOGIN_USERNAME || process.env.MCP_OAUTH_LOCAL_LOGIN_PASSWORD ? "local" : "oidc";
export const MCP_OAUTH_IDENTITY_PROVIDER = unwrapOrThrow(
  parseOAuthIdentityProviderMode(process.env.MCP_OAUTH_IDENTITY_PROVIDER, DEFAULT_OAUTH_IDENTITY_PROVIDER)
);

export const OIDC_ISSUER_URL = parseOptionalUrl(process.env.OIDC_ISSUER_URL, "OIDC_ISSUER_URL");
export const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID?.trim() || undefined;
export const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET?.trim() || undefined;

export const MCP_OAUTH_LOCAL_LOGIN_USERNAME =
  process.env.MCP_OAUTH_LOCAL_LOGIN_USERNAME?.trim() || undefined;
export const MCP_OAUTH_LOCAL_LOGIN_PASSWORD = process.env.MCP_OAUTH_LOCAL_LOGIN_PASSWORD || undefined;
export const MCP_OAUTH_LOCAL_LOGIN_SUB = process.env.MCP_OAUTH_LOCAL_LOGIN_SUB?.trim() || undefined;
export const MCP_OAUTH_LOCAL_LOGIN_EMAIL = process.env.MCP_OAUTH_LOCAL_LOGIN_EMAIL?.trim() || undefined;

export const MCP_OAUTH_ALLOW_IN_MEMORY_STORE =
  process.env.MCP_OAUTH_ALLOW_IN_MEMORY_STORE?.trim().toLowerCase() === "true";

export const REDIS_URL = process.env.REDIS_URL?.trim() || undefined;

// ──────────────────────────────────────────────────────────────────────
// Validierung
// Wenn im HTTP-Modus der Learnweb-Endpoint aktiv ist, muss OAuth vollständig
// konfiguriert sein. Stdio-Modus braucht keine OAuth-Konfiguration.
// ──────────────────────────────────────────────────────────────────────

const OAUTH_REQUIRED = MCP_TRANSPORT === "http" && MCP_LEARNWEB_ENDPOINT_ENABLED;

if (OAUTH_REQUIRED) {
  if (!MCP_PUBLIC_BASE_URL) {
    throw new Error("MCP_PUBLIC_BASE_URL is required when the /mcp/learnweb endpoint is enabled.");
  }
  if (Object.keys(MCP_OAUTH_STATIC_CLIENTS).length === 0) {
    throw new Error("MCP_OAUTH_STATIC_CLIENTS is required when the /mcp/learnweb endpoint is enabled.");
  }
  if (!MCP_OAUTH_COOKIE_SECRET) {
    throw new Error("MCP_OAUTH_COOKIE_SECRET is required when the /mcp/learnweb endpoint is enabled.");
  }
  if (!MCP_OAUTH_JWT_SECRET) {
    throw new Error("MCP_OAUTH_JWT_SECRET is required when the /mcp/learnweb endpoint is enabled.");
  }
  if (MCP_OAUTH_IDENTITY_PROVIDER === "oidc") {
    if (MCP_OAUTH_ALLOWED_EMAILS.length === 0) {
      throw new Error(
        "MCP_OAUTH_ALLOWED_EMAILS must include at least one email when using the oidc identity provider."
      );
    }
    if (!OIDC_ISSUER_URL) {
      throw new Error("OIDC_ISSUER_URL is required when using the oidc identity provider.");
    }
    if (!OIDC_CLIENT_ID) {
      throw new Error("OIDC_CLIENT_ID is required when using the oidc identity provider.");
    }
    if (!OIDC_CLIENT_SECRET) {
      throw new Error("OIDC_CLIENT_SECRET is required when using the oidc identity provider.");
    }
  }
  if (MCP_OAUTH_IDENTITY_PROVIDER === "local") {
    if (!MCP_OAUTH_LOCAL_LOGIN_USERNAME) {
      throw new Error(
        "MCP_OAUTH_LOCAL_LOGIN_USERNAME is required when using the local identity provider."
      );
    }
    if (!MCP_OAUTH_LOCAL_LOGIN_PASSWORD) {
      throw new Error(
        "MCP_OAUTH_LOCAL_LOGIN_PASSWORD is required when using the local identity provider."
      );
    }
  }
  if (process.env.NODE_ENV === "production" && !REDIS_URL && !MCP_OAUTH_ALLOW_IN_MEMORY_STORE) {
    throw new Error(
      "REDIS_URL is required in production when OAuth is enabled, unless MCP_OAUTH_ALLOW_IN_MEMORY_STORE=true is set as an explicit fallback."
    );
  }
}

if (process.env.NODE_ENV === "production" && OAUTH_REQUIRED && !REDIS_URL && MCP_OAUTH_ALLOW_IN_MEMORY_STORE) {
  console.warn(
    "OAuth is running with the in-memory store fallback in production. Auth codes, refresh tokens, and browser sessions will reset on redeploy or restart."
  );
}
