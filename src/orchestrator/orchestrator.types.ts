import type { RequestContext } from '../auth/identity';
import type { Candidate, FunctionResult } from '../registry/function.contract';
import type {
  ConversationTurn,
  PendingDisambiguation,
} from '../memory/conversation.service';

export type Intent = 'read' | 'write' | 'conversational' | 'clarification-reply';

export interface RouterDecision {
  intent: Intent;
  reason: string;
  pending?: PendingDisambiguation;
  resolvedCandidate?: Candidate;
}

export interface PlannedCall {
  functionName: string;
  params: Record<string, unknown>;
  reason: string;
  /** Names of other planned calls this one waits for (lookup → action). */
  dependsOn?: string[];
}

export interface ExecutionPlan {
  calls: PlannedCall[];
  reasoning: string;
  requiresSynthesis: boolean;
  isFallback: boolean;
  /**
   * Why an empty plan is empty. "The model is unreachable" and "the model read
   * the question and had nothing to call" need different things said to the
   * user, and send an operator looking in different places.
   */
  fallbackCause?: 'llm-unavailable' | 'not-understood';
}

export interface CallOutcome {
  functionName: string;
  functionVersion: number;
  params: Record<string, unknown>;
  result: FunctionResult;
  durationMs: number;
}

export type AgentResponseType =
  | 'answer'
  | 'clarification'
  | 'confirmation'
  | 'error';

export interface AgentResponse {
  conversationId: string;
  runId: string;
  type: AgentResponseType;
  message: string;
  candidates?: Candidate[];
  functionsUsed: string[];
  requestId: string;
}

export interface AgentRun {
  message: string;
  conversationKey: string;
  context: RequestContext;
  history: ConversationTurn[];
}

/**
 * Everything the agent does as it happens.
 *
 * Two audiences, one stream. `channel: 'user'` is what a chat interface renders
 * — deltas, the clarifying question, the final response. `channel: 'trace'` is
 * the machinery: which functions were chosen, with which parameters, and what
 * each returned.
 *
 * Trace events name functions and echo extracted parameters, so they are gated
 * on the calling key holding the `trace` scope. An end-user surface gets the
 * user channel only; an operator dashboard gets both.
 */
/**
 * The phases of a run, in order.
 *
 * Emitted on the user channel and carrying no function names or parameters, so
 * an end-user surface can show honest progress ("choosing what to look up…",
 * "writing the answer…") without being handed the internals. The trace channel
 * still carries the detail for an operator.
 */
export type RunStage =
  | 'understanding'
  | 'selecting'
  | 'retrieving'
  | 'composing'
  | 'done';

export type AgentEvent =
  | { type: 'run.started'; channel: 'user'; runId: string; conversationId: string }
  | { type: 'stage'; channel: 'user'; stage: RunStage }
  | { type: 'router.decision'; channel: 'trace'; intent: Intent; reason: string }
  | { type: 'catalogue.selected'; channel: 'trace'; functions: string[] }
  | {
      type: 'plan.created';
      channel: 'trace';
      reasoning: string;
      /**
       * Every function the model was shown, so "was this chosen or was it the
       * only option" is answerable from the stream. Without it a single-function
       * plan looks identical to a fallback.
       */
      considered: string[];
      /** True when no model chose this — the planner was unavailable. */
      isFallback: boolean;
      calls: Array<{ name: string; params: Record<string, unknown>; reason: string }>;
    }
  | { type: 'function.started'; channel: 'trace'; name: string }
  | {
      type: 'function.completed';
      channel: 'trace';
      name: string;
      status: FunctionResult['status'];
      rowCount: number;
      durationMs: number;
    }
  | { type: 'reflection'; channel: 'trace'; action: string }
  | { type: 'message.delta'; channel: 'user'; text: string }
  | {
      type: 'clarification';
      channel: 'user';
      message: string;
      candidates: Candidate[];
    }
  | {
      type: 'run.completed';
      channel: 'user';
      responseType: AgentResponseType;
      message: string;
      functionsUsed: string[];
      latencyMs: number;
    }
  | { type: 'error'; channel: 'user'; message: string };

export type AgentEventSink = (event: AgentEvent) => void;

/** Discards everything. Used by the non-streaming path. */
export const NOOP_SINK: AgentEventSink = () => undefined;

/** Aggregate confidence over the outcomes that produced usable data. */
export function overallConfidence(outcomes: CallOutcome[]): number {
  const scores = outcomes.map((outcome) => {
    switch (outcome.result.status) {
      case 'single':
        return outcome.result.confidence;
      case 'list':
        return outcome.result.data.length > 0 ? 0.9 : 0.4;
      case 'ambiguous':
        return 0.55;
      case 'empty':
        return 0.4;
      default:
        return 0;
    }
  });

  return scores.length === 0 ? 0 : Math.max(...scores);
}
