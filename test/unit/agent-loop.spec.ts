import { AgentLoopService } from '../../src/orchestrator/agent-loop.service';
import { toToolSchema } from '../../src/orchestrator/tool-schema';
import { describeObservation } from '../../src/orchestrator/observation';
import type { PlannerFacingFunction } from '../../src/registry/function.contract';
import type {
  AgentRun,
  CallOutcome,
  PlannedCall,
} from '../../src/orchestrator/orchestrator.types';
import type { ChatMessage, CompletionResult } from '../../src/llm/llm.types';

/*
 * The three failures that motivated the loop, as tests.
 *
 * Each one is a transcript that actually happened against the single-shot
 * planner: a report request that produced a placeholder id, a list request that
 * produced an empty parameter, and a validator complaint that reached the user
 * verbatim. They are written against the loop rather than against the model, so
 * what they pin down is the machinery — that a result can inform the next call,
 * that declining is reachable, and that a rejected call comes back as a turn.
 */

const FIND_CANDIDATE: PlannerFacingFunction = {
  name: 'find_candidate',
  category: 'people',
  description: 'Find one candidate by name.',
  whenToUse: ['looking someone up by name'],
  whenNotToUse: [],
  parameters: {
    name: { type: 'string', description: 'Full or partial name', required: true },
  },
  requiredOneOf: [],
  kind: 'read',
};

const GENERATE_REPORT: PlannerFacingFunction = {
  name: 'generate_candidate_report',
  category: 'reports',
  description: "Prepare a candidate's report and return a download link.",
  whenToUse: [],
  whenNotToUse: [],
  parameters: {
    user_id: {
      type: 'integer',
      description: 'Candidate user id from find_candidate',
      required: true,
      resolvedIdentifier: true,
    },
  },
  requiredOneOf: [],
  kind: 'write',
};

const FIND_USER: PlannerFacingFunction = {
  name: 'find_user',
  category: 'admin',
  description: 'Look up one platform user.',
  whenToUse: [],
  whenNotToUse: [],
  parameters: {
    email: { type: 'string', description: 'Email address', required: false },
    userid: { type: 'integer', description: 'User id', required: false },
  },
  requiredOneOf: [['email', 'userid']],
  kind: 'read',
};

function completion(
  overrides: Partial<CompletionResult> = {},
): CompletionResult {
  return {
    text: '',
    toolCalls: [],
    finishReason: 'stop',
    provider: 'test',
    model: 'test',
    latencyMs: 1,
    promptTokens: null,
    completionTokens: null,
    ...overrides,
  };
}

/** A scripted model: one queued response per loop step. */
function scriptedLlm(responses: CompletionResult[]) {
  const seen: ChatMessage[][] = [];
  let index = 0;

  return {
    seen,
    complete: jest.fn(async (messages: ChatMessage[]) => {
      seen.push(messages.map((message) => ({ ...message })));
      const next = responses[index];
      index += 1;
      if (!next) throw new Error('The loop asked for more steps than were scripted');
      return next;
    }),
  };
}

function makeRun(): AgentRun {
  return {
    message: 'generate the report for Priya',
    conversationKey: 'conv-1',
    history: [],
    context: {
      application: { id: 1, slug: 'test' },
      role: { name: 'CORPORATE' },
      runId: 'run-1',
      requestId: 'req-1',
    },
  } as unknown as AgentRun;
}

function makeLoop(
  llm: { complete: jest.Mock },
  executor: { runCall: jest.Mock },
  maxAgentSteps = 4,
): AgentLoopService {
  return new AgentLoopService(
    {
      behaviour: { maxAgentSteps, maxPlannedCalls: 3 },
    } as never,
    llm as never,
    executor as never,
    // No policy configured: the prompt block is empty and nothing is refused.
    { compilePrompt: async () => '' } as never,
  );
}

function outcome(
  functionName: string,
  result: CallOutcome['result'],
  params: Record<string, unknown> = {},
): CallOutcome {
  return { functionName, functionVersion: 1, params, result, durationMs: 1 };
}

describe('AgentLoopService', () => {
  it('feeds a lookup result into the next call instead of a placeholder', async () => {
    // The exact failure from the transcript: the old planner emitted
    // {"user_id": "{registration_id_from_find_candidate}"} in one shot, which
    // failed validation before the call ever started.
    const llm = scriptedLlm([
      completion({
        toolCalls: [
          { id: 'c1', name: 'find_candidate', arguments: { name: 'Priya' } },
        ],
      }),
      completion({
        toolCalls: [
          {
            id: 'c2',
            name: 'generate_candidate_report',
            arguments: { user_id: 4821 },
          },
        ],
      }),
      completion({ text: 'The report is ready.' }),
    ]);

    const runCall = jest.fn(async (call: PlannedCall) =>
      call.functionName === 'find_candidate'
        ? outcome('find_candidate', {
            status: 'single',
            data: { id: 4821, full_name: 'Priya Sharma' },
            confidence: 1,
          })
        : outcome('generate_candidate_report', {
            status: 'single',
            data: {},
            confidence: 1,
          }),
    );

    const loop = makeLoop(llm, { runCall });
    const result = await loop.run(
      makeRun(),
      [FIND_CANDIDATE, GENERATE_REPORT],
      '',
      () => undefined,
    );

    expect(result.stop).toBe('answered');
    expect(result.outcomes).toHaveLength(2);
    expect(runCall.mock.calls[1]![0].params).toEqual({ user_id: 4821 });

    // The second decision was made with the first result in front of it.
    const secondPrompt = llm.seen[1]!;
    const observation = secondPrompt.find((message) => message.role === 'tool');
    expect(observation?.content).toContain('Priya Sharma');
  });

  it('lets the model decline when nothing fits', async () => {
    // "list corporate users" against a catalogue with no such function. The old
    // planner rejected an empty plan and forced a repair round-trip, so the
    // model settled on find_user with an empty email.
    const llm = scriptedLlm([
      completion({ text: 'Nothing here lists every user.' }),
    ]);
    const runCall = jest.fn();

    const loop = makeLoop(llm, { runCall });
    const result = await loop.run(makeRun(), [FIND_USER], '', () => undefined);

    expect(result.stop).toBe('declined');
    expect(runCall).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([]);
  });

  it('hands a rejected call back to the model as a turn it can correct', async () => {
    const llm = scriptedLlm([
      completion({
        toolCalls: [{ id: 'c1', name: 'find_user', arguments: {} }],
      }),
      completion({
        toolCalls: [
          { id: 'c2', name: 'find_user', arguments: { email: 'p@example.com' } },
        ],
      }),
      completion({ text: 'Found them.' }),
    ]);

    const runCall = jest.fn(async (call: PlannedCall) =>
      Object.keys(call.params).length === 0
        ? {
            ...outcome('find_user', {
              status: 'error',
              message: "I couldn't look that up with what I had to go on.",
              retryable: false,
            }),
            operatorDetail: 'find_user needs at least one of: email, userid.',
          }
        : outcome('find_user', {
            status: 'single',
            data: { email: 'p@example.com' },
            confidence: 1,
          }),
    );

    const loop = makeLoop(llm, { runCall });
    const result = await loop.run(makeRun(), [FIND_USER], '', () => undefined);

    expect(result.stop).toBe('answered');

    // The model was told the specific problem, not the vague user-facing one.
    const retryPrompt = llm.seen[1]!;
    const observation = retryPrompt.find((message) => message.role === 'tool');
    expect(observation?.content).toContain('at least one of: email, userid');
    expect(observation?.content).not.toContain("I couldn't look that up");
  });

  it('stops the moment a lookup is ambiguous rather than picking a candidate', async () => {
    const llm = scriptedLlm([
      completion({
        toolCalls: [
          { id: 'c1', name: 'find_candidate', arguments: { name: 'sriharan' } },
        ],
      }),
    ]);

    const runCall = jest.fn(async () =>
      outcome('find_candidate', {
        status: 'ambiguous',
        candidates: [
          { id: 1, label: 'a@example.com', score: 80 },
          { id: 2, label: 'b@example.com', score: 80 },
        ],
        searchedBy: 'name "sriharan"',
      }),
    );

    const loop = makeLoop(llm, { runCall });
    const result = await loop.run(
      makeRun(),
      [FIND_CANDIDATE],
      '',
      () => undefined,
    );

    expect(result.stop).toBe('ambiguous');
    // One model call only: the loop did not get a chance to resolve it itself.
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('refuses to repeat an identical call', async () => {
    const llm = scriptedLlm([
      completion({
        toolCalls: [
          { id: 'c1', name: 'find_candidate', arguments: { name: 'Priya' } },
        ],
      }),
      completion({
        toolCalls: [
          { id: 'c2', name: 'find_candidate', arguments: { name: 'Priya' } },
        ],
      }),
      completion({ text: 'Nothing found.' }),
    ]);

    const runCall = jest.fn(async () =>
      outcome('find_candidate', { status: 'empty', searchedBy: 'name "Priya"' }),
    );

    const loop = makeLoop(llm, { runCall });
    await loop.run(makeRun(), [FIND_CANDIDATE], '', () => undefined);

    // Executed once, even though the model asked twice.
    expect(runCall).toHaveBeenCalledTimes(1);
    const thirdPrompt = llm.seen[2]!;
    const observations = thirdPrompt.filter((message) => message.role === 'tool');
    expect(observations[1]?.content).toContain('already called that');
  });

  it('rejects a hallucinated function name without reaching the executor', async () => {
    const llm = scriptedLlm([
      completion({
        toolCalls: [{ id: 'c1', name: 'list_all_users', arguments: {} }],
      }),
      completion({ text: 'I cannot do that.' }),
    ]);
    const runCall = jest.fn();

    const loop = makeLoop(llm, { runCall });
    await loop.run(makeRun(), [FIND_USER], '', () => undefined);

    expect(runCall).not.toHaveBeenCalled();
    const secondPrompt = llm.seen[1]!;
    const observation = secondPrompt.find((message) => message.role === 'tool');
    expect(observation?.content).toContain('no function called "list_all_users"');
  });

  it('reports an unreachable model differently from a decline', async () => {
    const llm = {
      complete: jest.fn(async () => {
        throw new Error('no enabled model is configured for "planner"');
      }),
    };

    const loop = makeLoop(llm, { runCall: jest.fn() });
    const result = await loop.run(makeRun(), [FIND_USER], '', () => undefined);

    expect(result.stop).toBe('llm-unavailable');
  });

  it('gives up rather than looping forever', async () => {
    const responses = Array.from({ length: 6 }, (_unused, index) =>
      completion({
        toolCalls: [
          {
            id: `c${index}`,
            name: 'find_candidate',
            arguments: { name: `attempt ${index}` },
          },
        ],
      }),
    );

    const llm = scriptedLlm(responses);
    const runCall = jest.fn(async () =>
      outcome('find_candidate', { status: 'empty', searchedBy: 'name' }),
    );

    const loop = makeLoop(llm, { runCall }, 3);
    const result = await loop.run(
      makeRun(),
      [FIND_CANDIDATE],
      '',
      () => undefined,
    );

    expect(llm.complete).toHaveBeenCalledTimes(3);
    expect(result.steps).toBe(3);
  });

  it('puts knowledge grounding in the system prompt when there is any', async () => {
    const llm = scriptedLlm([completion({ text: 'ok' })]);
    const loop = makeLoop(llm, { runCall: jest.fn() });

    await loop.run(
      makeRun(),
      [FIND_USER],
      'A candidate is a person registered by a company.',
      () => undefined,
    );

    const system = llm.seen[0]!.find((message) => message.role === 'system');
    expect(system?.content).toContain('A candidate is a person registered by a company.');
  });
});

describe('toToolSchema', () => {
  it('marks a resolved identifier so the model knows to look it up first', () => {
    const schema = toToolSchema(GENERATE_REPORT);
    const parameter = schema.parameters.properties.user_id as {
      description: string;
    };

    expect(parameter.description).toContain('earlier lookup');
    expect(parameter.description).toContain('placeholder');
  });

  it('names the exact label a resolved id must be taken from', () => {
    // A record carries several ids; picking the wrong one acts on the wrong
    // person. The label quoted here is the one observations actually render.
    const parameter = toToolSchema(GENERATE_REPORT).parameters.properties
      .user_id as { description: string };

    expect(parameter.description).toContain('"User id"');
    expect(parameter.description).toContain('NOT interchangeable');
  });

  it('states requiredOneOf in the description, since JSON Schema cannot', () => {
    const schema = toToolSchema(FIND_USER);
    expect(schema.description).toContain('at least one of these: email, userid');
    expect(schema.description).toContain('blank value');
  });

  it('lists genuinely required parameters', () => {
    expect(toToolSchema(FIND_CANDIDATE).parameters.required).toEqual(['name']);
    // Neither is required on its own — the constraint is the one-of group.
    expect(toToolSchema(FIND_USER).parameters.required).toBeUndefined();
  });

  it('closes the object so an invented parameter is refused at decode time', () => {
    expect(toToolSchema(FIND_USER).parameters.additionalProperties).toBe(false);
  });

  it('warns that a write function changes data', () => {
    expect(toToolSchema(GENERATE_REPORT).description).toContain('changes data');
    expect(toToolSchema(FIND_USER).description).not.toContain('changes data');
  });
});

describe('describeObservation', () => {
  it('gives the model the operator detail, not the user-facing message', () => {
    const text = describeObservation({
      ...outcome('find_user', {
        status: 'error',
        message: 'Something went wrong.',
        retryable: false,
      }),
      operatorDetail: 'find_user needs at least one of: email, userid.',
    });

    expect(text).toContain('at least one of: email, userid');
    expect(text).not.toContain('Something went wrong');
  });

  it('shows every id the loop has to chain on, by name', () => {
    /*
     * The cross-person bug, pinned with the shape that caused it.
     *
     * find_candidate returns `id` (a registration) and `user_id` (a person).
     * `user_id` was stripped, because evidence.ts hides foreign keys — right
     * for the synthesizer, catastrophic here. The model saw only `Id: 582`,
     * passed it to an action wanting a user id, and generated the report for
     * registration 582's number read as a user id: a different candidate
     * entirely.
     */
    const text = describeObservation(
      outcome('find_candidate', {
        status: 'single',
        data: {
          id: 582,
          user_id: 596,
          full_name: 'Sriharan S2',
          label: 'Sriharan S2',
          match_score: 100,
        },
        confidence: 1,
      }),
    );

    expect(text).toContain('User id: 596');
    expect(text).toContain('Id: 582');
    // Engine columns stay hidden — they are not facts about the record.
    expect(text).not.toContain('match_score');
  });

  it('still withholds secrets from the loop', () => {
    // Identifiers became visible; credentials must not have.
    const text = describeObservation(
      outcome('find_user', {
        status: 'single',
        data: {
          user_id: 7,
          password_hash: 'argon2id$v=19$...',
          api_token: 'sk-live-abcdef',
          cognito_sub: 'a-b-c-d',
        },
        confidence: 1,
      }),
    );

    expect(text).toContain('User id: 7');
    expect(text).not.toContain('argon2id');
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('a-b-c-d');
  });

  it('says a failure produced nothing, so it is not reported as pending', () => {
    // Observed: asked to generate a report against a service that was down, the
    // agent answered "the report is not ready yet". The action had failed
    // outright, so the user waits for something that will never arrive.
    const text = describeObservation(
      outcome('generate_report', {
        status: 'error',
        message: 'That action could not be completed.',
        retryable: true,
      }),
    );

    expect(text).toContain('FAILED');
    expect(text).toContain('nothing was created');
    expect(text).toContain('did not happen');
  });

  it('tells the model an empty result is not worth retrying identically', () => {
    const text = describeObservation(
      outcome('find_user', { status: 'empty', searchedBy: 'email "x"' }),
    );
    expect(text).toContain('Do not retry with the same arguments');
  });

  it('names an artifact without ever showing its value', () => {
    const text = describeObservation({
      ...outcome('generate_report', { status: 'single', data: {}, confidence: 1 }),
      artifacts: [
        { label: 'Report download', url: 'https://example.test/very-long-signed-url' },
      ],
    });

    expect(text).toContain('report download');
    expect(text).not.toContain('very-long-signed-url');
  });

  it('caps a long list rather than pasting a whole table into context', () => {
    const rows = Array.from({ length: 200 }, (_unused, index) => ({
      full_name: `Person number ${index} with a fairly long name attached`,
      programme: 'College Students',
    }));

    const text = describeObservation(
      outcome('list_candidates', {
        status: 'list',
        data: rows,
        total: 200,
        truncated: false,
      }),
    );

    // Observations accumulate across steps, so the bound is the point. It says
    // how many were withheld, so the model can ask the user to narrow rather
    // than believing it has seen everything.
    expect(text.length).toBeLessThan(2300);
    expect(text).toContain('and 185 more not shown');
    expect(text).not.toContain('Person number 20 ');
  });

  it('cuts a single oversized record on a line boundary', () => {
    const text = describeObservation(
      outcome('get_policy', {
        status: 'single',
        data: Object.fromEntries(
          Array.from({ length: 60 }, (_unused, index) => [
            `clause_${index}`,
            'Some fairly wordy policy text that goes on for a while, repeatedly.',
          ]),
        ),
        confidence: 1,
      }),
    );

    expect(text.length).toBeLessThan(2300);
    expect(text).toContain('truncated');
  });
});
