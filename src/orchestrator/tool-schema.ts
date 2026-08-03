import type { PlannerFacingFunction } from '../registry/function.contract';
import type { ToolSchema } from '../llm/llm.types';
import { humaniseKey } from './evidence';

/**
 * The label this parameter will appear under in a result.
 *
 * Observations render columns through `humaniseKey`, so `user_id` reads as
 * "User id". Quoting the same form here is what lets the model match a
 * parameter to the right field by name rather than by guessing which of several
 * ids in a row is meant.
 */
function humaniseParamName(name: string): string {
  return humaniseKey(name);
}

/**
 * A registry function, as a tool the model can actually call.
 *
 * This replaces describing the catalogue in prose and asking for JSON back. The
 * prose catalogue put the entire burden of "what shape is a call" on the model,
 * and it showed: parameters arrived as placeholder strings, as invented names,
 * and as empty strings standing in for values the user never gave. A tool
 * schema moves most of that into the provider's own constrained decoding.
 *
 * The schema is derived from the function's `ParamSchema` rather than written
 * alongside it, so what the model is told it may send and what the validator
 * will accept cannot drift.
 */
export function toToolSchema(entry: PlannerFacingFunction): ToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(entry.parameters)) {
    const description = [
      param.description,
      param.resolvedIdentifier
        ? `This must be an id returned by an earlier lookup in this same ` +
          `conversation. Never invent it, never use a name, and never use a ` +
          `placeholder — if you do not have the id yet, call the lookup first. ` +
          `Take the value labelled exactly "${humaniseParamName(name)}". A ` +
          `lookup usually returns several different ids for one record and they ` +
          `are NOT interchangeable — passing the wrong one acts on a different ` +
          `person. If no field with that exact label was returned, say so ` +
          `instead of substituting another id.`
        : null,
    ]
      .filter(Boolean)
      .join(' ');

    properties[name] = {
      type: param.type,
      description,
      ...(param.enum ? { enum: [...param.enum] } : {}),
    };

    if (param.required) required.push(name);
  }

  return {
    name: entry.name,
    description: buildDescription(entry),
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}

/**
 * Everything the model needs to choose between two similar functions.
 *
 * `requiredOneOf` cannot be said in the subset of JSON Schema that providers
 * reliably honour — `anyOf` over `required` is legal and widely ignored — so it
 * is stated in the description instead, where it is at least read. The validator
 * remains the thing that enforces it.
 */
function buildDescription(entry: PlannerFacingFunction): string {
  const parts = [entry.description];

  if (entry.whenToUse.length > 0) {
    parts.push(`Use when: ${entry.whenToUse.join('; ')}.`);
  }
  if (entry.whenNotToUse.length > 0) {
    parts.push(`Do NOT use when: ${entry.whenNotToUse.join('; ')}.`);
  }
  for (const group of entry.requiredOneOf) {
    parts.push(
      `You must supply at least one of these: ${group.join(', ')}. ` +
        'If the user has given you none of them, ask them for one instead of ' +
        'calling this with a blank value.',
    );
  }
  if (entry.kind === 'write') {
    parts.push('This changes data. Only call it when the user asked you to.');
  }

  return parts.join(' ');
}
