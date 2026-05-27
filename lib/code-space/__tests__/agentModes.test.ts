import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODE_SPACE_AGENT_MODE,
  getCodeSpaceAgentModeMeta,
  isCodeSpacePlanMode,
  isCodeSpaceReadOnlyMode,
  normalizeCodeSpaceAgentMode,
} from '../agentModes';

describe('Code Space agent modes', () => {
  it('defaults missing or unknown modes to Code', () => {
    expect(DEFAULT_CODE_SPACE_AGENT_MODE).toBe('code');
    expect(normalizeCodeSpaceAgentMode(undefined)).toBe('code');
    expect(normalizeCodeSpaceAgentMode('surprise')).toBe('code');
  });

  it('maps legacy agent-like modes to Code', () => {
    expect(normalizeCodeSpaceAgentMode('agent')).toBe('code');
    expect(normalizeCodeSpaceAgentMode('chat')).toBe('code');
    expect(normalizeCodeSpaceAgentMode('edit')).toBe('code');
  });

  it('marks Ask as read-only and Plan as markdown-producing', () => {
    expect(isCodeSpaceReadOnlyMode('ask')).toBe(true);
    expect(isCodeSpaceReadOnlyMode('plan')).toBe(false);
    expect(isCodeSpacePlanMode('plan')).toBe(true);
    expect(getCodeSpaceAgentModeMeta('plan')).toMatchObject({
      label: 'Plan',
      createsPlanMarkdown: true,
    });
  });
});
