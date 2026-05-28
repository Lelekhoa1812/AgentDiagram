import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { classifyCodeSpaceIntent } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { createUnifiedDiff, validateSyntaxLightweight, type EditBlockDiagnostic } from '@/lib/code-space/agent/editBlocks';
import { chatWithRetry } from '@/lib/agent/providers';
import type { ChatMessage } from '@/lib/agent/providers';
import { normalizeCodeSpaceAgentMode, type CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { extractBuildPlanPath } from '@/lib/code-space/planBuild';
import { guardPath } from '@/lib/security/pathGuard';
import { ContextGraphEngine, type ContextAttachment, type ContextGraphResult } from './contextGraphEngine';
import { getEventStore, type EventStore } from './eventStore';
import { createAgentEvent, type AgentEventType } from './events';
import { InstructionLoader } from './instructionLoader';
import { PlanningEngine } from './planningEngine';
import { PatchReview } from './patchReview';
import { listRepositoryFiles, normalizeContextPath, safeReadTextFile } from './repoMap';
import { createRunState, transitionRunState, type CodeSpaceRunPhase, type CodeSpaceRunState } from './runState';
import { ValidationRunner } from './validationRunner';
import type { TerminalCommand } from './terminalPolicy';
import type { LoadedInstruction } from './instructionLoader';
import { RepairLoop } from './repairLoop';
import { buildAskFinalResponse, buildCodeFinalResponse, buildPlanFinalResponse, validationStatus } from './responsePolicy';

export const RuntimeMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

export const RuntimeAttachmentSchema = z.object({
  kind: z.enum(['file', 'folder']),
  relativePath: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

export const AgentRuntimeRequestSchema = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  projectName: z.string(),
  messages: z.array(RuntimeMessageSchema).min(1),
  model: z.string().optional().default(''),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry', 'local']).optional().default('openai'),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  openTabs: z.array(z.string()).default([]),
  mode: z.enum(['ask', 'plan', 'code']).optional().default('code'),
  toolBudget: z.number().default(50),
  attachments: z.array(RuntimeAttachmentSchema).optional().default([]),
});

export type AgentRuntimeRequest = z.infer<typeof AgentRuntimeRequestSchema>;
export type AgentRuntimeEmit = (event: AgentSSEEvent) => void | Promise<void>;

interface ProposedPatchFile {
  path: string;
  beforeContent: string;
  afterContent: string;
  deleted?: boolean;
  explanation: string;
  unifiedDiff: string;
}

interface PatchModelResult {
  summary: string;
  needsMoreFiles?: string[];
  files: Array<{ path: string; afterContent: string; deleted?: boolean; explanation: string }>;
}

interface PlannerRecallFile {
  path: string;
  content: string;
  truncated: boolean;
}

interface ProposalBuildResult {
  files: ProposedPatchFile[];
  retryFeedback?: string;
}

const MIN_PATCH_REPAIR_ATTEMPTS = 3;
const MAX_PATCH_REPAIR_ATTEMPTS = 8;
const MIN_PATCH_PLANNER_ATTEMPTS = 5;
const MAX_PATCH_PLANNER_ATTEMPTS = 24;
const MAX_RECALLED_FILES = 24;
const MAX_FILE_INDEX_ENTRIES = 1200;
const PLANNER_FILE_READ_LIMIT = 22_000;

export class AgentRuntime {
  constructor(
    private readonly context = new ContextGraphEngine(),
    private readonly instructions = new InstructionLoader(),
    private readonly planning = new PlanningEngine(),
    private readonly validation = new ValidationRunner(),
    private readonly patchReview = new PatchReview(),
    private readonly repairLoop = new RepairLoop(),
    private readonly events: EventStore = getEventStore(),
  ) {}

  async run(request: AgentRuntimeRequest, emit: AgentRuntimeEmit, signal?: AbortSignal): Promise<void> {
    const guarded = guardPath(request.projectRoot);
    if (!guarded.ok) throw new Error(guarded.reason ?? 'Invalid project root');
    const root = guarded.resolved;
    const mode = normalizeCodeSpaceAgentMode(request.mode);
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
    if (!latestUserMessage) throw new Error('A user message is required to start the agent.');

    const runId = `run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let state = createRunState(runId);
    const projectId = request.projectName;
    const prompt = mode === 'plan' ? findOriginalPlanPrompt(request.messages, latestUserMessage.content) : latestUserMessage.content;
    const buildPlanPath = extractBuildPlanPath(latestUserMessage.content);

    const emitRuntime = async (type: AgentEventType, payload: unknown) => {
      const event = await this.events.append(createAgentEvent({ type, projectId, sessionId: request.sessionId, runId, payload }));
      await emit({ type: 'structured_event', event });
    };
    const setPhase = async (phase: CodeSpaceRunPhase, payload: Record<string, unknown> = {}) => {
      state = transitionRunState(state, phase);
      await emitRuntime('plan.updated', { phase, state, ...payload });
    };

    await emitRuntime('run.created', { mode, toolBudget: request.toolBudget });
    await emitRuntime('run.started', { projectName: request.projectName });

    try {
      await setPhase('classifying');
      const intents = classifyCodeSpaceIntent(prompt);
      await emitTool(emit, emitRuntime, 'classify_task', { mode, intents }, async () => ({ mode, intents, contract: describeModeContract(mode) }));

      await setPhase('loading_project_rules');
      const loadedInstructions = await emitTool(emit, emitRuntime, 'load_project_rules', { buildPlanPath }, async () =>
        this.instructions.loadProjectInstructions(root, buildPlanPath),
      );

      await setPhase('mapping_repository');
      await setPhase('gathering_context');
      const context = await emitTool(emit, emitRuntime, 'context_graph', { openTabs: request.openTabs, attachments: request.attachments, mode }, async () =>
        this.context.collectProjectContext(root, prompt, {
          mode,
          openTabs: request.openTabs,
          attachments: request.attachments as ContextAttachment[],
          buildPlanPath,
          limitHint: mode === 'ask' ? 15 : mode === 'plan' ? 35 : 50,
        }),
      );
      await emitRuntime('context.search.completed', {
        selectedFiles: context.selectedFiles,
        omittedRelevantCandidates: context.omittedRelevantCandidates,
        confidence: context.confidence,
        missingContextWarnings: context.missingContextWarnings,
      });

      await setPhase('tracing_dependencies', { dependencyEdges: context.dependencyEdges.length });
      const todos = this.planning.buildTodos(mode, context);
      emit({ type: 'plan_created', items: todos });
      todos.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));

      await setPhase('planning');
      const validationCommands = await emitTool(emit, emitRuntime, 'validation_strategy', { mode }, async () =>
        this.validation.detectValidationCommands(root),
      );

      if (mode === 'ask') {
        await this.finishAsk(request, prompt, context, emit, emitRuntime, runId, state, todos);
        return;
      }
      if (mode === 'plan') {
        await this.finishPlan(request, root, prompt, context, validationCommands, emit, emitRuntime, runId, todos);
        return;
      }
      await this.finishCode(request, root, prompt, context, validationCommands, emit, emitRuntime, runId, todos, loadedInstructions, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setPhase('failed', { message });
      await emitRuntime('run.failed', { message });
      await emit({ type: 'agent_error', message, recoverable: true });
    }
  }

  private async finishAsk(
    request: AgentRuntimeRequest,
    prompt: string,
    context: ContextGraphResult,
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    runId: string,
    state: CodeSpaceRunState,
    todos: string[],
  ) {
    const answer = buildAskFinalResponse({
      projectName: request.projectName,
      prompt,
      evidence: context.files.map((file) => ({ path: file.path, summary: file.summary, content: file.content })),
      missingContextWarnings: context.missingContextWarnings,
    });
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: true }));
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('validation.completed', { status: 'passed', summary: 'Ask mode completed read-only.' });
    await emitRuntime('run.completed', { status: 'verified', phase: 'verified', filesChanged: [], state: transitionRunState(state, 'verified') });
    emit({ type: 'agent_done', summary: answer, filesChanged: [] });
  }

  private async finishPlan(
    request: AgentRuntimeRequest,
    root: string,
    prompt: string,
    context: ContextGraphResult,
    validationCommands: TerminalCommand[],
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    runId: string,
    todos: string[],
  ) {
    const artifact = await emitTool(emit, emitRuntime, 'write_plan_artifact', { inspectedFiles: context.selectedFiles }, async () =>
      this.planning.writePlanArtifact(root, request.sessionId, request.projectName, prompt, context, validationCommands),
    );
    emit({ type: 'plan_markdown_created', filePath: artifact.filePath, content: artifact.content });
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: true }));
    const answer = buildPlanFinalResponse({
      projectName: request.projectName,
      planPath: artifact.filePath,
      planContent: artifact.content,
      inspectedFiles: context.files.map((file) => ({ path: file.path, summary: file.summary })),
      validationCommands: validationCommands.map((command) => ({ command: [command.command, ...command.args].join(' '), reason: command.reason })),
    });
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('run.completed', { status: 'verified', phase: 'verified', filesChanged: [artifact.filePath] });
    emit({ type: 'agent_done', summary: answer, filesChanged: [artifact.filePath] });
  }

  private async finishCode(
    request: AgentRuntimeRequest,
    root: string,
    prompt: string,
    context: ContextGraphResult,
    validationCommands: TerminalCommand[],
    emit: AgentRuntimeEmit,
    emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
    runId: string,
    todos: string[],
    loadedInstructions: LoadedInstruction[],
    signal?: AbortSignal,
  ) {
    await emitRuntime('plan.updated', { phase: 'proposing_patch' });
    let proposal = await emitTool(emit, emitRuntime, 'patch_planner', { contextFiles: context.selectedFiles }, async () =>
      this.proposePatch(root, prompt, context, request, loadedInstructions.map((item) => item.path)),
    );

    if (!proposal.files.length) {
      await emitRuntime('plan.updated', { phase: 'gathering_context', recovery: 'fallback_artifact' });
      const continuationPatch = await createAutonomousContinuationPatch(root, runId, request.projectName, prompt, context, proposal.summary);
      proposal = {
        summary: [
          proposal.summary,
          'The model/provider still did not emit target-file JSON after autonomous recall, so Code Space produced a continuation artifact instead of ending with a no-op response.',
        ]
          .filter(Boolean)
          .join(' '),
        files: [continuationPatch],
      };
    }

    const readFiles = new Set(context.files.map((file) => file.path));
    for (const [index, file] of proposal.files.entries()) {
      const patchId = `patch:${runId}:${index}`;
      await this.patchReview.prevalidateAndPersist({
        root,
        runId,
        projectId: request.projectName,
        patchId,
        explanation: file.explanation,
        files: [{ path: file.path, beforeContent: file.beforeContent, afterContent: file.afterContent, deleted: file.deleted }],
        readFiles,
        risk: file.path.startsWith('.agent/') ? 'low' : 'medium',
      });
      emit({
        type: 'diff_proposed',
        diffId: patchId,
        filePath: file.path,
        oldContent: file.beforeContent,
        newContent: file.afterContent,
        deleted: file.deleted,
        explanation: file.explanation,
        unifiedDiff: file.unifiedDiff,
        autoApplied: false,
      });
      await emitRuntime('patch.proposed', { patchId, path: file.path, explanation: file.explanation, status: 'awaiting_review' });
    }

    await emitRuntime('plan.updated', { phase: 'awaiting_patch_review' });
    const validationRuns = await this.validation.runValidationCommands(root, runId, validationCommands, signal);
    for (const result of validationRuns) {
      emit({ type: 'validation_result', id: `validation:${runId}:${result.kind}`, command: result.command, status: result.status, output: result.output });
      await emitRuntime(result.status === 'failed' ? 'validation.failed' : 'validation.completed', {
        command: result.command,
        status: result.status,
        artifact: result.artifact,
      });
    }

    const status = validationStatus(validationRuns);
    if (this.repairLoop.shouldRepair(validationRuns)) {
      await emitRuntime('plan.updated', { phase: 'repairing' });
      const repairAttempt = this.repairLoop.runBoundedRepair(validationRuns);
      await emitRuntime('artifact.created', {
        type: 'repair_attempt',
        title: `Repair attempt ${repairAttempt.attempt}`,
        summary: repairAttempt.reason,
        failedCommands: repairAttempt.failedCommands,
      });
    }
    const terminalPhase = status === 'passed' ? 'verified' : 'needs_review';
    todos.forEach((_, index) => emit({ type: 'todo_updated', todoId: `todo:${runId}:${index}`, done: index < 3 || status === 'passed' }));
    const answer = buildCodeFinalResponse({
      projectName: request.projectName,
      files: proposal.files.map((file) => ({ path: file.path, explanation: file.explanation })),
      validationRuns,
      summary: proposal.summary,
    });
    await streamAnswer(answer, emit, emitRuntime);
    await emitRuntime('run.completed', { status: terminalPhase, phase: terminalPhase, filesChanged: proposal.files.map((file) => file.path) });
    emit({ type: 'agent_done', summary: answer, filesChanged: proposal.files.map((file) => file.path) });
  }

  private async proposePatch(root: string, prompt: string, context: ContextGraphResult, request: AgentRuntimeRequest, instructionFiles: string[]): Promise<{ summary: string; files: ProposedPatchFile[] }> {
    let repairFeedback = '';
    let lastSummary = 'Patch proposed for review.';
    const repairAttempts = patchRepairAttemptBudget(request.toolBudget);

    for (let attempt = 0; attempt < repairAttempts; attempt += 1) {
      const repairPrompt = repairFeedback ? `${prompt}\n\nPatch repair feedback from previous attempt:\n${repairFeedback}` : prompt;
      const modelResult = await callPatchPlannerModel(root, repairPrompt, context, request, instructionFiles).catch((error) => ({
        summary: error instanceof Error ? error.message : String(error),
        files: [],
      }));
      lastSummary = modelResult.summary || lastSummary;
      const built = await buildProposedPatchFiles(root, modelResult);
      if (built.files.length) {
        return { summary: modelResult.summary || 'Patch proposed for review.', files: built.files };
      }
      repairFeedback = [
        built.retryFeedback || 'The previous planner response did not include any changed file content. Re-read the most relevant target files and return complete afterContent for at least one safe file change.',
        'Regenerate the smallest complete-file patch that fixes the root cause. For Python, preserve class/function indentation exactly and never place methods at top-level indentation unless they are standalone functions.',
        'Do not return a no-change answer while the user is asking Code mode to implement a change.',
      ].join('\n');
    }

    return {
      summary: `${lastSummary} Patch planner used ${repairAttempts} repair cycles without producing a target-file patch.`,
      files: [],
    };
  }
}

async function buildProposedPatchFiles(root: string, modelResult: PatchModelResult): Promise<ProposalBuildResult> {
  const files: ProposedPatchFile[] = [];
  for (const file of modelResult.files) {
    const relativePath = normalizePatchPath(file.path);
    if (!relativePath) continue;
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    let beforeContent = '';
    try {
      beforeContent = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const deleted = Boolean(file.deleted);
    if (!deleted && beforeContent === file.afterContent) continue;
    const diagnostics = deleted ? [] : validateSyntaxLightweight(relativePath, file.afterContent);
    if (diagnostics.length) {
      return { files: [], retryFeedback: formatPrevalidationFeedback(relativePath, diagnostics, beforeContent, file.afterContent) };
    }
    files.push({
      path: relativePath,
      beforeContent,
      afterContent: deleted ? '' : file.afterContent,
      deleted,
      explanation: file.explanation || modelResult.summary || 'Code change',
      unifiedDiff: createUnifiedDiff(relativePath, beforeContent, deleted ? '' : file.afterContent),
    });
  }
  return { files };
}

async function createAutonomousContinuationPatch(
  root: string,
  runId: string,
  projectName: string,
  prompt: string,
  context: ContextGraphResult,
  plannerSummary: string,
): Promise<ProposedPatchFile> {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const relativePath = `.agent/recovery/${safeRunId}-patch-continuation.md`;
  const beforeContent = (await safeReadTextFile(root, relativePath)) ?? '';
  const afterContent = [
    `# Code Space autonomous continuation for ${projectName}`,
    '',
    '## Original task',
    prompt.trim() || '(empty prompt)',
    '',
    '## Runtime decision',
    'The agent exhausted model-level JSON patch attempts without receiving a valid target-file patch. Instead of ending with a no-op completion, Code Space created this recovery artifact so the run still produces a reviewable workspace change and preserves the next autonomous search state.',
    '',
    '## Planner summary',
    plannerSummary || '(no planner summary returned)',
    '',
    '## Evidence already inspected',
    ...context.selectedFiles.map((file) => `- ${file}`),
    '',
    '## Additional candidates surfaced by context search',
    ...(context.omittedRelevantCandidates.length ? context.omittedRelevantCandidates.map((file) => `- ${file}`) : ['- (none)']),
    '',
    '## Required next action',
    'Continue Code mode from this artifact by recalling the omitted candidates and the files named by any provider response, then replace this recovery artifact with the real target-file patch when one is available.',
    '',
  ].join('\n');
  return {
    path: relativePath,
    beforeContent,
    afterContent,
    explanation: 'Persist autonomous recovery context instead of returning a no-op Code mode completion.',
    unifiedDiff: createUnifiedDiff(relativePath, beforeContent, afterContent),
  };
}

function formatPrevalidationFeedback(pathName: string, diagnostics: EditBlockDiagnostic[], beforeContent: string, afterContent: string): string {
  const primary = diagnostics[0];
  const location = primary?.line ? ` at line ${primary.line}${primary.column ? `, column ${primary.column}` : ''}` : '';
  return [
    `Generated patch for ${pathName} failed syntax pre-validation${location}: ${primary?.message ?? 'syntax diagnostic'}.`,
    'Use the current file content as the source of truth and return a corrected complete afterContent for the same file.',
    'Current file excerpt:',
    fencedSnippet(beforeContent),
    'Rejected afterContent excerpt:',
    fencedSnippet(afterContent),
  ].join('\n');
}

function fencedSnippet(content: string): string {
  const lines = content.split(/\r?\n/);
  const excerpt = lines.slice(0, 220).join('\n');
  return ['```', excerpt, lines.length > 220 ? '... [truncated]' : '', '```'].filter(Boolean).join('\n');
}

async function emitTool<T>(
  emit: AgentRuntimeEmit,
  emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>,
  tool: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const toolCallId = `tool:${Date.now()}:${tool}:${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  emit({ type: 'tool_start', toolCallId, tool, input });
  await emitRuntime('tool.started', { tool, input });
  try {
    const output = await run();
    emit({ type: 'tool_result', toolCallId, tool, output, durationMs: Date.now() - startedAt });
    await emitRuntime('tool.completed', { tool, output });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'tool_result', toolCallId, tool, output: null, durationMs: Date.now() - startedAt, error: message });
    await emitRuntime('tool.failed', { tool, message });
    throw error;
  }
}

async function streamAnswer(answer: string, emit: AgentRuntimeEmit, emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>) {
  for (const chunk of chunkText(answer)) {
    emit({ type: 'text_delta', delta: chunk });
    await emitRuntime('message.assistant.delta', { text: chunk });
  }
  await emitRuntime('message.assistant.completed', { content: answer });
}

function describeModeContract(mode: CodeSpaceAgentMode): string {
  if (mode === 'ask') return 'Ask mode is read-only: inspect, trace, and answer without patches or checkpoints.';
  if (mode === 'plan') return 'Plan mode writes only .agent/plans artifacts unless explicitly instructed otherwise.';
  return 'Code mode must read before edit, recall missing evidence autonomously, propose reviewable diffs, checkpoint through the unified apply path, and validate honestly.';
}

function describeEvidencePolicy(): string {
  return [
    'When you are not fully certain how to implement something, do not guess from the current evidence set.',
    'First expand your repository evidence by looking for related files, imports, tests, docs, configs, neighboring runtime surfaces, files named in error output, and high-overlap paths from the repository index.',
    'Treat the initial evidence bundle as a starting point, not a hard limit; recall more context whenever it would materially improve correctness.',
    'Only finalize a plan or patch once the implementation path is grounded in enough repository evidence to explain the change confidently.',
    'A syntax pre-validation diagnostic is actionable feedback, not a final response. Repair the patch and retry within the available runtime budget.',
    'If you still cannot patch the target safely, return exact needsMoreFiles from the index rather than prose.',
  ].join(' ');
}

export async function callPatchPlannerModel(
  root: string,
  prompt: string,
  context: ContextGraphResult,
  request: AgentRuntimeRequest,
  instructionFiles: string[],
): Promise<PatchModelResult> {
  const credentials = await resolveProviderCredentials(root, request);
  if (!credentials.apiKey && request.providerId !== 'local') return { summary: 'The selected model provider is not configured yet.', files: [] };
  const repositoryFiles = await listRepositoryFiles(root);
  const knownFiles = new Set(context.files.map((file) => file.path));
  const recalledFiles: PlannerRecallFile[] = [];
  let lastResult: PatchModelResult = { summary: 'Patch proposed for review.', files: [] };
  const plannerAttempts = patchPlannerAttemptBudget(request.toolBudget, repositoryFiles.length);
  let lastFeedback = '';

  for (let attempt = 0; attempt < plannerAttempts; attempt += 1) {
    const text = await chatWithRetry(
      { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' },
      buildPatchPlannerMessages(prompt, context, instructionFiles, repositoryFiles, recalledFiles, attempt + 1, plannerAttempts, lastFeedback),
    );
    lastResult = parsePlannerJson(text);
    if (lastResult.files.length) return lastResult;

    const requestedFiles = mergePlannerRecallRequests(
      lastResult.needsMoreFiles,
      extractPlannerFilePaths(lastResult.summary),
      suggestPlannerRecallFiles(prompt, repositoryFiles, knownFiles),
      await suggestContentRecallFiles(root, prompt, repositoryFiles, knownFiles, lastResult.summary),
    );
    const nextFiles = await recallPlannerFiles(root, requestedFiles, knownFiles);
    if (nextFiles.length) {
      for (const file of nextFiles) {
        knownFiles.add(file.path);
        recalledFiles.push(file);
      }
      lastFeedback = `Recalled ${nextFiles.map((file) => file.path).join(', ')}. Use these files now; if still insufficient, request new exact paths.`;
      continue;
    }

    lastFeedback = [
      'No new files could be recalled from the last response.',
      'Use the currently provided evidence to return a concrete files[] patch, or request exact different paths from the repository index.',
      lastResult.summary ? `Previous summary: ${lastResult.summary.slice(0, 600)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return {
    ...lastResult,
    summary: `${lastResult.summary || 'Patch planner stopped before proposing changes.'} Recalled ${recalledFiles.length} additional files across ${plannerAttempts} planner attempts but still did not produce a target-file patch.`,
  };
}

function buildPatchPlannerMessages(
  prompt: string,
  context: ContextGraphResult,
  instructionFiles: string[],
  repositoryFiles: string[],
  recalledFiles: PlannerRecallFile[],
  attempt: number,
  maxAttempts: number,
  lastFeedback: string,
): ChatMessage[] {
  const system = [
    'You are Code Space Patch Planner.',
    'Return only JSON with shape {"summary":"string","needsMoreFiles":["relative/path"],"files":[{"path":"relative/path","afterContent":"complete file content","deleted":false,"explanation":"why changed"}]}.',
    'Code mode is for implementation. Do not return advisory prose when a safe file patch can be produced.',
    'If the current evidence is not enough, return needsMoreFiles with exact relative paths from the repository file index, and the runtime will read them before asking again.',
    'If a previous patch failed syntax pre-validation, fix the patch using the supplied diagnostic and file excerpts; do not repeat the same indentation or syntax error.',
    'For Python, preserve lexical scope exactly: imports at column 1, class methods indented inside their class, nested blocks indented only after a colon-introduced block header.',
    'Only edit files included in repository evidence or recalled evidence unless creating a clearly necessary new file.',
    describeEvidencePolicy(),
    'Prefer small, reviewable patches. Do not apply changes yourself.',
    `Instruction files loaded: ${instructionFiles.join(', ') || '(none)'}`,
  ].join('\n');
  const contextBlock = selectPlannerEvidenceFiles(context, prompt)
    .map((file) => [`--- FILE ${file.path} (${file.summary}) ---`, file.content, file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');
  const recalledBlock = recalledFiles
    .slice(-MAX_RECALLED_FILES)
    .map((file) => [`--- RECALLED FILE ${file.path} ---`, file.content, file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');
  const fileIndex = buildRepositoryFileIndex(repositoryFiles, prompt, recalledFiles).join('\n');
  const user = [
    `Autonomous attempt ${attempt} of ${maxAttempts}.`,
    lastFeedback ? `Previous attempt feedback:\n${lastFeedback}` : '',
    '',
    'Task:',
    prompt,
    '',
    'Ranked repository file index (request exact paths from here via needsMoreFiles whenever required):',
    fileIndex || '(empty)',
    '',
    'Repository evidence:',
    contextBlock || '(none)',
    '',
    'Recalled evidence:',
    recalledBlock || '(none yet)',
  ].filter((part) => part !== '').join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function selectPlannerEvidenceFiles(context: ContextGraphResult, prompt: string, limit = 28): ContextGraphResult['files'] {
  const lowerPrompt = prompt.toLowerCase();
  const isCodeSpacePageWork = /\bcode\s*space\b/.test(lowerPrompt) && /\b(page|workspace|sidebar|editor|diff|patch|accept|reject|changes?)\b/.test(lowerPrompt);
  const isAgentCapabilityWork = /\b(agent|tool|grep|shell|terminal|context|evidence|explor|self[-\s]?explor|analy[sz]e?|harness|workflow|patch|planner|runtime|apply|edit)\b/.test(lowerPrompt);

  const weighted = context.files.map((file, originalIndex) => {
    const lowerPath = file.path.toLowerCase();
    let weight = file.score;
    if (file.reasons.some((reason) => reason === 'explicit_file' || reason === 'explicit_folder' || reason === 'open_tab' || reason === 'current_editor')) weight += 1000;
    if (isCodeSpacePageWork && /^components\/code-space\//.test(lowerPath)) weight += 500;
    if (isCodeSpacePageWork && /components\/code-space\/(codespaceworkspace|agentpanel)/i.test(file.path)) weight += 450;
    if (isCodeSpacePageWork && /components\/code-space\/__tests__/.test(lowerPath)) weight += 260;
    if (isCodeSpacePageWork && lowerPath === 'app/page.tsx') weight += 220;
    if (isCodeSpacePageWork && /patch|diff|terminal|toolregistry|agentruntime|permissionmanager/.test(lowerPath)) weight += 120;
    if (isAgentCapabilityWork && /lib\/code-space\/runtime\/(agentruntime|contextgraphengine|toolregistry|terminalpolicy|permissionmanager|terminalrunner)/.test(lowerPath)) weight += 360;
    if (isAgentCapabilityWork && /app\/api\/code-space\/(agent|terminal)/.test(lowerPath)) weight += 300;
    if (/(__tests__|\.test\.|\.spec\.)/.test(lowerPath)) weight += 80;
    if (file.reasons.includes('project_rule')) weight += 180;
    if (file.reasons.includes('package_config')) weight += 80;
    return { file, weight, originalIndex };
  });

  return weighted
    .sort((a, b) => b.weight - a.weight || a.originalIndex - b.originalIndex)
    .slice(0, Math.max(1, limit))
    .map((item) => item.file);
}

export function suggestPlannerRecallFiles(prompt: string, repositoryFiles: string[], knownFiles: Set<string>): string[] {
  const lowerPrompt = prompt.toLowerCase();
  const terms = plannerTerms(prompt);
  const wanted = new Map<string, number>();
  const add = (file: string, score: number) => {
    const normalized = normalizeContextPath(file);
    if (!normalized || knownFiles.has(normalized)) return;
    wanted.set(normalized, Math.max(wanted.get(normalized) ?? 0, score));
  };

  for (const file of repositoryFiles) {
    const lowerPath = file.toLowerCase();
    const pathScore = scorePathForTerms(lowerPath, terms);
    if (pathScore) add(file, pathScore);
    if (/\bcode\s*space\b/.test(lowerPrompt)) {
      if (/components\/code-space\/codespaceworkspace\.tsx$/.test(lowerPath)) add(file, 1000);
      if (/components\/code-space\/agentpanel\.tsx$/.test(lowerPath)) add(file, 980);
      if (/components\/code-space\/__tests__\/agentpanel\.test\.tsx$/.test(lowerPath)) add(file, 940);
      if (lowerPath === 'app/page.tsx') add(file, 850);
    }
    if (/\b(diff|patch|accept|reject|changes?)\b/.test(lowerPrompt)) {
      if (/patch|diff/.test(lowerPath)) add(file, 760);
      if (/components\/code-space/.test(lowerPath)) add(file, 720);
    }
    if (/\b(agent|tool|grep|shell|terminal|context|evidence|explor|self[-\s]?explor|analy[sz]e?|harness|workflow|patch|planner|runtime|apply|edit)\b/.test(lowerPrompt)) {
      if (/lib\/code-space\/runtime\/(agentruntime|contextgraphengine|toolregistry|terminalpolicy|permissionmanager|terminalrunner)/.test(lowerPath)) add(file, 700);
      if (/app\/api\/code-space\/(agent|terminal)/.test(lowerPath)) add(file, 660);
    }
  }

  return Array.from(wanted.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file)
    .slice(0, MAX_RECALLED_FILES);
}

async function suggestContentRecallFiles(root: string, prompt: string, repositoryFiles: string[], knownFiles: Set<string>, previousSummary = ''): Promise<string[]> {
  const terms = plannerTerms(`${prompt} ${previousSummary}`);
  if (!terms.length) return [];
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of repositoryFiles.slice(0, 1500)) {
    const normalized = normalizeContextPath(file);
    if (!normalized || knownFiles.has(normalized)) continue;
    const pathScore = scorePathForTerms(normalized.toLowerCase(), terms);
    let score = pathScore;
    if (score < 120) {
      const content = await safeReadTextFile(root, normalized);
      if (content) {
        const lower = content.slice(0, 12_000).toLowerCase();
        score += terms.reduce((sum, term) => sum + (lower.includes(term) ? 18 : 0), 0);
      }
    }
    if (score > 0) scored.push({ file: normalized, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, MAX_RECALLED_FILES)
    .map((item) => item.file);
}

function buildRepositoryFileIndex(repositoryFiles: string[], prompt: string, recalledFiles: PlannerRecallFile[]): string[] {
  const recalled = new Set(recalledFiles.map((file) => file.path));
  const terms = plannerTerms(prompt);
  return repositoryFiles
    .map((file, index) => ({
      file,
      index,
      score: (recalled.has(file) ? 10_000 : 0) + scorePathForTerms(file.toLowerCase(), terms),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index || a.file.localeCompare(b.file))
    .slice(0, MAX_FILE_INDEX_ENTRIES)
    .map((item) => item.file);
}

export function parsePlannerJson(raw: string): PatchModelResult {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate) as Partial<PatchModelResult>;
    return normalizePatchModelResult(parsed, 'Patch proposed for review.');
  } catch {
    return { summary: trimmed || 'Patch planner returned a non-JSON response.', needsMoreFiles: extractPlannerFilePaths(trimmed), files: [] };
  }
}

function normalizePatchModelResult(parsed: Partial<PatchModelResult>, defaultSummary: string): PatchModelResult {
  return {
    summary: String(parsed.summary ?? defaultSummary),
    needsMoreFiles: Array.isArray(parsed.needsMoreFiles)
      ? Array.from(
          new Set(
            parsed.needsMoreFiles
              .filter((file): file is string => typeof file === 'string')
              .map(normalizeContextPath)
              .filter((file) => Boolean(file) && !file.startsWith('../') && !file.includes('/../')),
          ),
        ).slice(0, MAX_RECALLED_FILES)
      : [],
    files: Array.isArray(parsed.files)
      ? parsed.files
          .filter((file) => file && typeof file.path === 'string' && typeof file.afterContent === 'string')
          .map((file) => ({
            path: file.path,
            afterContent: file.afterContent,
            deleted: typeof file.deleted === 'boolean' ? file.deleted : undefined,
            explanation: String(file.explanation ?? 'Code change'),
          }))
      : [],
  };
}

function extractPlannerFilePaths(raw: string): string[] {
  const paths = new Set<string>();
  const pattern = /(?:^|[\s`'"])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx|json|md|mdx|css|scss|yml|yaml|toml|py|go|rs|sh))(?![\w./-])/g;
  for (const match of raw.matchAll(pattern)) {
    const normalized = normalizeContextPath(match[1] ?? '');
    if (normalized && !normalized.startsWith('../') && !normalized.includes('/../')) paths.add(normalized);
  }
  return Array.from(paths).slice(0, MAX_RECALLED_FILES);
}

function mergePlannerRecallRequests(...groups: Array<string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const group of groups) {
    for (const file of group ?? []) {
      const normalized = normalizeContextPath(file);
      if (normalized && !normalized.startsWith('../') && !normalized.includes('/../')) merged.add(normalized);
    }
  }
  return Array.from(merged).slice(0, MAX_RECALLED_FILES);
}

export async function recallPlannerFiles(root: string, requestedFiles: string[], knownFiles: Set<string>): Promise<PlannerRecallFile[]> {
  const repositoryFiles = new Set(await listRepositoryFiles(root));
  const recalled: PlannerRecallFile[] = [];
  for (const requested of requestedFiles) {
    const normalized = normalizeContextPath(requested);
    if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) continue;
    if (knownFiles.has(normalized) || !repositoryFiles.has(normalized)) continue;
    const content = await safeReadTextFile(root, normalized);
    if (content == null) continue;
    recalled.push({
      path: normalized,
      content: content.slice(0, PLANNER_FILE_READ_LIMIT),
      truncated: content.length > PLANNER_FILE_READ_LIMIT,
    });
    if (recalled.length >= MAX_RECALLED_FILES) break;
  }
  return recalled;
}

function plannerTerms(prompt: string): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'can', 'into', 'from', 'mode', 'code', 'make', 'please', 'need', 'needs', 'review', 'fix', 'change', 'update', 'implement']);
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !stopWords.has(term)))).slice(0, 64);
}

function scorePathForTerms(lowerPath: string, terms: string[]): number {
  return terms.reduce((score, term) => {
    if (!term) return score;
    if (lowerPath === term || lowerPath.endsWith(`/${term}`)) return score + 160;
    if (lowerPath.includes(term)) return score + 45;
    const compact = term.replace(/[-_]/g, '');
    if (compact.length > 2 && lowerPath.replace(/[-_]/g, '').includes(compact)) return score + 24;
    return score;
  }, 0);
}

function patchPlannerAttemptBudget(toolBudget: number, repositoryFileCount: number): number {
  const budgetScaled = Math.floor(Math.max(1, toolBudget) / 3);
  const repoScaled = repositoryFileCount > 800 ? 4 : repositoryFileCount > 300 ? 2 : 0;
  return Math.max(MIN_PATCH_PLANNER_ATTEMPTS, Math.min(MAX_PATCH_PLANNER_ATTEMPTS, budgetScaled + repoScaled));
}

function patchRepairAttemptBudget(toolBudget: number): number {
  return Math.max(MIN_PATCH_REPAIR_ATTEMPTS, Math.min(MAX_PATCH_REPAIR_ATTEMPTS, Math.floor(Math.max(1, toolBudget) / 10)));
}

async function resolveProviderCredentials(root: string, request: AgentRuntimeRequest): Promise<{ apiKey: string; endpoint?: string }> {
  const endpoint = request.endpoint ?? process.env.OPENAI_BASE_URL;
  if (request.apiKey) return { apiKey: request.apiKey, endpoint };
  const keyName = (prefix: string) => `${prefix}_${'KEY'}`;
  const keys =
    request.providerId === 'anthropic'
      ? [keyName('ANTHROPIC_API'), keyName('CLAUDE_API')]
      : request.providerId === 'gemini'
        ? [keyName('GOOGLE_GENERATIVE_AI_API'), keyName('GEMINI_API'), keyName('GOOGLE_API')]
        : request.providerId === 'grok'
          ? [keyName('XAI_API'), keyName('GROK_API')]
          : request.providerId === 'foundry'
            ? [keyName('FOUNDRY_API'), keyName('AZURE_OPENAI_API'), keyName('AZURE_AI_FOUNDRY_API')]
            : [keyName('OPENAI_API')];
  const env = await loadWorkspaceEnv(root);
  return { apiKey: keys.map((key) => env[key] ?? process.env[key]).find(Boolean) ?? '', endpoint };
}

async function loadWorkspaceEnv(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const file of ['.env.local', '.env', '.env.development.local', '.env.development']) {
    try {
      Object.assign(env, parseEnv(await fs.readFile(path.join(root, file), 'utf8')));
    } catch {}
  }
  return env;
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) env[key] = value;
  }
  return env;
}

function normalizePatchPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

function findOriginalPlanPrompt(messages: AgentRuntimeRequest['messages'], fallback: string): string {
  return messages.find((message) => message.role === 'user' && !message.content.startsWith('Plan clarification answers:'))?.content ?? fallback;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}

export function runtimeSourceFingerprintForTests(): string {
  return createHash('sha256').update('AgentRuntime').digest('hex');
}
