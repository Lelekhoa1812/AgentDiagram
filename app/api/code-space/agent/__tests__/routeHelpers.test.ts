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
import {
  buildCodeCompletionResponse,
  buildPlanCompletionResponse,
} from '@/lib/code-space/agent/runResponses';

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
    expect(content).toContain('## Request Summary');
    expect(content).not.toContain('\n## Request\n');
    expect(content).toContain('## Planning Decisions And Assumptions');
    expect(content).toContain('## Implementation Plan');
    expect(content).toContain('### Current system');
    expect(content).toContain('### Implementation plan');
    expect(content).toContain('## Validation and Testing');
    expect(content).toContain('## Risks and Acceptance Criteria');
    expect(content).toContain('Modular monolith inside the existing app');
    expect(content).toContain('Request routing is handled through API entrypoints');
    expect(content).not.toContain('## Context Already Inspected');
    expect(content).not.toContain('## Multi-Agent Exploration Brief');
    expect(content).not.toContain('## Current behavior inferred from the codebase');
    expect(content).not.toContain('## Execution Blueprint');
  });

  it('summarizes plan completion from the actual plan artifact instead of a canned template', () => {
    const response = buildPlanCompletionResponse({
      projectName: 'demo',
      planPath: '.agent/plans/session-123.md',
      planContent: [
        '# Code Space Plan',
        '## Implementation Plan',
        '- Update AgentPanel to show the live plan summary.',
        '- Derive the completion text from the artifact content.',
        '## Validation and Testing',
        '- cd backend && python -m compileall .',
        '- cd backend && python -m pytest',
      ].join('\n'),
      inspectedFiles: [
        { path: 'components/code-space/AgentPanel.tsx', summary: 'sidebar message surface' },
        { path: 'app/api/code-space/agent/route.ts', summary: 'agent response route' },
      ],
      validationCommands: [
        { command: 'cd backend && python -m compileall .', reason: 'Python syntax compilation is available.' },
        { command: 'cd backend && python -m pytest', reason: 'Python pytest validation appears available.' },
      ],
    });

    expect(response).toContain('Saved .agent/plans/session-123.md for demo.');
    expect(response).toContain('Plan focus: Update AgentPanel to show the live plan summary.; Derive the completion text from the artifact content.');
    expect(response).toContain('Validation: `cd backend && python -m compileall .`; `cd backend && python -m pytest`.');
    expect(response).not.toContain('Plan ready for');
    expect(response).not.toContain('Use Build when you are ready for Code mode to implement it.');
  });

  it('summarizes code completion from patch details and validation results without a fixed done template', () => {
    const response = buildCodeCompletionResponse({
      projectName: 'demo',
      files: [
        { path: 'components/code-space/AgentPanel.tsx', explanation: 'wire live completion copy into the sidebar' },
        { path: 'app/api/code-space/agent/route.ts', explanation: 'route plan/code summaries through shared helpers' },
      ],
      validationRuns: [
        { command: 'npm test', status: 'failed', output: '1 failing test' },
        { command: 'npm run lint', status: 'passed', output: '' },
      ],
      summary: 'Refined the sidebar completion message so it reflects the actual patch.',
      checkpointRef: 'snapshot:abc123',
    });

    expect(response).toContain('Refined the sidebar completion message so it reflects the actual patch.');
    expect(response).toContain('Updated 2 files in demo: `components/code-space/AgentPanel.tsx` and `app/api/code-space/agent/route.ts`.');
    expect(response).toContain('Validation still needs attention: `npm test`.');
    expect(response).toContain('Checkpoint created before the edit.');
    expect(response).not.toContain('Done — I updated');
  });
});
