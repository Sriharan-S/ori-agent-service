import {
  decideAmbiguity,
  type AmbiguityThresholds,
  type ScoredMatch,
} from '../../src/registry/ambiguity';

const thresholds: AmbiguityThresholds = {
  gapThreshold: 6,
  minConfidentScore: 90,
  shortTermLength: 3,
  shortTermMinScore: 95,
};

function match(id: number, score: number, label = `Person ${id}`): ScoredMatch {
  return { id, label, score };
}

describe('decideAmbiguity', () => {
  it('returns empty when nothing matched', () => {
    expect(decideAmbiguity([], 'Priya', thresholds)).toEqual({
      outcome: 'empty',
    });
  });

  it('resolves a lone match without asking', () => {
    const decision = decideAmbiguity([match(1, 60)], 'Priya', thresholds);

    expect(decision.outcome).toBe('single');
    if (decision.outcome === 'single') {
      expect(decision.match.id).toBe(1);
    }
  });

  it('does not treat "more than one row" as ambiguity when the top match wins clearly', () => {
    const decision = decideAmbiguity(
      [match(1, 100), match(2, 60), match(3, 60)],
      'Priya Sharma',
      thresholds,
    );

    expect(decision.outcome).toBe('single');
    if (decision.outcome === 'single') {
      expect(decision.match.id).toBe(1);
    }
  });

  it('asks when the runner-up is inside the gap threshold', () => {
    // Deliberately narrow: 100 vs 95 is a gap of 5, below the threshold of 6.
    const decision = decideAmbiguity(
      [match(1, 100, 'Priya Sharma'), match(2, 95, 'Priya Sharman')],
      'Priya Sharma',
      thresholds,
    );

    expect(decision.outcome).toBe('ambiguous');
    if (decision.outcome === 'ambiguous') {
      expect(decision.candidates.map((c) => c.id)).toEqual([1, 2]);
    }
  });

  it('resolves at exactly the gap threshold', () => {
    // 100 vs 94 is a gap of exactly 6 — the plan's rule resolves this.
    const decision = decideAmbiguity(
      [match(1, 100), match(2, 94)],
      'Priya Sharma',
      thresholds,
    );

    expect(decision.outcome).toBe('single');
  });

  it('asks when the top match is weak even with a wide gap', () => {
    // Gap of 24 is wide, but 84 is below minConfidentScore.
    const decision = decideAmbiguity(
      [match(1, 84), match(2, 60)],
      'Sharma',
      thresholds,
    );

    expect(decision.outcome).toBe('ambiguous');
  });

  it('holds short search terms to a stricter bar', () => {
    // 94 clears minConfidentScore and the gap, but "Ana" is 3 characters.
    const decision = decideAmbiguity(
      [match(1, 94), match(2, 60)],
      'Ana',
      thresholds,
    );

    expect(decision.outcome).toBe('ambiguous');
  });

  it('resolves a short term when the match is exact', () => {
    const decision = decideAmbiguity(
      [match(1, 100), match(2, 60)],
      'Ana',
      thresholds,
    );

    expect(decision.outcome).toBe('single');
  });

  it('honours a reconfigured gap threshold', () => {
    const strict: AmbiguityThresholds = { ...thresholds, gapThreshold: 20 };

    const decision = decideAmbiguity(
      [match(1, 100), match(2, 90)],
      'Priya Sharma',
      strict,
    );

    expect(decision.outcome).toBe('ambiguous');
  });

  it('caps the candidate list', () => {
    const matches = Array.from({ length: 12 }, (_, i) => match(i + 1, 80));

    const decision = decideAmbiguity(matches, 'Kumar', thresholds, 5);

    expect(decision.outcome).toBe('ambiguous');
    if (decision.outcome === 'ambiguous') {
      expect(decision.candidates).toHaveLength(5);
    }
  });

  it('reports higher confidence for a wider separation', () => {
    const close = decideAmbiguity(
      [match(1, 100), match(2, 94)],
      'Priya Sharma',
      thresholds,
    );
    const clear = decideAmbiguity(
      [match(1, 100), match(2, 40)],
      'Priya Sharma',
      thresholds,
    );

    expect(close.outcome).toBe('single');
    expect(clear.outcome).toBe('single');
    if (close.outcome === 'single' && clear.outcome === 'single') {
      expect(clear.confidence).toBeGreaterThan(close.confidence);
    }
  });
});
