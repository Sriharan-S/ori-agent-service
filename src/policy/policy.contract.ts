/**
 * What the model is permitted to answer.
 *
 * A registry function controls what data the agent can *reach*. This controls
 * what it may *say* — the two are different questions, and roles were only ever
 * an answer to the first. "This assistant may give career advice from a
 * candidate's own scores, and must never offer a clinical opinion" is not
 * expressible as a function grant, because both sentences describe the same
 * function returning the same rows.
 *
 * A policy is one document per application: extra prompt instructions, a list
 * of subjects the model may address, and a list it must refuse. It is authored
 * in the console and moves between environments as JSON, the same way functions
 * do.
 */

/** Marks a JSON file as a policy bundle and pins the shape it was written in. */
export const POLICY_BUNDLE_TAG = 'ori.policy-bundle';
export const POLICY_BUNDLE_VERSION = 1;

/**
 * A subject the model is explicitly permitted to address.
 *
 * Allow rules never widen data access — every fact still comes from a function
 * the caller's role may call. What they widen is willingness: without one, a
 * model told to be careful refuses adjacent-sounding questions it could have
 * answered from the rows in front of it.
 */
export interface AllowRule {
  /** Short subject label, e.g. "career guidance". */
  topic: string;
  /** How to handle it — conditions, framing, what to ground it in. */
  note: string;
}

/**
 * A subject the model must refuse.
 *
 * `patterns` are matched against the incoming message before anything else
 * runs. A hit refuses immediately: no planner call, no function call, no model
 * token spent. That is the difference between a policy and a suggestion.
 */
export interface DenyRule {
  /** Short subject label, e.g. "clinical diagnosis". */
  topic: string;
  /**
   * Case-insensitive substrings or `/regex/` literals. A message matching any
   * one of them is refused.
   *
   * Empty means the rule is prompt-only: the model is told to refuse the
   * subject, but nothing is blocked mechanically. That is the right shape for
   * a topic no keyword captures honestly.
   */
  patterns: string[];
  /** Shown to the user instead of an answer. Falls back to `refusalMessage`. */
  message?: string;
}

export interface ResponsePolicy {
  applicationId: number;
  isEnabled: boolean;
  /** Appended verbatim to the reasoning and answering prompts. */
  systemPrompt: string;
  allowRules: AllowRule[];
  denyRules: DenyRule[];
  /** Used when a matching deny rule carries no message of its own. */
  refusalMessage: string;
  updatedAt: string | null;
}

export interface ResponsePolicyInput {
  isEnabled?: boolean;
  systemPrompt?: string;
  allowRules?: AllowRule[];
  denyRules?: DenyRule[];
  refusalMessage?: string;
}

/** A policy as it travels between environments. */
export interface PolicyBundle {
  bundle: typeof POLICY_BUNDLE_TAG;
  version: number;
  exportedAt: string;
  application?: { slug?: string; name?: string };
  policy: ResponsePolicyInput;
}

/** The verdict of the pre-flight check. */
export interface PolicyVerdict {
  allowed: boolean;
  /** The deny rule that matched, when one did. */
  topic?: string;
  /** What the pattern matched on, for the audit record. Never shown to a user. */
  matched?: string;
  /** What to say instead of answering. */
  message?: string;
}

export const DEFAULT_REFUSAL =
  'I am not able to help with that. If you think that is wrong, the team that ' +
  'runs this assistant can change what I am allowed to cover.';

/** An empty policy — what an application has until one is written. */
export function emptyPolicy(applicationId: number): ResponsePolicy {
  return {
    applicationId,
    isEnabled: false,
    systemPrompt: '',
    allowRules: [],
    denyRules: [],
    refusalMessage: DEFAULT_REFUSAL,
    updatedAt: null,
  };
}
