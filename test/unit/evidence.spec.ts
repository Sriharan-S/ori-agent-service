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

    it('drops foreign keys and secrets, which are never the answer', () => {
      const presented = presentRecord({
        full_name: 'Priya Sharma',
        corporate_account_id: 13,
        assessment_session_id: 359,
        cognito_sub: 'e1a3ad7a-6041-70c3',
        report_url: 'https://example.com/x.pdf',
      })!;

      expect(presented).toContain('Priya Sharma');
      expect(presented).not.toContain('13');
      expect(presented).not.toContain('359');
      expect(presented).not.toContain('e1a3ad7a');
      expect(presented).not.toContain('example.com');
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
      expect(presentRecord({ user_id: 5, ori_total: 2 })).toBeNull();
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
