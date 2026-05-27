import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildClarifyingQuestions,
  buildPlan,
  buildPlanImplementationPrompt,
  buildStrategyDocument,
  collectProjectContext,
  extractBuildPlanPath,
} from '../route';

describe('Code Space agent route mode helpers', () => {
  it('builds a read-only Ask plan', () => {
    expect(buildPlan('ask', ['repository_explanation'], 'explain this repo')).toEqual([
      'Gather comprehensive repository evidence',
      'Trace relevant symbols and references',
      'Answer directly from inspected context',
    ]);
  });

  it('builds a deep Plan workflow and asks architecture/design MCQ clarifiers for ambiguous implementation prompts', () => {
    const plan = buildPlan('plan', ['feature_build'], 'make this better');
    expect(plan).toEqual([
      'Gather comprehensive repository evidence',
      'Expand related files with symbol and reference context',
      'Ask MCQ decisions only after inspected evidence reveals ambiguity',
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
    const questionIds = questions.map((question) => question.id);
    expect(questionIds).not.toContain('planning-depth');
    expect(questionIds).not.toContain('build-execution');
    expect(questionIds).not.toContain('agent-review-loop');
    expect(questionIds).not.toContain('validation-gate');
    expect(questionIds).toContain('application-architecture');
    expect(questionIds).toContain('service-boundary');
    expect(questions.map((question) => question.question).join('\n')).toMatch(/monolith|micro-services|dedicated service|existing service/i);
  });

  it('does not ask planning MCQs before repository evidence has been inspected', () => {
    expect(buildClarifyingQuestions('build a better planning workflow', ['feature_build'])).toEqual([]);
    expect(
      buildClarifyingQuestions('build a better planning workflow', ['feature_build'], {
        filesConsidered: 12,
        terms: [],
        omittedRelevantFiles: [],
        files: [],
      }),
    ).toEqual([]);
  });

  it('expands context with local imports and importers so planning starts from code evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'code-space-context-'));
    try {
      await writeFile(path.join(root, 'feature.ts'), "import { helper } from './helper';\nexport function runFeature() { return helper(); }\n");
      await writeFile(path.join(root, 'helper.ts'), 'export function helper() { return "ok"; }\n');
      await writeFile(path.join(root, 'caller.ts'), "import { runFeature } from './feature';\nexport const value = runFeature();\n");

      const context = await collectProjectContext(root, 'change feature.ts runFeature behavior', [], []);
      const paths = context.files.map((file) => file.path);

      expect(paths).toContain('feature.ts');
      expect(paths).toContain('helper.ts');
      expect(paths).toContain('caller.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Code mode implementation-oriented without clarifying questions', () => {
    expect(buildPlan('code', ['bug_fix'], 'fix the failing build and run tests')).toEqual([
      'Gather comprehensive repository evidence',
      'Inspect relevant source and tests',
      'Apply the smallest safe change',
      'Report changed files and validation',
    ]);
    expect(buildClarifyingQuestions()).toEqual([]);
  });

  it('treats refactor tasks as move-first workflows before updating imports and validation', () => {
    const plan = buildPlan('code', ['refactor'], 'rename the widgets folder and update imports');

    expect(plan).toEqual([
      'Gather comprehensive repository evidence',
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

  it('keeps MCQ question text and option menus out of the plan artifact', () => {
    const content = buildStrategyDocument({
      projectName: 'demo',
      prompt: 'improve planning',
      context: {
        filesConsidered: 1,
        terms: [],
        omittedRelevantFiles: [],
        files: [
          {
            path: 'app/api/code-space/agent/route.ts',
            content: 'export function buildPlan() {}',
            truncated: false,
            lineCount: 1,
            score: 10,
            reasons: ['test'],
            summary: 'Agent route',
            symbols: ['buildPlan'],
          },
        ],
      },
      validation: {
        commands: [{ kind: 'test', command: 'npm run test', reason: 'Automated tests are available.' }],
        packageManager: 'npm',
      },
      codeMode: false,
      answers: [
        {
          question: 'Should this be implemented as a cohesive monolith/module inside the existing app, or split into micro-services?',
          answer: 'Modular monolith inside the existing app (Recommended) — reuse current routing.',
        },
      ],
    });

    expect(content).not.toMatch(/\bMCQ\s*\d+\s*:/i);
    expect(content).not.toMatch(/Should this be implemented as a cohesive monolith/i);
    expect(content).not.toMatch(/^\s*[-*]\s*[A-E]\)\s+/im);
    expect(content).toContain('Sidebar-selected planning inputs');
    expect(content).toContain('Modular monolith inside the existing app');
  });
});
