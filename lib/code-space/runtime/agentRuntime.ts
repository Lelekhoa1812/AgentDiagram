import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { classifyCodeSpaceIntent } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
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
    const proposal = await emitTool(emit, emitRuntime, 'patch_planner', { contextFiles: context.selectedFiles }, async () =>
      this.proposePatch(root, prompt, context, request, loadedInstructions.map((item) => item.path)),
    );
    if (!proposal.files.length) {
      const answer = buildCodeFinalResponse({ projectName: request.projectName, files: [], validationRuns: [], summary: proposal.summary });
      await streamAnswer(answer, emit, emitRuntime);
      await emitRuntime('run.completed', { status: 'needs_review', phase: 'needs_review', filesChanged: [] });
      emit({ type: 'validation_result', id: `validation:${runId}:skipped`, command: 'manual review', status: 'skipped', output: 'No patch was proposed.' });
      emit({ type: 'agent_done', summary: answer, filesChanged: [] });
      return;
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
        risk: 'medium',
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
    const modelResult = await callPatchPlannerModel(root, prompt, context, request, instructionFiles).catch((error) => ({
      summary: error instanceof Error ? error.message : String(error),
      files: [],
    }));
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
      if (diagnostics.length) throw new Error(`Generated patch for ${relativePath} failed syntax pre-validation: ${diagnostics[0]?.message ?? 'syntax diagnostic'}`);
      files.push({
        path: relativePath,
        beforeContent,
        afterContent: deleted ? '' : file.afterContent,
        deleted,
        explanation: file.explanation || modelResult.summary || 'Code change',
        unifiedDiff: createUnifiedDiff(relativePath, beforeContent, deleted ? '' : file.afterContent),
      });
    }
    return { summary: modelResult.summary || 'Patch proposed for review.', files };
  }
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
  return 'Code mode must read before edit, propose reviewable diffs, checkpoint through the unified apply path, and validate honestly.';
}

function describeEvidencePolicy(): string {
  // Motivation vs Logic: patch planning can stall when the model treats the first evidence bundle as exhaustive.
  // This policy tells the agent to keep recalling repository context until the implementation path is actually grounded.
  return [
    'When you are not fully certain how to implement something, do not guess from the current evidence set.',
    'First expand your repository evidence by looking for related files, imports, tests, docs, configs, and neighboring runtime surfaces.',
    'Treat the initial evidence bundle as a starting point, not a hard limit; recall more context whenever it would materially improve correctness.',
    'Only finalize a plan or patch once the implementation path is grounded in enough repository evidence to explain the change confidently.',
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

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const text = await chatWithRetry(
      { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' },
      buildPatchPlannerMessages(prompt, context, instructionFiles, repositoryFiles, recalledFiles),
    );
    lastResult = parsePlannerJson(text);
    if (lastResult.files.length) return lastResult;

    const requestedFiles = lastResult.needsMoreFiles?.length
      ? lastResult.needsMoreFiles
      : suggestPlannerRecallFiles(prompt, repositoryFiles, knownFiles);
    const nextFiles = await recallPlannerFiles(root, requestedFiles, knownFiles);
    if (!nextFiles.length) return lastResult;
    for (const file of nextFiles) {
      knownFiles.add(file.path);
      recalledFiles.push(file);
    }
  }

  return {
    ...lastResult,
    summary: `${lastResult.summary || 'Patch planner stopped before proposing changes.'} Recalled additional files but still did not produce a patch.`,
  };
}

function buildPatchPlannerMessages(
  prompt: string,
  context: ContextGraphResult,
  instructionFiles: string[],
  repositoryFiles: string[],
  recalledFiles: PlannerRecallFile[],
): ChatMessage[] {
  const system = [
    'You are Code Space Patch Planner.',
    'Return only JSON with shape {"summary":"string","needsMoreFiles":["relative/path"],"files":[{"path":"relative/path","afterContent":"complete file content","deleted":false,"explanation":"why changed"}]}.',
    'If the current evidence is not enough, do not give up. Return needsMoreFiles with exact relative paths from the repository file index, and the runtime will read them before asking again.',
    'Only edit files included in repository evidence or recalled evidence unless creating a clearly necessary new file.',
    describeEvidencePolicy(),
    'Prefer small, reviewable patches. Do not apply changes yourself.',
    `Instruction files loaded: ${instructionFiles.join(', ') || '(none)'}`,
  ].join('\n');
  const contextBlock = selectPlannerEvidenceFiles(context, prompt)
    .map((file) => [`--- FILE ${file.path} (${file.summary}) ---`, file.content, file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');
  const recalledBlock = recalledFiles
    .map((file) => [`--- RECALLED FILE ${file.path} ---`, file.content, file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');
  const fileIndex = repositoryFiles.slice(0, 500).join('\n');
  const user = [
      'Task:',
      prompt,
      '',
      'Repository file index (request exact paths from here via needsMoreFiles whenever required):',
      fileIndex || '(empty)',
      '',
      'Repository evidence:',
      contextBlock || '(none)',
      '',
      'Recalled evidence:',
      recalledBlock || '(none yet)',
    ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function selectPlannerEvidenceFiles(context: ContextGraphResult, prompt: string, limit = 28): ContextGraphResult['files'] {
  const lowerPrompt = prompt.toLowerCase();
  const isCodeSpacePageWork = /\bcode\s*space\b/.test(lowerPrompt) && /\b(page|workspace|sidebar|editor|diff|patch|accept|reject|changes?)\b/.test(lowerPrompt);
  const isAgentCapabilityWork = /\b(agent|tool|grep|shell|terminal|context|evidence|explor|cursor|codex|claude\s*code)\b/.test(lowerPrompt);

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
  const wanted = new Map<string, number>();
  const add = (file: string, score: number) => {
    const normalized = normalizeContextPath(file);
    if (!normalized || knownFiles.has(normalized)) return;
    wanted.set(normalized, Math.max(wanted.get(normalized) ?? 0, score));
  };

  for (const file of repositoryFiles) {
    const lowerPath = file.toLowerCase();
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
    if (/\b(agent|tool|grep|shell|terminal|context|evidence|explor|cursor|codex|claude\s*code)\b/.test(lowerPrompt)) {
      if (/lib\/code-space\/runtime\/(agentruntime|contextgraphengine|toolregistry|terminalpolicy|permissionmanager|terminalrunner)/.test(lowerPath)) add(file, 700);
      if (/app\/api\/code-space\/(agent|terminal)/.test(lowerPath)) add(file, 660);
    }
  }

  return Array.from(wanted.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file)
    .slice(0, 12);
}

export function parsePlannerJson(raw: string): PatchModelResult {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  const parsed = JSON.parse(candidate) as Partial<PatchModelResult>;
  return {
    summary: String(parsed.summary ?? 'Patch proposed for review.'),
    needsMoreFiles: Array.isArray(parsed.needsMoreFiles)
      ? Array.from(
          new Set(
            parsed.needsMoreFiles
              .filter((file): file is string => typeof file === 'string')
              .map(normalizeContextPath)
              .filter((file) => Boolean(file) && !file.startsWith('../') && !file.includes('/../')),
          ),
        ).slice(0, 12)
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
      content: content.slice(0, 22_000),
      truncated: content.length > 22_000,
    });
    if (recalled.length >= 12) break;
  }
  return recalled;
}

async function resolveProviderCredentials(root: string, request: AgentRuntimeRequest): Promise<{ apiKey: string; endpoint?: string }> {
  const endpoint = request.endpoint ?? process.env.OPENAI_BASE_URL;
  if (request.apiKey) return { apiKey: request.apiKey, endpoint };
  const keys =
    request.providerId === 'anthropic'
      ? ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY']
      : request.providerId === 'gemini'
        ? ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
        : request.providerId === 'grok'
          ? ['XAI_API_KEY', 'GROK_API_KEY']
          : request.providerId === 'foundry'
            ? ['FOUNDRY_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_AI_FOUNDRY_API_KEY']
            : ['OPENAI_API_KEY'];
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
