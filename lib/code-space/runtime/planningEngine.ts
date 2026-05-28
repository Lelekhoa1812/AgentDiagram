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

    // Motivation vs Logic: Plan mode is an artifact handoff, not chat prose. The artifact should make
    // Code mode behave like a real coding agent loop: gather evidence, inspect/editor-review patches,
    // apply through a checkpointed boundary, validate, repair, and report exact blockers instead of
    // returning a dummy summary with no file changes.
    return [
      `# Code Space Plan — ${projectName}`,
      '',
      '## Request Understanding',
      `The request is to upgrade the Code Space coding agent into one coherent, evidence-led workflow rather than improving only UI copy. User prompt: ${prompt.trim().replace(/\s+/g, ' ').slice(0, 240) || '(not provided)'}. The work must preserve the user-facing review loop: generated patches remain pending, each changed file can be opened in the main editor as a red/green diff, and files are written only after the accept/apply boundary unless Auto is explicitly selected.`,
      '',
      '## Repository Evidence Reviewed',
      ...Object.entries(groups).flatMap(([group, files]) => [
        `- ${group}:`,
        ...(files.length ? files.map((file) => `  - ${file.path}: ${file.summary}`) : ['  - No high-signal file selected in this group.']),
      ]),
      '',
      '## Current Workflow Diagnosis',
      '- A coding-agent run is not complete when it only returns chat text or a sidebar-only patch; the workspace must expose the proposed change as an editor-level review artifact.',
      '- Pending patches need a stable file-review target before accept/reject. Existing-file diffs can use Monaco DiffEditor, while new/deleted/missing files need a virtual review tab that does not depend on reading the current file from disk.',
      '- Code mode must avoid dummy no-op completions: if the first evidence pack is insufficient, it should recall more files, inspect imports/tests/configs, and retry before marking needs_review.',
      '- Patch preview, stored patch approval, checkpointing, and write application need one shared server-side path with stale-content checks.',
      '- Context discovery, validation detection, response formatting, and todo/status updates should stay shared runtime modules instead of route-local helpers.',
      '- UI compatibility can keep old dummy-message cleanup, but new responses should be concise, evidence-backed, and tied to actual artifacts.',
      '',
      '## Target Architecture',
      '- `agentRuntime.ts`: single run coordinator used by the route and RunManager/AgentOrchestrator; follows an agent loop of think/inspect/edit/validate/repair/report.',
      '- `contextGraphEngine.ts`, `repoMap.ts`, `symbolScanner.ts`, `dependencyTrace.ts`: shared repository intelligence and recall expansion when context is missing.',
      '- `planningEngine.ts`: evidence-led todos, plan artifacts, strict Definition of Done, and build instructions.',
      '- `patchReview.ts`, `patchStore.ts`, `patchApply.ts`: unified patch proposal, persistence, review, checkpoint, and apply lifecycle.',
      '- `CodeSpaceWorkspace.tsx`: main editor review surface for pending/applied diffs, including virtual review tabs for new files.',
      '- `AgentPanel.tsx`: right-sidebar queue that opens the same editor-level review surface and keeps accept/reject controls visible.',
      '- `terminalPolicy.ts`, `terminalRunner.ts`, `validationRunner.ts`: shared validation detection and safe execution.',
      '- `responsePolicy.ts`: centralized clean chat summaries that cannot claim completion without filesChanged, validation, or exact blockers.',
      '',
      '## Implementation Sequence',
      '1. Runtime diagnosis: trace the agent request from AgentPanel submit to AgentRuntime, patch proposal, sidebar rendering, editor opening, accept/reject, patch apply, validation, and final response.',
      '2. Editor review contract: make pending diff opening explicit; acceptance is clicking any changed file opens Monaco DiffEditor with red/green content before accept/reject.',
      '3. Virtual diff support: support added/deleted/missing-file patches without requiring a successful disk read before the diff tab appears.',
      '4. No-op prevention: Code mode must recall additional context and retry before returning filesChanged=[]; empty patch runs must finish as needs_review with exact missing context or model-output blockers.',
      '5. Validation and repair loop: run detected checks, inspect failures, repair change-caused failures within budget, and report unresolved commands.',
      '6. UX/status alignment: keep pending, applied, validation, and needs_review states consistent across sidebar, editor, session history, and final chat.',
      '7. Tests and non-regression gates: add focused tests for review-first policy, plan-build prompt, route delegation, and diff review wiring; run typecheck, lint, test, and build when available.',
      '',
      '## File-Level Change Plan',
      ...fileLevel,
      '',
      '## Runtime State Machine',
      '- Phases: created, classifying, loading_project_rules, mapping_repository, gathering_context, tracing_dependencies, planning, awaiting_clarification, proposing_patch, awaiting_patch_review, applying_patch, validating, repairing, verified, needs_review, failed, cancelled.',
      '- Ask mode can reach verified without patch phases and must stay read-only.',
      '- Plan mode writes only `.agent/plans` unless explicitly instructed otherwise.',
      '- Code mode reaches awaiting_patch_review only after at least one real diff proposal or a precise needs_review blocker explaining why no safe patch can be proposed.',
      '- Code mode reaches verified only when changed files are written through the patch boundary and validation passes or is honestly unavailable/skipped with explanation.',
      '',
      '## User-Facing Response Policy',
      '- Chat should answer directly, cite critical files only when useful, and avoid file counts/internal traces/raw JSON.',
      '- Trace/artifact panels carry structured events, tool calls, long logs, validation artifacts, and patch metadata.',
      '- Final Code responses must distinguish proposed, applied, validated, and needs_review states; never imply file mutation if filesChanged is empty.',
      '',
      '## Validation and Test Plan',
      ...validation,
      '- Focused unit tests for context scoring, plan artifact sections, patch rejection/application, validation detection, repair budget, response policy, route delegation, and editor diff review wiring.',
      '',
      '## Risks and Rollback',
      '- Checkpoint rollback remains the safety net before file mutation.',
      '- Editor diff review must not mutate files; mutation stays inside the accept/apply path.',
      '- New-file virtual diff tabs must not create tabs that are later persisted as dirty real files unless the patch is accepted.',
      '- Provider failure fallback should produce deterministic Ask/Plan responses and avoid unrelated Code patches.',
      '- Validation failure handling should stop as needs_review after bounded repair attempts.',
      '- Patch conflict handling should reject stale beforeContent and request regeneration.',
      '',
      '## Definition of Done',
      '- Ask mode: read-only, evidence-grounded answer; no patches, no writes, no fake validation claims.',
      '- Plan mode: writes an executable plan artifact with the required sections, evidence reviewed, implementation sequence, validation plan, risks, rollback, and DoD.',
      '- Code mode: selected context includes target files plus related imports/tests/configs/docs; if context is insufficient, recall more before patching.',
      '- Code mode: every generated change appears as a pending diff and can be opened in the main editor red/green review surface before accept/reject.',
      '- Code mode: new, deleted, and modified files all have reviewable editor states; no pending patch is sidebar-only.',
      '- Code mode: patch apply rejects traversal/stale content and checkpoints before writes/deletes.',
      '- Code mode: validation runs when available, repair is bounded, and the final status is verified only when the implementation is actually applied and validated.',
      '- Code mode: empty `filesChanged` is allowed only with a needs_review blocker that names the missing context, unsafe action, provider failure, or validation blocker.',
      '- UI/session state: todos, phase, patch queue, editor tab, validation panel, and final chat agree on the same state.',
      '',
      '## Build Instructions',
      '- Read this artifact first, then reopen target files from disk and recall related files as needed.',
      '- Do not guess from the first evidence pack; inspect imports, call sites, tests, config, and neighboring UI/runtime files before editing.',
      '- Make the editor-level diff review work before polishing sidebar copy.',
      '- Implement milestones in order and validate after major phases.',
      '- Stop as needs_review only after the recall/repair budget is exhausted and exact blockers are recorded.',
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
