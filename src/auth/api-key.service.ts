import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { ApiKeyRecord, ApiKeyScope, Application } from './identity';

interface KeyRow {
  id: string;
  application_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  scopes: string[];
  revoked_at: Date | null;
  app_slug: string;
  app_name: string;
  end_user_auth: string;
  jwt_issuer: string | null;
  jwt_jwks_url: string | null;
  jwt_audience: string | null;
  jwt_subject_claim: string;
  jwt_role_claim: string | null;
  jwt_scope_claims: Record<string, string>;
  app_is_active: boolean;
}

export interface IssuedKey {
  record: ApiKeyRecord;
  /** Shown once, at creation. Never recoverable afterwards. */
  secret: string;
}

const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;

/**
 * API keys authenticate the *calling application*, not a person.
 *
 * Storage: a short random prefix in clear (for lookup and for showing the
 * operator which key is which) and a SHA-256 of the full secret. SHA-256 rather
 * than a slow KDF is deliberate — these are 192 bits of machine-generated
 * randomness, so there is no dictionary to defend against, and key checks sit
 * on the hot path of every request.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly cache = new Map<
    string,
    { key: ApiKeyRecord; application: Application; expiresAt: number }
  >();
  private readonly cacheTtlMs = 30_000;

  constructor(private readonly db: PrimaryDb) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  async issue(
    applicationId: number,
    name: string,
    scopes: ApiKeyScope[],
  ): Promise<IssuedKey> {
    const prefix = `ori_${randomBytes(PREFIX_BYTES).toString('base64url')}`;
    const secret = `${prefix}.${randomBytes(SECRET_BYTES).toString('base64url')}`;

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO ${this.schema}.agent_api_keys (application_id, name, prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [applicationId, name, prefix, hashSecret(secret), scopes],
    );

    this.logger.log(`Issued API key ${prefix} for application ${applicationId}`);

    return {
      secret,
      record: {
        id: Number(row!.id),
        applicationId,
        name,
        prefix,
        scopes,
      },
    };
  }

  /**
   * Verify a presented key.
   *
   * @throws UnauthorizedException on any failure. There is no degraded path —
   *   an unverified caller does not get a reduced context, it gets a 401.
   */
  async verify(
    presented: string | undefined,
  ): Promise<{ key: ApiKeyRecord; application: Application }> {
    if (!presented || typeof presented !== 'string') {
      throw new UnauthorizedException('An API key is required');
    }

    const trimmed = presented.trim();
    const prefix = trimmed.split('.')[0];

    if (!prefix || !prefix.startsWith('ori_') || trimmed.length < 24) {
      throw new UnauthorizedException('Malformed API key');
    }

    const cached = this.cache.get(trimmed);
    if (cached && cached.expiresAt > Date.now()) {
      return { key: cached.key, application: cached.application };
    }

    const row = await this.db.one<KeyRow>(
      `SELECT k.id, k.application_id, k.name, k.prefix, k.key_hash, k.scopes, k.revoked_at,
              a.slug AS app_slug, a.name AS app_name, a.end_user_auth,
              a.jwt_issuer, a.jwt_jwks_url, a.jwt_audience,
              a.jwt_subject_claim, a.jwt_role_claim, a.jwt_scope_claims,
              a.is_active AS app_is_active
         FROM ${this.schema}.agent_api_keys k
         JOIN ${this.schema}.agent_applications a ON a.id = k.application_id
        WHERE k.prefix = $1
        LIMIT 1`,
      [prefix],
    );

    if (!row) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (!matchesHash(trimmed, row.key_hash)) {
      this.logger.warn(`API key ${prefix} presented with a wrong secret`);
      throw new UnauthorizedException('Invalid API key');
    }
    if (row.revoked_at) {
      throw new UnauthorizedException('This API key has been revoked');
    }
    if (!row.app_is_active) {
      throw new UnauthorizedException('This application is disabled');
    }

    const key: ApiKeyRecord = {
      id: Number(row.id),
      applicationId: Number(row.application_id),
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes as ApiKeyScope[],
    };

    const application: Application = {
      id: Number(row.application_id),
      slug: row.app_slug,
      name: row.app_name,
      endUserAuth: row.end_user_auth === 'jwt' ? 'jwt' : 'asserted',
      jwtIssuer: row.jwt_issuer,
      jwtJwksUrl: row.jwt_jwks_url,
      jwtAudience: row.jwt_audience,
      jwtSubjectClaim: row.jwt_subject_claim,
      jwtRoleClaim: row.jwt_role_claim,
      jwtScopeClaims: row.jwt_scope_claims ?? {},
      isActive: row.app_is_active,
    };

    this.cache.set(trimmed, {
      key,
      application,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    // Fire and forget: last-used is for the dashboard, not for correctness.
    void this.db
      .query(
        `UPDATE ${this.schema}.agent_api_keys SET last_used_at = now() WHERE id = $1`,
        [key.id],
      )
      .catch(() => undefined);

    return { key, application };
  }

  async revoke(id: number): Promise<void> {
    await this.db.query(
      `UPDATE ${this.schema}.agent_api_keys SET revoked_at = now() WHERE id = $1`,
      [id],
    );
    this.cache.clear();
  }

  async list(applicationId: number): Promise<
    Array<ApiKeyRecord & { lastUsedAt: Date | null; revokedAt: Date | null }>
  > {
    const rows = await this.db.query<{
      id: string;
      application_id: string;
      name: string;
      prefix: string;
      scopes: string[];
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, application_id, name, prefix, scopes, last_used_at, revoked_at
         FROM ${this.schema}.agent_api_keys
        WHERE application_id = $1
        ORDER BY created_at DESC`,
      [applicationId],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      applicationId: Number(row.application_id),
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes as ApiKeyScope[],
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison, so a wrong key cannot be found byte by byte. */
function matchesHash(secret: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}
