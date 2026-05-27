import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClarifyingQuestions, buildPlan, writePlanMarkdown } from '../route';

describe('Code Space agent route mode helpers', () => {
  it('builds a read-only Ask plan', () => {
    expect(buildPlan('ask', ['repository_explanation'], 'explain this repo')).toEqual([
      'Classify the request and keep this run read-only.',
      'Search and read the most relevant project files.',
      'Answer with file-grounded citations and note that no edits were made.',
    ]);
  });

  it('builds a markdown-producing Plan plan and asks MCQ clarifiers for ambiguous prompts', () => {
    expect(buildPlan('plan', ['feature_build'], 'make this better')[2]).toContain('editable markdown plan');

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
});
