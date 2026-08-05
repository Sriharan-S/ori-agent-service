import { BadRequestException } from '@nestjs/common';
import { ResponsePolicyService } from '../../src/policy/response-policy.service';
import { DEFAULT_REFUSAL } from '../../src/policy/policy.contract';

/**
 * A stand-in for the primary database.
 *
 * The service reads one row and writes one row, so a single stored value is the
 * whole surface. `queries` is kept so a test can assert the cache stopped a
 * second read, which is the only behaviour here that is invisible in the
 * return value.
 */
function makeDb(row: Record<string, unknown> | null = null) {
  const state = { row };
  const queries: string[] = [];

  return {
    schema: 'ori',
    queries,
    state,
    query: jest.fn((sql: string, params: unknown[] = []) => {
      queries.push(sql);

      if (sql.includes('DELETE')) {
        state.row = null;
        return Promise.resolve([]);
      }

      if (sql.includes('INSERT')) {
        state.row = {
          application_id: params[0],
          is_enabled: params[1],
          system_prompt: params[2],
          allow_rules: JSON.parse(params[3] as string),
          deny_rules: JSON.parse(params[4] as string),
          refusal_message: params[5],
          updated_at: new Date('2026-01-01T00:00:00Z'),
        };
        return Promise.resolve([state.row]);
      }

      return Promise.resolve(state.row ? [state.row] : []);
    }),
  };
}

const CONFIG = { behaviour: { registryCacheTtlMs: 30_000 } };

function makeService(db: ReturnType<typeof makeDb>) {
  return new ResponsePolicyService(CONFIG as never, db as never);
}

describe('ResponsePolicyService', () => {
  describe('when nothing is configured', () => {
    it('returns a disabled empty policy', async () => {
      const service = makeService(makeDb(null));
      const policy = await service.get(7);

      expect(policy.isEnabled).toBe(false);
      expect(policy.allowRules).toEqual([]);
      expect(policy.denyRules).toEqual([]);
      expect(policy.refusalMessage).toBe(DEFAULT_REFUSAL);
    });

    it('allows everything and adds nothing to the prompt', async () => {
      const service = makeService(makeDb(null));

      await expect(service.evaluate(7, 'anything at all')).resolves.toEqual({
        allowed: true,
      });
      await expect(service.compilePrompt(7)).resolves.toBe('');
    });
  });

  describe('enforcement', () => {
    it('refuses a message matching a deny pattern', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        {
          isEnabled: true,
          denyRules: [
            {
              topic: 'clinical diagnosis',
              patterns: ['depressed', '/anxiet(y|ies)/'],
              message: 'I cannot help with that.',
            },
          ],
        },
        null,
      );

      const verdict = await service.evaluate(1, 'Am I depressed?');
      expect(verdict.allowed).toBe(false);
      expect(verdict.topic).toBe('clinical diagnosis');
      expect(verdict.message).toBe('I cannot help with that.');

      await expect(service.evaluate(1, 'tell me about anxieties')).resolves.toMatchObject({
        allowed: false,
      });
    });

    it('matches on word boundaries, so a substring is not a hit', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        { isEnabled: true, denyRules: [{ topic: 'art', patterns: ['art'] }] },
        null,
      );

      // "start" contains "art". Refusing this would be a user blocked for a
      // reason they could never work out.
      await expect(service.evaluate(1, 'how do I start?')).resolves.toEqual({
        allowed: true,
      });
      await expect(service.evaluate(1, 'tell me about art')).resolves.toMatchObject({
        allowed: false,
      });
    });

    it('does not block a rule that carries no patterns', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        {
          isEnabled: true,
          denyRules: [{ topic: 'legal advice', patterns: [] }],
        },
        null,
      );

      await expect(service.evaluate(1, 'is this legal advice')).resolves.toEqual({
        allowed: true,
      });

      // Still named in the prompt, which is the whole point of a prompt-only rule.
      await expect(service.compilePrompt(1)).resolves.toContain('legal advice');
    });

    it('enforces nothing while the policy is switched off', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        {
          isEnabled: false,
          denyRules: [{ topic: 'x', patterns: ['forbidden'] }],
        },
        null,
      );

      await expect(service.evaluate(1, 'this is forbidden')).resolves.toEqual({
        allowed: true,
      });
      await expect(service.compilePrompt(1)).resolves.toBe('');
    });

    it('falls back to the default refusal when a rule has no message', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        { isEnabled: true, denyRules: [{ topic: 'x', patterns: ['nope'] }] },
        null,
      );

      const verdict = await service.evaluate(1, 'nope');
      expect(verdict.allowed).toBe(false);
      expect(verdict.message).toBeFalsy();
      // The orchestrator resolves the fallback, so the policy must carry one.
      await expect(service.get(1)).resolves.toMatchObject({
        refusalMessage: DEFAULT_REFUSAL,
      });
    });

    it('does not carry regex state between calls', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        { isEnabled: true, denyRules: [{ topic: 'x', patterns: ['/bad/g'] }] },
        null,
      );

      // A `g` flag would make the second call miss. It is stripped on compile.
      await expect(service.evaluate(1, 'bad')).resolves.toMatchObject({ allowed: false });
      await expect(service.evaluate(1, 'bad')).resolves.toMatchObject({ allowed: false });
    });
  });

  describe('the compiled prompt', () => {
    it('names what is allowed and what is refused', async () => {
      const service = makeService(makeDb());
      await service.upsert(
        1,
        {
          isEnabled: true,
          systemPrompt: 'Be brief.',
          allowRules: [{ topic: 'career guidance', note: 'From their own scores only.' }],
          denyRules: [{ topic: 'medical opinion', patterns: [] }],
        },
        null,
      );

      const prompt = await service.compilePrompt(1);
      expect(prompt).toContain('Be brief.');
      expect(prompt).toContain('career guidance');
      expect(prompt).toContain('From their own scores only.');
      expect(prompt).toContain('medical opinion');
    });
  });

  describe('validation', () => {
    it('rejects a rule with no topic', async () => {
      const service = makeService(makeDb());
      await expect(
        service.upsert(1, { denyRules: [{ topic: '  ', patterns: [] }] }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a pattern that will not compile', async () => {
      const service = makeService(makeDb());
      await expect(
        service.upsert(
          1,
          { denyRules: [{ topic: 'x', patterns: ['/([unclosed/'] }] },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('bundles', () => {
    it('round-trips through export and import', async () => {
      const db = makeDb();
      const service = makeService(db);

      await service.upsert(
        1,
        {
          isEnabled: true,
          systemPrompt: 'Be brief.',
          allowRules: [{ topic: 'career guidance', note: 'Scores only.' }],
          denyRules: [{ topic: 'medical', patterns: ['diagnose'] }],
        },
        null,
      );

      const bundle = await service.exportBundle(1, 'originbi', 'OriginBI');
      expect(bundle.bundle).toBe('ori.policy-bundle');

      const imported = await service.importBundle(2, bundle, null);
      expect(imported.allowRules).toEqual([
        { topic: 'career guidance', note: 'Scores only.' },
      ]);
      expect(imported.denyRules[0]!.topic).toBe('medical');
    });

    it('imports switched off even when the bundle says otherwise', async () => {
      const service = makeService(makeDb());
      const imported = await service.importBundle(
        1,
        { bundle: 'ori.policy-bundle', policy: { isEnabled: true } },
        null,
      );

      expect(imported.isEnabled).toBe(false);
    });

    it('honours an explicit opt-in to enable on import', async () => {
      const service = makeService(makeDb());
      const imported = await service.importBundle(
        1,
        { bundle: 'ori.policy-bundle', policy: { isEnabled: true } },
        null,
        { enable: true },
      );

      expect(imported.isEnabled).toBe(true);
    });

    it('accepts a bare policy object', async () => {
      const service = makeService(makeDb());
      const imported = await service.importBundle(
        1,
        { allowRules: [{ topic: 'careers', note: 'yes' }] },
        null,
      );

      expect(imported.allowRules).toHaveLength(1);
    });

    it('rejects a foreign bundle tag', async () => {
      const service = makeService(makeDb());
      await expect(
        service.importBundle(1, { bundle: 'ori.function-bundle', policy: {} }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a bundle from a newer service', async () => {
      const service = makeService(makeDb());
      await expect(
        service.importBundle(
          1,
          { bundle: 'ori.policy-bundle', version: 99, policy: {} },
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('caching', () => {
    it('reads once and serves the rest from cache', async () => {
      const db = makeDb(null);
      const service = makeService(db);

      await service.get(1);
      await service.get(1);
      await service.evaluate(1, 'hello');

      const reads = db.queries.filter((sql) => sql.includes('SELECT'));
      expect(reads).toHaveLength(1);
    });

    it('drops the cache on write, so an edit takes effect at once', async () => {
      const db = makeDb();
      const service = makeService(db);

      await service.get(1);
      await service.upsert(
        1,
        { isEnabled: true, denyRules: [{ topic: 'x', patterns: ['nope'] }] },
        null,
      );

      await expect(service.evaluate(1, 'nope')).resolves.toMatchObject({
        allowed: false,
      });
    });
  });
});
