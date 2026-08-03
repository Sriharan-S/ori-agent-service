import { Injectable, Logger } from '@nestjs/common';
import { ReadDb } from '../db/read.db';
import {
  LOOKUP_REQUIRED_COLUMNS,
  type FunctionKind,
  type HttpRequestSpec,
  type ParamSchema,
  type ReturnShape,
} from './function.contract';
import {
  applyRowBounds,
  checkTemplateStatically,
  compileSqlTemplate,
  TOTAL_COLUMN,
  type ScopeFilterDefinition,
} from './sql-template';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface FunctionDraft {
  name: string;
  kind: FunctionKind;
  description: string;
  parameters: ParamSchema;
  requiredOneOf: string[][];
  returns: ReturnShape;
  ambiguityResolvesTo: string | null;
  scopeFilters: ScopeFilterDefinition[];
  sqlTemplate: string | null;
  httpRequest: HttpRequestSpec | null;
  writeScope: string | null;
  allowedRoles: string[];
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  /** Output columns, from real result metadata. Read functions only. */
  columns?: string[];
  /** Query plan, shown to the author so index problems surface at authoring time. */
  plan?: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Validates a function before it can be saved.
 *
 * The important part is what it does *not* do: it does not try to understand
 * SQL with regular expressions. The predecessor's validator failed because a
 * regex cannot parse SQL, so this hands the statement to Postgres and lets the
 * real parser answer.
 *
 * Two live checks, both inside a READ ONLY transaction:
 *
 *   - `LIMIT 0` execution — parses, plans and returns column metadata without
 *     reading a row. This is how output columns are verified.
 *   - `EXPLAIN` — produces the plan, which is returned to the author. The
 *     "confirm it is index-backed" step becomes something they can see when
 *     they save, rather than a checklist item nobody runs.
 *
 * A statement that is not a read is rejected by the server, not by a keyword
 * blocklist.
 */
@Injectable()
export class FunctionValidatorService {
  private readonly logger = new Logger(FunctionValidatorService.name);

  constructor(private readonly readDb: ReadDb) {}

  async validate(draft: FunctionDraft): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [...this.checkShape(draft)];

    if (draft.kind === 'write') {
      issues.push(...this.checkHttpRequest(draft));

      // The precondition is real SQL and gets the same treatment as a read
      // function's body: Postgres decides whether it is valid, not a regex.
      // Skipped once the shape is already wrong, so an author sees the
      // structural problem rather than a parse error caused by it.
      const guard = draft.httpRequest?.precondition;
      if (guard && !issues.some((issue) => issue.severity === 'error')) {
        issues.push(...(await this.checkPreconditionSql(draft, guard.sqlTemplate)));
      }

      return { ok: !issues.some((i) => i.severity === 'error'), issues };
    }

    const template = draft.sqlTemplate ?? '';
    issues.push(
      ...checkTemplateStatically(
        template,
        Object.keys(draft.parameters),
        draft.scopeFilters,
      ),
    );

    if (issues.some((issue) => issue.severity === 'error')) {
      return { ok: false, issues };
    }

    const live = await this.checkAgainstDatabase(draft, template);
    issues.push(...live.issues);

    return {
      ok: !issues.some((issue) => issue.severity === 'error'),
      issues,
      ...(live.columns ? { columns: live.columns } : {}),
      ...(live.plan ? { plan: live.plan } : {}),
    };
  }

  /** Structural rules that hold regardless of the body. */
  private checkShape(draft: FunctionDraft): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (!NAME_PATTERN.test(draft.name)) {
      issues.push({
        severity: 'error',
        message:
          'Name must be lower_snake_case, 3-64 characters, starting with a letter.',
      });
    }

    if (draft.description.trim().length < 40) {
      issues.push({
        severity: 'warning',
        message:
          'The description is very short. The planner selects functions almost ' +
          'entirely on this text — say what it returns and which identifiers it accepts.',
      });
    }

    if (draft.allowedRoles.length === 0) {
      issues.push({
        severity: 'error',
        message: 'No roles are allowed to call this function, so nothing could.',
      });
    }

    for (const group of draft.requiredOneOf) {
      for (const name of group) {
        if (!Object.prototype.hasOwnProperty.call(draft.parameters, name)) {
          issues.push({
            severity: 'error',
            message: `requiredOneOf references undeclared parameter "${name}".`,
          });
        }
      }
    }

    if (draft.returns === 'single-or-ambiguous') {
      const target = draft.ambiguityResolvesTo;
      if (!target) {
        issues.push({
          severity: 'error',
          message:
            'A single-or-ambiguous function must set ambiguityResolvesTo, so a ' +
            "reply to the clarifying question has somewhere to go.",
        });
      } else if (
        !Object.prototype.hasOwnProperty.call(draft.parameters, target)
      ) {
        issues.push({
          severity: 'error',
          message: `ambiguityResolvesTo references undeclared parameter "${target}".`,
        });
      }
    }

    if (draft.kind === 'write') {
      if (!draft.writeScope) {
        issues.push({
          severity: 'error',
          message: 'A write function must declare a write scope.',
        });
      }
      const hasResolved = Object.values(draft.parameters).some(
        (param) => param.resolvedIdentifier,
      );
      // An action must act on something it did not have to guess. Two ways to
      // satisfy that: an id a lookup produced, or the caller's own proven scope
      // — "generate *my* report" takes no identifier at all, and demanding one
      // would force a self-service action to accept a user id as a parameter,
      // which is strictly worse.
      const boundToScope =
        SCOPE_TOKEN_PATTERN.test(draft.httpRequest?.path ?? '') ||
        SCOPE_TOKEN_PATTERN.test(JSON.stringify(draft.httpRequest?.body ?? null)) ||
        Boolean(draft.httpRequest?.precondition);

      if (!hasResolved && !boundToScope) {
        issues.push({
          severity: 'error',
          message:
            'A write function must either take a resolvedIdentifier parameter or bind the ' +
            "caller's scope — with a {{scope:key}} token or a precondition. Actions act on " +
            'ids a lookup produced or on the caller\'s own records, never on names.',
        });
      }
    } else if (draft.writeScope) {
      issues.push({
        severity: 'error',
        message: 'A read function must not declare a write scope.',
      });
    }

    for (const filter of draft.scopeFilters) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(filter.key)) {
        issues.push({
          severity: 'error',
          message: `Scope key "${filter.key}" must be a plain identifier.`,
        });
      }
      // The column is spliced into SQL as an identifier, so it is constrained
      // to an identifier shape rather than trusted.
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(filter.column)) {
        issues.push({
          severity: 'error',
          message:
            `Scope column "${filter.column}" must be a column reference such as ` +
            '`alias.column` — no expressions, no function calls.',
        });
      }
    }

    return issues;
  }

  private checkHttpRequest(draft: FunctionDraft): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const spec = draft.httpRequest;

    if (!spec) {
      return [
        { severity: 'error', message: 'A write function needs an HTTP action.' },
      ];
    }

    issues.push(...this.checkScopeTokens(draft, spec));
    issues.push(...this.checkPoll(spec));
    issues.push(...this.checkResult(spec));

    if (!spec.service || !/^[a-z][a-z0-9_-]*$/i.test(spec.service)) {
      issues.push({
        severity: 'error',
        message:
          'The action must name a registered service. Actions cannot target an ' +
          'arbitrary host — that is what stops a saved function reaching internal endpoints.',
      });
    }

    if (!spec.path.startsWith('/')) {
      issues.push({
        severity: 'error',
        message: 'The action path must start with "/" and be relative to the service base URL.',
      });
    }

    if (/^https?:\/\//i.test(spec.path)) {
      issues.push({
        severity: 'error',
        message: 'The action path must not be an absolute URL.',
      });
    }

    for (const name of collectTemplateNames(spec.path)) {
      if (!Object.prototype.hasOwnProperty.call(draft.parameters, name)) {
        issues.push({
          severity: 'error',
          message: `Path references {{param:${name}}}, which is not declared.`,
        });
      }
    }

    for (const name of collectTemplateNames(JSON.stringify(spec.body ?? null))) {
      if (!Object.prototype.hasOwnProperty.call(draft.parameters, name)) {
        issues.push({
          severity: 'error',
          message: `Body references {{param:${name}}}, which is not declared.`,
        });
      }
    }

    if (spec.method === 'GET' && spec.body) {
      issues.push({
        severity: 'warning',
        message: 'A GET action with a body is unusual; most servers ignore it.',
      });
    }

    return issues;
  }

  /** Every {{scope:key}} in a path or body must be a key the function declares. */
  private checkScopeTokens(
    draft: FunctionDraft,
    spec: HttpRequestSpec,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const declared = new Set(draft.scopeFilters.map((filter) => filter.key));
    const used = new Set([
      ...collectScopeNames(spec.path),
      ...collectScopeNames(JSON.stringify(spec.body ?? null)),
      ...collectScopeNames(spec.precondition?.sqlTemplate ?? ''),
    ]);

    for (const key of used) {
      if (!declared.has(key)) {
        issues.push({
          severity: 'error',
          message:
            `{{scope:${key}}} is used but no scope filter declares "${key}". ` +
            'A scope the engine cannot resolve refuses the action at run time.',
        });
      }
    }

    for (const key of declared) {
      if (!used.has(key)) {
        issues.push({
          severity: 'error',
          message:
            `Scope filter "${key}" is declared but {{scope:${key}}} appears nowhere in the ` +
            'action or its precondition. A declared scope that is not applied reads as ' +
            'protected and is not.',
        });
      }
    }

    return issues;
  }

  private checkPoll(spec: HttpRequestSpec): ValidationIssue[] {
    const poll = spec.poll;
    if (!poll) return [];

    const issues: ValidationIssue[] = [];

    if (!poll.urlFrom && !poll.path) {
      issues.push({
        severity: 'error',
        message:
          'A poll needs either urlFrom — the response field holding the follow-up URL — ' +
          'or path, a template built from the response.',
      });
    }

    if (!poll.statusField) {
      issues.push({
        severity: 'error',
        message: 'A poll needs statusField, naming the field that says whether the job is done.',
      });
    }

    if (!Array.isArray(poll.successWhen) || poll.successWhen.length === 0) {
      issues.push({
        severity: 'error',
        message:
          'A poll needs successWhen: the status values that mean the job finished. ' +
          'Without one it can only ever time out.',
      });
    }

    if (poll.path && /^https?:\/\//i.test(poll.path)) {
      issues.push({
        severity: 'error',
        message: 'A poll path must be relative to the service, not an absolute URL.',
      });
    }

    const overlap = (poll.failureWhen ?? []).filter((value) =>
      (poll.successWhen ?? []).includes(value),
    );
    if (overlap.length > 0) {
      issues.push({
        severity: 'error',
        message: `Status "${overlap.join('", "')}" is listed as both success and failure.`,
      });
    }

    if ((poll.maxAttempts ?? 20) * (poll.intervalMs ?? 2000) > 300_000) {
      issues.push({
        severity: 'warning',
        message:
          'This poll could run for over five minutes on paper. The service-wide ceiling ' +
          'stops it long before that, so the later attempts will never happen.',
      });
    }

    return issues;
  }

  private checkResult(spec: HttpRequestSpec): ValidationIssue[] {
    const result = spec.result;
    if (!result) return [];

    const issues: ValidationIssue[] = [];

    if (result.link && !result.link.from) {
      issues.push({
        severity: 'error',
        message: 'A result link needs "from", naming the response field that holds the URL.',
      });
    }

    for (const field of result.expose ?? []) {
      if (!field.from) {
        issues.push({
          severity: 'error',
          message: 'Every exposed field needs "from", naming the response field to read.',
        });
      }
    }

    if ((result.expose ?? []).length > 0) {
      issues.push({
        severity: 'warning',
        message:
          'Exposed fields are handed to the caller verbatim. They bypass the model, so they ' +
          'are never paraphrased — but whoever can call this function will see them. ' +
          'Expose one field at a time and only what the answer genuinely needs.',
      });
    }

    return issues;
  }

  /**
   * The scope guard, handed to Postgres.
   *
   * Only the scope keys the guard itself uses are bound, because a function may
   * declare a key that its path uses and its guard does not — the combined
   * usage is checked separately in `checkScopeTokens`.
   */
  private async checkPreconditionSql(
    draft: FunctionDraft,
    template: string,
  ): Promise<ValidationIssue[]> {
    const used = new Set(collectScopeNames(template));
    const filters = draft.scopeFilters.filter((filter) => used.has(filter.key));

    let compiled;
    try {
      compiled = compileSqlTemplate({
        template,
        params: sampleParams(draft.parameters),
        scopeFilters: filters,
        scopeValues: Object.fromEntries(filters.map((f) => [f.key, 1])),
        unscopedKeys: [],
      });
    } catch (error) {
      return [
        {
          severity: 'error',
          message: `Precondition: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }

    const bounded = applyRowBounds(compiled, 0, 0);

    try {
      await this.readDb.query(bounded.sql, bounded.values, {
        label: `validate-precondition:${draft.name}`,
        statementTimeoutMs: 5000,
      });
    } catch (error) {
      return [
        {
          severity: 'error',
          message: `Postgres rejected the precondition: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ];
    }

    return [];
  }

  /**
   * Ask Postgres.
   *
   * Bound values are type-appropriate placeholders rather than NULL. That
   * matters more than it looks: with every parameter NULL, a `WHERE a = $1 OR
   * b = $2` collapses to a provable false and Postgres returns a `One-Time
   * Filter: false` plan without touching an index — so the plan shown to the
   * author would say nothing about whether the query is actually index-backed.
   */
  private async checkAgainstDatabase(
    draft: FunctionDraft,
    template: string,
  ): Promise<{ issues: ValidationIssue[]; columns?: string[]; plan?: string }> {
    const issues: ValidationIssue[] = [];

    let compiled;
    try {
      compiled = compileSqlTemplate({
        template,
        params: sampleParams(draft.parameters),
        scopeFilters: draft.scopeFilters,
        scopeValues: Object.fromEntries(
          draft.scopeFilters.map((filter) => [filter.key, 1]),
        ),
        unscopedKeys: [],
      });
    } catch (error) {
      return {
        issues: [
          {
            severity: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    const bounded = applyRowBounds(compiled, 0, 0);

    let columns: string[] | undefined;
    try {
      const probe = await this.readDb.query(bounded.sql, bounded.values, {
        label: `validate:${draft.name}`,
        statementTimeoutMs: 5000,
      });
      // The engine's own bookkeeping column is not part of the author's output.
      columns = probe.fields.filter((field) => field !== TOTAL_COLUMN);
    } catch (error) {
      return {
        issues: [
          {
            severity: 'error',
            message: `Postgres rejected this query: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }

    if (draft.returns === 'single-or-ambiguous') {
      for (const required of LOOKUP_REQUIRED_COLUMNS) {
        if (!columns.includes(required)) {
          issues.push({
            severity: 'error',
            message:
              `A single-or-ambiguous function must return a "${required}" column — ` +
              'it is what the clarifying question is built from. ' +
              `Returned columns: ${columns.join(', ')}.`,
          });
        }
      }
      if (!columns.includes('match_score')) {
        issues.push({
          severity: 'warning',
          message:
            'No "match_score" column. Without one every row scores equally and any ' +
            'multi-row result will ask the user to choose. Add a scoring expression ' +
            'if this function does fuzzy matching.',
        });
      }
    }

    const explained = await this.readDb.explain(bounded.sql, bounded.values);
    let plan: string | undefined;

    if (explained.ok) {
      plan = explained.plan;
      if (/Seq Scan on/i.test(plan)) {
        issues.push({
          severity: 'warning',
          message:
            'The plan contains a sequential scan. Fine on a small table, a problem ' +
            'on a large one — check that the columns you filter on are indexed.',
        });
      }
    } else {
      this.logger.debug(`EXPLAIN failed for ${draft.name}: ${explained.error}`);
    }

    return { issues, columns, ...(plan ? { plan } : {}) };
  }
}

/**
 * Representative values for planning, derived from the declared schema.
 *
 * The values are never read — nothing is returned, because the probe runs with
 * `LIMIT 0`. They exist so Postgres plans the query it would really run: a
 * number where a number is expected, so an integer comparison is not coerced
 * into something unindexable, and a short string where a string is expected.
 */
function sampleParams(schema: ParamSchema): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (const [name, param] of Object.entries(schema)) {
    switch (param.type) {
      case 'integer':
      case 'number':
        params[name] = param.min ?? 1;
        break;
      case 'boolean':
        params[name] = true;
        break;
      default:
        params[name] = param.enum?.[0] ?? 'sample';
    }
  }

  return params;
}

function collectTemplateNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /\{\{\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
  )) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

const SCOPE_TOKEN_PATTERN = /\{\{\s*scope\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

function collectScopeNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /\{\{\s*scope\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
  )) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}
