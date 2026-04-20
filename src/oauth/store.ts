import crypto from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export type AuthorizationRequestRecord = {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource: string;
  workspaceId: string;
  scopes: string[];
  createdAt: number;
};

export type AuthorizationCodeRecord = AuthorizationRequestRecord & {
  sub: string;
  email?: string;
  expiresAt: number;
};

export type RefreshTokenRecord = {
  clientId: string;
  sub: string;
  email?: string;
  resource: string;
  workspaceId: string;
  scopes: string[];
  expiresAt: number;
};

export type LoginRequestRecord = {
  authorizationRequestId: string;
  nonce: string;
  createdAt: number;
};

export type BrowserSessionRecord = {
  sub: string;
  email?: string;
  createdAt: number;
  expiresAt: number;
};

type InMemoryEntry = {
  payload: string;
  expiresAt: number;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export class OAuthStore {
  private readonly redis?: RedisClientType;

  private readonly ready: Promise<void>;

  private readonly memory = new Map<string, InMemoryEntry>();

  constructor(redisUrl?: string) {
    if (redisUrl) {
      this.redis = createClient({ url: redisUrl });
      this.redis.on("error", (error) => {
        console.error("OAuth store Redis error:", error);
      });
      this.ready = this.redis.connect().then(() => undefined);
      return;
    }

    this.ready = Promise.resolve();
  }

  async close() {
    await this.ready;
    if (this.redis) {
      await this.redis.quit();
    }
  }

  async storeAuthorizationRequest(requestId: string, record: AuthorizationRequestRecord, ttlSeconds: number) {
    await this.setJson(`oauth:authorization-request:${requestId}`, record, ttlSeconds);
  }

  async getAuthorizationRequest(requestId: string) {
    return this.getJson<AuthorizationRequestRecord>(`oauth:authorization-request:${requestId}`);
  }

  async deleteAuthorizationRequest(requestId: string) {
    await this.deleteKey(`oauth:authorization-request:${requestId}`);
  }

  async storeLoginRequest(loginRequestId: string, record: LoginRequestRecord, ttlSeconds: number) {
    await this.setJson(`oauth:login-request:${loginRequestId}`, record, ttlSeconds);
  }

  async getLoginRequest(loginRequestId: string) {
    return this.getJson<LoginRequestRecord>(`oauth:login-request:${loginRequestId}`);
  }

  async deleteLoginRequest(loginRequestId: string) {
    await this.deleteKey(`oauth:login-request:${loginRequestId}`);
  }

  async storeBrowserSession(sessionId: string, record: BrowserSessionRecord, ttlSeconds: number) {
    await this.setJson(`oauth:browser-session:${sessionId}`, record, ttlSeconds);
  }

  async getBrowserSession(sessionId: string) {
    return this.getJson<BrowserSessionRecord>(`oauth:browser-session:${sessionId}`);
  }

  async deleteBrowserSession(sessionId: string) {
    await this.deleteKey(`oauth:browser-session:${sessionId}`);
  }

  async storeAuthorizationCode(code: string, record: AuthorizationCodeRecord, ttlSeconds: number) {
    await this.setJson(`oauth:authorization-code:${hashOpaqueToken(code)}`, record, ttlSeconds);
  }

  async getAuthorizationCode(code: string) {
    return this.getJson<AuthorizationCodeRecord>(`oauth:authorization-code:${hashOpaqueToken(code)}`);
  }

  async consumeAuthorizationCode(code: string) {
    const key = `oauth:authorization-code:${hashOpaqueToken(code)}`;
    const record = await this.getJson<AuthorizationCodeRecord>(key);
    if (record) {
      await this.deleteKey(key);
    }
    return record;
  }

  async storeRefreshToken(refreshToken: string, record: RefreshTokenRecord, ttlSeconds: number) {
    await this.setJson(`oauth:refresh-token:${hashOpaqueToken(refreshToken)}`, record, ttlSeconds);
  }

  async getRefreshToken(refreshToken: string) {
    return this.getJson<RefreshTokenRecord>(`oauth:refresh-token:${hashOpaqueToken(refreshToken)}`);
  }

  async consumeRefreshToken(refreshToken: string) {
    const key = `oauth:refresh-token:${hashOpaqueToken(refreshToken)}`;
    const record = await this.getJson<RefreshTokenRecord>(key);
    if (record) {
      await this.deleteKey(key);
    }
    return record;
  }

  async revokeRefreshToken(refreshToken: string) {
    await this.deleteKey(`oauth:refresh-token:${hashOpaqueToken(refreshToken)}`);
  }

  private async setJson(key: string, value: unknown, ttlSeconds: number) {
    await this.ready;

    if (this.redis) {
      await this.redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
      return;
    }

    this.memory.set(key, {
      payload: JSON.stringify(value),
      expiresAt: nowSeconds() + ttlSeconds,
    });
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    await this.ready;

    if (this.redis) {
      const payload = await this.redis.get(key);
      if (!payload) {
        return undefined;
      }
      return JSON.parse(payload) as T;
    }

    const entry = this.memory.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= nowSeconds()) {
      this.memory.delete(key);
      return undefined;
    }

    return JSON.parse(entry.payload) as T;
  }

  private async deleteKey(key: string) {
    await this.ready;

    if (this.redis) {
      await this.redis.del(key);
      return;
    }

    this.memory.delete(key);
  }
}
