import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Code Space agent route delegation', () => {
  it('is a thin transport adapter and delegates orchestration to AgentRuntime', async () => {
    const source = await readFile(path.join(process.cwd(), 'app/api/code-space/agent/route.ts'), 'utf8');

    expect(source).toContain('new AgentRuntime()');
    expect(source).not.toContain('function detectValidationCommands');
    expect(source).not.toContain('function runValidationCommands');
    expect(source).not.toContain('function applyGeneratedPatch');
    expect(source).not.toContain('function proposeAutonomousPatch');
    expect(source).not.toContain('function expandContextWithCodeIntelligence');
  });
});
