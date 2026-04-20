import { createRemoteJWKSet, jwtVerify } from "jose";

type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  token_endpoint_auth_methods_supported?: string[];
};

type OidcTokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
};

type OidcUserInfo = {
  sub: string;
  email?: string;
  claims: Record<string, unknown>;
};

function buildDiscoveryUrl(issuerUrl: string): URL {
  const issuer = new URL(issuerUrl);
  return new URL("/.well-known/openid-configuration", issuer);
}

export class OidcClient {
  private metadataPromise?: Promise<OidcMetadata>;

  constructor(
    private readonly issuerUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {}

  async createAuthorizationUrl(options: { redirectUri: string; state: string; nonce: string }) {
    const metadata = await this.getMetadata();
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", options.state);
    url.searchParams.set("nonce", options.nonce);
    return url.toString();
  }

  async exchangeCode(options: { code: string; redirectUri: string; nonce?: string }): Promise<OidcUserInfo> {
    const metadata = await this.getMetadata();
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: this.clientId,
    });

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const supportedAuthMethods = metadata.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (supportedAuthMethods.includes("client_secret_post")) {
      params.set("client_secret", this.clientSecret);
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    }

    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers,
      body: params.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OIDC token exchange failed: ${response.status} ${text}`.trim());
    }

    const tokenResponse = (await response.json()) as OidcTokenResponse;
    let claims: Record<string, unknown> = {};

    if (typeof tokenResponse.id_token === "string" && metadata.jwks_uri) {
      const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
      const { payload } = await jwtVerify(tokenResponse.id_token, jwks, {
        issuer: metadata.issuer,
        audience: this.clientId,
      });
      if (options.nonce && typeof payload.nonce === "string" && payload.nonce !== options.nonce) {
        throw new Error("OIDC nonce mismatch.");
      }
      claims = payload as Record<string, unknown>;
    }

    if ((!claims.sub || !claims.email) && metadata.userinfo_endpoint && typeof tokenResponse.access_token === "string") {
      const userInfoResponse = await fetch(metadata.userinfo_endpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${tokenResponse.access_token}`,
        },
      });
      if (!userInfoResponse.ok) {
        const text = await userInfoResponse.text().catch(() => "");
        throw new Error(`OIDC userinfo lookup failed: ${userInfoResponse.status} ${text}`.trim());
      }
      const userInfo = (await userInfoResponse.json()) as Record<string, unknown>;
      claims = { ...userInfo, ...claims };
    }

    if (typeof claims.sub !== "string" || claims.sub.trim() === "") {
      throw new Error("OIDC response is missing a usable 'sub' claim.");
    }

    return {
      sub: claims.sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      claims,
    };
  }

  private async getMetadata(): Promise<OidcMetadata> {
    if (!this.metadataPromise) {
      this.metadataPromise = this.fetchMetadata();
    }
    return this.metadataPromise;
  }

  private async fetchMetadata(): Promise<OidcMetadata> {
    const response = await fetch(buildDiscoveryUrl(this.issuerUrl), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OIDC discovery failed: ${response.status} ${text}`.trim());
    }

    const metadata = (await response.json()) as OidcMetadata;
    if (
      typeof metadata.issuer !== "string" ||
      typeof metadata.authorization_endpoint !== "string" ||
      typeof metadata.token_endpoint !== "string"
    ) {
      throw new Error("OIDC discovery response is missing required endpoints.");
    }

    return metadata;
  }
}
