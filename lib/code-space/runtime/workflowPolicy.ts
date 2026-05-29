import type { ContextGraphFile, ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';

export type WorkflowMode = 'ask' | 'plan' | 'code';
export type ContextSufficiencyStatus = 'ready' | 'needs_recall' | 'needs_review';

export interface ContextSufficiencyReport {
  status: ContextSufficiencyStatus;
  confidence: ContextGraphResult['confidence'];
  score: number;
  blockers: string[];
  warnings: string[];
  requiredEvidence: string[];
  recommendedRecall: string[];
}

export const V32_WORKFLOW_DOD = [
  'Repository rules, explicit mentions, open tabs, current editor files, and plan artifacts were inspected or reported as unreadable.',
  'The evidence pack contains target files, neighboring call sites/importers, validation/config surfaces, and relevant tests/docs for non-trivial code work.',
  'The plan states objective, scope, non-goals, assumptions, evidence, diagnosis checks, milestones, file-level changes, validation, repair, safety, DoD, and final response format.',
  'Code mode reads before edit, recalls missing context before completion, edits only required files, validates, repairs bounded failures, and reports exact blockers.',
  'No implementation run claims success with zero changed files unless the task is read-only or the runtime has exhausted recall and reported needs_review.',
  'Autonomy and execution-policy behavior is visible, reversible, and aligned with checkpoints and review state.',
  'Validation outcomes are reported honestly with commands run, skipped commands, and unresolved issues.',
] as const;

const WORKFLOW_CORE_PHASES = [
  'resolve intent and risk',
  'collect repository evidence',
  'score context sufficiency',
  'synthesise a bounded plan',
  'implement with read-before-edit discipline',
  'validate, repair, and produce a verdict',
] as const;

function hasReason(file: ContextGraphFile, reason: string): boolean {
  return file.reasons.some((item) => item === reason);
}

function hasPath(files: ContextGraphFile[], pattern: RegExp): boolean {
  return files.some((file) => pattern.test(file.path));
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export function assessContextSufficiency(input: {
  mode: WorkflowMode;
  prompt: string;
  context: ContextGraphResult;
  buildPlanPath?: string | null;
  validationCommands?: TerminalCommand[];
}): ContextSufficiencyReport {
  const { mode, prompt, context, buildPlanPath } = input;
  const lowerPrompt = prompt.toLowerCase();
  const files = context.files;
  const requiredEvidence: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [...context.missingContextWarnings];
  const recommendedRecall: string[] = [...context.omittedRelevantCandidates.slice(0, 8)];

  const hasExplicit = files.some((file) => hasReason(file, 'explicit_file') || hasReason(file, 'explicit_folder') || hasReason(file, 'open_tab') || hasReason(file, 'current_editor'));
  const hasRuntimeOrTarget = hasPath(files, /(components|app|lib|src|server|api|runtime|route|controller|service|store|workspace|panel|agent|planner|context|tool|validation|response)/i);
  const hasValidationSurface = hasPath(files, /(package\.json|tsconfig|vitest|playwright|pytest|pyproject|requirements|go\.mod|cargo\.toml|test|spec|__tests__)/i);
  const hasTestOrDoc = hasPath(files, /(test|spec|__tests__|docs?|readme|agents\.md|instructions\.md|project[-_]?rules)/i);
  const hasCallSite = files.some((file) => hasReason(file, 'direct_import_dependency') || hasReason(file, 'reverse_importer') || /route|runtime|workspace|panel|handler|controller|service|store/i.test(file.path));
  const codeLikeTask = mode === 'code' || /\b(build|implement|fix|refactor|migrate|upgrade|wire|change|update|repair)\b/i.test(prompt);
  const planningTask = mode === 'plan' || /\b(plan|strategy|workflow|architecture|design)\b/i.test(prompt);

  if (!files.length) {
    blockers.push('No readable repository files were selected. Run repository mapping and context recall before continuing.');
  }
  if (buildPlanPath && !context.selectedFiles.includes(buildPlanPath)) {
    blockers.push(`Referenced plan artifact was not included in evidence: ${buildPlanPath}`);
    recommendedRecall.unshift(buildPlanPath);
  }
  if (codeLikeTask && !hasRuntimeOrTarget) {
    blockers.push('No target/runtime implementation file is present in the evidence pack.');
    requiredEvidence.push('target implementation file');
  }
  if (codeLikeTask && !hasCallSite) {
    warnings.push('No adjacent call site, importer, route, or runtime entrypoint was found yet.');
    requiredEvidence.push('adjacent call site or importer');
  }
  if ((codeLikeTask || planningTask) && !hasValidationSurface) {
    warnings.push('No validation/config/test surface was included in evidence.');
    requiredEvidence.push('validation, config, or focused test surface');
  }
  if (planningTask && !hasTestOrDoc) {
    warnings.push('No test, docs, or repository-rule surface was selected for planning quality control.');
    requiredEvidence.push('test, docs, or repository-rule surface');
  }
  if (context.confidence === 'low') {
    blockers.push('Context graph confidence is low. Recall more files before producing a final plan or implementation verdict.');
  }
  for (const file of files.filter((item) => item.truncated && (hasReason(item, 'explicit_file') || hasReason(item, 'open_tab') || hasReason(item, 'plan_artifact')))) {
    warnings.push(`High-priority evidence was truncated: ${file.path}`);
    recommendedRecall.unshift(file.path);
  }
  if (!hasExplicit && /(this file|current file|open file|attached|mentioned|@)/i.test(prompt)) {
    warnings.push('The prompt implies an explicit target, but no explicit file/folder/open-tab evidence was selected.');
  }

  const score = Math.max(0, Math.min(100,
    (files.length >= 8 ? 24 : files.length * 3) +
      (context.confidence === 'high' ? 22 : context.confidence === 'medium' ? 12 : 0) +
      (hasRuntimeOrTarget ? 16 : 0) +
      (hasCallSite ? 14 : 0) +
      (hasValidationSurface ? 12 : 0) +
      (hasTestOrDoc ? 8 : 0) +
      (hasExplicit ? 4 : 0) -
      blockers.length * 20,
  ));

  const status: ContextSufficiencyStatus = blockers.length
    ? 'needs_review'
    : warnings.length || score < (mode === 'ask' ? 35 : 60)
      ? 'needs_recall'
      : 'ready';

  return {
    status,
    confidence: context.confidence,
    score,
    blockers: unique(blockers),
    warnings: unique(warnings),
    requiredEvidence: unique(requiredEvidence),
    recommendedRecall: unique(recommendedRecall).slice(0, 12),
  };
}

export function formatContextSufficiencyMarkdown(report: ContextSufficiencyReport): string {
  const lines = [
    `- Status: ${report.status}`,
    `- Confidence: ${report.confidence}`,
    `- Score: ${report.score}/100`,
  ];
  if (report.blockers.length) lines.push('- Blockers:', ...report.blockers.map((item) => `  - ${item}`));
  if (report.warnings.length) lines.push('- Warnings:', ...report.warnings.map((item) => `  - ${item}`));
  if (report.requiredEvidence.length) lines.push('- Evidence still expected:', ...report.requiredEvidence.map((item) => `  - ${item}`));
  if (report.recommendedRecall.length) lines.push('- Recommended recall targets:', ...report.recommendedRecall.map((item) => `  - ${item}`));
  return lines.join('\n');
}

export function buildWorkflowKernelPrompt(mode: WorkflowMode): string {
  return [
    `v3.2 workflow kernel for ${mode.toUpperCase()} mode`,
    '',
    'Operate as an evidence-first coding agent. Do not treat the first context bundle as final when the task needs more repository evidence.',
    'Core phases:',
    ...WORKFLOW_CORE_PHASES.map((phase, index) => `${index + 1}. ${phase}.`),
    '',
    'Hard gates:',
    '- Read repository evidence before planning or editing.',
    '- If context is missing, recall more files, imports, tests, docs, configs, or runtime surfaces before finalising.',
    '- Prefer the smallest coherent change; do not invent services, dependencies, databases, queues, or broad rewrites without evidence.',
    '- Validation failures must be inspected and repaired only within the smallest affected area.',
    '- The final verdict must clearly separate applied changes, proposed changes, skipped validation, and remaining blockers.',
  ].join('\n');
}

export function buildRecallDirective(report: ContextSufficiencyReport): string {
  return [
    'Context sufficiency gate did not pass.',
    formatContextSufficiencyMarkdown(report),
    '',
    'Before completing, use repository tools to recall the missing evidence above. Search imports, tests, docs, configs, routes, and neighboring runtime surfaces. Only return needs_review if the exact required evidence cannot be read or a safety gate blocks the task.',
  ].join('\n');
}

export function formatWorkflowDodMarkdown(): string {
  return V32_WORKFLOW_DOD.map((item, index) => `${index + 1}. ${item}`).join('\n');
}
