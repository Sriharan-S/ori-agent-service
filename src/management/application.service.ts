import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { Application } from '../auth/identity';

export interface ApplicationInput {
  slug: string;
  name: string;
  description?: string | null;
  endUserAuth: 'jwt' | 'asserted';
  jwtIssuer?: string | null;
  jwtJwksUrl?: string | null;
  jwtAudience?: string | null;
  jwtSubjectClaim?: string;
  jwtRoleClaim?: string | null;
  jwtScopeClaims?: Record<string, string>;
  isActive?: boolean;
}

export interface ServiceEntry {
  id: number;
  name: string;
  baseUrl: string;
  /**
   * Where links handed back to a person point, when that is not where the agent
   * calls — an internal hostname is reachable from the service and useless in a
   * browser. Null means the two are the same.
   */
  publicBaseUrl: string | null;
}

interface ApplicationRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  end_user_auth: string;
  jwt_issuer: string | null;
  jwt_jwks_url: string | null;
  jwt_audience: string | null;
  jwt_subject_claim: string;
  jwt_role_claim: string | null;
  jwt_scope_claims: Record<string, string>;
  is_active: boolean;
}

/**
 * Applications are the tenancy boundary: functions, roles, conversations, audit
 * and API keys all hang off one. A deployment can serve several products, and
 * nothing crosses between them.
 */
@Injectable()
export class ApplicationService {
  private readonly logger = new Logger(ApplicationService.name);

  constructor(private readonly db: PrimaryDb) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  async list(): Promise<Array<Application & { description: string | null }>> {
    const rows = await this.db.query<ApplicationRow>(
      `SELECT id, slug, name, description, end_user_auth, jwt_issuer, jwt_jwks_url,
              jwt_audience, jwt_subject_claim, jwt_role_claim, jwt_scope_claims, is_active
         FROM ${this.schema}.agent_applications
        ORDER BY name`,
    );
    return rows.map(toApplication);
  }

  async get(id: number): Promise<Application & { description: string | null }> {
    const row = await this.db.one<ApplicationRow>(
      `SELECT id, slug, name, description, end_user_auth, jwt_issuer, jwt_jwks_url,
              jwt_audience, jwt_subject_claim, jwt_role_claim, jwt_scope_claims, is_active
         FROM ${this.schema}.agent_applications WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('No such application');
    return toApplication(row);
  }

  async upsert(
    input: ApplicationInput,
    id?: number,
  ): Promise<Application & { description: string | null }> {
    const values = [
      input.slug,
      input.name,
      input.description ?? null,
      input.endUserAuth,
      input.jwtIssuer ?? null,
      input.jwtJwksUrl ?? null,
      input.jwtAudience ?? null,
      input.jwtSubjectClaim ?? 'sub',
      input.jwtRoleClaim ?? null,
      JSON.stringify(input.jwtScopeClaims ?? {}),
      input.isActive ?? true,
    ];

    const row = id
      ? await this.db.one<ApplicationRow>(
          `UPDATE ${this.schema}.agent_applications
              SET slug = $1, name = $2, description = $3, end_user_auth = $4,
                  jwt_issuer = $5, jwt_jwks_url = $6, jwt_audience = $7,
                  jwt_subject_claim = $8, jwt_role_claim = $9,
                  jwt_scope_claims = $10::jsonb, is_active = $11, updated_at = now()
            WHERE id = $12
        RETURNING id, slug, name, description, end_user_auth, jwt_issuer, jwt_jwks_url,
                  jwt_audience, jwt_subject_claim, jwt_role_claim, jwt_scope_claims, is_active`,
          [...values, id],
        )
      : await this.db.one<ApplicationRow>(
          `INSERT INTO ${this.schema}.agent_applications
             (slug, name, description, end_user_auth, jwt_issuer, jwt_jwks_url,
              jwt_audience, jwt_subject_claim, jwt_role_claim, jwt_scope_claims, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
        RETURNING id, slug, name, description, end_user_auth, jwt_issuer, jwt_jwks_url,
                  jwt_audience, jwt_subject_claim, jwt_role_claim, jwt_scope_claims, is_active`,
          values,
        );

    this.logger.log(`Application "${input.slug}" saved`);
    return toApplication(row!);
  }

  /** Base URLs an HTTP action may target. Nothing else is reachable. */
  async listServices(applicationId: number): Promise<ServiceEntry[]> {
    const rows = await this.db.query<{
      id: string;
      name: string;
      base_url: string;
      public_base_url: string | null;
    }>(
      `SELECT id, name, base_url, public_base_url FROM ${this.schema}.agent_services
        WHERE application_id = $1 ORDER BY name`,
      [applicationId],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      baseUrl: row.base_url,
      publicBaseUrl: row.public_base_url,
    }));
  }

  /**
   * @param publicBaseUrl Where a link handed to a person should point, when
   *   that differs from where the agent calls. Null means they are the same.
   */
  async upsertService(
    applicationId: number,
    name: string,
    baseUrl: string,
    publicBaseUrl?: string | null,
  ): Promise<ServiceEntry> {
    // Parsed rather than pattern-matched, so a malformed base URL is rejected
    // here rather than at the first action that uses it.
    const parsed = parseBaseUrl(baseUrl, 'Service base URL');
    const parsedPublic =
      publicBaseUrl && publicBaseUrl.trim() !== ''
        ? parseBaseUrl(publicBaseUrl, 'Public base URL')
        : null;

    const row = await this.db.one<{
      id: string;
      name: string;
      base_url: string;
      public_base_url: string | null;
    }>(
      `INSERT INTO ${this.schema}.agent_services
         (application_id, name, base_url, public_base_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (application_id, name) DO UPDATE
         SET base_url = EXCLUDED.base_url,
             public_base_url = EXCLUDED.public_base_url,
             updated_at = now()
       RETURNING id, name, base_url, public_base_url`,
      [applicationId, name, parsed, parsedPublic],
    );

    return {
      id: Number(row!.id),
      name: row!.name,
      baseUrl: row!.base_url,
      publicBaseUrl: row!.public_base_url,
    };
  }

  async removeService(applicationId: number, name: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.schema}.agent_services WHERE application_id = $1 AND name = $2`,
      [applicationId, name],
    );
  }
}

/** A base URL the service will later resolve paths against, checked once here. */
function parseBaseUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must be http or https`);
  }

  return parsed.toString();
}

function toApplication(
  row: ApplicationRow,
): Application & { description: string | null } {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    endUserAuth: row.end_user_auth === 'jwt' ? 'jwt' : 'asserted',
    jwtIssuer: row.jwt_issuer,
    jwtJwksUrl: row.jwt_jwks_url,
    jwtAudience: row.jwt_audience,
    jwtSubjectClaim: row.jwt_subject_claim,
    jwtRoleClaim: row.jwt_role_claim,
    jwtScopeClaims: row.jwt_scope_claims ?? {},
    isActive: row.is_active,
  };
}
