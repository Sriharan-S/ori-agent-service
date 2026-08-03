import { BadRequestException } from '@nestjs/common';
import { FunctionManagementService } from '../../src/management/function-management.service';

/**
 * `validation_error` is a verdict cached at save time, and the rules move
 * underneath it. A function saved under an older build keeps that build's
 * opinion until something saves it again — nothing else rewrites the column.
 *
 * This bit in production: a write function was saved under a rule that demanded
 * a resolvedIdentifier parameter. The rule was later relaxed to also accept an
 * action bound to the caller's own scope, which that function was. Approval
 * stayed blocked by the cached string, while the `live` gate — which does
 * re-validate — would have passed it.
 */
describe('approval re-validates rather than trusting the cached verdict', () => {
  const definition = {
    name: 'generate_my_report',
    status: 'draft' as const,
    kind: 'write' as const,
    description: 'Prepare the caller’s own report.',
    allowedRoles: ['STUDENT'],
    parameters: {},
    returns: 'confirmation' as const,
    writeScope: 'reports.generate',
    httpRequest: { method: 'GET', service: 'reports', path: '/x/{{scope:user_id}}' },
    // The stale verdict, written by a build whose rule no longer exists.
    validationError:
      'A write function must take at least one resolvedIdentifier parameter.',
  };

  const build = (ok: boolean) => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const validate = jest.fn().mockResolvedValue(
      ok ? { ok: true, issues: [] } : { ok: false, issues: [{ severity: 'error', message: 'still broken' }] },
    );
    const service = new FunctionManagementService(
      { query, schema: 'ori', one: jest.fn() } as never,
      {
        getByName: jest.fn().mockResolvedValue(definition),
        invalidate: jest.fn(),
      } as never,
      { validate } as never,
    );
    return { service, validate, query };
  };

  it('approves when the current rules pass, despite a stale error on the row', async () => {
    const { service, validate } = build(true);

    await service.setStatus(1, 'generate_my_report', 'approved', 7);

    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the function genuinely does not validate', async () => {
    const { service } = build(false);

    await expect(
      service.setStatus(1, 'generate_my_report', 'approved', 7),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports the current failure, not the cached string', async () => {
    const { service } = build(false);

    await expect(
      service.setStatus(1, 'generate_my_report', 'approved', 7),
    ).rejects.toThrow(/still broken/);
  });
});
