import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import {
  FunctionValidatorService,
  type ValidationReport,
} from '../registry/function-validator.service';
import { RegistryService } from '../registry/registry.service';
import type {
  FunctionDefinition,
  FunctionKind,
  FunctionStatus,
  HttpRequestSpec,
  ParamSchema,
  ReturnShape,
} from '../registry/function.contract';
import type { ScopeFilterDefinition } from '../registry/sql-template';
import { buildDemoFunction, DEMO_FUNCTION_NAME } from './demo-function';

export interface FunctionInput {
  name: string;
  category?: string;
  kind: FunctionKind;
  description: string;
  whenToUse?: string[];
  whenNotToUse?: string[];
  parameters?: ParamSchema;
  requiredOneOf?: string[][];
  returns: ReturnShape;
  ambiguityResolvesTo?: string | null;
  allowedRoles: string[];
  scopeFilters?: ScopeFilterDefinition[];
  sqlTemplate?: string | null;
  httpRequest?: HttpRequestSpec | null;
  writeScope?: string | null;
  requiresConfirmation?: boolean;
  defaultLimit?: number | null;
  maxLimit?: number | null;
}

export interface SaveResult {
  definition: FunctionDefinition;
  validation: ValidationReport;
  /** Existing functions whose descriptions read similarly. */
  similar: Array<{ name: string; similarity: number }>;
}

export interface VersionEntry {
  version: number;
  note: string | null;
  changedBy: number | null;
  changedAt: Date;
  snapshot: unknown;
}

/**
 * Creating and changing registry functions.
 *
 * The rules that make administrator-authored SQL safe to run live here:
 *
 *   - **Nothing saves without validating.** A draft that fails validation is
 *     stored with its error so the author can come back to it, but it can never
 *     be promoted.
 *   - **Nothing reaches `live` without an explicit approval step.** Editing a
 *     live function knocks it back to `draft`, so a change cannot ride in on an
 *     earlier approval.
 *   - **Every change is versioned.** The previous state is snapshotted before
 *     it is overwritten, so a bad edit can be read back and reverted.
 */
@Injectable()
export class FunctionManagementService {
  private readonly logger = new Logger(FunctionManagementService.name);

  constructor(
    private readonly db: PrimaryDb,
    private readonly registry: RegistryService,
    private readonly validator: FunctionValidatorService,
  ) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  /** Validates without saving — what the editor calls as you type. */
  async check(
    applicationId: number,
    input: FunctionInput,
  ): Promise<{ validation: ValidationReport; similar: SaveResult['similar'] }> {
    const [validation, similar] = await Promise.all([
      this.validator.validate(toDraft(input)),
      this.registry.findSimilarDescriptions(
        applicationId,
        input.description,
        input.name,
      ),
    ]);

    return { validation, similar };
  }

  async create(
    applicationId: number,
    input: FunctionInput,
    authorId: number | null,
  ): Promise<SaveResult> {
    const existing = await this.registry.getByName(applicationId, input.name);
    if (existing) {
      throw new ConflictException(
        `A function named "${input.name}" already exists.`,
      );
    }

    const validation = await this.validator.validate(toDraft(input));
    const similar = await this.registry.findSimilarDescriptions(
      applicationId,
      input.description,
      input.name,
    );

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO ${this.schema}.agent_functions (
         application_id, name, category, kind, description,
         when_to_use, when_not_to_use, parameters, required_one_of,
         returns, ambiguity_resolves_to, allowed_roles, scope_filters,
         sql_template, http_request, write_scope, requires_confirmation,
         default_limit, max_limit, status, version, created_by,
         last_validated_at, validation_error
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
         $10, $11, $12, $13::jsonb,
         $14, $15::jsonb, $16, $17,
         $18, $19, 'draft', 1, $20,
         now(), $21
       ) RETURNING id`,
      [
        applicationId,
        input.name,
        input.category ?? 'general',
        input.kind,
        input.description,
        JSON.stringify(input.whenToUse ?? []),
        JSON.stringify(input.whenNotToUse ?? []),
        JSON.stringify(input.parameters ?? {}),
        JSON.stringify(input.requiredOneOf ?? []),
        input.returns,
        input.ambiguityResolvesTo ?? null,
        input.allowedRoles,
        JSON.stringify(input.scopeFilters ?? []),
        input.sqlTemplate ?? null,
        input.httpRequest ? JSON.stringify(input.httpRequest) : null,
        input.writeScope ?? null,
        input.requiresConfirmation ?? false,
        input.defaultLimit ?? null,
        input.maxLimit ?? null,
        authorId,
        validation.ok ? null : summarise(validation),
      ],
    );

    this.registry.invalidate(applicationId);
    const definition = await this.registry.getById(Number(row!.id));

    await this.snapshot(definition!, authorId, 'created');
    this.logger.log(`Function "${input.name}" created as draft`);

    return { definition: definition!, validation, similar };
  }

  /**
   * Updating a live function returns it to `draft`.
   *
   * Otherwise an approval would cover code nobody approved: the reviewer signed
   * off on the version they read, not on whatever replaced it.
   */
  async update(
    applicationId: number,
    name: string,
    input: FunctionInput,
    authorId: number | null,
  ): Promise<SaveResult> {
    const current = await this.registry.getByName(applicationId, name);
    if (!current) throw new NotFoundException(`No function named "${name}".`);

    await this.snapshot(current, authorId, 'before update');

    const validation = await this.validator.validate(toDraft(input));
    const similar = await this.registry.findSimilarDescriptions(
      applicationId,
      input.description,
      name,
    );

    await this.db.query(
      `UPDATE ${this.schema}.agent_functions SET
         name = $3, category = $4, kind = $5, description = $6,
         when_to_use = $7::jsonb, when_not_to_use = $8::jsonb,
         parameters = $9::jsonb, required_one_of = $10::jsonb,
         returns = $11, ambiguity_resolves_to = $12, allowed_roles = $13,
         scope_filters = $14::jsonb, sql_template = $15,
         http_request = $16::jsonb, write_scope = $17,
         requires_confirmation = $18, default_limit = $19, max_limit = $20,
         status = 'draft', approved_by = NULL, approved_at = NULL,
         version = version + 1, last_validated_at = now(), validation_error = $21,
         updated_at = now()
       WHERE application_id = $1 AND name = $2`,
      [
        applicationId,
        name,
        input.name,
        input.category ?? 'general',
        input.kind,
        input.description,
        JSON.stringify(input.whenToUse ?? []),
        JSON.stringify(input.whenNotToUse ?? []),
        JSON.stringify(input.parameters ?? {}),
        JSON.stringify(input.requiredOneOf ?? []),
        input.returns,
        input.ambiguityResolvesTo ?? null,
        input.allowedRoles,
        JSON.stringify(input.scopeFilters ?? []),
        input.sqlTemplate ?? null,
        input.httpRequest ? JSON.stringify(input.httpRequest) : null,
        input.writeScope ?? null,
        input.requiresConfirmation ?? false,
        input.defaultLimit ?? null,
        input.maxLimit ?? null,
        validation.ok ? null : summarise(validation),
      ],
    );

    this.registry.invalidate(applicationId);
    const definition = await this.registry.getByName(applicationId, input.name);

    if (current.status === 'live') {
      this.logger.warn(
        `Function "${name}" was live and has been returned to draft after an edit`,
      );
    }

    return { definition: definition!, validation, similar };
  }

  /**
   * Move a function between statuses.
   *
   * Re-validates on the way to `live`: a function approved a week ago may not
   * still plan, because the tables it reads can change underneath it.
   */
  async setStatus(
    applicationId: number,
    name: string,
    status: FunctionStatus,
    actorId: number | null,
  ): Promise<FunctionDefinition> {
    const current = await this.registry.getByName(applicationId, name);
    if (!current) throw new NotFoundException(`No function named "${name}".`);

    if (status === 'live') {
      if (current.status === 'draft') {
        throw new BadRequestException(
          'A draft must be approved before it can go live.',
        );
      }

      const validation = await this.validator.validate(toDraft(current));
      if (!validation.ok) {
        throw new BadRequestException(
          `This function no longer validates and cannot go live: ${summarise(validation)}`,
        );
      }
    }

    if (status === 'approved' && current.validationError) {
      throw new BadRequestException(
        `This function does not validate and cannot be approved: ${current.validationError}`,
      );
    }

    // `$4::bigint` is not decoration. Inside a CASE whose other branch is NULL,
    // Postgres infers an untyped parameter as text, and assigning text to the
    // bigint `approved_by` column fails at execution.
    await this.db.query(
      `UPDATE ${this.schema}.agent_functions
          SET status = $3,
              approved_by = CASE WHEN $3 IN ('approved','live') THEN $4::bigint ELSE NULL END,
              approved_at = CASE WHEN $3 IN ('approved','live') THEN now() ELSE NULL END,
              updated_at = now()
        WHERE application_id = $1 AND name = $2`,
      [applicationId, name, status, actorId],
    );

    this.registry.invalidate(applicationId);
    const updated = await this.registry.getByName(applicationId, name);

    await this.snapshot(updated!, actorId, `status → ${status}`);
    this.logger.log(`Function "${name}" is now ${status}`);

    return updated!;
  }

  async remove(
    applicationId: number,
    name: string,
    actorId: number | null,
  ): Promise<void> {
    const current = await this.registry.getByName(applicationId, name);
    if (!current) throw new NotFoundException(`No function named "${name}".`);

    await this.snapshot(current, actorId, 'deleted');
    await this.db.query(
      `DELETE FROM ${this.schema}.agent_functions WHERE application_id = $1 AND name = $2`,
      [applicationId, name],
    );

    this.registry.invalidate(applicationId);
    this.logger.log(`Function "${name}" deleted`);
  }

  /**
   * Create the demo function for an application, or bring it back if it was
   * deleted. Returns null when it already exists and is untouched.
   *
   * Goes straight to `live` — unlike an author-written function, this one ships
   * with the service and is validated the same way, so an approval step would be
   * ceremony. If validation fails (an unusual Postgres, a restricted read role)
   * it stays a draft with the error attached rather than being forced live.
   */
  async ensureDemoFunction(
    applicationId: number,
    agentSchema: string,
  ): Promise<SaveResult | null> {
    const existing = await this.registry.getByName(
      applicationId,
      DEMO_FUNCTION_NAME,
    );
    if (existing) return null;

    const created = await this.create(
      applicationId,
      buildDemoFunction(agentSchema),
      null,
    );

    if (created.validation.ok) {
      await this.setStatus(applicationId, DEMO_FUNCTION_NAME, 'approved', null);
      const live = await this.setStatus(
        applicationId,
        DEMO_FUNCTION_NAME,
        'live',
        null,
      );
      this.logger.log(`Demo function installed and live for app ${applicationId}`);
      return { ...created, definition: live };
    }

    this.logger.warn(
      `Demo function did not validate against this database: ${summarise(created.validation)}`,
    );
    return created;
  }

  async versions(functionId: number): Promise<VersionEntry[]> {
    const rows = await this.db.query<{
      version: number;
      note: string | null;
      changed_by: string | null;
      changed_at: Date;
      snapshot: unknown;
    }>(
      `SELECT version, note, changed_by, changed_at, snapshot
         FROM ${this.schema}.agent_function_versions
        WHERE function_id = $1
        ORDER BY version DESC, changed_at DESC`,
      [functionId],
    );

    return rows.map((row) => ({
      version: row.version,
      note: row.note,
      changedBy: row.changed_by ? Number(row.changed_by) : null,
      changedAt: row.changed_at,
      snapshot: row.snapshot,
    }));
  }

  private async snapshot(
    definition: FunctionDefinition,
    actorId: number | null,
    note: string,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO ${this.schema}.agent_function_versions
           (function_id, version, snapshot, note, changed_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (function_id, version) DO NOTHING`,
        [
          definition.id,
          definition.version,
          JSON.stringify(definition),
          note,
          actorId,
        ],
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not snapshot ${definition.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}

function toDraft(
  input: FunctionInput | FunctionDefinition,
): Parameters<FunctionValidatorService['validate']>[0] {
  return {
    name: input.name,
    kind: input.kind,
    description: input.description,
    parameters: input.parameters ?? {},
    requiredOneOf: input.requiredOneOf ?? [],
    returns: input.returns,
    ambiguityResolvesTo: input.ambiguityResolvesTo ?? null,
    scopeFilters: input.scopeFilters ?? [],
    sqlTemplate: input.sqlTemplate ?? null,
    httpRequest: input.httpRequest ?? null,
    writeScope: input.writeScope ?? null,
    allowedRoles: input.allowedRoles,
  };
}

function summarise(report: ValidationReport): string {
  return report.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message)
    .join(' ');
}
