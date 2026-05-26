import { describe, expect, it } from 'vitest';
import { createAgentEvent } from '../events';

describe('createAgentEvent', () => {
  it('adds stable audit metadata around structured payloads', () => {
    const event = createAgentEvent({
      type: 'run.created',
      projectId: 'project-1',
      sessionId: 'session-1',
      runId: 'run-1',
      payload: { mode: 'ask' },
    });

    expect(event.id).toMatch(/^event:/);
    expect(event.createdAt).toEqual(expect.any(Number));
    expect(event.projectId).toBe('project-1');
    expect(event.sessionId).toBe('session-1');
    expect(event.runId).toBe('run-1');
    expect(event.payload).toEqual({ mode: 'ask' });
  });
});
