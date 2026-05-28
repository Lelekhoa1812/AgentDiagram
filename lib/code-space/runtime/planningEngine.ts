import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import {
  formatPlanArtifactSectionHeading,
  PLAN_ARTIFACT_SECTION_TITLES,
} from '@/lib/code-space/agent/planTemplate';
import type { ContextGraphResult } from './contextGraphEngine';
import type { TerminalCommand } from './terminalPolicy';

export interface WorkflowOutline {
  intentSummary: string;
  planItems: string[];
  clarifyingQuestions: CodeSpaceClarifyingQuestion[];
}

const REQUIRED_PLAN_SECTIONS = [
  'Request Understanding',
  'Repository Evidence Reviewed',
  'Current Workflow Diagnosis',
  'Target Architecture',
  'Implementation Sequence',
  'File-Level Change Plan',
  'Runtime State Machine',
  'User-Facing Response Policy',
  'Validation and Test Plan',
  'Risks and Rollback',
  'Definition of Done',
  'Build Instructions',
];

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function filesByGroup(context: ContextGraphResult): Record<string, Array<{ path: string; summary: string }>> {
  const groups: Record<string, Array<{ path: string; summary: string }>> = {
    'UI surfaces': [],
    'API route/runtime': [],
    'state/session/store': [],
    'patch/checkpoint': [],
    'validation/testing': [],
    'docs/specs/plans': [],
  };
  for (const file of context.files) {
    const entry = { path: file.path, summary: file.summary };
    if (/components\/code-space|app\/code-space/.test(file.path)) groups['UI surfaces']?.push(entry);
    else if (/app\/api\/code-space|runtime|agent/.test(file.path)) groups['API route/runtime']?.push(entry);
    else if (/store|session|project|event/.test(file.path)) groups['state/session/store']?.push(entry);
    else if (/patch|checkpoint|diff/.test(file.path)) groups['patch/checkpoint']?.push(entry);
    else if (/test|spec|validation|package\.json|vitest|playwright/.test(file.path)) groups['validation/testing']?.push(entry);
    else if (/docs|README|\.agent\/plans|AGENTS|CLAUDE|\.cursorrules/.test(file.path)) groups['docs/specs/plans']?.push(entry);
  }
  return groups;
}

export class PlanningEngine {
  buildTodos(mode: 'ask' | 'plan' | 'code', context: ContextGraphResult): string[] {
    if (mode === 'ask') return ['Gather repository evidence for the question', 'Trace relevant references and tests', 'Answer directly from evidence'];
    if (mode === 'plan') return ['Map Code Space runtime entrypoints', 'Diagnose patch lifecycle and validation seams', 'Write implementation plan artifact', 'Define validation gates'];
    const surfaces = context.files.slice(0, 4).map((file) => file.path);
    return [
      'Load plan artifact and target files',
      surfaces.length ? `Consolidate implementation across ${formatList(surfaces.map((file) => `\`${file}\``))}` : 'Consolidate the relevant runtime path',
      'Prepare reviewable patch',
      'Run validation',
      'Repair failures or mark needs_review',
    ];
  }

  buildOutline(mode: 'ask' | 'plan' | 'code', prompt: string, context: ContextGraphResult): WorkflowOutline {
    return {
      intentSummary: prompt.trim().replace(/\s+/g, ' ').slice(0, 320),
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
    const groups = filesByGroup(context);
    const validation = validationCommands.length
      ? validationCommands.map((command) => `- ${[command.command, ...command.args].join(' ')} — ${command.reason}`)
      : ['- Manual review — no project-specific validation command was detected.'];
    const fileLevel = context.files
      .slice(0, 40)
      .map((file) => `- ${file.path}: preserve/reuse this surface as indicated by ${file.reasons.join(', ')}; ${file.summary}`);

    // Motivation vs Logic: Plan mode is an artifact handoff, not chat prose. The deterministic plan keeps
    // Code mode executable even when the model provider is unavailable or a structured planner times out.
    return [
      `# Code Space Plan — ${projectName}`,
      '',
      '## Request Understanding',
      `The request is to upgrade the Code Space coding agent into one coherent, evidence-led workflow rather than improving only UI copy. User prompt: ${prompt.trim().replace(/\s+/g, ' ').slice(0, 240) || '(not provided)'}. The work should verify and remove competing runtime paths, make repository context and validation shared, and turn patches into the true review/apply boundary. The implementation should preserve existing Code Space browsing, editor, file mentions, plan links, patch review, and validation surfaces while strengthening their contracts.`,
      '',
      '## Repository Evidence Reviewed',
      ...Object.entries(groups).flatMap(([group, files]) => [
        `- ${group}:`,
        ...(files.length ? files.map((file) => `  - ${file.path}: ${file.summary}`) : ['  - No high-signal file selected in this group.']),
      ]),
      '',
      '## Current Workflow Diagnosis',
      '- The API route has historically owned rich orchestration logic while RunManager used a separate AgentOrchestrator path, producing inconsistent behavior by entrypoint.',
      '- Code mode must avoid applying files before `diff_proposed`; reviewable diffs need to become the mutation boundary.',
      '- Patch preview, stored patch approval, checkpointing, and write application need one shared server-side path with stale-content checks.',
      '- Context discovery, validation detection, response formatting, and todo/status updates should be shared runtime modules instead of route-local helpers.',
      '- UI compatibility can keep old dummy-message cleanup, but new responses should be concise and evidence-backed.',
      '',
      '## Target Architecture',
      '- `agentRuntime.ts`: single run coordinator used by the route and RunManager/AgentOrchestrator.',
      '- `runState.ts`: formal phase/status model and phase event transitions.',
      '- `contextGraphEngine.ts`, `repoMap.ts`, `symbolScanner.ts`, `dependencyTrace.ts`: shared repository intelligence.',
      '- `planningEngine.ts`: evidence-led todos and plan artifacts.',
      '- `patchReview.ts`, `patchStore.ts`, `patchApply.ts`: unified patch proposal, persistence, review, checkpoint, and apply lifecycle.',
      '- `terminalPolicy.ts`, `terminalRunner.ts`, `validationRunner.ts`: shared validation detection and safe execution.',
      '- `responsePolicy.ts`: centralized clean chat summaries.',
      '',
      '## Implementation Sequence',
      '1. Runtime unification: edit `app/api/code-space/agent/route.ts`, `lib/code-space/runtime/agentRuntime.ts`, `lib/code-space/runtime/agentOrchestrator.ts`, and `lib/code-space/runtime/runManager.ts`; acceptance is both entrypoints using AgentRuntime; validate with route/source tests and typecheck.',
      '2. Context graph and repository intelligence: edit context/repo/symbol/dependency modules; acceptance is scored @File/@Folder/open tab/plan/import/reverse/test/config evidence; validate with unit tests.',
      '3. Plan mode upgrade: edit `planningEngine.ts` and plan response wiring; acceptance is required artifact sections and concise final chat; validate with plan artifact tests.',
      '4. Code mode patch lifecycle upgrade: edit patch modules and patch routes; acceptance is diff before mutation, stale/path rejection, checkpoint before write; validate with patch tests.',
      '5. Validation and repair loop upgrade: edit validation and terminal modules; acceptance is package scripts detected/executed and failures reported as needs_review after retry budget; validate with unit tests and npm scripts.',
      '6. UI/status/artifact upgrade: edit AgentPanel/workspace only as needed; acceptance is phase/todo/diff/validation visibility with clean chat.',
      '7. Tests and non-regression gates: add focused tests and run typecheck, lint, test, build.',
      '',
      '## File-Level Change Plan',
      ...fileLevel,
      '',
      '## Runtime State Machine',
      '- Phases: created, classifying, loading_project_rules, mapping_repository, gathering_context, tracing_dependencies, planning, awaiting_clarification, proposing_patch, awaiting_patch_review, applying_patch, validating, repairing, verified, needs_review, failed, cancelled.',
      '- Ask mode can reach verified without patch phases and must stay read-only.',
      '- Plan mode writes only `.agent/plans` unless explicitly instructed otherwise.',
      '- Code mode reaches verified only when validation passes; failed/skipped/unavailable validation reaches needs_review.',
      '',
      '## User-Facing Response Policy',
      '- Chat should answer directly, cite critical files only when useful, and avoid file counts/internal traces/raw JSON.',
      '- Trace/artifact panels carry structured events, tool calls, long logs, validation artifacts, and patch metadata.',
      '',
      '## Validation and Test Plan',
      ...validation,
      '- Focused unit tests for context scoring, plan artifact sections, patch rejection/application, validation detection, repair budget, response policy, and route delegation.',
      '',
      '## Risks and Rollback',
      '- Checkpoint rollback remains the safety net before file mutation.',
      '- Route refactor risk is controlled by moving behavior into AgentRuntime and testing that the route delegates.',
      '- Provider failure fallback should produce deterministic Ask/Plan responses and avoid unrelated Code patches.',
      '- Validation failure handling should stop as needs_review after bounded repair attempts.',
      '- Patch conflict handling should reject stale beforeContent and request regeneration.',
      '',
      '## Definition of Done',
      '- One runtime path is used by the route and RunManager.',
      '- `route.ts` is transport-only and delegates orchestration.',
      '- Ask is read-only, Plan writes executable artifacts, Code proposes reviewable diffs before mutation.',
      '- Patch apply rejects traversal/stale content and checkpoints before writes/deletes.',
      '- Validation runs when available and final status is honest.',
      '- UI/session state remains consistent and concise.',
      '',
      '## Build Instructions',
      '- Read this artifact first, then reopen target files from disk.',
      '- Compare assumptions against current code before editing.',
      '- Implement milestones in order and validate after major phases.',
      '- Stop as needs_review if validation cannot be safely fixed within the retry budget.',
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
