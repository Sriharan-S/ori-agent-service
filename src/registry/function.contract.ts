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

/**
 * Waiting for a job the host application runs in the background.
 *
 * Plenty of useful actions do not finish inside their own request: the host
 * accepts the work, hands back a job reference, and the real answer appears
 * somewhere else a few seconds later. Without this the agent can only report
 * the job reference, which is not what anybody asked for.
 *
 * Everything here is declarative and named by the operator. Nothing in the
 * service knows what a job *is* — only that a field holds a URL, a field holds
 * a status, and certain values of that status mean stop.
 */
export interface HttpPollSpec {
  /**
   * Field in the first response holding the URL to poll. It is resolved against
   * the registered service and rejected if it points anywhere else — the value
   * arrives in a response body, so it is not trusted to name its own host.
   */
  urlFrom?: string;
  /** Or a path template, when the host returns only an id. Supports {{result:field}}. */
  path?: string;
  /** Field holding the job's status. */
  statusField: string;
  /** Status values that mean the work finished. */
  successWhen: string[];
  /** Status values that mean it failed. Anything else is treated as "still working". */
  failureWhen?: string[];
  intervalMs?: number;
  maxAttempts?: number;
}

/**
 * Something an action produced that has to reach the user exactly as it is.
 *
 * A URL or a one-time password cannot survive being described — a model asked
 * to repeat a long signed link will eventually get a character wrong, and a
 * humanised value is no longer the value. So these bypass the model entirely:
 * they are appended to the answer verbatim and emitted as their own event.
 */
export interface HttpResultSpec {
  /** Field in the final payload holding a URL to offer the user. */
  link?: { from: string; label?: string };
  /**
   * Fields handed back literally alongside the link — a password, a reference
   * number. Declared one at a time and off by default, because this is the one
   * place a stored function decides what leaves the host application.
   */
  expose?: Array<{ from: string; label?: string }>;
}

/**
 * A read that must return a row before the action runs.
 *
 * An HTTP action cannot carry a WHERE clause, so without this the only thing
 * confining it to the caller's tenant is the host API's own checks — and the
 * agent would be asserting the tenant rather than proving it. The guard is
 * compiled by the same template engine as every read function, against the same
 * declared `scopeFilters`, so an unbindable scope refuses the action exactly as
 * it refuses a query.
 */
export interface HttpPreconditionSpec {
  /** Parameterized SQL. Must return at least one row for the action to proceed. */
  sqlTemplate: string;
  /** What the caller is told when it returns nothing. */
  denyMessage?: string;
}

/** A declarative HTTP call back into the host application. */
export interface HttpRequestSpec {
  /** Name of a service registered for this application. Never a raw host. */
  service: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Path template; supports {{param:name}} and {{scope:key}}. Values are
   * URL-encoded.
   *
   * A scope token here must resolve to a concrete value. Exemption means "sees
   * every value of this key", which is a sensible thing to say about a filter
   * and a meaningless thing to say about an identifier an action has to act on,
   * so an exempt role is refused rather than sent an empty segment.
   */
  path: string;
  headers?: Record<string, string>;
  /** JSON body template; string leaves support {{param:name}} and {{scope:key}}. */
  body?: unknown;
  /** Forward the end user's token, when the application supplies one. */
  forwardEndUserToken?: boolean;
  /** Send an Idempotency-Key header derived from the run id. */
  idempotent?: boolean;
  /** Prove the target is inside the caller's scope before calling out. */
  precondition?: HttpPreconditionSpec;
  /** Wait for a background job rather than answering with its reference. */
  poll?: HttpPollSpec;
  /** What of the final payload reaches the user, and how. */
  result?: HttpResultSpec;
}

/**
 * A value that must reach the user unaltered: a link to open, or something to
 * copy. Never enters a model prompt.
 */
export interface ResultArtifact {
  label: string;
  /** Absolute, and pointing at the service's public base URL when it has one. */
  url?: string;
  /** A literal value — a password, a reference. */
  value?: string;
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
      /**
       * Carried through to the model, not just to the validator.
       *
       * Without it the model has no way to know an id must come from an earlier
       * lookup, so it invents one — a literal
       * `"{registration_id_from_find_candidate}"` was the observed failure. The
       * validator rejected that, correctly, but only after the model had already
       * committed to a plan it could not fulfil.
       */
      resolvedIdentifier?: boolean;
    }
  >;
  requiredOneOf: string[][];
  /** `read` may be called freely; `write` changes something. */
  kind: FunctionKind;
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
      ...(param.resolvedIdentifier ? { resolvedIdentifier: true } : {}),
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
    kind: definition.kind,
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
