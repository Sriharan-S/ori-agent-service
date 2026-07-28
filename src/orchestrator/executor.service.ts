import { Injectable, Logger } from '@nestjs/common';
import {
  AuditLoggerService,
  type AuditStatus,
} from '../audit/audit-logger.service';
import { RoleService } from '../auth/role.service';
import type { FunctionDefinition, FunctionResult } from '../registry/function.contract';
import { HttpFunctionRunner } from '../registry/http-function.runner';
import { ParamValidatorService } from '../registry/param-validator.service';
import { RegistryService } from '../registry/registry.service';
import { SqlFunctionRunner } from '../registry/sql-function.runner';
import type {
  AgentEventSink,
  AgentRun,
  CallOutcome,
  ExecutionPlan,
  PlannedCall,
} from './orchestrator.types';

/**
 * Runs a plan.
 *
 * Order of checks before any function body executes, none of them skippable:
 *
 *   1. the function exists and is `live`
 *   2. the caller's role may call it, and the function admits that role
 *   3. the extracted parameters validate against its schema
 *   4. for writes, the caller's role holds the required write scope
 *
 * Then the body runs — SQL on the read-only connection, or an HTTP action
 * against a registered service. Scope binding happens inside the runner and
 * fails closed there.
 *
 * Every outcome is audited, including refusals and validation failures.
 * Independent calls run in parallel and one failure never fails the request: a
 * partial answer with an honest gap beats no answer.
 */
@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);

  constructor(
    private readonly registry: RegistryService,
    private readonly params: ParamValidatorService,
    private readonly roles: RoleService,
    private readonly sql: SqlFunctionRunner,
    private readonly http: HttpFunctionRunner,
    private readonly audit: AuditLoggerService,
  ) {}

  async execute(
    plan: ExecutionPlan,
    run: AgentRun,
    emit: AgentEventSink,
  ): Promise<CallOutcome[]> {
    const { independent, dependent } = partition(plan.calls);

    const settled = await Promise.allSettled(
      independent.map((call) => this.runOne(call, run, emit)),
    );

    const outcomes: CallOutcome[] = [];

    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const call = independent[index]!;

      if (result.status === 'fulfilled') {
        outcomes.push(result.value);
        continue;
      }

      this.logger.warn(
        `${call.functionName} threw: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
      outcomes.push({
        functionName: call.functionName,
        functionVersion: 0,
        params: call.params,
        durationMs: 0,
        result: {
          status: 'error',
          message: 'That step failed unexpectedly.',
          retryable: true,
        },
      });
    }

    // Then anything waiting on a resolved id from the calls above.
    for (const call of dependent) {
      const resolved = await this.resolveDependencies(call, outcomes, run);
      if (!resolved) {
        this.logger.warn(
          `Skipping ${call.functionName}: its dependency did not resolve to a single record`,
        );
        continue;
      }
      outcomes.push(await this.runOne(resolved, run, emit));
    }

    return outcomes;
  }

  private async runOne(
    call: PlannedCall,
    run: AgentRun,
    emit: AgentEventSink,
  ): Promise<CallOutcome> {
    const startedAt = Date.now();
    const { context } = run;

    const definition = await this.registry.getExecutable(
      context.application.id,
      call.functionName,
    );

    if (!definition) {
      // Unknown, or not live. Either way it does not exist to this caller.
      return this.finish(
        call,
        0,
        {
          status: 'error',
          message: 'That capability is not available.',
          retryable: false,
        },
        run,
        startedAt,
        'error',
        'function not live',
        'read',
      );
    }

    const roleMayCall =
      this.roles.canCallFunction(context.role, definition.name) &&
      (definition.allowedRoles.includes('*') ||
        definition.allowedRoles.includes(context.role.name));

    if (!roleMayCall) {
      return this.finish(
        call,
        definition.version,
        {
          status: 'denied',
          reason: 'You do not have access to that information.',
        },
        run,
        startedAt,
        'denied',
        `role ${context.role.name} may not call ${definition.name}`,
        definition.kind,
      );
    }

    if (
      definition.kind === 'write' &&
      (!definition.writeScope ||
        !this.roles.hasWriteScope(context.role, definition.writeScope))
    ) {
      return this.finish(
        call,
        definition.version,
        {
          status: 'denied',
          reason: "You don't have permission to make that change.",
        },
        run,
        startedAt,
        'denied',
        `missing write scope ${String(definition.writeScope)}`,
        definition.kind,
      );
    }

    const validation = this.params.validate(definition, call.params);
    if (!validation.ok) {
      return this.finish(
        call,
        definition.version,
        {
          status: 'error',
          message: validation.errors.map((error) => error.message).join(' '),
          retryable: false,
        },
        run,
        startedAt,
        'invalid_params',
        validation.errors.map((error) => `${error.kind}:${error.param}`).join(','),
        definition.kind,
      );
    }

    emit({ type: 'function.started', channel: 'trace', name: definition.name });

    let result: FunctionResult;
    let scopesApplied: Record<string, string | number> = {};
    let afterState: Record<string, unknown> | undefined;
    let rowCount = 0;

    try {
      if (definition.kind === 'read') {
        const outcome = await this.sql.run(definition, validation.params, context);
        result = outcome.result;
        scopesApplied = outcome.scopesApplied;
        rowCount = outcome.rowCount;
      } else {
        const outcome = await this.http.run(definition, validation.params, context);
        result = outcome.result;
        afterState = outcome.afterState;
        rowCount = result.status === 'single' ? 1 : 0;
      }
    } catch (error) {
      this.logger.error(
        `${definition.name} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      result = {
        status: 'error',
        message: 'That step failed unexpectedly.',
        retryable: true,
      };
    }

    const durationMs = Date.now() - startedAt;

    emit({
      type: 'function.completed',
      channel: 'trace',
      name: definition.name,
      status: result.status,
      rowCount,
      durationMs,
    });

    await this.audit.record({
      context,
      conversationKey: run.conversationKey,
      functionName: definition.name,
      functionVersion: definition.version,
      functionKind: definition.kind,
      params: validation.params,
      scopesApplied,
      status: auditStatusFor(result),
      ...(result.status === 'denied' ? { deniedReason: result.reason } : {}),
      ...(result.status === 'error' ? { errorMessage: result.message } : {}),
      ...(afterState ? { afterState } : {}),
      disambiguated: result.status === 'ambiguous',
      rowCount,
      latencyMs: durationMs,
    });

    return {
      functionName: definition.name,
      functionVersion: definition.version,
      params: validation.params,
      result,
      durationMs,
    };
  }

  /** Audits and returns an outcome that never reached the function body. */
  private async finish(
    call: PlannedCall,
    version: number,
    result: FunctionResult,
    run: AgentRun,
    startedAt: number,
    status: AuditStatus,
    detail: string,
    kind: 'read' | 'write',
  ): Promise<CallOutcome> {
    const durationMs = Date.now() - startedAt;

    await this.audit.record({
      context: run.context,
      conversationKey: run.conversationKey,
      functionName: call.functionName,
      functionVersion: version,
      functionKind: kind,
      params: call.params,
      scopesApplied: {},
      status,
      ...(status === 'denied' ? { deniedReason: detail } : {}),
      ...(status === 'error' || status === 'invalid_params'
        ? { errorMessage: detail }
        : {}),
      rowCount: 0,
      latencyMs: durationMs,
    });

    return {
      functionName: call.functionName,
      functionVersion: version,
      params: call.params,
      result,
      durationMs,
    };
  }

  /**
   * Fill a dependent call's resolved-identifier parameters from an earlier
   * outcome. Only a `single` result counts — an ambiguous lookup must reach the
   * user as a question, never be quietly collapsed to its top candidate.
   */
  private async resolveDependencies(
    call: PlannedCall,
    outcomes: CallOutcome[],
    run: AgentRun,
  ): Promise<PlannedCall | null> {
    const definition = await this.registry.getExecutable(
      run.context.application.id,
      call.functionName,
    );
    if (!definition) return null;

    const params = { ...call.params };

    for (const dependency of call.dependsOn ?? []) {
      const source = outcomes.find(
        (outcome) => outcome.functionName === dependency,
      );
      if (!source || source.result.status !== 'single') return null;

      const data = source.result.data as Record<string, unknown> | null;
      if (!data) return null;

      for (const [name, param] of Object.entries(definition.parameters)) {
        if (!param.resolvedIdentifier) continue;
        if (params[name] !== undefined) continue;

        // Prefer a same-named column, then the lookup's `id` convention.
        const value = data[name] ?? data.id;
        if (typeof value === 'number' || typeof value === 'string') {
          params[name] = value;
        }
      }
    }

    return { ...call, params };
  }
}

function partition(calls: PlannedCall[]): {
  independent: PlannedCall[];
  dependent: PlannedCall[];
} {
  const names = new Set(calls.map((call) => call.functionName));
  const independent: PlannedCall[] = [];
  const dependent: PlannedCall[] = [];

  for (const call of calls) {
    const waitsOn = (call.dependsOn ?? []).filter((name) => names.has(name));
    if (waitsOn.length > 0) {
      dependent.push({ ...call, dependsOn: waitsOn });
    } else {
      independent.push(call);
    }
  }

  return { independent, dependent };
}

function auditStatusFor(result: FunctionResult): AuditStatus {
  switch (result.status) {
    case 'single':
    case 'list':
      return 'success';
    case 'ambiguous':
      return 'ambiguous';
    case 'empty':
      return 'empty';
    case 'denied':
      return 'denied';
    default:
      return 'error';
  }
}

/** Re-exported so the executor's guard order can be asserted in tests. */
export type { FunctionDefinition };
