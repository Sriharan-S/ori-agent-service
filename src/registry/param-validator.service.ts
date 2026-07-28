import { Injectable } from '@nestjs/common';
import type {
  FunctionDefinition,
  ParamDefinition,
} from './function.contract';

export type ParamErrorKind =
  | 'missing_required'
  | 'missing_one_of'
  | 'unknown_param'
  | 'wrong_type'
  | 'out_of_range'
  | 'not_in_enum'
  | 'name_like_identifier';

export interface ParamError {
  kind: ParamErrorKind;
  param: string;
  message: string;
}

export type ValidationOutcome =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: ParamError[] };

/**
 * Validates planner-extracted parameters against a function's schema.
 *
 * Errors are typed rather than stringly so the planner can act on them: a
 * `missing_one_of` is a question to ask the user, a `wrong_type` is worth one
 * re-plan, an `unknown_param` is a prompt problem.
 *
 * Unknown parameters are rejected, not dropped. A planner inventing a parameter
 * means it has misunderstood the function, and silently discarding it would run
 * a query the model did not intend.
 */
@Injectable()
export class ParamValidatorService {
  validate(
    definition: FunctionDefinition,
    raw: Record<string, unknown>,
  ): ValidationOutcome {
    const errors: ParamError[] = [];
    const validated: Record<string, unknown> = {};
    const schema = definition.parameters;

    for (const key of Object.keys(raw)) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) {
        errors.push({
          kind: 'unknown_param',
          param: key,
          message: `"${key}" is not a parameter of ${definition.name}. Valid parameters: ${Object.keys(schema).join(', ') || '(none)'}.`,
        });
      }
    }

    for (const [name, param] of Object.entries(schema)) {
      const provided = raw[name];
      const isAbsent =
        provided === undefined ||
        provided === null ||
        (typeof provided === 'string' && provided.trim() === '');

      if (isAbsent) {
        if (param.default !== undefined) {
          validated[name] = param.default;
        } else if (param.required) {
          errors.push({
            kind: 'missing_required',
            param: name,
            message: `${definition.name} requires "${name}": ${param.description}`,
          });
        }
        continue;
      }

      const coerced = this.coerce(name, param, provided, errors);
      if (coerced !== undefined) validated[name] = coerced;
    }

    for (const group of definition.requiredOneOf ?? []) {
      const satisfied = group.some(
        (name) =>
          validated[name] !== undefined &&
          validated[name] !== null &&
          validated[name] !== '',
      );
      if (!satisfied) {
        errors.push({
          kind: 'missing_one_of',
          param: group.join('|'),
          message: `${definition.name} needs at least one of: ${group.join(', ')}.`,
        });
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true, params: validated };
  }

  private coerce(
    name: string,
    param: ParamDefinition,
    value: unknown,
    errors: ParamError[],
  ): unknown {
    switch (param.type) {
      case 'string':
        return this.coerceString(name, param, value, errors);
      case 'number':
      case 'integer':
        return this.coerceNumber(name, param, value, errors);
      case 'boolean':
        return this.coerceBoolean(name, value, errors);
      default: {
        const exhaustive: never = param.type;
        throw new Error(`Unhandled param type: ${String(exhaustive)}`);
      }
    }
  }

  private coerceString(
    name: string,
    param: ParamDefinition,
    value: unknown,
    errors: ParamError[],
  ): string | undefined {
    if (typeof value !== 'string') {
      errors.push({
        kind: 'wrong_type',
        param: name,
        message: `"${name}" must be a string, received ${typeof value}.`,
      });
      return undefined;
    }

    const text = param.trim === false ? value : value.trim();

    if (param.minLength !== undefined && text.length < param.minLength) {
      errors.push({
        kind: 'out_of_range',
        param: name,
        message: `"${name}" must be at least ${param.minLength} characters.`,
      });
      return undefined;
    }
    if (param.maxLength !== undefined && text.length > param.maxLength) {
      errors.push({
        kind: 'out_of_range',
        param: name,
        message: `"${name}" must be at most ${param.maxLength} characters.`,
      });
      return undefined;
    }
    if (param.enum && !param.enum.includes(text)) {
      errors.push({
        kind: 'not_in_enum',
        param: name,
        message: `"${name}" must be one of: ${param.enum.join(', ')}.`,
      });
      return undefined;
    }

    return text;
  }

  private coerceNumber(
    name: string,
    param: ParamDefinition,
    value: unknown,
    errors: ParamError[],
  ): number | undefined {
    // Planners routinely emit numbers as strings; accept that, reject garbage.
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN;

    if (!Number.isFinite(parsed)) {
      errors.push({
        kind: 'wrong_type',
        param: name,
        message: `"${name}" must be a number, received ${JSON.stringify(value)}.`,
      });
      return undefined;
    }

    if (param.type === 'integer' && !Number.isInteger(parsed)) {
      errors.push({
        kind: 'wrong_type',
        param: name,
        message: `"${name}" must be a whole number.`,
      });
      return undefined;
    }

    // §5.6: action functions take resolved IDs, never fuzzy identifiers.
    if (param.resolvedIdentifier && (!Number.isInteger(parsed) || parsed <= 0)) {
      errors.push({
        kind: 'name_like_identifier',
        param: name,
        message: `"${name}" must be a resolved numeric id from a lookup function, not a name or free text.`,
      });
      return undefined;
    }

    if (param.min !== undefined && parsed < param.min) {
      errors.push({
        kind: 'out_of_range',
        param: name,
        message: `"${name}" must be >= ${param.min}.`,
      });
      return undefined;
    }
    if (param.max !== undefined && parsed > param.max) {
      errors.push({
        kind: 'out_of_range',
        param: name,
        message: `"${name}" must be <= ${param.max}.`,
      });
      return undefined;
    }

    return parsed;
  }

  private coerceBoolean(
    name: string,
    value: unknown,
    errors: ParamError[],
  ): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;

    errors.push({
      kind: 'wrong_type',
      param: name,
      message: `"${name}" must be a boolean.`,
    });
    return undefined;
  }
}
