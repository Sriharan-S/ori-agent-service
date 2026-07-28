import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Application, EndUser } from './identity';

/** What the application sends in `X-End-User` when it asserts identity. */
export interface AssertedEndUser {
  id: string;
  role: string;
  scopes?: Record<string, string | number>;
  displayName?: string;
  email?: string;
}

type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

/**
 * Establishes who the end user is, in whichever mode the application is
 * configured for.
 *
 * **jwt** — the application forwards the end user's token and the agent
 * verifies it against that application's issuer and JWKS. Identity is proven,
 * so a compromised host cannot impersonate a user it does not have a token for.
 *
 * **asserted** — the application states who the user is, and the agent believes
 * it because the API key authenticated the channel. This is a real reduction in
 * guarantee and it is worth naming precisely: the trust boundary becomes the
 * API key, so an API key that reaches a browser becomes an impersonation
 * primitive for every user of that application.
 *
 * What neither mode has is a fallback. There is no anonymous path, no default
 * role, and no way to reach the orchestrator without an identity — an
 * unresolvable caller gets a 401.
 */
@Injectable()
export class EndUserResolverService {
  private readonly logger = new Logger(EndUserResolverService.name);
  private readonly jwks = new Map<string, JwksResolver>();

  async resolve(
    application: Application,
    headers: {
      endUserToken?: string;
      assertedEndUser?: string;
    },
  ): Promise<EndUser> {
    return application.endUserAuth === 'jwt'
      ? this.fromToken(application, headers.endUserToken)
      : this.fromAssertion(headers.assertedEndUser);
  }

  private async fromToken(
    application: Application,
    token: string | undefined,
  ): Promise<EndUser> {
    if (!token) {
      throw new UnauthorizedException(
        `Application "${application.slug}" is configured for JWT end-user auth; ` +
          'an X-End-User-Token header is required.',
      );
    }

    if (!application.jwtJwksUrl) {
      // Misconfiguration, not a caller error — but it must not fall back to
      // trusting the token unverified.
      this.logger.error(
        `Application ${application.slug} uses jwt auth with no jwks url configured`,
      );
      throw new UnauthorizedException(
        'End-user token verification is not configured for this application',
      );
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(
        token.replace(/^Bearer\s+/i, ''),
        this.getJwks(application.jwtJwksUrl),
        {
          ...(application.jwtIssuer ? { issuer: application.jwtIssuer } : {}),
          ...(application.jwtAudience
            ? { audience: application.jwtAudience }
            : {}),
        },
      );
      payload = verified.payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/exp|expired/i.test(message)) {
        throw new UnauthorizedException('End-user token expired');
      }
      this.logger.warn(
        `End-user token verification failed for ${application.slug}: ${message}`,
      );
      throw new UnauthorizedException('Invalid end-user token');
    }

    const id = readClaim(payload, application.jwtSubjectClaim);
    if (!id) {
      throw new UnauthorizedException(
        `End-user token has no "${application.jwtSubjectClaim}" claim to identify the user.`,
      );
    }

    const role = application.jwtRoleClaim
      ? readClaim(payload, application.jwtRoleClaim)
      : null;
    if (!role) {
      throw new UnauthorizedException(
        'End-user token carries no role claim, and this application reads the role from the token.',
      );
    }

    const scopes: Record<string, string | number> = {};
    for (const [key, claim] of Object.entries(application.jwtScopeClaims)) {
      const value = readClaim(payload, claim);
      if (value !== null) {
        scopes[key] = /^-?\d+$/.test(value) ? Number(value) : value;
      }
    }

    return {
      id: String(id),
      role: String(role),
      scopes,
      ...(typeof payload.name === 'string' ? { displayName: payload.name } : {}),
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      token,
    };
  }

  private fromAssertion(raw: string | undefined): EndUser {
    if (!raw) {
      throw new UnauthorizedException(
        'An X-End-User header is required: this application asserts end-user identity.',
      );
    }

    let parsed: AssertedEndUser;
    try {
      parsed = JSON.parse(raw) as AssertedEndUser;
    } catch {
      throw new BadRequestException('X-End-User must be valid JSON');
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException('X-End-User must be a JSON object');
    }
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
      throw new BadRequestException('X-End-User.id is required');
    }
    if (typeof parsed.role !== 'string' || parsed.role.trim() === '') {
      throw new BadRequestException('X-End-User.role is required');
    }

    const scopes: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(parsed.scopes ?? {})) {
      if (typeof value === 'string' || typeof value === 'number') {
        scopes[key] = value;
      }
    }

    return {
      id: parsed.id.trim(),
      role: parsed.role.trim(),
      scopes,
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
      ...(parsed.email ? { email: parsed.email } : {}),
    };
  }

  /** JWKS sets are cached per URL; `jose` handles key rotation and caching. */
  private getJwks(url: string): JwksResolver {
    const existing = this.jwks.get(url);
    if (existing) return existing;

    const resolver = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30 * 1000,
    });
    this.jwks.set(url, resolver);
    return resolver;
  }
}

/** Reads a claim, supporting dotted paths like `custom.org_id`. */
function readClaim(payload: JWTPayload, path: string): string | null {
  const parts = path.split('.');
  let current: unknown = payload;

  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === 'string' || typeof current === 'number') {
    return String(current);
  }
  return null;
}
