import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import type { RoleRecord } from '../auth/identity';
import {
  toPlannerFacing,
  type FunctionDefinition,
  type FunctionStatus,
  type HttpRequestSpec,
  type ParamSchema,
  type PlannerFacingFunction,
} from './function.contract';
import type { ScopeFilterDefinition } from './sql-template';

interface FunctionRow {
  id: string;
  application_id: string;
  name: string;
  category: string;
  kind: string;
  description: string;
  when_to_use: string[];
  when_not_to_use: string[];
  parameters: ParamSchema;
  required_one_of: string[][];
  returns: string;
  ambiguity_resolves_to: string | null;
  allowed_roles: string[];
  scope_filters: ScopeFilterDefinition[];
  sql_template: string | null;
  http_request: HttpRequestSpec | null;
  write_scope: string | null;
  requires_confirmation: boolean;
  default_limit: number | null;
  max_limit: number | null;
  status: string;
  version: number;
  last_validated_at: Date | null;
  validation_error: string | null;
}

interface CacheEntry {
  functions: FunctionDefinition[];
  expiresAt: number;
}

const SELECT_COLUMNS = `
  id, application_id, name, category, kind, description,
  when_to_use, when_not_to_use, parameters, required_one_of,
  returns, ambiguity_resolves_to, allowed_roles, scope_filters,
  sql_template, http_request, write_scope, requires_confirmation,
  default_limit, max_limit, status, version, last_validated_at, validation_error
`;

/**
 * The function registry, loaded from the database.
 *
 * Two invariants, both enforced here rather than left to callers:
 *
 *   - Only `status = 'live'` functions are visible to the planner or reachable
 *     by the executor. `draft` is unfinished, `approved` is reviewed but not
 *     released, `disabled` is the kill switch for something misbehaving. All
 *     three are invisible, which means turning a function off is one UPDATE and
 *     takes effect within the cache TTL.
 *   - A caller only ever sees functions their role may call, so the planner
 *     cannot select something that would be denied a moment later.
 */
@Injectable()
export class RegistryService {
  private readonly cache = new Map<number, CacheEntry>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: PrimaryDb,
  ) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  /** Live functions for an application, cached briefly. */
  async getLiveFunctions(applicationId: number): Promise<FunctionDefinition[]> {
    const cached = this.cache.get(applicationId);
    if (cached && cached.expiresAt > Date.now()) return cached.functions;

    const rows = await this.db.query<FunctionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${this.schema}.functions
        WHERE application_id = $1 AND status = 'live'
        ORDER BY name`,
      [applicationId],
    );

    const functions = rows.map(toDefinition);
    this.cache.set(applicationId, {
      functions,
      expiresAt: Date.now() + this.config.behaviour.registryCacheTtlMs,
    });

    return functions;
  }

  /** The planner-facing catalogue for one caller. */
  async getCatalogueFor(
    applicationId: number,
    role: RoleRecord,
    categories?: string[],
  ): Promise<PlannerFacingFunction[]> {
    const live = await this.getLiveFunctions(applicationId);
    const allowAll = role.allowedFunctions.includes('*');

    return live
      .filter(
        (definition) =>
          allowAll || role.allowedFunctions.includes(definition.name),
      )
      .filter(
        (definition) =>
          definition.allowedRoles.includes('*') ||
          definition.allowedRoles.includes(role.name),
      )
      .filter((definition) =>
        categories ? categories.includes(definition.category) : true,
      )
      .map(toPlannerFacing);
  }

  /** Executor-facing lookup. Returns undefined for anything not live. */
  async getExecutable(
    applicationId: number,
    name: string,
  ): Promise<FunctionDefinition | undefined> {
    const live = await this.getLiveFunctions(applicationId);
    return live.find((definition) => definition.name === name);
  }

  /** Includes non-live functions. Management API and dashboard only. */
  async getByName(
    applicationId: number,
    name: string,
  ): Promise<FunctionDefinition | null> {
    const row = await this.db.one<FunctionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${this.schema}.functions
        WHERE application_id = $1 AND name = $2`,
      [applicationId, name],
    );
    return row ? toDefinition(row) : null;
  }

  async getById(id: number): Promise<FunctionDefinition | null> {
    const row = await this.db.one<FunctionRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${this.schema}.functions WHERE id = $1`,
      [id],
    );
    return row ? toDefinition(row) : null;
  }

  async listAll(
    applicationId: number,
    status?: FunctionStatus,
  ): Promise<FunctionDefinition[]> {
    const rows = await this.db.query<FunctionRow>(
      status
        ? `SELECT ${SELECT_COLUMNS} FROM ${this.schema}.functions
            WHERE application_id = $1 AND status = $2 ORDER BY name`
        : `SELECT ${SELECT_COLUMNS} FROM ${this.schema}.functions
            WHERE application_id = $1 ORDER BY name`,
      status ? [applicationId, status] : [applicationId],
    );
    return rows.map(toDefinition);
  }

  /** Called after any write to a function row. */
  invalidate(applicationId?: number): void {
    if (applicationId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(applicationId);
    }
  }

  /**
   * Descriptions that sit too close together in wording.
   *
   * Retrieval quality depends far more on descriptions than on the retrieval
   * algorithm, and two functions described alike will be confused however good
   * the retriever is. This is a cheap token-overlap check surfaced at authoring
   * time; Phase 8's embedding-based version replaces it once there are enough
   * functions to warrant one.
   */
  async findSimilarDescriptions(
    applicationId: number,
    description: string,
    excludeName?: string,
    threshold = 0.6,
  ): Promise<Array<{ name: string; similarity: number }>> {
    const rows = await this.db.query<{ name: string; description: string }>(
      `SELECT name, description FROM ${this.schema}.functions
        WHERE application_id = $1 AND ($2::text IS NULL OR name <> $2)`,
      [applicationId, excludeName ?? null],
    );

    const target = tokenise(description);

    return rows
      .map((row) => ({
        name: row.name,
        similarity: jaccard(target, tokenise(row.description)),
      }))
      .filter((entry) => entry.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);
  }
}

function toDefinition(row: FunctionRow): FunctionDefinition {
  return {
    id: Number(row.id),
    applicationId: Number(row.application_id),
    name: row.name,
    category: row.category,
    kind: row.kind === 'write' ? 'write' : 'read',
    description: row.description,
    whenToUse: row.when_to_use ?? [],
    whenNotToUse: row.when_not_to_use ?? [],
    parameters: row.parameters ?? {},
    requiredOneOf: row.required_one_of ?? [],
    returns: row.returns as FunctionDefinition['returns'],
    ambiguityResolvesTo: row.ambiguity_resolves_to,
    allowedRoles: row.allowed_roles ?? [],
    scopeFilters: row.scope_filters ?? [],
    sqlTemplate: row.sql_template,
    httpRequest: row.http_request,
    writeScope: row.write_scope,
    requiresConfirmation: row.requires_confirmation,
    defaultLimit: row.default_limit,
    maxLimit: row.max_limit,
    status: row.status as FunctionStatus,
    version: row.version,
    lastValidatedAt: row.last_validated_at,
    validationError: row.validation_error,
  };
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'when',
  'which', 'with', 'this', 'their', 'them', 'they', 'returns', 'return',
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}
