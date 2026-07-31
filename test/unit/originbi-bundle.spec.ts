import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FUNCTION_BUNDLE_TAG } from '../../src/management/function-management.service';
import { checkTemplateStatically } from '../../src/registry/sql-template';

// Read as loose records on purpose: the point of these tests is to check the
// file's shape, so field access is deliberately untyped and asserted per use.
type LooseFn = Record<string, unknown>;
interface LooseBundle {
  bundle?: unknown;
  functions: LooseFn[];
}

/**
 * Structural guard for the OriginBI function bundle.
 *
 * These are hand-written functions against a real schema, delivered as a file
 * an operator re-imports. The database is not available in CI, so this cannot
 * check that they *run* — the import path does that against live Postgres. What
 * it can check is everything that has to be true before a query is ever sent:
 * the envelope, the lookup contract, and that every declared scope is actually
 * applied in the SQL. A scope declared and not applied reads as protected and
 * is not, which is the one mistake in a read function that matters most.
 */
describe('OriginBI function bundle', () => {
  const bundle = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'docs', 'originbi-functions.bundle.json'), 'utf8'),
  ) as LooseBundle;

  it('is a well-formed bundle', () => {
    expect(bundle.bundle).toBe(FUNCTION_BUNDLE_TAG);
    expect(Array.isArray(bundle.functions)).toBe(true);
    expect(bundle.functions.length).toBeGreaterThanOrEqual(10);
  });

  it('has a unique name for every function', () => {
    const names = bundle.functions.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(bundle.functions.map((fn) => [fn.name as string, fn]))(
    '%s declares the fields the planner and engine require',
    (_name, fn) => {
      expect(typeof fn.name).toBe('string');
      expect(String(fn.description).length).toBeGreaterThan(30);
      expect(fn.kind).toBe('read');
      expect(['single', 'list', 'single-or-ambiguous']).toContain(fn.returns);
      expect(Array.isArray(fn.allowedRoles)).toBe(true);
      expect((fn.allowedRoles as string[]).length).toBeGreaterThan(0);
      expect(typeof fn.sqlTemplate).toBe('string');
    },
  );

  it.each(
    bundle.functions
      .filter((fn) => fn.returns === 'single-or-ambiguous')
      .map((fn) => [fn.name as string, fn]),
  )('%s (a lookup) resolves ambiguity into a declared parameter', (_name, fn) => {
    const target = fn.ambiguityResolvesTo as string;
    expect(target).toBeTruthy();
    expect(Object.keys(fn.parameters as object)).toContain(target);
    // The label/id/match_score contract is what the runner reads to build
    // candidates; without match_score every row scores equally.
    const sql = fn.sqlTemplate as string;
    expect(sql).toMatch(/\bAS\s+id\b/i);
    expect(sql).toMatch(/\bAS\s+label\b/i);
    expect(sql).toMatch(/\bAS\s+match_score\b/i);
  });

  it.each(bundle.functions.map((fn) => [fn.name as string, fn]))(
    '%s passes the same static checks the editor runs',
    (_name, fn) => {
      const params = Object.keys((fn.parameters as object) ?? {});
      const scopeFilters = (fn.scopeFilters as { key: string; column: string }[]) ?? [];

      const issues = checkTemplateStatically(
        fn.sqlTemplate as string,
        params,
        scopeFilters,
      );
      const errors = issues.filter((issue) => issue.severity === 'error');

      expect(errors).toEqual([]);
    },
  );

  it('scopes every non-admin function to a tenant, and leaves admin/self functions deliberately unscoped or self-scoped', () => {
    for (const fn of bundle.functions) {
      const scopeKeys = ((fn.scopeFilters as { key: string }[]) ?? []).map((f) => f.key);
      const roles = fn.allowedRoles as string[];

      // A CORPORATE-callable function must bind corporate_account_id.
      if (roles.includes('CORPORATE')) {
        expect(scopeKeys).toContain('corporate_account_id');
      }
      // A STUDENT-callable function must bind user_id — a student only ever
      // sees their own rows.
      if (roles.includes('STUDENT')) {
        expect(scopeKeys).toContain('user_id');
      }
    }
  });
});
