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
      if (!hasResolved) {
        issues.push({
          severity: 'error',
          message:
            'A write function must take at least one resolvedIdentifier parameter. ' +
            'Actions act on ids that a lookup produced, never on names.',
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

  /**
   * Ask Postgres. Compiles with NULL bound to every placeholder — enough to
   * parse, resolve every identifier and plan, without depending on real values.
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
        params: {},
        scopeFilters: draft.scopeFilters,
        scopeValues: Object.fromEntries(
          draft.scopeFilters.map((filter) => [filter.key, 0]),
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

function collectTemplateNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /\{\{\s*param\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
  )) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}
