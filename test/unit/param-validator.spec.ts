import { ParamValidatorService } from '../../src/registry/param-validator.service';
import type { FunctionDefinition } from '../../src/registry/function.contract';

function definition(
  overrides: Partial<FunctionDefinition> = {},
): FunctionDefinition {
  return {
    id: 1,
    applicationId: 1,
    name: 'test_function',
    category: 'general',
    kind: 'read',
    description: 'test',
    whenToUse: [],
    whenNotToUse: [],
    parameters: {
      name: { type: 'string', description: 'a name', minLength: 2, maxLength: 10 },
      count: { type: 'integer', description: 'a count', min: 1, max: 100 },
      ratio: { type: 'number', description: 'a ratio' },
      active: { type: 'boolean', description: 'a flag' },
      mode: { type: 'string', description: 'a mode', enum: ['FAST', 'SLOW'] },
      page: { type: 'integer', description: 'a page', default: 0 },
      required: { type: 'string', description: 'always needed', required: true },
    },
    requiredOneOf: [],
    returns: 'single',
    ambiguityResolvesTo: null,
    allowedRoles: ['*'],
    scopeFilters: [],
    sqlTemplate: 'SELECT 1 AS id',
    httpRequest: null,
    writeScope: null,
    requiresConfirmation: false,
    defaultLimit: null,
    maxLimit: null,
    status: 'live',
    version: 1,
    lastValidatedAt: null,
    validationError: null,
    ...overrides,
  };
}

const writeDefinition = definition({
  name: 'test_write',
  kind: 'write',
  returns: 'confirmation',
  writeScope: 'record.update',
  parameters: {
    recordId: {
      type: 'integer',
      description: 'resolved record id',
      required: true,
      resolvedIdentifier: true,
    },
  },
});

describe('ParamValidatorService', () => {
  const validator = new ParamValidatorService();

  it('accepts a valid set of parameters and applies defaults', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      name: 'Priya',
      count: 5,
      mode: 'FAST',
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.params).toEqual({
        required: 'yes',
        name: 'Priya',
        count: 5,
        mode: 'FAST',
        page: 0,
      });
    }
  });

  it('reports missing_required distinctly', () => {
    const outcome = validator.validate(definition(), { name: 'Priya' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errors).toHaveLength(1);
      expect(outcome.errors[0]!.kind).toBe('missing_required');
    }
  });

  it('rejects an unknown parameter rather than dropping it', () => {
    // A planner inventing a parameter has misunderstood the function; running
    // the call anyway would execute something the model did not intend.
    const outcome = validator.validate(definition(), {
      required: 'yes',
      tableName: 'users',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errors.map((error) => error.kind)).toContain('unknown_param');
    }
  });

  it('reports wrong_type for a non-numeric number', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      count: 'many',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]!.kind).toBe('wrong_type');
  });

  it('accepts numbers the planner emitted as strings', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      count: '7',
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.params.count).toBe(7);
  });

  it('rejects a fractional value for an integer parameter', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      count: 2.5,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]!.kind).toBe('wrong_type');
  });

  it('reports out_of_range above the maximum', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      count: 500,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]!.kind).toBe('out_of_range');
  });

  it('reports not_in_enum for a value outside the closed set', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      mode: 'MEDIUM',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]!.kind).toBe('not_in_enum');
  });

  it('reports missing_one_of when no member of a group is present', () => {
    const withOneOf = definition({
      parameters: {
        email: { type: 'string', description: 'email' },
        phone: { type: 'string', description: 'phone' },
      },
      requiredOneOf: [['email', 'phone']],
    });

    const outcome = validator.validate(withOneOf, {});

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]!.kind).toBe('missing_one_of');
  });

  it('is satisfied when one member of the group is present', () => {
    const withOneOf = definition({
      parameters: {
        email: { type: 'string', description: 'email' },
        phone: { type: 'string', description: 'phone' },
      },
      requiredOneOf: [['email', 'phone']],
    });

    expect(validator.validate(withOneOf, { phone: '9876543210' }).ok).toBe(true);
  });

  it('rejects a name where an action requires a resolved id', () => {
    const outcome = validator.validate(writeDefinition, {
      recordId: 'Priya Sharma',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]!.kind).toBe('wrong_type');
  });

  it('rejects a non-positive resolved identifier', () => {
    const outcome = validator.validate(writeDefinition, { recordId: 0 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errors[0]!.kind).toBe('name_like_identifier');
    }
  });

  it('treats a blank string as absent', () => {
    const outcome = validator.validate(definition(), {
      required: 'yes',
      name: '   ',
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.params.name).toBeUndefined();
  });

  it('collects every error rather than stopping at the first', () => {
    const outcome = validator.validate(definition(), {
      count: 'many',
      mode: 'MEDIUM',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
  });
});
