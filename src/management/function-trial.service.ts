import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RoleService } from '../auth/role.service';
import type { RequestContext } from '../auth/identity';
import type { FunctionResult } from '../registry/function.contract';
import { HttpFunctionRunner } from '../registry/http-function.runner';
import { ParamValidatorService } from '../registry/param-validator.service';
import { RegistryService } from '../registry/registry.service';
import { SqlFunctionRunner } from '../registry/sql-function.runner';
import { ApplicationService } from './application.service';

export interface TrialInput {
  /** Role to run as. Its scope exemptions apply exactly as in production. */
  role: string;
  /** Scope values the pretend caller supplies, e.g. `{ org_id: 1 }`. */
  scopes?: Record<string, string | number>;
  params?: Record<string, unknown>;
}

export interface TrialResult {
  result: FunctionResult;
  scopesApplied: Record<string, string | number>;
  rowCount: number;
  durationMs: number;
}

/**
 * Runs a function the way the agent would, for an author who wants to see what
 * it actually returns.
 *
 * Deliberately runs **draft** functions — checking a function before promoting
 * it is the entire point, and validation only proves it plans, not that it
 * returns the right rows or disambiguates sensibly.
 *
 * Equally deliberately, it is not a way around scoping. The caller picks a role
 * and supplies scope values, and the same code path applies them: choose a role
 * without an exemption and omit its scope value, and the trial is refused just
 * as a real request would be. That makes this useful for testing the *refusal*
 * as well as the happy path.
 *
 * Write functions are not trialled. A dry run that issues a real PATCH to a host
 * API is not a dry run.
 */
@Injectable()
export class FunctionTrialService {
  private readonly logger = new Logger(FunctionTrialService.name);

  constructor(
    private readonly registry: RegistryService,
    private readonly roles: RoleService,
    private readonly params: ParamValidatorService,
    private readonly sql: SqlFunctionRunner,
    private readonly http: HttpFunctionRunner,
    private readonly applications: ApplicationService,
  ) {
    // `http` is injected so the guard below is a decision this class makes
    // rather than a capability it happens to lack.
    void this.http;
  }

  async run(
    applicationId: number,
    name: string,
    input: TrialInput,
  ): Promise<TrialResult> {
    const definition = await this.registry.getByName(applicationId, name);
    if (!definition) {
      throw new BadRequestException(`No function named "${name}".`);
    }

    if (definition.kind === 'write') {
      throw new BadRequestException(
        'Write functions cannot be trialled — a dry run that really calls the ' +
          'host API is not a dry run. Test the action against a staging service instead.',
      );
    }

    const role = await this.roles.require(applicationId, input.role);
    const application = await this.applications.get(applicationId);

    const validation = this.params.validate(definition, input.params ?? {});
    if (!validation.ok) {
      return {
        result: {
          status: 'error',
          message: validation.errors.map((error) => error.message).join(' '),
          retryable: false,
        },
        scopesApplied: {},
        rowCount: 0,
        durationMs: 0,
      };
    }

    const context: RequestContext = {
      application,
      apiKey: {
        id: 0,
        applicationId,
        name: 'console trial',
        prefix: 'trial',
        scopes: ['manage'],
      },
      endUser: {
        id: '__console_trial__',
        role: role.name,
        scopes: input.scopes ?? {},
      },
      role,
      runId: randomUUID(),
      requestId: randomUUID(),
      traceEnabled: true,
    };

    const startedAt = Date.now();
    const outcome = await this.sql.run(definition, validation.params, context);

    this.logger.log(
      `Trial of "${name}" as role "${role.name}" → ${outcome.result.status}`,
    );

    return {
      result: outcome.result,
      scopesApplied: outcome.scopesApplied,
      rowCount: outcome.rowCount,
      durationMs: Date.now() - startedAt,
    };
  }
}
