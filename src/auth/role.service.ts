import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { RoleRecord } from './identity';

interface RoleRow {
  id: string;
  application_id: string;
  name: string;
  description: string | null;
  allowed_functions: string[];
  write_scopes: string[];
  unscoped_keys: string[];
}

/**
 * Roles are rows, not classes.
 *
 * The predecessor had one TypeScript class per role, which meant adding a role
 * to a product was a deployment. Here an application defines its own roles
 * through the management API, and what a role can do is three arrays: which
 * functions it may call, which write scopes it holds, and which data scopes it
 * is exempt from.
 *
 * That last one carries the weight. A role exempt from `org_id` sees every
 * organisation; a role that is not must supply an `org_id`, or every function
 * declaring that scope is refused. Exemption is explicit and stored — it is
 * never the consequence of a missing value.
 */
@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);
  private readonly cache = new Map<
    string,
    { role: RoleRecord; expiresAt: number }
  >();
  private readonly cacheTtlMs = 30_000;

  constructor(private readonly db: PrimaryDb) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  /**
   * @throws ForbiddenException when the application has not defined this role.
   *   An unknown role is refused rather than defaulted — a typo in a host
   *   application's role name must not silently grant or deny access.
   */
  async require(applicationId: number, name: string): Promise<RoleRecord> {
    const role = await this.find(applicationId, name);

    if (!role) {
      this.logger.warn(
        `Application ${applicationId} has no role "${name}" defined`,
      );
      throw new ForbiddenException(
        `Role "${name}" is not defined for this application.`,
      );
    }

    return role;
  }

  async find(
    applicationId: number,
    name: string,
  ): Promise<RoleRecord | null> {
    const cacheKey = `${applicationId}:${name}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.role;

    const row = await this.db.one<RoleRow>(
      `SELECT id, application_id, name, description,
              allowed_functions, write_scopes, unscoped_keys
         FROM ${this.schema}.agent_roles
        WHERE application_id = $1 AND name = $2
        LIMIT 1`,
      [applicationId, name],
    );

    if (!row) return null;

    const role = toRecord(row);
    this.cache.set(cacheKey, {
      role,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return role;
  }

  async list(applicationId: number): Promise<RoleRecord[]> {
    const rows = await this.db.query<RoleRow>(
      `SELECT id, application_id, name, description,
              allowed_functions, write_scopes, unscoped_keys
         FROM ${this.schema}.agent_roles
        WHERE application_id = $1
        ORDER BY name`,
      [applicationId],
    );
    return rows.map(toRecord);
  }

  async upsert(
    applicationId: number,
    input: Omit<RoleRecord, 'id' | 'applicationId'>,
  ): Promise<RoleRecord> {
    const row = await this.db.one<RoleRow>(
      `INSERT INTO ${this.schema}.agent_roles
         (application_id, name, description, allowed_functions, write_scopes, unscoped_keys)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (application_id, name) DO UPDATE
         SET description       = EXCLUDED.description,
             allowed_functions = EXCLUDED.allowed_functions,
             write_scopes      = EXCLUDED.write_scopes,
             unscoped_keys     = EXCLUDED.unscoped_keys,
             updated_at        = now()
       RETURNING id, application_id, name, description,
                 allowed_functions, write_scopes, unscoped_keys`,
      [
        applicationId,
        input.name,
        input.description,
        input.allowedFunctions,
        input.writeScopes,
        input.unscopedKeys,
      ],
    );

    this.cache.delete(`${applicationId}:${input.name}`);
    return toRecord(row!);
  }

  async remove(applicationId: number, name: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.schema}.agent_roles WHERE application_id = $1 AND name = $2`,
      [applicationId, name],
    );
    this.cache.delete(`${applicationId}:${name}`);
  }

  canCallFunction(role: RoleRecord, functionName: string): boolean {
    return (
      role.allowedFunctions.includes('*') ||
      role.allowedFunctions.includes(functionName)
    );
  }

  hasWriteScope(role: RoleRecord, scope: string): boolean {
    return role.writeScopes.includes('*') || role.writeScopes.includes(scope);
  }

  invalidate(): void {
    this.cache.clear();
  }
}

function toRecord(row: RoleRow): RoleRecord {
  return {
    id: Number(row.id),
    applicationId: Number(row.application_id),
    name: row.name,
    description: row.description,
    allowedFunctions: row.allowed_functions,
    writeScopes: row.write_scopes,
    unscopedKeys: row.unscoped_keys,
  };
}
