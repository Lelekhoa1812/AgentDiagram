import { describe, expect, it } from 'vitest';
import { buildClarifyingQuestions, buildPlan, buildPlanImplementationPrompt, extractBuildPlanPath } from '../route';

describe('Code Space agent route mode helpers', () => {
  it('builds a read-only Ask plan', () => {
    expect(buildPlan('ask', ['repository_explanation'], 'explain this repo')).toEqual([
      'Understand the question',
      'Gather relevant project context',
      'Answer directly',
    ]);
  });

  it('builds a deep Plan workflow and asks detailed MCQ clarifiers for ambiguous implementation prompts', () => {
    const plan = buildPlan('plan', ['feature_build'], 'make this better');
    expect(plan).toEqual([
      'Map request intent and planning depth',
      'Run multi-perspective repository exploration',
      'Ask detailed MCQ decisions when execution strategy is ambiguous',
      'Write an operator-ready implementation plan artifact',
    ]);

    const questions = buildClarifyingQuestions('comprehensively improve the agent planning and Build button workflow', ['feature_build'], {
      filesConsidered: 4,
      terms: [],
      omittedRelevantFiles: [],
      files: [
        {
          path: 'components/code-space/AgentPanel.tsx',
          content: '',
          truncated: false,
          lineCount: 1,
          score: 10,
          reasons: ['test'],
          summary: 'UI surface',
          symbols: [],
        },
        {
          path: 'app/api/code-space/agent/route.ts',
          content: '',
          truncated: false,
          lineCount: 1,
          score: 10,
          reasons: ['test'],
          summary: 'API surface',
          symbols: [],
        },
      ],
    });
    expect(questions.length).toBeGreaterThanOrEqual(4);
    expect(questions.map((question) => question.id)).toContain('planning-depth');
    expect(questions.map((question) => question.id)).toContain('build-execution');
  });

  it('keeps Code mode implementation-oriented without clarifying questions', () => {
    expect(buildPlan('code', ['bug_fix'], 'fix the failing build and run tests')).toEqual([
      'Understand the requested change',
      'Inspect relevant source and tests',
      'Apply the smallest safe change',
      'Report changed files and validation',
    ]);
    expect(buildClarifyingQuestions()).toEqual([]);
  });

  it('treats refactor tasks as move-first workflows before updating imports and validation', () => {
    const plan = buildPlan('code', ['refactor'], 'rename the widgets folder and update imports');

    expect(plan).toEqual([
      'Inspect the current file, imports, exports, and references',
      'Move or rename files on disk with shell-native operations instead of duplicating them',
      'Search and repair every affected importer, export, and test',
      'Run validation commands to confirm the refactor compiles cleanly',
    ]);
  });

  it('builds Code mode prompts that preserve and expose the selected plan path', () => {
    const prompt = buildPlanImplementationPrompt('.agent/plans/session-123.md');

    expect(prompt).toContain('Build from the approved plan at .agent/plans/session-123.md.');
    expect(prompt).toContain('Read that plan artifact first');
    expect(extractBuildPlanPath(prompt)).toBe('.agent/plans/session-123.md');
  });
});
