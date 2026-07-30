import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/configuration';
import { LlmService } from '../llm/llm.service';
import { LlmError, type ChatMessage } from '../llm/llm.types';
import type { PlannerFacingFunction } from '../registry/function.contract';
import type { ConversationTurn } from '../memory/conversation.service';
import type { ExecutionPlan, PlannedCall } from './orchestrator.types';
import { ORI_PLANNER_PERSONA } from './ori-persona';

interface RawPlan {
  calls: Array<{
    function?: unknown;
    params?: unknown;
    reason?: unknown;
    dependsOn?: unknown;
  }>;
  reasoning?: unknown;
  requiresSynthesis?: unknown;
}

/**
 * Chooses which registry functions to call and extracts their parameters.
 *
 * The prompt contains function names, descriptions and parameter schemas —
 * nothing else. No table names, no columns, no schema. The model's entire
 * vocabulary is the catalogue it was handed, so it cannot express a query even
 * if asked to.
 */
@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly llm: LlmService,
  ) {}

  async plan(
    question: string,
    functions: PlannerFacingFunction[],
    history: ConversationTurn[],
    role: string,
    applicationId: number,
  ): Promise<ExecutionPlan> {
    if (functions.length === 0) {
      return {
        calls: [],
        reasoning: 'No functions are available to this role.',
        requiresSynthesis: false,
        isFallback: true,
        fallbackCause: 'not-understood',
      };
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.buildSystemPrompt(functions, role, history),
      },
      { role: 'user', content: question },
    ];

    const validNames = new Set(functions.map((entry) => entry.name));

    try {
      const raw = await this.llm.completeStructured<RawPlan>(messages, {
        purpose: 'planner',
        applicationId,
        temperature: 0,
        shapeHint:
          '{"calls":[{"function":"<name>","params":{},"reason":"<why>"}],' +
          '"reasoning":"<one line>","requiresSynthesis":false}',
        validate: (value) => this.validateRawPlan(value, validNames),
      });

      const plan = this.toPlan(raw, validNames);
      if (plan.calls.length > 0) return plan;

      this.logger.warn('Planner returned no usable calls');
      return fallbackPlan('planner selected nothing usable', 'not-understood');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Planner failed: ${detail}`);

      // No model configured, every model failing, or the breaker open — all of
      // which mean the agent never got to read the question.
      const unavailable =
        error instanceof LlmError || /no enabled model|all .* failed/i.test(detail);

      return fallbackPlan(
        `planner unavailable: ${detail}`,
        unavailable ? 'llm-unavailable' : 'not-understood',
      );
    }
  }

  private buildSystemPrompt(
    functions: PlannerFacingFunction[],
    role: string,
    history: ConversationTurn[],
  ): string {
    const catalogue = functions
      .map((entry) => {
        const params = Object.entries(entry.parameters)
          .map(([name, param]) => {
            const flags = [
              param.type,
              param.required ? 'required' : 'optional',
              param.enum ? `one of: ${param.enum.join('|')}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            return `      - ${name} (${flags}): ${param.description}`;
          })
          .join('\n');

        const oneOf = entry.requiredOneOf
          .map((group) => `      at least one of: ${group.join(', ')}`)
          .join('\n');

        return [
          `  ${entry.name}`,
          `    ${entry.description}`,
          entry.whenToUse.length > 0
            ? `    Use when: ${entry.whenToUse.join(' | ')}`
            : null,
          entry.whenNotToUse.length > 0
            ? `    Do NOT use when: ${entry.whenNotToUse.join(' | ')}`
            : null,
          params ? `    Parameters:\n${params}` : '    Parameters: none',
          oneOf || null,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    const recent = history
      .slice(-4)
      .map((turn) => `${turn.role}: ${turn.content.slice(0, 300)}`)
      .join('\n');

    return `${ORI_PLANNER_PERSONA}

═══ AVAILABLE FUNCTIONS ═══
${catalogue}

═══ CALLER ═══
Role: ${role}
${recent ? `\n═══ RECENT CONVERSATION ═══\n${recent}\n` : ''}
═══ RULES ═══
1. Choose the fewest functions that answer the question. Usually one.
2. Never name a function that is not in the list above.
3. Never invent parameters. Use only the parameter names listed for that function.
4. Take parameter values from what the user actually said. Do not guess a value
   that was not stated — leave the parameter out instead.
5. If a function needs an id but the user gave a name, call the function that
   accepts a name. Never fabricate an id.
6. Choose at most ${this.config.behaviour.maxPlannedCalls} functions.
7. Set requiresSynthesis to true only when two or more functions return
   different kinds of content that must be combined into one answer.

═══ OUTPUT ═══
Valid JSON only. No markdown fences, no commentary:
{
  "calls": [
    {"function": "<name>", "params": {"<param>": "<value>"}, "reason": "<short reason>"}
  ],
  "reasoning": "<one line>",
  "requiresSynthesis": false
}`;
  }

  private validateRawPlan(
    value: unknown,
    validNames: Set<string>,
  ): RawPlan | string {
    if (typeof value !== 'object' || value === null) {
      return 'response was not a JSON object';
    }

    const candidate = value as { calls?: unknown };
    if (!Array.isArray(candidate.calls)) return '"calls" must be an array';
    if (candidate.calls.length === 0) {
      return '"calls" was empty — choose at least one function';
    }

    const unknown = candidate.calls
      .map((call) =>
        typeof call === 'object' && call !== null
          ? (call as { function?: unknown }).function
          : undefined,
      )
      .filter(
        (name): name is string =>
          typeof name === 'string' && !validNames.has(name),
      );

    if (unknown.length > 0) {
      return `unknown function(s): ${unknown.join(', ')}. Choose only from the listed functions.`;
    }

    return value as RawPlan;
  }

  private toPlan(raw: RawPlan, validNames: Set<string>): ExecutionPlan {
    const calls: PlannedCall[] = [];
    const max = this.config.behaviour.maxPlannedCalls;

    for (const entry of raw.calls) {
      if (calls.length >= max) break;

      const name = typeof entry.function === 'string' ? entry.function : null;
      if (!name || !validNames.has(name)) continue;
      if (calls.some((call) => call.functionName === name)) continue;

      calls.push({
        functionName: name,
        params:
          typeof entry.params === 'object' && entry.params !== null
            ? (entry.params as Record<string, unknown>)
            : {},
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        ...(Array.isArray(entry.dependsOn)
          ? {
              dependsOn: entry.dependsOn.filter(
                (value): value is string => typeof value === 'string',
              ),
            }
          : {}),
      });
    }

    return {
      calls,
      reasoning:
        typeof raw.reasoning === 'string' ? raw.reasoning : 'Plan generated',
      requiresSynthesis: raw.requiresSynthesis === true && calls.length > 1,
      isFallback: false,
    };
  }
}

/**
 * What to do when the planner produces nothing usable.
 *
 * An empty plan, deliberately. Guessing a function from keywords would mean
 * calling it with invented parameters — answering confidently about the wrong
 * record. Not answering beats answering wrongly.
 */
function fallbackPlan(
  reason: string,
  cause: NonNullable<ExecutionPlan['fallbackCause']>,
): ExecutionPlan {
  return {
    calls: [],
    reasoning: `Fallback plan (${reason})`,
    requiresSynthesis: false,
    isFallback: true,
    fallbackCause: cause,
  };
}
