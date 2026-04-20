// Generische ENV-Parser für den LearnWeb-MCP-Connector.
// Enthält nur Parser, die vom OAuth-Stack oder von der HTTP-Konfiguration gebraucht werden.
// Notion-spezifische Workspace-Parser wurden beim Split in das neue Repo entfernt.

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type OAuthIdentityProviderMode = "oidc" | "local";

export type StaticOAuthClientConfig = {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
};

export type StaticOAuthClients = Record<string, StaticOAuthClientConfig>;

function success<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function failure(error: string): ParseResult<never> {
  return { ok: false, error };
}

/**
 * Parst eine kommagetrennte Liste ODER ein JSON-String-Array.
 * Liefert Fallback, wenn der Wert leer/undefiniert ist.
 */
export function parseStringList(
  value: string | undefined,
  fallback: string[] = [],
  envName = "value"
): ParseResult<string[]> {
  if (!value) {
    return success([...fallback]);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return success([...fallback]);
  }

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return failure(`${envName} must be a valid JSON string array or comma-separated list.`);
    }

    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      return failure(`${envName} must contain only non-empty strings.`);
    }

    return success(parsed.map((entry) => entry.trim()));
  }

  return success(
    trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

/**
 * Parst eine positive Ganzzahl aus einer ENV-Variable. Liefert `undefined`,
 * wenn die Variable nicht gesetzt oder leer ist.
 */
export function parsePositiveInt(
  value: string | undefined,
  envName = "value"
): ParseResult<number | undefined> {
  if (value == null) {
    return success(undefined);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return success(undefined);
  }

  if (!/^\d+$/.test(trimmed)) {
    return failure(`${envName} must be a positive integer.`);
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return failure(`${envName} must be a positive integer.`);
  }

  return success(parsed);
}

/**
 * Parst den OAuth-Identity-Provider-Modus. Erlaubt sind "oidc" und "local".
 */
export function parseOAuthIdentityProviderMode(
  raw: string | undefined,
  fallback: OAuthIdentityProviderMode
): ParseResult<OAuthIdentityProviderMode> {
  if (!raw || raw.trim() === "") {
    return success(fallback);
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized !== "oidc" && normalized !== "local") {
    return failure("MCP_OAUTH_IDENTITY_PROVIDER must be either 'oidc' or 'local'.");
  }

  return success(normalized);
}

/**
 * Parst MCP_OAUTH_STATIC_CLIENTS. Jeder Eintrag muss eine gültige
 * client_id und mindestens eine redirect_uri haben.
 */
export function parseStaticOAuthClients(raw: string | undefined): ParseResult<StaticOAuthClients> {
  if (!raw || raw.trim() === "") {
    return success({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("MCP_OAUTH_STATIC_CLIENTS must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("MCP_OAUTH_STATIC_CLIENTS must be a JSON object map.");
  }

  const clients: StaticOAuthClients = {};
  const seenClientIds = new Set<string>();

  for (const [entryKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failure(`MCP_OAUTH_STATIC_CLIENTS entry '${entryKey}' must be an object.`);
    }

    const typed = value as Record<string, unknown>;
    const clientId = typed.client_id;
    const clientSecret = typed.client_secret;
    const redirectUris = typed.redirect_uris;
    const clientName = typed.client_name;
    const scope = typed.scope;

    if (typeof clientId !== "string" || clientId.trim() === "") {
      return failure(`MCP_OAUTH_STATIC_CLIENTS entry '${entryKey}' must include a non-empty client_id.`);
    }
    if (seenClientIds.has(clientId.trim())) {
      return failure(`Duplicate OAuth client_id '${clientId.trim()}' in MCP_OAUTH_STATIC_CLIENTS.`);
    }
    seenClientIds.add(clientId.trim());

    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((redirectUri) => typeof redirectUri !== "string" || !URL.canParse(redirectUri))
    ) {
      return failure(
        `MCP_OAUTH_STATIC_CLIENTS entry '${entryKey}' must include redirect_uris as a non-empty array of URLs.`
      );
    }

    if (clientSecret != null && (typeof clientSecret !== "string" || clientSecret.trim() === "")) {
      return failure(`MCP_OAUTH_STATIC_CLIENTS entry '${entryKey}' has an invalid client_secret.`);
    }

    if (clientName != null && (typeof clientName !== "string" || clientName.trim() === "")) {
      return failure(`MCP_OAUTH_STATIC_CLIENTS entry '${entryKey}' has an invalid client_name.`);
    }

    if (scope != null && (typeof scope !== "string" || scope.trim() === "")) {
      return failure(`MCP_OAUTH_STATIC_CLIENTS entry '${entryKey}' has an invalid scope.`);
    }

    clients[entryKey] = {
      client_id: clientId.trim(),
      ...(typeof clientSecret === "string" ? { client_secret: clientSecret.trim() } : {}),
      redirect_uris: redirectUris.map((redirectUri) => redirectUri.trim()),
      ...(typeof clientName === "string" ? { client_name: clientName.trim() } : {}),
      ...(typeof scope === "string" ? { scope: scope.trim() } : {}),
    };
  }

  return success(clients);
}
