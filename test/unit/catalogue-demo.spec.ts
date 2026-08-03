import { RegistryService } from '../../src/registry/registry.service';
import { DEMO_FUNCTION_NAME } from '../../src/management/demo-function';
import type { PrimaryDb } from '../../src/db/primary.db';
import type { RoleRecord } from '../../src/auth/identity';
import { loadConfiguration } from '../../src/config/configuration';

/**
 * What the planner is allowed to see.
 *
 * The demo function reads the database catalogue, which makes it a plausible
 * answer to almost any question when nothing better is on offer. That is
 * exactly what it is for on a fresh install, and exactly wrong once real
 * functions exist: after an import every real function is a draft, the demo is
 * the only live one, and the model answers a question about a person's report
 * with a list of table names — confidently, because it had one option.
 */

function row(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    application_id: '1',
    name,
    category: 'general',
    kind: 'read',
    description: `the ${name} function`,
    when_to_use: [],
    when_not_to_use: [],
    parameters: {},
    required_one_of: [],
    returns: 'list',
    ambiguity_resolves_to: null,
    allowed_roles: ['*'],
    scope_filters: [],
    sql_template: 'SELECT 1',
    http_request: null,
    write_scope: null,
    requires_confirmation: false,
    default_limit: null,
    max_limit: null,
    status: 'live',
    version: 1,
    last_validated_at: null,
    validation_error: null,
    ...overrides,
  };
}

function registry(names: string[]): RegistryService {
  const db = {
    schema: 'ori',
    query: () => Promise.resolve(names.map((name) => row(name))),
  } as unknown as PrimaryDb;

  return new RegistryService(loadConfiguration(), db);
}

const role = (overrides: Partial<RoleRecord> = {}): RoleRecord => ({
  id: 1,
  applicationId: 1,
  name: 'ADMIN',
  description: null,
  allowedFunctions: ['*'],
  writeScopes: ['*'],
  unscopedKeys: [],
  ...overrides,
});

describe('the demo function in the planner catalogue', () => {
  it('is offered when it is the only live function', async () => {
    // The fresh-install case it exists for: without it a new deployment has
    // nothing to demonstrate that any of the machinery works.
    const catalogue = await registry([DEMO_FUNCTION_NAME]).getCatalogueFor(1, role());

    expect(catalogue.map((entry) => entry.name)).toEqual([DEMO_FUNCTION_NAME]);
  });

  it('is dropped as soon as a real function is live', async () => {
    const catalogue = await registry([
      DEMO_FUNCTION_NAME,
      'find_candidate',
    ]).getCatalogueFor(1, role());

    expect(catalogue.map((entry) => entry.name)).toEqual(['find_candidate']);
  });

  it('is dropped even for a role that names it explicitly', async () => {
    const catalogue = await registry([DEMO_FUNCTION_NAME, 'find_candidate']).getCatalogueFor(
      1,
      role({ allowedFunctions: [DEMO_FUNCTION_NAME, 'find_candidate'] }),
    );

    expect(catalogue.map((entry) => entry.name)).not.toContain(DEMO_FUNCTION_NAME);
  });

  it('leaves the catalogue empty rather than falling back to demo when a role can call nothing', async () => {
    // "This role has nothing it may call" has to reach the user as that, not as
    // an answer built from table names.
    const catalogue = await registry([DEMO_FUNCTION_NAME, 'find_candidate']).getCatalogueFor(
      1,
      role({ allowedFunctions: ['something_else'] }),
    );

    expect(catalogue).toEqual([]);
  });
});
