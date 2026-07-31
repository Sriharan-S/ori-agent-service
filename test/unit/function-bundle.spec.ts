import { BadRequestException } from '@nestjs/common';
import {
  parseBundle,
  FUNCTION_BUNDLE_TAG,
  FUNCTION_BUNDLE_VERSION,
} from '../../src/management/function-management.service';

/**
 * The import envelope.
 *
 * Import is how functions move between deployments, and the failure that costs
 * the most is the quiet one: a file that is not a bundle being treated as an
 * empty one, so an import silently does nothing. So the envelope is strict about
 * what it accepts and loud about what it rejects, and this pins both.
 */
describe('parseBundle', () => {
  const oneFunction = [{ name: 'x', kind: 'read', description: 'd', returns: 'list' }];

  it('accepts a full bundle', () => {
    const parsed = parseBundle({
      bundle: FUNCTION_BUNDLE_TAG,
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      application: { slug: 'app' },
      functions: oneFunction,
    });
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.application?.slug).toBe('app');
  });

  it('accepts a bare array — the shape a first hand-written bundle takes', () => {
    const parsed = parseBundle(oneFunction);
    expect(parsed.bundle).toBe(FUNCTION_BUNDLE_TAG);
    expect(parsed.functions).toHaveLength(1);
  });

  it('rejects a wrong bundle tag rather than importing a stray file', () => {
    expect(() => parseBundle({ bundle: 'something-else', functions: [] })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a bundle from a newer service version', () => {
    expect(() =>
      parseBundle({
        bundle: FUNCTION_BUNDLE_TAG,
        version: FUNCTION_BUNDLE_VERSION + 1,
        functions: [],
      }),
    ).toThrow(/version/i);
  });

  it('rejects an object with no functions array', () => {
    expect(() => parseBundle({ bundle: FUNCTION_BUNDLE_TAG })).toThrow(BadRequestException);
    expect(() => parseBundle({ functions: 'nope' })).toThrow(BadRequestException);
  });

  it('rejects a non-object', () => {
    expect(() => parseBundle('a string')).toThrow(BadRequestException);
    expect(() => parseBundle(null)).toThrow(BadRequestException);
  });

  it('tolerates a version-less bundle from an early export', () => {
    const parsed = parseBundle({ bundle: FUNCTION_BUNDLE_TAG, functions: oneFunction });
    expect(parsed.functions).toHaveLength(1);
    expect(typeof parsed.exportedAt).toBe('string');
  });
});
