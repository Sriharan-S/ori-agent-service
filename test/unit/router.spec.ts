import { RouterService } from '../../src/orchestrator/router.service';
import type { PendingDisambiguation } from '../../src/memory/conversation.service';

const pending: PendingDisambiguation = {
  functionName: 'find_person',
  resolveInto: 'personId',
  originalParams: { name: 'Priya' },
  searchedBy: 'name "Priya"',
  askedAt: Date.now(),
  candidates: [
    { id: 101, label: 'Priya Sharma', detail: 'score 78', score: 100 },
    { id: 202, label: 'Priya Nair', detail: 'not assessed', score: 96 },
    { id: 303, label: 'Priyanka Rao', detail: 'score 64', score: 60 },
  ],
};

describe('RouterService', () => {
  const router = new RouterService();

  describe('without a pending clarification', () => {
    it('routes greetings and capability questions as conversational', () => {
      expect(router.classify('hello there', null).intent).toBe('conversational');
      expect(router.classify('thanks!', null).intent).toBe('conversational');
      expect(router.classify('what can you do?', null).intent).toBe('conversational');
    });

    /**
     * These all failed once, and the failure was not obvious: they went to the
     * read path, where the planner is obliged to pick a data function, so "show
     * me what you can do" was answered by reciting one student's registration
     * record. The words are the same as "what can you do" — only the auxiliary
     * moves — which is exactly the kind of near-miss a literal phrase list
     * cannot catch.
     */
    it.each([
      'show me what you can do',
      'Tell me what you can do?',
      'what you can do',
      'what are you able to do',
      'list your features',
      'what can I ask you',
      'who are you',
      'how do you work',
      'help me',
    ])('routes "%s" as conversational', (message) => {
      expect(router.classify(message, null).intent).toBe('conversational');
    });

    it('routes an update request as a write', () => {
      expect(router.classify("change Priya's name to Priya S", null).intent).toBe('write');
    });

    it('routes a question about data as a read', () => {
      expect(router.classify('tell me about Priya Sharma', null).intent).toBe('read');
      expect(router.classify('list everyone on the programme', null).intent).toBe('read');
    });

    /**
     * The other half of the same risk: widening the capability pattern must not
     * start swallowing real questions. "show me our candidates" is a read.
     */
    it.each([
      'what is my name',
      'how many candidates have completed the assessment',
      'is my report ready',
      'show me our candidates',
      'list everyone who has not started',
      'what is my exam score',
      'how many credits do we have left',
      'what is the status of candidate Priya',
    ])('still routes "%s" as a read', (message) => {
      expect(router.classify(message, null).intent).toBe('read');
    });
  });

  describe('with a pending clarification', () => {
    it('resolves an ordinal digit', () => {
      const decision = router.classify('2', pending);
      expect(decision.intent).toBe('clarification-reply');
      expect(decision.resolvedCandidate?.id).toBe(202);
    });

    it('resolves an ordinal word', () => {
      const decision = router.classify('the third one', pending);
      expect(decision.intent).toBe('clarification-reply');
      expect(decision.resolvedCandidate?.id).toBe(303);
    });

    it('resolves an exact label', () => {
      const decision = router.classify('Priya Nair', pending);
      expect(decision.intent).toBe('clarification-reply');
      expect(decision.resolvedCandidate?.id).toBe(202);
    });

    it('resolves a raw candidate id', () => {
      const decision = router.classify('303', pending);
      expect(decision.intent).toBe('clarification-reply');
      expect(decision.resolvedCandidate?.id).toBe(303);
    });

    it('does not guess when the reply matches several candidates', () => {
      // "Priya" is inside all three labels — that is not an answer.
      const decision = router.classify('Priya', pending);
      expect(decision.intent).not.toBe('clarification-reply');
      expect(decision.resolvedCandidate).toBeUndefined();
    });

    it('routes a fresh question normally rather than forcing a selection', () => {
      const decision = router.classify('actually, list everyone instead', pending);
      expect(decision.intent).toBe('read');
    });

    it('ignores an ordinal beyond the candidate list', () => {
      expect(router.classify('9', pending).intent).not.toBe('clarification-reply');
    });
  });
});
