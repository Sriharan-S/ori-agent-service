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

  const reads = bundle.functions.filter((fn) => fn.kind === 'read');
  const writes = bundle.functions.filter((fn) => fn.kind === 'write');

  it.each(bundle.functions.map((fn) => [fn.name as string, fn]))(
    '%s declares the fields the planner and engine require',
    (_name, fn) => {
      expect(typeof fn.name).toBe('string');
      expect(String(fn.description).length).toBeGreaterThan(30);
      expect(['read', 'write']).toContain(fn.kind);
      expect(['single', 'list', 'single-or-ambiguous', 'confirmation']).toContain(
        fn.returns,
      );
      expect(Array.isArray(fn.allowedRoles)).toBe(true);
      expect((fn.allowedRoles as string[]).length).toBeGreaterThan(0);

      // A read carries SQL; an action carries a request. Never both — the
      // executor picks a runner on `kind` alone, so the other one would be
      // stored and silently never run.
      if (fn.kind === 'read') {
        expect(typeof fn.sqlTemplate).toBe('string');
        expect(fn.httpRequest ?? null).toBeNull();
      } else {
        expect(fn.sqlTemplate ?? null).toBeNull();
        expect(fn.httpRequest).toBeTruthy();
      }
    },
  );

  /**
   * The report actions.
   *
   * An action leaves the database, so none of the guarantees a read gets for
   * free apply to it: no WHERE clause carries the tenant, and the row limiter
   * has nothing to bound. Everything that keeps one honest has to be declared.
   */
  describe('actions', () => {
    it('has some', () => {
      expect(writes.length).toBeGreaterThan(0);
    });

    it.each(writes.map((fn) => [fn.name as string, fn]))(
      '%s is gated by a write scope',
      (_name, fn) => {
        expect(typeof fn.writeScope).toBe('string');
        expect(String(fn.writeScope).length).toBeGreaterThan(0);
      },
    );

    it.each(writes.map((fn) => [fn.name as string, fn]))(
      '%s proves the target is in the caller\'s scope before acting',
      (_name, fn) => {
        const request = fn.httpRequest as {
          path?: string;
          precondition?: { sqlTemplate?: string };
        };
        const guard = request.precondition;

        expect(guard?.sqlTemplate).toBeTruthy();
        // Every scope the function declares has to be applied by the guard or
        // the path. A declared scope that is applied nowhere reads as protected
        // and is not.
        const applied = `${request.path ?? ''} ${guard?.sqlTemplate ?? ''}`;
        for (const filter of (fn.scopeFilters as { key: string }[]) ?? []) {
          expect(applied).toContain(`{{scope:${filter.key}}}`);
        }
      },
    );

    it.each(writes.map((fn) => [fn.name as string, fn]))(
      '%s acts on a resolved id or the caller\'s own scope, never on a name',
      (_name, fn) => {
        const request = fn.httpRequest as { path?: string; body?: unknown };
        const hasResolved = Object.values(
          (fn.parameters as Record<string, { resolvedIdentifier?: boolean }>) ?? {},
        ).some((param) => param.resolvedIdentifier);
        const boundToScope = /\{\{scope:/.test(
          `${request.path ?? ''}${JSON.stringify(request.body ?? null)}`,
        );

        expect(hasResolved || boundToScope).toBe(true);
      },
    );

    it('takes the user id the report endpoint is actually keyed on', () => {
      // /report/generate/student/:id is a users.id, not a registrations.id.
      // A registration id in that slot generates a different person's report,
      // and nothing downstream would notice.
      const candidateReport = bundle.functions.find(
        (fn) => fn.name === 'generate_candidate_report',
      );
      const request = candidateReport?.httpRequest as { path: string };

      expect(request.path).toContain('{{param:user_id}}');
      expect(request.path).not.toContain('registration_id');

      // …and the lookup that feeds it has to return that column, or the chain
      // has nothing to fill the parameter from.
      const finder = bundle.functions.find((fn) => fn.name === 'find_candidate');
      expect(finder?.sqlTemplate as string).toMatch(/\br\.user_id\b/);
    });
  });

  it.each(
    reads
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

  it.each(reads.map((fn) => [fn.name as string, fn]))(
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

  /**
   * Three properties of this schema that are easy to get wrong and impossible
   * to notice from the result: each was found by querying the real database
   * while writing these functions, and each would produce a confident wrong
   * answer rather than an error.
   */
  describe('assessment level traps', () => {
    const levelFunctions = bundle.functions.filter((fn) =>
      /_level_scores$|_completion_funnel$|_throughput$|expiring_soon$|^stalled_/.test(fn.name as string),
    );

    it('has functions that read levels at all', () => {
      expect(levelFunctions.length).toBeGreaterThan(0);
    });

    it.each(levelFunctions.map((fn) => [fn.name as string, fn]))(
      '%s never treats a level id as a level number',
      (_name, fn) => {
        const sql = fn.sqlTemplate as string;
        // Level 3 is id 5 and level 4 is id 3, so any literal comparison
        // against assessment_level_id is wrong by construction.
        expect(sql).not.toMatch(/assessment_level_id\s*(=|IN)\s*\(?\s*\d/i);
        expect(sql).toMatch(/JOIN\s+assessment_levels\b/i);
      },
    );

    it.each(
      levelFunctions
        .filter((fn) => /_level_scores$|_completion_funnel$|_throughput$/.test(fn.name as string))
        .map((fn) => [fn.name as string, fn]),
    )('%s orders levels by sort_order, not by id', (_name, fn) => {
      expect(fn.sqlTemplate as string).toMatch(/l\.sort_order/);
    });

    it.each(
      bundle.functions
        .filter((fn) => /_level_scores$/.test(fn.name as string))
        .map((fn) => [fn.name as string, fn]),
    )('%s survives a zero max_score_snapshot', (_name, fn) => {
      // ACI attempts store 0 rather than null, so a plain coalesce divides by
      // zero and a plain nullif reports no maximum at all.
      expect(fn.sqlTemplate as string).toContain('nullif(a.max_score_snapshot, 0)');
    });

    it('reports the IAT error rate as stored, which is already a percentage', () => {
      for (const fn of bundle.functions.filter((f) => /_iat_patterns$/.test(f.name as string))) {
        expect(fn.sqlTemplate as string).toMatch(/round\(m\.error_rate/);
        expect(fn.sqlTemplate as string).not.toMatch(/100\s*\*\s*m\.error_rate/);
      }
    });

    it.each(
      bundle.functions
        .filter((fn) => /_level_scores$/.test(fn.name as string))
        .map((fn) => [fn.name as string, fn]),
    )('%s returns the latest attempt per level, since levels can be retaken', (_name, fn) => {
      expect(fn.sqlTemplate as string).toContain('DISTINCT ON (l.sort_order)');
      expect(fn.sqlTemplate as string).toMatch(/ORDER BY l\.sort_order, a\.completed_at DESC/);
    });
  });

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
