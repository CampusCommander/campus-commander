import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  identitySchema,
  type Permission,
  type Preferences,
  type SessionResponse,
} from '@campus/application-contracts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import * as oidc from 'openid-client';
import { ConfigurationService } from '../configuration/configuration.service';
import { DatabaseService } from '../database/database.service';
import { CacheService } from '../cache/cache.service';

const sessionSchema = z.strictObject({
  principalId: z.uuid(),
  permissionVersion: z.number().int(),
  expiresAt: z.number().int(),
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
});
const loginSchema = z.strictObject({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
});
export const sessionCookie = '__Host-cc-session';
export const loginCookie = '__Host-cc-login';
const opaqueToken = () => randomBytes(32).toString('hex');
const key = (kind: string, token: string) =>
  `cc:auth:${kind}:${createHash('sha256').update(token).digest('hex')}`;

export function equalToken(
  actual: string | undefined,
  expected: string,
): boolean {
  return (
    typeof actual === 'string' &&
    /^[a-f0-9]{64}$/.test(actual) &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

@Injectable()
export class AuthService {
  private discovery?: Promise<oidc.Configuration>;

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly database: DatabaseService,
    private readonly cache: CacheService,
  ) {}

  private provider() {
    const auth = this.configuration.auth;
    this.discovery ??= oidc
      .discovery(
        new URL(auth.issuer),
        auth.clientId,
        this.configuration
          .secret(auth.clientSecretRef)
          .toString('utf8')
          .replace(/\r?\n$/, ''),
        undefined,
        { timeout: 5 },
      )
      .catch((error: unknown) => {
        this.discovery = undefined;
        throw error;
      });
    return this.discovery;
  }

  async start(correlationId: string) {
    const provider = await this.provider();
    const login = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    const token = opaqueToken();
    const url = oidc.buildAuthorizationUrl(provider, {
      redirect_uri: `${this.configuration.auth.publicOrigin}/api/auth/callback`,
      scope: 'openid profile',
      response_type: 'code',
      state: login.state,
      nonce: login.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(login.verifier),
      code_challenge_method: 'S256',
    });
    await this.database.audit('login-started', correlationId);
    await this.cache.set(key('login', token), JSON.stringify(login), 300);
    return { token, url: url.href };
  }

  async callback(
    originalUrl: string,
    cookie: string | undefined,
    correlationId: string,
  ) {
    const token = readCookie(cookie, loginCookie);
    if (!token) throw new UnauthorizedException('The sign-in request expired.');
    const raw = await this.cache.consume(key('login', token));
    if (!raw) throw new UnauthorizedException('The sign-in request expired.');
    const login = loginSchema.parse(JSON.parse(raw));
    const current = new URL(originalUrl, this.configuration.auth.publicOrigin);
    if (
      current.origin !== this.configuration.auth.publicOrigin ||
      current.pathname !== '/api/auth/callback'
    )
      throw new UnauthorizedException();
    const tokens = await oidc.authorizationCodeGrant(
      await this.provider(),
      current,
      {
        expectedState: login.state,
        expectedNonce: login.nonce,
        pkceCodeVerifier: login.verifier,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (!claims?.sub) throw new UnauthorizedException();
    const result = await this.database.connection.query(
      'SELECT id,permission_version FROM cc.application_principals WHERE issuer=$1 AND subject=$2 AND enabled',
      [this.configuration.auth.issuer, claims.sub],
    );
    if (!result.rowCount) {
      throw new ForbiddenException(
        'This identity does not have application access.',
      );
    }
    const principal = result.rows[0];
    const session = sessionSchema.parse({
      principalId: principal.id,
      permissionVersion: principal.permission_version,
      expiresAt:
        Date.now() + this.configuration.auth.sessionLifetimeSeconds * 1000,
      csrfToken: opaqueToken(),
    });
    const sessionToken = opaqueToken();
    await this.database.audit(
      'login-succeeded',
      correlationId,
      session.principalId,
    );
    await this.cache.set(
      key('session', sessionToken),
      JSON.stringify(session),
      Math.min(
        this.configuration.auth.sessionIdleSeconds,
        this.configuration.auth.sessionLifetimeSeconds,
      ),
    );
    return {
      token: sessionToken,
      seconds: this.configuration.auth.sessionLifetimeSeconds,
    };
  }

  async authenticate(
    cookie: string | undefined,
    permission: Permission,
    correlationId: string,
  ): Promise<SessionResponse> {
    const token = readCookie(cookie, sessionCookie);
    if (!token) throw new UnauthorizedException('Sign in to continue.');
    const raw = await this.cache.get(key('session', token));
    if (!raw)
      throw new UnauthorizedException('Your session expired. Sign in again.');
    const session = sessionSchema.parse(JSON.parse(raw));
    if (session.expiresAt <= Date.now()) {
      await this.cache.remove(key('session', token));
      await this.database.audit(
        'session-expired',
        correlationId,
        session.principalId,
      );
      throw new UnauthorizedException('Your session expired. Sign in again.');
    }
    const result = await this.database.connection.query(
      'SELECT * FROM cc.application_principals WHERE id=$1 AND enabled',
      [session.principalId],
    );
    const principal = result.rows[0];
    if (
      !principal ||
      principal.permission_version !== session.permissionVersion
    ) {
      await this.cache.remove(key('session', token));
      throw new UnauthorizedException(
        'Application access changed. Sign in again.',
      );
    }
    const identity = identitySchema.parse({
      id: principal.id,
      displayName: principal.display_name,
      permissions: principal.permissions,
      preferences: principal.preferences,
    });
    if (!identity.permissions.includes(permission)) {
      await this.database.audit(
        'access-denied',
        correlationId,
        identity.id,
        permission,
      );
      throw new ForbiddenException(
        'This action requires additional permission.',
      );
    }
    const retained = await this.cache.expire(
      key('session', token),
      Math.max(
        1,
        Math.min(
          this.configuration.auth.sessionIdleSeconds,
          Math.floor((session.expiresAt - Date.now()) / 1000),
        ),
      ),
    );
    if (!retained)
      throw new UnauthorizedException('Your session expired. Sign in again.');
    return {
      identity,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async recordDeniedLogin(correlationId: string) {
    await this.database.audit('login-denied', correlationId);
  }

  async recordDeniedRequest(correlationId: string, actorId: string) {
    await this.database.audit(
      'access-denied',
      correlationId,
      actorId,
      'browser-security',
    );
  }

  async logout(
    cookie: string | undefined,
    session: SessionResponse,
    correlationId: string,
  ) {
    const token = readCookie(cookie, sessionCookie);
    if (token) await this.cache.remove(key('session', token));
    await this.database.audit('logout', correlationId, session.identity.id);
  }

  async preferences(
    session: SessionResponse,
    preferences: Preferences,
    correlationId: string,
  ) {
    await this.database.transaction(async (client) => {
      await client.query(
        'UPDATE cc.application_principals SET preferences=$1 WHERE id=$2 AND enabled',
        [preferences, session.identity.id],
      );
      await this.database.audit(
        'preferences-changed',
        correlationId,
        session.identity.id,
        undefined,
        client,
      );
    });
    return preferences;
  }
}
