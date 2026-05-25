import { describe, expect, it } from 'vitest';
import { optionalUrl } from '../planning/requestValidation';

describe('requestValidation', () => {
  it('treats blank repoUrl values as omitted', () => {
    expect(optionalUrl.safeParse('').success).toBe(true);
    expect(optionalUrl.safeParse('   ').success).toBe(true);
    expect(optionalUrl.safeParse(undefined).success).toBe(true);
  });

  it('still rejects malformed URLs', () => {
    expect(optionalUrl.safeParse('not-a-url').success).toBe(false);
  });
});
