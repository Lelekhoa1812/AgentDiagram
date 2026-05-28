import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import {
  formatPlanArtifactSectionHeading,
  PLAN_ARTIFACT_SECTION_TITLES,
} from '@/lib/code-space/agent/planTemplate';
import type { ContextGraphFile, ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';

export interface WorkflowOutline {
  intentSummary: string;
  planItems: string[];
  clarifyingQuestions: CodeSpaceClarifyingQuestion[];
}

const REQUIRED_PLAN_SECTIONS = ['Summary', 'Key Changes', 'Test Plans', 'Assumptions'];
const MAX_PLAN_FILES = 12;

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function normalizePrompt(prompt: string, limit = 360): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, limit) || '(not provided)';
}

function planCandidateFiles(context: ContextGraphResult): ContextGraphFile[] {
  return context.files
    .filter((file) => !file.path.startsWith('.agent/plans/'))
    .sort((a, b) => {
      const explicitDelta = Number(b.reasons.includes('explicit_file')) - Number(a.reasons.includes('explicit_file'));
      return explicitDelta || b.score - a.score || a.path.localeCompare(b.path);
    })
    .slice(0, MAX_PLAN_FILES);
}

function filesByGroup(files: ContextGraphFile[]): Record<string, ContextGraphFile[]> {
  const groups: Record<string, ContextGraphFile[]> = {
    'Primary target files': [],
    'Call sites and runtime entrypoints': [],
    'Configuration and startup': [],
    'Tests and validation': [],
    'Supporting files': [],
  };

  for (const file of files) {
    if (file.reasons.includes('explicit_file')) groups['Primary target files']?.push(file);
    else if (/route|controller|handler|main|app\.|server|runtime|chatbot|retrieval|database/i.test(file.path)) groups['Call sites and runtime entrypoints']?.push(file);
    else if (/config|settings|env|package\.json|pyproject|requirements|docker|compose/i.test(file.path)) groups['Configuration and startup']?.push(file);
    else if (/test|spec|pytest|vitest|playwright/i.test(file.path)) groups['Tests and validation']?.push(file);
    else groups['Supporting files']?.push(file);
  }

  return groups;
}

function summarizeAction(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (/disable|turn off|remove|bypass/.test(lower)) return 'Disable or bypass only the requested functionality while keeping the rest of the application path intact.';
  if (/fix|bug|error|traceback|exception|fail/.test(lower)) return 'Fix the reported failure at the smallest responsible implementation surface.';
  if (/refactor|cleanup|simplify/.test(lower)) return 'Refactor the relevant implementation path without changing unrelated behavior.';
  if (/add|implement|support|enable/.test(lower)) return 'Implement the requested behavior in the smallest coherent set of files.';
  return 'Apply the requested change using the selected repository evidence and avoid unrelated architecture work.';
}

function buildFilePlan(file: ContextGraphFile, prompt: string): string {
  const lowerPath = file.path.toLowerCase();
  const lowerPrompt = prompt.toLowerCase();
  if (/database|mongo|mongodb/.test(lowerPath) && /disable|mongo|mongodb|database/.test(lowerPrompt)) {
    return 'inspect startup/initialization paths and remove, bypass, or guard the database connection without breaking imports.';
  }
  if (/retrieval|rag|rerank|vector|faiss|search/.test(lowerPath) && /rag|retriev|clinical|passage|vector|faiss/.test(lowerPrompt)) {
    return 'disable clinical passage retrieval/RAG calls and preserve a direct non-RAG response path.';
  }
  if (/chatbot|route|app|main/.test(lowerPath)) {
    return 'update the call path so the requested behavior is actually used at runtime.';
  }
  if (/config|settings|env/.test(lowerPath)) {
    return 'check whether a flag or setting is the safest way to disable the feature.';
  }
  if (/test|spec/.test(lowerPath)) {
    return 'add or update coverage for the changed runtime behavior.';
  }
  return 'review only if it is required by imports, call sites, or validation failures.';
}

function validationLines(validationCommands: TerminalCommand[]): string[] {
  if (!validationCommands.length) return ['- Manual review — no project-specific validation command was detected; do not claim verification until a compile/test command is run.'];
  return validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} — ${command.reason}`);
}

function evidenceLines(files: ContextGraphFile[]): string[] {
  if (!files.length) return ['- No target files were selected. Re-run context discovery before implementing.'];
  const groups = filesByGroup(files);
  return Object.entries(groups).flatMap(([group, groupFiles]) => {
    if (!groupFiles.length) return [];
    return [
      `- ${group}:`,
      ...groupFiles.map((file) => `  - ${file.path}: ${file.summary}`),
    ];
  });
}

export class PlanningEngine {
  buildTodos(mode: 'ask' | 'plan' | 'code', context: ContextGraphResult): string[] {
    if (mode === 'ask') return ['Gather repository evidence for the question', 'Trace relevant references and tests', 'Answer directly from evidence'];
    const surfaces = planCandidateFiles(context).slice(0, 4).map((file) => file.path);
    if (mode === 'plan') {
      return [
        surfaces.length ? `Ground the plan in ${formatList(surfaces.map((file) => `\`${file}\``))}` : 'Ground the plan in selected repository evidence',
        'Identify the minimal implementation path',
        'Write a task-specific plan artifact',
        'Define validation gates',
      ];
    }
    return [
      'Load target files and related call sites',
      surfaces.length ? `Prepare the patch across ${formatList(surfaces.map((file) => `\`${file}\``))}` : 'Prepare the smallest coherent patch',
      'Run validation',
      'Repair failures or mark exact needs_review blockers',
    ];
  }

  buildOutline(mode: 'ask' | 'plan' | 'code', prompt: string, context: ContextGraphResult): WorkflowOutline {
    return {
      intentSummary: normalizePrompt(prompt, 320),
      planItems: this.buildTodos(mode, context).slice(0, 6),
      clarifyingQuestions: [],
    };
  }

  buildPlanArtifact({
    projectName,
    prompt,
    context,
    validationCommands,
  }: {
    projectName: string;
    prompt: string;
    context: ContextGraphResult;
    validationCommands: TerminalCommand[];
  }): string {
    const selectedFiles = planCandidateFiles(context);
    const topFiles = selectedFiles.slice(0, 6).map((file) => `\`${file.path}\``);
    const action = summarizeAction(prompt);
    const filePlans = selectedFiles.map((file) => `- ${file.path}: ${buildFilePlan(file, prompt)}`);

    return [
      `# Code Space Plan — ${projectName}`,
      '',
      '## Summary',
      `- Request: ${normalizePrompt(prompt)}`,
      `- Implementation goal: ${action}`,
      topFiles.length ? `- Primary files to inspect/change: ${formatList(topFiles)}.` : '- Primary files to inspect/change: none selected yet; rerun context discovery before editing.',
      '- Non-goal: do not change Code Space runtime, UI patch-review workflows, or prior `.agent/plans` artifacts unless the user explicitly asks for that project.',
      '',
      '## Key Changes',
      '- Re-open the primary target files from disk before editing; do not rely on this plan artifact as source code evidence.',
      ...filePlans,
      '- Keep the patch narrow: modify only files required by the user request, direct imports/call sites, configuration, and tests.',
      '- If the selected evidence does not contain the necessary target file, recall or rescore repository files and regenerate the plan before returning needs_review.',
      '',
      '## Evidence Reviewed',
      ...evidenceLines(selectedFiles),
      '',
      '## Test Plans',
      ...validationLines(validationCommands),
      '- After implementation, rerun the most specific failing validation command before broader gates.',
      '- If validation cannot run because tooling is unavailable, record the exact command and failure output rather than marking the work verified.',
      '',
      '## Assumptions',
      '- The plan is scoped to the user request above, not to improving the Code Space agent itself.',
      '- Existing public API behavior should remain unchanged except for the requested feature disable/fix path.',
      '- Database, retrieval, model-loading, and route startup changes should be guarded so imports and application startup still succeed.',
      '- Stop only with an exact blocker: missing file, unsafe operation, provider/tool failure, or validation failure after bounded repair.',
      '',
    ].join('\n');
  }

  async writePlanArtifact(root: string, sessionId: string, projectName: string, prompt: string, context: ContextGraphResult, validationCommands: TerminalCommand[]): Promise<{ filePath: string; content: string }> {
    const filePath = `.agent/plans/${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.md`;
    const content = this.buildPlanArtifact({ projectName, prompt, context, validationCommands });
    await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await fs.writeFile(path.join(root, filePath), content, 'utf8');
    return { filePath, content };
  }
}

export function planContainsRequiredSections(content: string): boolean {
  return REQUIRED_PLAN_SECTIONS.every((section) => content.includes(formatPlanArtifactSectionHeading(section)) || content.includes(`## ${section}`));
}

export { REQUIRED_PLAN_SECTIONS, PLAN_ARTIFACT_SECTION_TITLES };
