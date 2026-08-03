import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

/**
 * Recognises a SQL statement rather than English that happens to use SQL words.
 *
 * Keyword-anywhere matching produced false positives on the prompt templates —
 * the planner prompt contains both "Choose the fewest functions" and "take
 * parameter values from what the user said". A noisy guard is a guard someone
 * eventually switches off, so this matches on structure: a literal is SQL when
 * it *begins* with a statement keyword, or contains a JOIN … ON clause.
 */
const SQL_STATEMENT =
  /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|BEGIN|SET)\b|\bJOIN\b[\s\S]+?\bON\b/i;

/**
 * Interpolations permitted inside a SQL template literal.
 *
 * Each composes SQL *structure* from something this codebase controls — a
 * schema name validated by `quoteIdent`, a column reference constrained to an
 * identifier shape at save time, a fixed column list. None can carry a value
 * that originated with the LLM, an end user, or a stored function body.
 *
 * Adding an entry here is a security decision. Do not add one to make a test
 * pass; bind the value instead.
 */
const ALLOWED_FRAGMENTS = new Set([
  // Schema name — `quoteIdent` rejects anything that is not an identifier.
  'this.schema',
  's',
  'schema',
  'quoteIdent(schema)',
  'quoteIdent(this.db.schema)',
  // Fixed column list constant in registry.service.ts.
  'SELECT_COLUMNS',
  // Scope column, constrained to `alias.column` by the save-time validator.
  'filter.column',
  // Engine-owned identifiers and already-compiled placeholder-only SQL.
  'TOTAL_COLUMN',
  'compiled.sql',
  // Fixed column list constant in observability.service.ts.
  'AUDIT_COLUMNS',
  /*
   * Fixed column list constant in knowledge/document.service.ts.
   *
   * A module-level string literal naming the columns of `agent_documents`.
   * Postgres cannot bind a column list as a parameter, and this one is not
   * reachable from a request, an end user, an uploaded document or the LLM —
   * it is the same category as SELECT_COLUMNS and AUDIT_COLUMNS above.
   *
   * Note what is *not* here: the retrieval pool sizes. They are module
   * constants too, and binding them was still the right answer, because a LIMIT
   * is a value and values get bound.
   */
  'SUMMARY_COLUMNS',
  // Fixed column list constant in feedback/feedback.service.ts. Same category
  // again. Named for its table rather than called `COLUMNS`, so this entry
  // cannot later wave through some unrelated constant that happens to share a
  // generic name.
  'FEEDBACK_COLUMNS',
  /*
   * Scope-sample lookup in database-info.service.ts.
   *
   * Postgres cannot bind an identifier as a parameter, so a query that reads
   * "the distinct values of this column on that table" has to interpolate both.
   * Justification, on the same principle as the schema name above:
   *
   *   - `relation` is `quoteIdent(schema) + '.' + quoteIdent(table)`, and
   *     `scopeColumn` is `quoteIdent(column)`. `quoteIdent` *throws* on anything
   *     that is not `[A-Za-z_][A-Za-z0-9_$]*`, so neither can carry punctuation.
   *   - Both originate from configuration and the catalogue — a function's own
   *     declared scope filter, an alias resolved from that function's SQL, or
   *     `information_schema` — never from a request, an end user, or the LLM.
   *   - The one actual *value*, the row limit, is bound as `$1`.
   *
   * If either name ever becomes reachable from request input, this entry must
   * go and the feature with it.
   */
  'relation',
  'scopeColumn',
]);

function collectTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...collectTypeScriptFiles(path));
    } else if (entry.endsWith('.ts')) {
      found.push(path);
    }
  }

  return found;
}

/** Documentation quotes SQL, and a comment cannot execute. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractTemplateLiterals(source: string): string[] {
  const literals: string[] = [];
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf('`', index);
    if (start === -1) break;

    let end = start + 1;
    while (end < source.length) {
      if (source[end] === '\\') {
        end += 2;
        continue;
      }
      if (source[end] === '`') break;
      end += 1;
    }
    if (end >= source.length) break;

    literals.push(source.slice(start + 1, end));
    index = end + 1;
  }

  return literals;
}

interface Interpolation {
  expression: string;
  /** True when the literal reads `$${expr}` — it emits a placeholder. */
  isPlaceholder: boolean;
}

function extractInterpolations(literal: string): Interpolation[] {
  const found: Interpolation[] = [];
  let index = 0;

  while (index < literal.length) {
    const start = literal.indexOf('${', index);
    if (start === -1) break;

    let depth = 1;
    let end = start + 2;
    while (end < literal.length && depth > 0) {
      if (literal[end] === '{') depth += 1;
      if (literal[end] === '}') depth -= 1;
      end += 1;
    }

    found.push({
      expression: literal.slice(start + 2, end - 1).trim(),
      isPlaceholder: start > 0 && literal[start - 1] === '$',
    });

    index = end;
  }

  return found;
}

function scan(source: string): string[] {
  const offenders: string[] = [];

  for (const literal of extractTemplateLiterals(stripComments(source))) {
    if (!SQL_STATEMENT.test(literal)) continue;

    for (const interpolation of extractInterpolations(literal)) {
      if (interpolation.isPlaceholder) continue;
      if (ALLOWED_FRAGMENTS.has(interpolation.expression)) continue;
      offenders.push(interpolation.expression);
    }
  }

  return offenders;
}

describe('no value is interpolated into SQL', () => {
  const files = collectTypeScriptFiles(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((file) => [file.slice(SRC.length + 1), file]))(
    '%s',
    (_label, file) => {
      expect(scan(readFileSync(file, 'utf8'))).toEqual([]);
    },
  );
});

describe('the guard itself', () => {
  // A scanner that cannot fail is not protecting anything.
  it('catches a value interpolated into a WHERE clause', () => {
    expect(
      scan("const q = `SELECT id FROM users WHERE email = '${email}'`;"),
    ).toEqual(['email']);
  });

  it('catches an interpolated LIMIT', () => {
    expect(scan('const q = `SELECT id FROM users LIMIT ${limit}`;')).toEqual([
      'limit',
    ]);
  });

  it('catches an interpolated table name', () => {
    expect(scan('const q = `SELECT id FROM ${table} WHERE id = $1`;')).toEqual([
      'table',
    ]);
  });

  it('accepts a bound placeholder', () => {
    expect(
      scan('const q = `SELECT id FROM users WHERE email = $${index}`;'),
    ).toEqual([]);
  });

  it('accepts an allow-listed structural fragment', () => {
    expect(scan('const q = `SELECT id FROM ${this.schema}.users`;')).toEqual([]);
  });

  it('ignores prose that merely uses SQL words', () => {
    expect(
      scan(
        'const p = `Choose the fewest functions. Take values from the message.`;',
      ),
    ).toEqual([]);
  });
});

describe('no engine query selects everything', () => {
  const files = collectTypeScriptFiles(SRC);

  it.each(files.map((file) => [file.slice(SRC.length + 1), file]))(
    '%s uses an explicit column list',
    (_label, file) => {
      const source = stripComments(readFileSync(file, 'utf8'));

      for (const literal of extractTemplateLiterals(source)) {
        if (!SQL_STATEMENT.test(literal)) continue;
        // The one legitimate `SELECT *` is the engine's row-bound wrapper,
        // which selects from the author's own column list rather than a table.
        if (literal.includes('AS ori_result')) continue;
        if (literal.includes('ori_result.*')) continue;

        expect(literal).not.toMatch(/SELECT\s+(\w+\.)?\*(?!\s*\)?\s*OVER)/i);
      }
    },
  );
});
