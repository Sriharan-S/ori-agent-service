import {
  applyRowBounds,
  checkTemplateStatically,
  compileSqlTemplate,
  SqlTemplateError,
  TOTAL_COLUMN,
} from '../../src/registry/sql-template';

const scopeFilters = [{ key: 'org_id', column: 'r.org_id' }];

describe('compileSqlTemplate', () => {
  it('turns a parameter token into a bound placeholder', () => {
    const compiled = compileSqlTemplate({
      template: 'SELECT id FROM t WHERE email = {{param:email}}',
      params: { email: 'a@b.test' },
      scopeFilters: [],
      scopeValues: {},
      unscopedKeys: [],
    });

    expect(compiled.sql).toBe('SELECT id FROM t WHERE email = $1');
    expect(compiled.values).toEqual(['a@b.test']);
  });

  it('never places a value in the SQL text, however hostile', () => {
    const compiled = compileSqlTemplate({
      template: 'SELECT id FROM t WHERE name = {{param:name}}',
      params: { name: "x'; DROP TABLE users; --" },
      scopeFilters: [],
      scopeValues: {},
      unscopedKeys: [],
    });

    expect(compiled.sql).toBe('SELECT id FROM t WHERE name = $1');
    expect(compiled.sql).not.toContain('DROP');
    expect(compiled.values[0]).toBe("x'; DROP TABLE users; --");
  });

  it('numbers placeholders in order of appearance', () => {
    const compiled = compileSqlTemplate({
      template:
        'SELECT id FROM t WHERE a = {{param:a}} AND b = {{param:b}} AND c = {{param:a}}',
      params: { a: 1, b: 2 },
      scopeFilters: [],
      scopeValues: {},
      unscopedKeys: [],
    });

    // Repeating a parameter binds it twice rather than reusing the placeholder,
    // which keeps compilation a single left-to-right pass.
    expect(compiled.sql).toBe(
      'SELECT id FROM t WHERE a = $1 AND b = $2 AND c = $3',
    );
    expect(compiled.values).toEqual([1, 2, 1]);
  });

  it('binds an absent optional parameter as NULL', () => {
    const compiled = compileSqlTemplate({
      template: 'SELECT id FROM t WHERE email = {{param:email}}',
      params: {},
      scopeFilters: [],
      scopeValues: {},
      unscopedKeys: [],
    });

    expect(compiled.values).toEqual([null]);
  });

  it('binds a scope value rather than embedding it', () => {
    const compiled = compileSqlTemplate({
      template: 'SELECT id FROM r WHERE {{scope:org_id}}',
      params: {},
      scopeFilters,
      scopeValues: { org_id: 42 },
      unscopedKeys: [],
    });

    expect(compiled.sql).toBe('SELECT id FROM r WHERE r.org_id = $1');
    expect(compiled.sql).not.toContain('42');
    expect(compiled.values).toEqual([42]);
    expect(compiled.scopesApplied).toEqual({ org_id: 42 });
  });

  it('opens the filter only for a role explicitly exempt from that scope', () => {
    const compiled = compileSqlTemplate({
      template: 'SELECT id FROM r WHERE {{scope:org_id}}',
      params: {},
      scopeFilters,
      scopeValues: {},
      unscopedKeys: ['org_id'],
    });

    expect(compiled.sql).toBe('SELECT id FROM r WHERE TRUE');
    expect(compiled.scopesApplied).toEqual({});
  });

  it('refuses to run when a scope value is missing and the role is not exempt', () => {
    // The case that must never quietly become an unfiltered query.
    expect(() =>
      compileSqlTemplate({
        template: 'SELECT id FROM r WHERE {{scope:org_id}}',
        params: {},
        scopeFilters,
        scopeValues: {},
        unscopedKeys: [],
      }),
    ).toThrow(SqlTemplateError);

    expect(() =>
      compileSqlTemplate({
        template: 'SELECT id FROM r WHERE {{scope:org_id}}',
        params: {},
        scopeFilters,
        scopeValues: {},
        unscopedKeys: [],
      }),
    ).toThrow(/Refusing to run unscoped/);
  });

  it('refuses an empty-string scope value', () => {
    expect(() =>
      compileSqlTemplate({
        template: 'SELECT id FROM r WHERE {{scope:org_id}}',
        params: {},
        scopeFilters,
        scopeValues: { org_id: '' },
        unscopedKeys: [],
      }),
    ).toThrow(SqlTemplateError);
  });

  it('refuses a scope token with no declared filter', () => {
    expect(() =>
      compileSqlTemplate({
        template: 'SELECT id FROM r WHERE {{scope:undeclared}}',
        params: {},
        scopeFilters,
        scopeValues: { undeclared: 1 },
        unscopedKeys: [],
      }),
    ).toThrow(/no scope filter declares/);
  });
});

describe('applyRowBounds', () => {
  it('binds the limit and offset, and adds an unpaged total', () => {
    const bounded = applyRowBounds(
      { sql: 'SELECT id FROM t WHERE a = $1', values: ['x'], scopesApplied: {} },
      50,
      100,
    );

    expect(bounded.sql).toContain(`COUNT(*) OVER () AS ${TOTAL_COLUMN}`);
    expect(bounded.sql).toContain('LIMIT $2 OFFSET $3');
    expect(bounded.values).toEqual(['x', 50, 100]);
  });

  it('cannot be omitted by the author — the engine always wraps', () => {
    const bounded = applyRowBounds(
      { sql: 'SELECT id FROM t', values: [], scopesApplied: {} },
      10,
      0,
    );

    expect(bounded.sql).toMatch(/LIMIT \$1 OFFSET \$2/);
  });
});

describe('checkTemplateStatically', () => {
  const errors = (issues: ReturnType<typeof checkTemplateStatically>) =>
    issues.filter((issue) => issue.severity === 'error').map((i) => i.message);

  it('accepts a well-formed template', () => {
    const issues = checkTemplateStatically(
      'SELECT r.id AS id, r.name AS label FROM r WHERE r.email = {{param:email}} AND {{scope:org_id}}',
      ['email'],
      scopeFilters,
    );

    expect(errors(issues)).toEqual([]);
  });

  it('rejects a raw $n placeholder', () => {
    const issues = checkTemplateStatically('SELECT id FROM t WHERE a = $1', [], []);
    expect(errors(issues).join(' ')).toMatch(/Raw \$n placeholders are not allowed/);
  });

  it('rejects JavaScript template interpolation', () => {
    const issues = checkTemplateStatically(
      'SELECT id FROM t WHERE a = ${value}',
      [],
      [],
    );
    expect(errors(issues).join(' ')).toMatch(/template interpolation/i);
  });

  it('rejects an unrecognised token', () => {
    const issues = checkTemplateStatically(
      'SELECT id FROM t WHERE a = {{value}}',
      [],
      [],
    );
    expect(errors(issues).join(' ')).toMatch(/Unrecognised/);
  });

  it('rejects SELECT *', () => {
    const issues = checkTemplateStatically('SELECT * FROM t', [], []);
    expect(errors(issues).join(' ')).toMatch(/SELECT \* is not allowed/);
  });

  it('rejects a qualified star', () => {
    const issues = checkTemplateStatically('SELECT r.* FROM registrations r', [], []);
    expect(errors(issues).join(' ')).toMatch(/SELECT \* is not allowed/);
  });

  it('rejects a second statement', () => {
    const issues = checkTemplateStatically(
      'SELECT id FROM t; DROP TABLE t',
      [],
      [],
    );
    expect(errors(issues).join(' ')).toMatch(/Only one statement/);
  });

  it('allows a semicolon inside a string literal', () => {
    const issues = checkTemplateStatically(
      "SELECT id FROM t WHERE note = 'a; b'",
      [],
      [],
    );
    expect(errors(issues).join(' ')).not.toMatch(/Only one statement/);
  });

  it('rejects anything that is not a SELECT or WITH', () => {
    expect(errors(checkTemplateStatically('UPDATE t SET a = 1', [], [])).join(' '))
      .toMatch(/must begin with SELECT or WITH/);
    expect(errors(checkTemplateStatically('DELETE FROM t', [], [])).join(' '))
      .toMatch(/must begin with SELECT or WITH/);
  });

  it('accepts a CTE', () => {
    const issues = checkTemplateStatically(
      'WITH x AS (SELECT id FROM t) SELECT id FROM x',
      [],
      [],
    );
    expect(errors(issues)).toEqual([]);
  });

  it('rejects a parameter token that is not declared', () => {
    const issues = checkTemplateStatically(
      'SELECT id FROM t WHERE a = {{param:ghost}}',
      [],
      [],
    );
    expect(errors(issues).join(' ')).toMatch(/not declared/);
  });

  it('warns about a declared parameter that is never used', () => {
    const issues = checkTemplateStatically('SELECT id FROM t', ['unused'], []);
    expect(issues.some((i) => i.severity === 'warning' && /never used/.test(i.message)))
      .toBe(true);
  });

  it('rejects a declared scope filter that the SQL never applies', () => {
    // The dangerous direction: the function looks protected and is not.
    const issues = checkTemplateStatically('SELECT id FROM t', [], scopeFilters);
    expect(errors(issues).join(' ')).toMatch(/never appears in the SQL/);
  });

  it('ignores tokens inside comments when checking statements', () => {
    const issues = checkTemplateStatically(
      '-- a comment with a ; semicolon\nSELECT id FROM t',
      [],
      [],
    );
    expect(errors(issues)).toEqual([]);
  });
});
