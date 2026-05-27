import { describe, expect, it } from 'vitest';
import { buildClarifyingQuestions, buildPlan } from '../route';

describe('Code Space agent route mode helpers', () => {
  it('builds a read-only Ask plan', () => {
    expect(buildPlan('ask', ['repository_explanation'], 'explain this repo')).toEqual([
      'Classify read-only request',
      'Autonomously discover relevant context',
      'Answer with evidence and no file mutation',
    ]);
  });

  it('builds a scan-first Plan plan and asks MCQ clarifiers for ambiguous prompts', () => {
    const plan = buildPlan('plan', ['feature_build'], 'make this better');
    expect(plan).toEqual([
      'Classify implementation intent',
      'Autonomously discover files, folders, and validation surfaces',
      'Write a reusable planning artifact',
    ]);

    const questions = buildClarifyingQuestions();
    expect(questions).toEqual([]);
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
});
