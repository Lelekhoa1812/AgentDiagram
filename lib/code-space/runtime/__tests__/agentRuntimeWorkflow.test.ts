import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime, runtimeSourceFingerprintForTests } from '../agentRuntime';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('AgentRuntime workflow contracts', () => {
  it('keeps ask mode read-only and avoids dummy internal workflow language', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-ask-'));
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(tmpDir, 'src.ts'), 'export const answer = 42;\n', 'utf8');
    const before = await readFile(path.join(tmpDir, 'src.ts'), 'utf8');
    const events: AgentSSEEvent[] = [];

    await new AgentRuntime().run(
      {
        sessionId: 's1',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [{ role: 'user', content: 'What does answer do in src.ts?' }],
        mode: 'ask',
        model: 'test',
        providerId: 'openai',
        apiKey: '',
        openTabs: [],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [{ kind: 'file', relativePath: 'src.ts', displayName: 'src.ts' }],
      },
      (event) => {
        events.push(event);
      },
    );

    expect(await readFile(path.join(tmpDir, 'src.ts'), 'utf8')).toBe(before);
    expect(events.some((event) => event.type === 'diff_proposed' || event.type === 'file_applied')).toBe(false);
    const final = events.find((event) => event.type === 'agent_done');
    expect(final?.summary).not.toMatch(/Reviewed \d+ files|Visible workflow|Repository map|Validation available/i);
  });

  it('writes plan artifacts with the required enterprise handoff sections', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-agent-runtime-plan-'));
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }), 'utf8');
    await writeFile(path.join(tmpDir, 'app.ts'), 'export function run() { return true; }\n', 'utf8');
    const events: AgentSSEEvent[] = [];

    await new AgentRuntime().run(
      {
        sessionId: 'session-plan',
        projectRoot: tmpDir,
        projectName: 'demo',
        messages: [{ role: 'user', content: 'Plan a runtime refactor for app.ts' }],
        mode: 'plan',
        model: 'test',
        providerId: 'openai',
        apiKey: '',
        openTabs: ['app.ts'],
        toolBudget: 20,
        autonomy: 'auto_safe_tools',
        attachments: [],
      },
      (event) => {
        events.push(event);
      },
    );

    const planEvent = events.find((event) => event.type === 'plan_markdown_created');
    expect(planEvent?.filePath).toBe('.agent/plans/session-plan.md');
    expect(planEvent?.content).toContain('## Summary');
    expect(planEvent?.content).toContain('## Key Changes');
    expect(planEvent?.content).toContain('## Evidence Reviewed');
    expect(planEvent?.content).toContain('## Test Plans');
    expect(planEvent?.content).toContain('## Assumptions');
    expect(planEvent?.content).not.toMatch(/\bMCQ\s*\d+\s*:/i);
  });

  it('exposes a stable runtime fingerprint for route delegation tests', () => {
    expect(runtimeSourceFingerprintForTests()).toHaveLength(64);
  });
});
