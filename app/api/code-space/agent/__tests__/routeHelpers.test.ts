import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClarifyingQuestions, buildGroundedResponse, buildPlan, writePlanMarkdown } from '../route';

describe('Code Space agent route mode helpers', () => {
  it('builds a read-only Ask plan', () => {
    expect(buildPlan('ask', ['repository_explanation'], 'explain this repo')).toEqual([
      'Classify the request and keep this run read-only.',
      'Search and read the most relevant project files.',
      'Answer with file-grounded citations and note that no edits were made.',
    ]);
  });

  it('builds a scan-first Plan plan and asks MCQ clarifiers for ambiguous prompts', () => {
    const plan = buildPlan('plan', ['feature_build'], 'make this better');
    expect(plan[0]).toContain('Scan');
    expect(plan[1]).toContain('read');
    expect(plan[2]).toContain('final planning doc');

    const questions = buildClarifyingQuestions('plan', 'make this better', ['feature_build']);
    expect(questions).toHaveLength(2);
    expect(questions[0]?.choices).toContain('Smallest safe change');
  });

  it('keeps Code mode implementation-oriented without clarifying questions', () => {
    expect(buildPlan('code', ['bug_fix'], 'fix the failing build and run tests')[2]).toContain('approval-gated patch path');
    expect(buildClarifyingQuestions('code', 'fix the failing build and run tests', ['bug_fix'])).toEqual([]);
  });

  it('writes Plan mode markdown under .codex/plans', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentdiagram-plan-'));
    try {
      const result = await writePlanMarkdown({
        root,
        sessionId: 'session:abc/123',
        projectName: 'Demo',
        prompt: 'Plan a safer implementation',
        intents: ['feature_build'],
        contextFiles: [{ path: 'src/App.tsx', content: 'export default function App() {}', truncated: false }],
        plan: ['Review current UI', 'Write tests', 'Implement the feature'],
        clarifyingQuestions: [
          {
            id: 'scope',
            question: 'What scope should this plan use?',
            choices: ['Smallest safe change', 'Production-ready feature pass'],
          },
        ],
      });

      expect(result.filePath).toMatch(/^\.codex\/plans\/session-abc-123\.md$/);
      const content = await readFile(path.join(root, result.filePath), 'utf8');
      expect(content).toContain('# Demo Agent Plan');
      expect(content).toContain('Other. Replace this line with a custom answer.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Plan mode chat concise and defers the full planning doc to the final artifact', () => {
    const answer = buildGroundedResponse({
      mode: 'plan',
      projectName: 'Demo',
      prompt: 'Improve this workflow',
      intents: ['feature_build'],
      contextFiles: [{ path: 'src/App.tsx', content: 'export default function App() {}', truncated: false }],
      plan: ['Scan the repo', 'Ask targeted MCQs', 'Write the final planning doc'],
      planMarkdownPath: '.codex/plans/session.md',
      planMarkdownContent: '# Demo Agent Plan',
      clarifyingQuestions: [{ id: 'scope', question: 'What scope?', choices: ['Smallest safe change'] }],
    });

    expect(answer).toContain('Full planning doc is ready at .codex/plans/session.md');
    expect(answer).not.toContain('Visible plan:');
    expect(answer).not.toContain('1. Scan the repo');
    expect(answer).toContain('Answer the sidebar clarifying questions');
  });
});
