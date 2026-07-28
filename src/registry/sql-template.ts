/**
 * The template language registry SQL is written in.
 *
 * Administrators author SQL through the management API. That SQL is data, and
 * the whole design question is how a value reaches a query without ever
 * reaching the query *text*. The answer here is that there is no syntax which
 * produces one:
 *
 *   {{param:name}}   compiles to a `$n` placeholder, bound to a validated value
 *   {{scope:key}}    compiles to `column = $n`, bound to the caller's scope value
 *
 * That is the entire language. A raw `$1` is rejected, a `${…}` is rejected, and
 * string concatenation is not expressible. An author who wants to interpolate a
 * value has no way to say it.
 *
 * Row limits are not the author's responsibility either — the engine wraps the
 * compiled statement, so a function cannot be shipped without one.
 */

export interface ScopeFilterDefinition {
  /** Key looked up on the caller's scope map, e.g. `org_id`. */
  key: string;
  /** Qualified column it constrains, e.g. `r.organisation_id`. */
  column: string;
}

export interface CompileInput {
  template: string;
  /** Validated parameter values, by name. Missing names compile to NULL. */
  params: Record<string, unknown>;
  scopeFilters: ScopeFilterDefinition[];
  /**
   * Scope values for this caller. A key present here is bound; a key listed in
   * `unscopedKeys` compiles to TRUE; a key that is neither is an error.
   */
  scopeValues: Record<string, string | number>;
  /** Scope keys this caller's role is exempt from. */
  unscopedKeys: string[];
}

export interface CompiledQuery {
  sql: string;
  values: unknown[];
  /** Scope keys actually bound, for the audit record. */
  scopesApplied: Record<string, string | number>;
}

export class SqlTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlTemplateError';
  }
}

const TOKEN = /\{\{\s*(param|scope)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Anything that looks like an attempt to reach the query text directly. */
const FORBIDDEN_SYNTAX: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\$\d/,
    reason:
      'Raw $n placeholders are not allowed. Use {{param:name}} — the engine assigns placeholder numbers.',
  },
  {
    pattern: /\$\{/,
    reason:
      'JavaScript template interpolation (${…}) is not a thing here. Use {{param:name}}.',
  },
  {
    pattern: /\{\{\s*(?!param\s*:|scope\s*:)[^}]*\}\}/,
    reason:
      'Unrecognised {{…}} token. Only {{param:name}} and {{scope:key}} exist.',
  },
];

/**
 * Compile a template into a parameterized statement.
 *
 * @throws SqlTemplateError when a token cannot be resolved. Failing closed
 *   matters most for scopes: a scope we cannot bind must never quietly become
 *   an unfiltered query.
 */
export function compileSqlTemplate(input: CompileInput): CompiledQuery {
  const values: unknown[] = [];
  const scopesApplied: Record<string, string | number> = {};
  const scopeByKey = new Map(
    input.scopeFilters.map((filter) => [filter.key, filter]),
  );
  const unscoped = new Set(input.unscopedKeys);

  let failure: string | null = null;

  const sql = input.template.replace(
    TOKEN,
    (_match, kind: string, name: string): string => {
      if (failure) return '';

      if (kind === 'param') {
        // A parameter the caller did not supply binds as NULL rather than
        // failing: optional parameters are normal, and `col = NULL` is false,
        // which is the correct behaviour for an absent filter.
        values.push(
          Object.prototype.hasOwnProperty.call(input.params, name)
            ? (input.params[name] ?? null)
            : null,
        );
        return `$${values.length}`;
      }

      const filter = scopeByKey.get(name);
      if (!filter) {
        failure = `Template references {{scope:${name}}} but no scope filter declares "${name}".`;
        return '';
      }

      if (unscoped.has(name)) {
        // The role is explicitly exempt from this scope — an administrator role
        // that sees every organisation, for example.
        return 'TRUE';
      }

      const value = input.scopeValues[name];
      if (value === undefined || value === null || value === '') {
        failure =
          `Scope "${name}" is required for this function but the caller supplied no value for it, ` +
          `and their role is not exempt. Refusing to run unscoped.`;
        return '';
      }

      values.push(value);
      scopesApplied[name] = value;
      return `${filter.column} = $${values.length}`;
    },
  );

  if (failure) throw new SqlTemplateError(failure);

  return { sql, values, scopesApplied };
}

/** Column the engine adds to carry the unpaged row count. */
export const TOTAL_COLUMN = 'ori_total';

/**
 * Wrap a compiled read so the engine, not the author, owns the row bound.
 *
 * `SELECT *` here selects from the author's own explicit column list rather
 * than from a table, so it cannot pull in a column they did not choose.
 *
 * `COUNT(*) OVER ()` is evaluated before LIMIT, so a paged result still knows
 * how many rows matched in total. That means an author never has to remember to
 * compute it, and "showing 50 of 1,240" is available for free.
 */
export function applyRowBounds(
  compiled: CompiledQuery,
  limit: number,
  offset: number,
): CompiledQuery {
  const values = [...compiled.values, limit, offset];

  return {
    sql:
      `SELECT ori_result.*, COUNT(*) OVER () AS ${TOTAL_COLUMN}\n` +
      `FROM (\n${compiled.sql}\n) AS ori_result\n` +
      `LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
    scopesApplied: compiled.scopesApplied,
  };
}

export interface TemplateStaticIssue {
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Checks that need no database. Run before the live-planning pass so an author
 * gets the obvious problems back immediately.
 */
export function checkTemplateStatically(
  template: string,
  declaredParams: string[],
  scopeFilters: ScopeFilterDefinition[],
): TemplateStaticIssue[] {
  const issues: TemplateStaticIssue[] = [];
  const body = stripSqlComments(template);

  if (body.trim().length === 0) {
    return [{ severity: 'error', message: 'The SQL template is empty.' }];
  }

  for (const { pattern, reason } of FORBIDDEN_SYNTAX) {
    if (pattern.test(body)) {
      issues.push({ severity: 'error', message: reason });
    }
  }

  // One statement. The read-only transaction would reject a second *write*
  // statement, but a second read is still a correctness problem — only the last
  // result would be returned.
  if (/;\s*\S/.test(stripStringLiterals(body))) {
    issues.push({
      severity: 'error',
      message:
        'Only one statement per function. Remove the semicolon and everything after it.',
    });
  }

  if (!/^\s*(SELECT|WITH)\b/i.test(body)) {
    issues.push({
      severity: 'error',
      message: 'A read function must begin with SELECT or WITH.',
    });
  }

  if (/SELECT\s+(\w+\.)?\*/i.test(body)) {
    issues.push({
      severity: 'error',
      message:
        'SELECT * is not allowed. List the columns you want explicitly — a column ' +
        'you do not name is a column that cannot leak.',
    });
  }

  const used = collectTokens(body);
  const declared = new Set(declaredParams);
  const scopeKeys = new Set(scopeFilters.map((filter) => filter.key));

  for (const name of used.params) {
    if (!declared.has(name)) {
      issues.push({
        severity: 'error',
        message: `{{param:${name}}} is used but not declared in the parameter schema.`,
      });
    }
  }

  for (const name of declared) {
    if (!used.params.has(name)) {
      issues.push({
        severity: 'warning',
        message: `Parameter "${name}" is declared but never used in the SQL.`,
      });
    }
  }

  for (const key of used.scopes) {
    if (!scopeKeys.has(key)) {
      issues.push({
        severity: 'error',
        message: `{{scope:${key}}} is used but no scope filter declares "${key}".`,
      });
    }
  }

  for (const key of scopeKeys) {
    if (!used.scopes.has(key)) {
      issues.push({
        severity: 'error',
        message:
          `Scope filter "${key}" is declared but {{scope:${key}}} never appears in the SQL. ` +
          `A declared scope that is not applied is worse than none — it reads as protected.`,
      });
    }
  }

  return issues;
}

function collectTokens(template: string): {
  params: Set<string>;
  scopes: Set<string>;
} {
  const params = new Set<string>();
  const scopes = new Set<string>();

  for (const match of template.matchAll(TOKEN)) {
    const kind = match[1];
    const name = match[2];
    if (!name) continue;
    if (kind === 'param') params.add(name);
    if (kind === 'scope') scopes.add(name);
  }

  return { params, scopes };
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}
