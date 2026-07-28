import { Injectable, Logger } from '@nestjs/common';
import { AuditLoggerService } from '../audit/audit-logger.service';
import type { RequestContext } from '../auth/identity';
import { PrimaryDb, quoteIdent } from '../db/primary.db';
import {
  ConversationService,
  type PendingDisambiguation,
} from '../memory/conversation.service';
import { RegistryService } from '../registry/registry.service';
import { ExecutorService } from './executor.service';
import { ORI_STATIC_FALLBACKS } from './ori-persona';
import type {
  AgentEventSink,
  AgentResponse,
  AgentRun,
  CallOutcome,
  ExecutionPlan,
} from './orchestrator.types';
import { NOOP_SINK } from './orchestrator.types';
import { PlannerService } from './planner.service';
import { ReflectorService } from './reflector.service';
import { RouterService } from './router.service';
import { SynthesizerService } from './synthesizer.service';

/**
 * The request pipeline.
 *
 *   route → catalogue → plan → validate + scope + execute → reflect →
 *   synthesize → audit → respond
 *
 * Every stage emits, so a caller with the `trace` scope watches the agent think
 * and a caller without one gets the answer as it is written. The non-streaming
 * path is the same code with a sink that discards.
 *
 * A clarification reply re-enters at the router, which is why the pending
 * candidate set lives in conversation state rather than in the response.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly db: PrimaryDb,
    private readonly conversations: ConversationService,
    private readonly registry: RegistryService,
    private readonly router: RouterService,
    private readonly planner: PlannerService,
    private readonly executor: ExecutorService,
    private readonly reflector: ReflectorService,
    private readonly synthesizer: SynthesizerService,
    private readonly audit: AuditLoggerService,
  ) {}

  async handle(
    message: string,
    conversationId: string | null,
    context: RequestContext,
    emit: AgentEventSink = NOOP_SINK,
  ): Promise<AgentResponse> {
    const startedAt = Date.now();
    const conversationKey = await this.conversations.resolve(
      conversationId,
      context,
    );

    emit({
      type: 'run.started',
      channel: 'user',
      runId: context.runId,
      conversationId: conversationKey,
    });

    await this.openRun(context, conversationKey, emit !== NOOP_SINK);

    const [pending, history] = await Promise.all([
      this.conversations.getPending(conversationKey),
      this.conversations.getHistory(conversationKey),
    ]);

    await this.conversations.appendTurn(conversationKey, 'user', message);

    const run: AgentRun = { message, conversationKey, context, history };
    const decision = this.router.classify(message, pending);

    emit({
      type: 'router.decision',
      channel: 'trace',
      intent: decision.intent,
      reason: decision.reason,
    });

    this.logger.log(
      `[${context.runId}] intent=${decision.intent} app=${context.application.slug} role=${context.endUser.role}`,
    );

    try {
      const response =
        decision.intent === 'clarification-reply' &&
        decision.pending &&
        decision.resolvedCandidate
          ? await this.handleClarificationReply(
              run,
              decision.pending,
              decision.resolvedCandidate,
              emit,
            )
          : decision.intent === 'conversational'
            ? await this.handleConversational(run, emit)
            : await this.handleDataRequest(run, pending !== null, emit);

      await this.conversations.appendTurn(
        conversationKey,
        'assistant',
        response.message,
        { type: response.type, functionsUsed: response.functionsUsed },
      );

      const latencyMs = Date.now() - startedAt;
      await this.closeRun(context, decision.intent, response, latencyMs, null);

      emit({
        type: 'run.completed',
        channel: 'user',
        responseType: response.type,
        message: response.message,
        functionsUsed: response.functionsUsed,
        latencyMs,
      });

      this.logger.log(
        `[${context.runId}] ${response.type} in ${latencyMs}ms (${response.functionsUsed.join(', ') || 'no functions'})`,
      );

      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${context.runId}] pipeline failed: ${detail}`);
      this.audit.recordRejection(context, `pipeline error: ${detail}`);

      const response: AgentResponse = {
        conversationId: conversationKey,
        runId: context.runId,
        type: 'error',
        message: ORI_STATIC_FALLBACKS.error,
        functionsUsed: [],
        requestId: context.requestId,
      };

      await this.closeRun(
        context,
        decision.intent,
        response,
        Date.now() - startedAt,
        detail,
      );

      emit({ type: 'error', channel: 'user', message: response.message });
      return response;
    }
  }

  /**
   * The user answered "which one did you mean". The original function runs
   * again with the chosen id filled in — the same function, so the same RBAC
   * checks and the same audit trail apply. The stored candidate list is not
   * trusted as data: only its id is reused, and the function looks the record
   * up afresh.
   */
  private async handleClarificationReply(
    run: AgentRun,
    pending: PendingDisambiguation,
    candidate: { id: number | string; label: string },
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    await this.conversations.clearPending(run.conversationKey);

    const plan: ExecutionPlan = {
      calls: [
        {
          functionName: pending.functionName,
          params: {
            ...pending.originalParams,
            [pending.resolveInto]: candidate.id,
          },
          reason: `user chose "${candidate.label}"`,
        },
      ],
      reasoning: 'Clarification reply',
      requiresSynthesis: false,
      isFallback: false,
    };

    const outcomes = await this.executor.execute(plan, run, emit);
    return this.respondTo(run, outcomes, emit);
  }

  private async handleConversational(
    run: AgentRun,
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    const catalogue = await this.registry.getCatalogueFor(
      run.context.application.id,
      run.context.role,
    );

    const message = await this.synthesizer.conversational(
      run.message,
      catalogue.map((entry) => entry.description),
      run.history,
      run.context.application.id,
      emit,
    );

    return {
      conversationId: run.conversationKey,
      runId: run.context.runId,
      type: 'answer',
      message,
      functionsUsed: [],
      requestId: run.context.requestId,
    };
  }

  private async handleDataRequest(
    run: AgentRun,
    hadStalePending: boolean,
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    // A pending question the user did not answer is stale. Drop it so a later
    // "the second one" cannot be applied to a clarification from two turns ago.
    if (hadStalePending) {
      await this.conversations.clearPending(run.conversationKey);
    }

    const catalogue = await this.registry.getCatalogueFor(
      run.context.application.id,
      run.context.role,
    );

    emit({
      type: 'catalogue.selected',
      channel: 'trace',
      functions: catalogue.map((entry) => entry.name),
    });

    const plan = await this.planner.plan(
      run.message,
      catalogue,
      run.history,
      run.context.role.name,
      run.context.application.id,
    );

    emit({
      type: 'plan.created',
      channel: 'trace',
      reasoning: plan.reasoning,
      calls: plan.calls.map((call) => ({
        name: call.functionName,
        params: call.params,
      })),
    });

    if (plan.calls.length === 0) {
      this.audit.recordRejection(run.context, `no plan: ${plan.reasoning}`);
      const message =
        catalogue.length === 0
          ? ORI_STATIC_FALLBACKS.nothingConfigured
          : ORI_STATIC_FALLBACKS.notUnderstood;

      emit({ type: 'message.delta', channel: 'user', text: message });

      return {
        conversationId: run.conversationKey,
        runId: run.context.runId,
        type: 'answer',
        message,
        functionsUsed: [],
        requestId: run.context.requestId,
      };
    }

    const outcomes = await this.executor.execute(plan, run, emit);
    return this.respondTo(run, outcomes, emit);
  }

  private async respondTo(
    run: AgentRun,
    outcomes: CallOutcome[],
    emit: AgentEventSink,
  ): Promise<AgentResponse> {
    const functionsUsed = outcomes.map((outcome) => outcome.functionName);
    const reflection = this.reflector.reflect(outcomes);

    emit({ type: 'reflection', channel: 'trace', action: reflection.action });

    if (reflection.action === 'clarify') {
      const result = reflection.outcome.result;
      if (result.status !== 'ambiguous') {
        throw new Error('Reflector returned clarify for a non-ambiguous result');
      }

      const definition = await this.registry.getExecutable(
        run.context.application.id,
        reflection.outcome.functionName,
      );
      const resolveInto = definition?.ambiguityResolvesTo;

      if (!resolveInto) {
        // Save-time validation makes this unreachable; a loud failure beats
        // asking a question we could not act on the answer to.
        this.logger.error(
          `${reflection.outcome.functionName} returned ambiguous but declares no ambiguityResolvesTo`,
        );
        emit({ type: 'error', channel: 'user', message: ORI_STATIC_FALLBACKS.error });

        return {
          conversationId: run.conversationKey,
          runId: run.context.runId,
          type: 'error',
          message: ORI_STATIC_FALLBACKS.error,
          functionsUsed,
          requestId: run.context.requestId,
        };
      }

      const originalParams = { ...reflection.outcome.params };
      delete originalParams[resolveInto];

      await this.conversations.setPending(run.conversationKey, {
        functionName: reflection.outcome.functionName,
        resolveInto,
        originalParams,
        candidates: result.candidates,
        searchedBy: result.searchedBy,
        askedAt: Date.now(),
      });

      const message = this.synthesizer.clarification(
        result.candidates,
        result.searchedBy,
      );

      emit({
        type: 'clarification',
        channel: 'user',
        message,
        candidates: result.candidates,
      });

      return {
        conversationId: run.conversationKey,
        runId: run.context.runId,
        type: 'clarification',
        message,
        candidates: result.candidates,
        functionsUsed,
        requestId: run.context.requestId,
      };
    }

    if (reflection.action === 'nothing_found') {
      const message = this.synthesizer.nothingFound(outcomes);
      emit({ type: 'message.delta', channel: 'user', text: message });

      return {
        conversationId: run.conversationKey,
        runId: run.context.runId,
        type: 'answer',
        message,
        functionsUsed,
        requestId: run.context.requestId,
      };
    }

    const wroteSomething = await this.didWrite(run, outcomes);

    const message = await this.synthesizer.answer(
      run.message,
      outcomes,
      run.history,
      run.context.application.id,
      emit,
    );

    return {
      conversationId: run.conversationKey,
      runId: run.context.runId,
      type: wroteSomething ? 'confirmation' : 'answer',
      message,
      functionsUsed,
      requestId: run.context.requestId,
    };
  }

  private async didWrite(
    run: AgentRun,
    outcomes: CallOutcome[],
  ): Promise<boolean> {
    for (const outcome of outcomes) {
      if (outcome.result.status !== 'single') continue;
      const definition = await this.registry.getExecutable(
        run.context.application.id,
        outcome.functionName,
      );
      if (definition?.kind === 'write') return true;
    }
    return false;
  }

  private async openRun(
    context: RequestContext,
    conversationKey: string,
    streamed: boolean,
  ): Promise<void> {
    await this.db
      .query(
        `INSERT INTO ${quoteIdent(this.db.schema)}.runs
           (application_id, run_key, conversation_key, end_user_id, end_user_role, streamed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_key) DO NOTHING`,
        [
          context.application.id,
          context.runId,
          conversationKey,
          context.endUser.id,
          context.endUser.role,
          streamed,
        ],
      )
      .catch((error: unknown) => {
        // Observability must never break the request it is observing.
        this.logger.warn(
          `Could not open run record: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async closeRun(
    context: RequestContext,
    intent: string,
    response: AgentResponse,
    latencyMs: number,
    error: string | null,
  ): Promise<void> {
    await this.db
      .query(
        `UPDATE ${quoteIdent(this.db.schema)}.runs
            SET status = $2, intent = $3, response_type = $4,
                functions_used = $5, latency_ms = $6, error = $7,
                completed_at = now()
          WHERE run_key = $1`,
        [
          context.runId,
          error ? 'failed' : 'completed',
          intent,
          response.type,
          response.functionsUsed,
          latencyMs,
          error,
        ],
      )
      .catch(() => undefined);
  }
}
