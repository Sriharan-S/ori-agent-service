import { extractJsonObject } from '../../src/llm/llm.service';
import {
  CircuitBreaker,
  isQuotaOrRateLimitError,
} from '../../src/llm/circuit-breaker';

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('ignores prose before and after', () => {
    expect(
      extractJsonObject('Sure! Here is the plan:\n{"a":1}\nHope that helps.'),
    ).toBe('{"a":1}');
  });

  it('stops at the matching brace rather than the last one in the text', () => {
    // A greedy /\{[\s\S]*\}/ would swallow the trailing brace in the prose.
    expect(extractJsonObject('{"a":1} and then some } text')).toBe('{"a":1}');
  });

  it('handles nested objects', () => {
    const nested = '{"calls":[{"function":"find_person","params":{"name":"P"}}]}';
    expect(extractJsonObject(`noise ${nested} noise`)).toBe(nested);
  });

  it('is not confused by braces inside strings', () => {
    const tricky = '{"reason":"uses { and } characters"}';
    expect(extractJsonObject(tricky)).toBe(tricky);
  });

  it('is not confused by escaped quotes', () => {
    const tricky = '{"reason":"he said \\"hi\\" then left"}';
    expect(extractJsonObject(tricky)).toBe(tricky);
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('I cannot help with that.')).toBeNull();
  });

  it('returns null on an unterminated object', () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

describe('isQuotaOrRateLimitError', () => {
  it.each([
    [{ status: 429 }],
    [{ status: 503 }],
    [{ code: 'rate_limit_exceeded' }],
    [{ message: 'RESOURCE_EXHAUSTED: quota' }],
    [{ message: 'Too Many Requests' }],
  ])('recognises %j', (error) => {
    expect(isQuotaOrRateLimitError(error)).toBe(true);
  });

  it.each([[{ status: 500 }], [{ message: 'socket hang up' }], [null]])(
    'does not over-match %j',
    (error) => {
      expect(isQuotaOrRateLimitError(error)).toBe(false);
    },
  );
});

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.recordFailure('m1');
    breaker.recordFailure('m1');
    expect(breaker.isOpen('m1')).toBe(false);
  });

  it('opens at the threshold', () => {
    const breaker = new CircuitBreaker(3, 1000);
    breaker.recordFailure('m1');
    breaker.recordFailure('m1');
    breaker.recordFailure('m1');
    expect(breaker.isOpen('m1')).toBe(true);
  });

  it('opens immediately on a quota error', () => {
    const breaker = new CircuitBreaker(5, 1000);
    breaker.recordFailure('m1', true);
    expect(breaker.isOpen('m1')).toBe(true);
  });

  it('keeps models independent, so one bad model does not disable the rest', () => {
    const breaker = new CircuitBreaker(1, 1000);
    breaker.recordFailure('m1');
    expect(breaker.isOpen('m1')).toBe(true);
    expect(breaker.isOpen('m2')).toBe(false);
  });

  it('closes again after the cooldown', () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker(1, 5000, () => now);

    breaker.recordFailure('m1');
    expect(breaker.isOpen('m1')).toBe(true);

    now += 5001;
    expect(breaker.isOpen('m1')).toBe(false);
  });

  it('a success resets the failure count', () => {
    const breaker = new CircuitBreaker(2, 1000);
    breaker.recordFailure('m1');
    breaker.recordSuccess('m1');
    breaker.recordFailure('m1');
    expect(breaker.isOpen('m1')).toBe(false);
  });
});
