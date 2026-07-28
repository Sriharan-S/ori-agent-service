import type { ScopeFilterDefinition } from './sql-template';

export type FunctionKind = 'read' | 'write';

/** `disabled` is the kill switch: it was live, it is not now. */
export type FunctionStatus = 'draft' | 'approved' | 'live' | 'disabled';

export type ReturnShape =
  | 'single'
  | 'list'
  | 'single-or-ambiguous'
  | 'confirmation';

export type ParamType = 'string' | 'number' | 'integer' | 'boolean';

export interface ParamDefinition {
  type: ParamType;
  description: string;
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  enum?: readonly string[];
  trim?: boolean;
  default?: string | number | boolean;
  /**
   * Marks an identifier that must have come from a prior lookup. Action
   * functions take these and never fuzzy identifiers, so that "which one did
   * you mean" lives in exactly one place and every write has a two-step audit
   * trail.
   */
  resolvedIdentifier?: boolean;
}

export type ParamSchema = Record<string, ParamDefinition>;

/** A declarative HTTP call back into the host application. */
export interface HttpRequestSpec {
  /** Name of a service registered for this application. Never a raw host. */
  service: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path template; supports {{param:name}}. Values are URL-encoded. */
  path: string;
  headers?: Record<string, string>;
  /** JSON body template; string leaves support {{param:name}}. */
  body?: unknown;
  /** Forward the end user's token, when the application supplies one. */
  forwardEndUserToken?: boolean;
  /** Send an Idempotency-Key header derived from the run id. */
  idempotent?: boolean;
}

/**
 * A registry function as stored and as the planner sees it.
 *
 * Nothing here names a domain. `category` is a free string chosen by whoever
 * authored the function, `allowedRoles` are role names from the application's
 * own role table, and scope keys are whatever that application scopes by.
 */
export interface FunctionDefinition {
  id: number;
  applicationId: number;
  name: string;
  category: string;
  kind: FunctionKind;

  /** LLM-facing. See docs/FUNCTION_AUTHORING.md. */
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];

  parameters: ParamSchema;
  requiredOneOf: string[][];
  returns: ReturnShape;
  /** Parameter a chosen candidate id is written into. Required for lookups. */
  ambiguityResolvesTo: string | null;

  allowedRoles: string[];
  scopeFilters: ScopeFilterDefinition[];

  sqlTemplate: string | null;
  httpRequest: HttpRequestSpec | null;
  writeScope: string | null;
  requiresConfirmation: boolean;

  defaultLimit: number | null;
  maxLimit: number | null;

  status: FunctionStatus;
  version: number;
  lastValidatedAt: Date | null;
  validationError: string | null;
}

export interface Candidate {
  /** Resolved identifier an action function can be called with. */
  id: number | string;
  label: string;
  detail?: string;
  score: number;
}

export type FunctionResult =
  | { status: 'single'; data: unknown; confidence: number }
  | { status: 'list'; data: unknown[]; total: number; truncated: boolean }
  | { status: 'ambiguous'; candidates: Candidate[]; searchedBy: string }
  | { status: 'empty'; searchedBy: string }
  | { status: 'denied'; reason: string }
  | { status: 'error'; message: string; retryable: boolean };

/** Shape handed to the planner prompt — deliberately minimal. */
export interface PlannerFacingFunction {
  name: string;
  category: string;
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  parameters: Record<
    string,
    {
      type: ParamType;
      description: string;
      required: boolean;
      enum?: readonly string[];
    }
  >;
  requiredOneOf: string[][];
}

export function toPlannerFacing(
  definition: FunctionDefinition,
): PlannerFacingFunction {
  const parameters: PlannerFacingFunction['parameters'] = {};

  for (const [name, param] of Object.entries(definition.parameters)) {
    parameters[name] = {
      type: param.type,
      description: param.description,
      required: param.required === true,
      ...(param.enum ? { enum: param.enum } : {}),
    };
  }

  return {
    name: definition.name,
    category: definition.category,
    description: definition.description,
    whenToUse: definition.whenToUse,
    whenNotToUse: definition.whenNotToUse,
    parameters,
    requiredOneOf: definition.requiredOneOf,
  };
}

/**
 * Output columns a lookup must produce.
 *
 * The engine builds candidates from the result set, so a `single-or-ambiguous`
 * function has to say which column is the identifier and which is the label.
 * Checked when the function is saved, against the real result metadata.
 */
export const LOOKUP_REQUIRED_COLUMNS = ['id', 'label'] as const;
export const LOOKUP_OPTIONAL_COLUMNS = ['detail', 'match_score'] as const;
