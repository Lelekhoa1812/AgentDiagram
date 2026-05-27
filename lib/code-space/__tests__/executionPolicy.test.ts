import { describe, expect, it } from 'vitest';
import {
  isCodeSpaceAutoExecutionPolicy,
  normalizeCodeSpaceExecutionPolicy,
  shouldAutoApplyCodeSpaceDiffs,
} from '../executionPolicy';

describe('Code Space execution policy', () => {
  it('defaults unknown values to manual confirmation mode', () => {
    expect(normalizeCodeSpaceExecutionPolicy(undefined)).toBe('manual');
    expect(normalizeCodeSpaceExecutionPolicy('surprise')).toBe('manual');
  });

  it('recognizes auto mode and auto-applied diffs', () => {
    expect(isCodeSpaceAutoExecutionPolicy('auto')).toBe(true);
    expect(isCodeSpaceAutoExecutionPolicy('manual')).toBe(false);
    expect(shouldAutoApplyCodeSpaceDiffs('auto')).toBe(true);
    expect(shouldAutoApplyCodeSpaceDiffs('manual', true)).toBe(true);
    expect(shouldAutoApplyCodeSpaceDiffs('manual', false)).toBe(false);
  });
});
