import {
  humaniseEnum,
  humaniseKey,
  presentRecord,
  presentRecords,
} from '../../src/orchestrator/evidence';

/**
 * What the synthesizer is allowed to see.
 *
 * These tests exist because of a real answer this service gave a user:
 *
 *   "The record I have for you (ID 50) does not include a name field. It only
 *    shows program, registration status, payment status, AI counsellor flag, and
 *    creation date."
 *
 * That is a description of a database row. The model wrote it because a database
 * row was what it was given, and no amount of prompt wording reliably stops a
 * model quoting the thing in front of it. So the fix is that the column names
 * never reach the prompt — which makes this transformation load-bearing, and
 * worth pinning.
 */
describe('evidence presentation', () => {
  describe('humaniseKey', () => {
    it('turns a column name into a label', () => {
      expect(humaniseKey('session_status')).toBe('Session status');
      expect(humaniseKey('full_name')).toBe('Full name');
      expect(humaniseKey('program')).toBe('Program');
    });
  });

  describe('humaniseEnum', () => {
    it('turns shouty constants into English', () => {
      expect(humaniseEnum('NOT_REQUIRED')).toBe('not required');
      expect(humaniseEnum('PARTIALLY_EXPIRED')).toBe('partially expired');
      expect(humaniseEnum('COMPLETED')).toBe('completed');
    });

    it('leaves a real code alone', () => {
      // A report number is quoted back to users verbatim; mangling one would be
      // worse than leaving an enum shouty.
      expect(humaniseEnum('OBI-G27-01/26-COLLEGE_STUDENT-065')).toBe(
        'OBI-G27-01/26-COLLEGE_STUDENT-065',
      );
      expect(humaniseEnum('Priya Sharma')).toBe('Priya Sharma');
      expect(humaniseEnum('ORD-1002')).toBe('ORD-1002');
    });
  });

  describe('presentRecord', () => {
    it('never emits a column name', () => {
      const presented = presentRecord({
        id: 50,
        full_name: 'Priya Sharma',
        session_status: 'COMPLETED',
        payment_status: 'NOT_REQUIRED',
        has_ai_counsellor: false,
        created_at: '2026-01-29T03:05:57.389Z',
      })!;

      for (const column of [
        'full_name',
        'session_status',
        'payment_status',
        'has_ai_counsellor',
        'created_at',
      ]) {
        expect(presented).not.toContain(column);
      }
    });

    it('renders values the way a person would read them', () => {
      const presented = presentRecord({
        full_name: 'Priya Sharma',
        session_status: 'COMPLETED',
        payment_status: 'NOT_REQUIRED',
        has_ai_counsellor: false,
        created_at: '2026-01-29T03:05:57.389Z',
      })!;

      expect(presented).toContain('Priya Sharma');
      expect(presented).toContain('completed');
      expect(presented).toContain('not required');
      expect(presented).toContain('no');
      expect(presented).toContain('29 January 2026');
      // And no raw timestamp survived.
      expect(presented).not.toContain('2026-01-29T03');
    });

    it('drops secrets, which must never reach a model at all', () => {
      const presented = presentRecord({
        full_name: 'Priya Sharma',
        cognito_sub: 'e1a3ad7a-6041-70c3',
        password_hash: 'argon2id$v=19$x',
        report_url: 'https://example.com/x.pdf',
      })!;

      expect(presented).toContain('Priya Sharma');
      expect(presented).not.toContain('e1a3ad7a');
      expect(presented).not.toContain('argon2id');
      expect(presented).not.toContain('example.com');
    });

    it('keeps identifiers, labelled, so the right one can be chosen', () => {
      /*
       * This assertion used to be the opposite, and that is what caused two
       * wrong-record bugs.
       *
       * `find_candidate` returns `id` (a registration) and `user_id` (a
       * person). With foreign keys stripped, both readers saw only `Id: 582`:
       * the agent loop passed it to an action wanting a user id and generated
       * one candidate's report under another candidate's name, and the
       * synthesizer, asked for a user id, answered with the registration id.
       *
       * Evidence is built from rows RBAC and scope binding have already
       * filtered, so every value in it is one the caller may see. Keeping ids
       * out was a presentation preference, and presentation is the persona's
       * job — enforcing it by withholding facts produced confident wrong
       * answers instead of tidy ones.
       */
      const presented = presentRecord({
        full_name: 'Sriharan S2',
        id: 582,
        user_id: 596,
        corporate_account_id: 13,
      })!;

      expect(presented).toContain('Id: 582');
      expect(presented).toContain('User id: 596');
      expect(presented).toContain('Corporate account id: 13');
      // Labelled, so "the user id" is answerable without guessing.
      expect(presented).not.toMatch(/\buser_id\b/);
    });

    it('drops engine-only columns', () => {
      const presented = presentRecord({
        full_name: 'Priya',
        match_score: 100,
        ori_total: 42,
        label: 'Priya',
        detail: 'x',
      })!;

      expect(presented).toBe('Full name: Priya');
    });

    it('omits empty values rather than saying null', () => {
      const presented = presentRecord({
        full_name: 'Priya',
        program: null,
        note: '',
        completed_at: undefined,
      })!;

      expect(presented).toBe('Full name: Priya');
      expect(presented).not.toMatch(/null|undefined/);
    });

    it('returns null when a record holds nothing worth saying', () => {
      // Engine columns and secrets only — nothing a reader or the loop could
      // use. An id on its own is now genuinely something worth saying, so it no
      // longer counts as empty.
      expect(presentRecord({ ori_total: 2, match_score: 90 })).toBeNull();
      expect(presentRecord({ password_hash: 'x' })).toBeNull();
      expect(presentRecord(null)).toBeNull();
    });
  });

  describe('presentRecords', () => {
    it('numbers rows as statements rather than a data structure', () => {
      const presented = presentRecords([
        { session_status: 'COMPLETED', candidates: 124 },
        { session_status: 'EXPIRED', candidates: 12 },
      ]);

      expect(presented).toContain('1. Session status: completed · Candidates: 124');
      expect(presented).toContain('2. Session status: expired · Candidates: 12');
      expect(presented).not.toContain('{');
    });

    it('says how many it left out instead of silently truncating', () => {
      const rows = Array.from({ length: 50 }, (_, index) => ({ name: `p${index}` }));
      const presented = presentRecords(rows, 10);

      expect(presented).toContain('and 40 more');
    });
  });
});
