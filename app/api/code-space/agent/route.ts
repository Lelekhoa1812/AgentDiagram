import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { classifyCodeSpaceIntent, type CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { normalizeCodeSpaceAgentMode, type CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import {
  buildPlanImplementationPrompt,
  extractBuildPlanPath,
} from '@/lib/code-space/planBuild';
import {
  formatPlanArtifactSectionHeading,
  PLAN_ARTIFACT_SECTION_TITLES,
} from '@/lib/code-space/agent/planTemplate';
import { createAgentEvent, createDefaultToolRegistry, createFileCheckpoint, encodeSseEvent, getEventStore } from '@/lib/code-space/runtime';
import type { AgentEventType } from '@/lib/code-space/runtime';
import { createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { chatWithRetry } from '@/lib/agent/providers';
import { chatStructuredWithRetry } from '@/lib/agent/planning/structuredOutput';
import { guardPath } from '@/lib/security/pathGuard';
import {
  buildCodeCompletionResponse,
  buildPlanCompletionResponse,
} from '@/lib/code-space/agent/runResponses';

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

const AttachmentSchema = z.object({
  kind: z.enum(['file', 'folder']),
  relativePath: z.string().min(1),
  displayName: z.string().min(1),
});

const BodySchema = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  projectName: z.string(),
  messages: z.array(MessageSchema).min(1),
  model: z.string(),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry', 'local']),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  localTemperature: z.number().min(0).max(2).optional(),
  localContextLength: z.number().int().positive().optional(),
  openTabs: z.array(z.string()).default([]),
  mode: z.enum(['ask', 'plan', 'code']).optional().default('code'),
  toolBudget: z.number().default(50),
  enableThinking: z.boolean().default(true),
  attachments: z.array(AttachmentSchema).optional().default([]),
});

type AgentRequest = z.infer<typeof BodySchema>;
type ProviderId = AgentRequest['providerId'];
type PlanClarificationAnswer = { question: string; answer: string };
type WorkflowOutline = {
  intentSummary: string;
  planItems: string[];
  clarifyingQuestions: CodeSpaceClarifyingQuestion[];
};

const WORKFLOW_OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    intent_summary: { type: 'string' },
    plan_items: { type: 'array', items: { type: 'string' } },
    clarifying_questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' } },
          allowMultiple: { type: 'boolean' },
        },
        required: ['id', 'question', 'choices', 'allowMultiple'],
        additionalProperties: false,
      },
    },
  },
  required: ['intent_summary', 'plan_items', 'clarifying_questions'],
  additionalProperties: false,
} as const;

const WorkflowOutlineSchema = z.object({
  intent_summary: z.string(),
  plan_items: z.array(z.string()),
  clarifying_questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      choices: z.array(z.string()),
      allowMultiple: z.boolean(),
    }),
  ),
});

const execFileAsync = promisify(execFile);

export { buildPlanImplementationPrompt, extractBuildPlanPath };

interface AgentAttachment {
  kind: 'file' | 'folder';
  relativePath: string;
  displayName: string;
}

interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
  lineCount: number;
  score: number;
  reasons: string[];
  summary: string;
  symbols: string[];
}

interface ContextSearchResult {
  filesConsidered: number;
  terms: string[];
  files: ContextFile[];
  omittedRelevantFiles: string[];
}

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
  files: Array<{ path: string; afterContent: string; deleted?: boolean; explanation: string }>;
  validationCommands?: string[];
  unableReason?: string;
}

interface AppliedFileResult {
  path: string;
  hash: string;
  unifiedDiff: string;
  explanation: string;
  deleted?: boolean;
}

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const { messages, projectName, projectRoot, sessionId, toolBudget, openTabs, attachments } = body.data;
  const mode = normalizeCodeSpaceAgentMode(body.data.mode);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) return Response.json({ error: 'A user message is required to start the agent.' }, { status: 400 });

  const planningPrompt = mode === 'plan' ? findOriginalPlanPrompt(messages, latestUserMessage.content) : latestUserMessage.content;
  const promptForContext = mode === 'plan' ? planningPrompt : latestUserMessage.content;
  const intents = classifyCodeSpaceIntent(promptForContext);
  const registry = createDefaultToolRegistry();
  const guarded = guardPath(projectRoot);
  if (!guarded.ok) return Response.json({ error: guarded.reason ?? 'Invalid project path' }, { status: 400 });

  const runId = `run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  const eventStore = getEventStore();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentSSEEvent) => controller.enqueue(encoder.encode(encodeSseEvent(event)));
      const emitRuntime = async (type: AgentEventType, payload: unknown) => {
        const event = await eventStore.append(createAgentEvent({ type, sessionId, runId, projectId: projectName, payload }));
        emit({ type: 'structured_event', event });
      };
      const emitTool = async <T>(tool: string, input: unknown, run: () => Promise<T>): Promise<T> => {
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
      };

      try {
        await emitRuntime('run.created', { mode, toolBudget });
        await emitRuntime('run.started', { projectName });

        await emitTool('classify_task', { prompt: promptForContext, intents, mode }, async () => ({ intents, mode, modeContract: describeModeContract(mode) }));

        let context = await emitTool('context_search', { openTabs, attachments, tools: registry.list().map((tool) => tool.name) }, async () =>
          collectProjectContext(guarded.resolved, promptForContext, openTabs, attachments),
        );
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path), summaries: context.files.map((file) => ({ path: file.path, summary: file.summary })), terms: context.terms, attachments });

        // Motivation vs Logic: plan/todo scaffolds are user-visible commitments, so they must come from the same
        // evidence-grounded synthesis pass that will also decide whether clarification is actually required.
        const workflowOutline = await emitTool(
          'workflow_outline',
          {
            mode,
            prompt: promptForContext,
            intents,
            context: context.files.map((file) => ({
              path: file.path,
              summary: file.summary,
              truncated: file.truncated,
              symbols: file.symbols,
            })),
          },
          async () => generateWorkflowOutline(guarded.resolved, body.data, promptForContext, intents, context, mode),
        );
        const plan = workflowOutline.planItems;
        emit({ type: 'plan_created', items: plan });
        await emitRuntime('plan.created', { items: plan, evidenceFiles: context.files.map((file) => file.path) });
        plan.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));
        if (plan[0]) emit({ type: 'todo_updated', todoId: `todo:${runId}:0`, done: true });
        if (plan[1]) emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const validation = await emitTool('validation_strategy', { mode, changedPaths: context.files.map((file) => file.path) }, async () => detectValidationCommands(guarded.resolved));

        let filesChanged: string[] = [];
        let answer = '';
        let validationRuns: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; output: string }> = [];

        if (mode === 'ask') {
          answer = await buildAskResponse(guarded.resolved, projectName, latestUserMessage.content, context, validation, body.data);
          emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });
        } else if (mode === 'plan') {
          const clarificationAnswers = extractPlanClarificationAnswers(messages);
          const questions = workflowOutline.clarifyingQuestions;
          const shouldAskClarification = questions.length > 0 && clarificationAnswers.length === 0;
          if (shouldAskClarification) {
            emit({ type: 'clarifying_questions_created', questions });
            await emitRuntime('plan.updated', { phase: 'clarification', questions: questions.map((question) => question.question) });
            answer = buildPlanClarificationResponse(projectName, context, questions);
            emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });
          } else {
            const planArtifact = await emitTool('write_plan_artifact', { projectName, prompt: planningPrompt, inspectedFiles: context.files.map((file) => file.path), answers: clarificationAnswers }, async () =>
              writePlanArtifact(guarded.resolved, sessionId, projectName, planningPrompt, context, validation, clarificationAnswers, body.data, workflowOutline),
            );
            filesChanged = [planArtifact.filePath];
            emit({ type: 'plan_markdown_created', filePath: planArtifact.filePath, content: planArtifact.content });
            // Root Cause vs Logic: the sidebar should summarize the actual plan artifact, not a canned status line,
            // so we surface the artifact path plus evidence-backed highlights from the plan body itself.
            answer = buildPlanResponse(projectName, planArtifact.filePath, planArtifact.content, context, validation);
            emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });
            emit({ type: 'todo_updated', todoId: `todo:${runId}:3`, done: true });
          }
        } else {
          let promptForPatch = latestUserMessage.content;
          let latestProposal: Awaited<ReturnType<typeof proposeAutonomousPatch>> | null = null;
          let latestApplied: Awaited<ReturnType<typeof applyGeneratedPatch>> | null = null;
          const changedFiles = new Set<string>();

          // Motivation vs Logic: Code mode is only useful if it keeps closing the loop on validation failures, so
          // we feed the latest failure summary back into the same patch planner instead of stopping after the first apply pass.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            latestProposal = await emitTool(
              'autonomous_patch_planner',
              {
                provider: body.data.providerId,
                model: body.data.model,
                prompt: promptForPatch,
                contextFiles: context.files.map((file) => file.path),
                folderScopes: attachments.filter((item) => item.kind === 'folder').map((item) => item.relativePath),
                attempt,
              },
              async () => proposeAutonomousPatch(guarded.resolved, promptForPatch, context, body.data),
            );
            latestApplied = await emitTool('apply_autonomous_patch', { files: latestProposal.files.map((file) => file.path), checkpointed: true, attempt }, async () =>
              applyGeneratedPatch({ root: guarded.resolved, projectId: projectName, runId, files: latestProposal?.files ?? [] }),
            );

            for (const file of latestProposal.files) {
              emit({ type: 'diff_proposed', diffId: `patch:${runId}:${file.path}:${attempt}`, filePath: file.path, oldContent: file.beforeContent, newContent: file.afterContent, deleted: file.deleted, explanation: file.explanation, unifiedDiff: file.unifiedDiff, autoApplied: true });
              await emitRuntime('patch.proposed', { path: file.path, explanation: file.explanation, autoApplied: true, attempt });
            }
            for (const file of latestApplied.files) {
              emit({ type: 'file_applied', filePath: file.path, deleted: file.deleted, explanation: file.explanation, unifiedDiff: file.unifiedDiff, hash: file.hash });
              await emitRuntime('patch.applied', { path: file.path, hash: file.hash, attempt });
              changedFiles.add(file.path);
            }

            validationRuns = await emitTool('validation_run', { commands: validation.commands.map((command) => command.command), attempt }, async () =>
              runValidationCommands(guarded.resolved, validation.commands),
            );
            const validationFailed = validationRuns.some((item) => item.status === 'failed');
            if (!validationFailed) break;

            promptForPatch = [
              latestUserMessage.content,
              '',
              'Validation results after the last implementation pass:',
              ...validationRuns.map((item) => `- ${item.command}: ${item.status}\n  ${item.output || 'No output captured.'}`),
              '',
              'Keep implementing the code until the validation issues are fixed.',
            ].join('\n');
            context = await emitTool('context_search', { openTabs, attachments, tools: registry.list().map((tool) => tool.name), attempt }, async () =>
              collectProjectContext(guarded.resolved, promptForPatch, openTabs, attachments),
            );
            await emitRuntime('context.search.completed', {
              selectedFiles: context.files.map((file) => file.path),
              summaries: context.files.map((file) => ({ path: file.path, summary: file.summary })),
              terms: context.terms,
              attachments,
            });
          }

          if (!latestProposal || !latestApplied) {
            throw new Error('Code mode did not produce a patch proposal.');
          }

          filesChanged = Array.from(changedFiles);
          // Root Cause vs Logic: code mode needs a concise change summary grounded in the actual patch and
          // validation results, not a fixed "done" template that hides what changed.
          answer = buildCodeResponse(
            projectName,
            latestProposal.files,
            validationRuns,
            latestProposal.summary,
            latestApplied.checkpoint?.snapshotRef,
          );
          const failedValidationRuns = validationRuns.filter((item) => item.status === 'failed');
          if (failedValidationRuns.length) {
            answer = [
              answer,
              '',
              'Validation still needs attention:',
              ...failedValidationRuns.map((item) => `- ${item.command}: ${item.output}`),
            ].join('\n');
          }
          emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });
          emit({ type: 'todo_updated', todoId: `todo:${runId}:3`, done: true });
        }

        for (const chunk of chunkText(answer)) {
          emit({ type: 'text_delta', delta: chunk });
          await emitRuntime('message.assistant.delta', { text: chunk });
        }
        await emitRuntime('message.assistant.completed', { content: answer });

        const validationStatus =
          mode === 'code'
            ? validationRuns.some((item) => item.status === 'failed')
              ? 'failed'
              : validation.commands.every((command) => command.command === 'manual review')
                ? 'skipped'
                : 'passed'
            : 'passed';
        emit({
          type: 'validation_result',
          id: `validation:${runId}:strategy`,
          command: validation.commands.map((command) => command.command).join(', ') || 'validation strategy discovery',
          status: validationStatus,
          output:
            mode === 'code'
              ? validationRuns.map((item) => `${item.command}: ${item.status}`).join('\n') || 'Validation ran with no captured output.'
              : `Detected ${validation.commands.length} validation command(s).`,
        });
        await emitRuntime('validation.completed', { status: validationStatus, validation });
        await emitRuntime('run.completed', { status: 'completed', filesChanged });
        emit({ type: 'agent_done', summary: answer, filesChanged });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await emitRuntime('run.failed', { message });
        emit({ type: 'agent_error', message, recoverable: true });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

export async function buildPlan(
  mode: CodeSpaceAgentMode,
  intents: string[],
  prompt: string,
  context?: ContextSearchResult,
  request?: AgentRequest,
): Promise<string[]> {
  if (!context?.files.length || !request) return [];
  const outline = await generateWorkflowOutline('', request, prompt, intents, context, mode);
  return outline.planItems;
}

export async function buildClarifyingQuestions(
  prompt = '',
  intents: string[] = [],
  context?: ContextSearchResult,
  request?: AgentRequest,
  mode: CodeSpaceAgentMode = 'plan',
): Promise<CodeSpaceClarifyingQuestion[]> {
  if (!context?.files.length || !request) return [];
  const outline = await generateWorkflowOutline('', request, prompt, intents, context, mode);
  return outline.clarifyingQuestions;
}

function describeModeContract(mode: CodeSpaceAgentMode): string {
  if (mode === 'ask') return 'Ask mode is read-only: inspect, explain, and answer directly without creating patches.';
  if (mode === 'plan') return 'Plan mode inspects relevant files first, asks only critical MCQ clarifications when needed, then creates an editable markdown implementation plan artifact grounded in inspected evidence.';
  return [
    'Code mode explores context, chooses target files, applies checkpointed changes, and summarizes the result conversationally.',
    buildTerminalDecisionGuide(),
  ].join('\n');
}

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term)))).slice(0, 48);
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'can', 'into', 'from', 'mode', 'code', 'make', 'please', 'need', 'deeply', 'review', 'comprehensively', 'improve', 'plan']);
const CONTEXT_GLOBS = ['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs,java,kt,php,rb,sh,yml,yaml,toml}', '!node_modules/**', '!.git/**', '!.agent/**', '!dist/**', '!build/**', '!.next/**', '!coverage/**', '!__pycache__/**'];
// Motivation vs Logic: rename-heavy tasks fail when the agent invents replacement files, so refactors must be treated as on-disk moves followed by a reference sweep and validation.
const REFACTOR_WORKFLOW = [
  'Refactor workflow:',
  '1. Inspect the current file, all imports, exports, and call sites before changing paths.',
  '2. Prefer shell-native moves and copies for renames or folder reorganizations instead of creating a brand-new duplicate file.',
  '3. Search every affected file, update imports, re-exports, and references, and keep the move atomic where possible.',
  '4. Run the detected typecheck, lint, test, and build commands after the refactor so import paths and compilation are verified.',
].join('\n');

// Motivation vs Logic: the agent should choose the terminal for real filesystem, search, and validation work instead of simulating those actions in chat.
const TERMINAL_DECISION_GUIDE = [
  'Terminal decision guide:',
  '- Use terminal commands for refactors that need real file moves or copies (`mv`, `cp`, `git mv`) and then sweep imports with `rg` or `grep`.',
  '- Use terminal commands when you need to reproduce bugs, inspect logs, run tests, typecheck, lint, or build after a change.',
  '- Use terminal commands for dependency or lockfile work, package-manager commands, and environment checks that cannot be inferred safely from source alone.',
  '- Use terminal commands for repo inspection tasks like `git status`, `git diff`, `git log`, file discovery, and path checks before or after edits.',
  '- Use terminal commands for bulk text replacement, search-and-repair loops, and any situation where editing one file implies updating many references.',
  '- Prefer `rg`/`grep` for searches, `find`/`ls` for tree inspection, and `npm`/`pnpm`/`yarn`/`bun` commands when the project manifest indicates they are the right validation or install tool.',
].join('\n');

function buildTerminalDecisionGuide(): string {
  return TERMINAL_DECISION_GUIDE;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export async function collectProjectContext(root: string, prompt: string, openTabs: string[], attachments: AgentAttachment[] = []): Promise<ContextSearchResult> {
  const discoveredCandidates = await fg(CONTEXT_GLOBS, { cwd: root, onlyFiles: true, dot: true, absolute: false, unique: true });
  const candidates = [...discoveredCandidates];
  const buildPlanPath = extractBuildPlanPath(prompt);
  if (buildPlanPath && !candidates.includes(buildPlanPath)) candidates.unshift(buildPlanPath);
  const terms = promptTerms(prompt);
  const attachedFiles = new Set(attachments.filter((item) => item.kind === 'file').map((item) => normalizeRelativePath(item.relativePath)));
  const attachedFolders = attachments.filter((item) => item.kind === 'folder').map((item) => normalizeRelativePath(item.relativePath));
  const normalizedOpenTabs = new Set(openTabs.map(normalizeRelativePath));
  const scored = candidates.map((file) => {
    const normalizedFile = normalizeRelativePath(file);
    const lower = normalizedFile.toLowerCase();
    const reasons: string[] = [];
    let score = 0;
    const add = (amount: number, reason: string) => {
      if (!amount) return;
      score += amount;
      reasons.push(reason);
    };
    // Root Cause vs Logic: Build-from-plan prompts point at `.agent/plans/*`, but the regular repo scan hides `.agent/**`.
    // Load the approved plan explicitly so Code mode implements the artifact instead of falling back into another plan-shaped response.
    add(buildPlanPath === normalizedFile ? 500 : 0, 'approved plan artifact');
    add(attachedFiles.has(normalizedFile) ? 150 : 0, '@File exact scope');
    const folderScope = attachedFolders.find((folder) => normalizedFile === folder || normalizedFile.startsWith(`${folder}/`));
    add(folderScope ? 120 - Math.min(normalizedFile.split('/').length, 12) : 0, folderScope ? `@Folder scope: ${folderScope}` : '');
    add(normalizedOpenTabs.has(normalizedFile) ? 60 : 0, 'open tab');
    add(/package\.json|requirements\.txt|pyproject\.toml|tsconfig|next\.config|readme|agent|code-space|runtime|route|test|spec/i.test(normalizedFile) ? 18 : 0, 'high-signal project file');
    add(terms.reduce((sum, term) => sum + (lower.includes(term) ? 8 : 0), 0), 'prompt/path overlap');
    add(terms.reduce((sum, term) => sum + (lowerContentHint(normalizedFile).includes(term) ? 4 : 0), 0), 'semantic filename overlap');
    add(/(__tests__|\.test\.|\.spec\.|tests?\/)/i.test(normalizedFile) ? 10 : 0, 'test surface');
    return { file: normalizedFile, score, reasons };
  });
  const explicitFolderFiles = scored.filter((item) => item.reasons.some((reason) => reason.startsWith('@Folder scope'))).slice(0, 40);
  const selected = [...explicitFolderFiles, ...scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))]
    .filter((item, index, arr) => arr.findIndex((other) => other.file === item.file) === index)
    .filter((item) => item.score > 0 || item.reasons.length > 0)
    .slice(0, 40);
  const expanded = await expandContextWithCodeIntelligence(root, candidates, selected);
  const files: ContextFile[] = [];
  for (const item of expanded) {
    const absolute = path.resolve(root, item.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const content = await fs.readFile(absolute, 'utf8');
      const symbols = extractSymbols(content).slice(0, 8);
      files.push({
        path: item.file,
        content: content.slice(0, 22_000),
        truncated: content.length > 22_000,
        lineCount: content.split('\n').length,
        score: item.score,
        reasons: item.reasons,
        summary: summarizeContextFile(item.file, content, symbols),
        symbols,
      });
    } catch {}
  }
  return { filesConsidered: discoveredCandidates.length, files, terms, omittedRelevantFiles: [] };
}

async function expandContextWithCodeIntelligence(
  root: string,
  candidates: string[],
  selected: Array<{ file: string; score: number; reasons: string[] }>,
): Promise<Array<{ file: string; score: number; reasons: string[] }>> {
  const byFile = new Map(selected.map((item) => [item.file, { ...item, reasons: [...item.reasons] }]));
  const selectedFiles = new Set(selected.map((item) => item.file));
  const contentCache = new Map<string, string>();
  const readCandidate = async (file: string) => {
    const normalized = normalizeRelativePath(file);
    if (contentCache.has(normalized)) return contentCache.get(normalized) ?? '';
    const absolute = path.resolve(root, normalized);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return '';
    try {
      const content = await fs.readFile(absolute, 'utf8');
      contentCache.set(normalized, content);
      return content;
    } catch {
      contentCache.set(normalized, '');
      return '';
    }
  };

  const candidateSet = new Set(candidates.map(normalizeRelativePath));
  const addExpanded = (file: string, score: number, reason: string) => {
    const normalized = normalizeRelativePath(file);
    if (!candidateSet.has(normalized) && !selectedFiles.has(normalized)) return;
    const existing = byFile.get(normalized);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    byFile.set(normalized, { file: normalized, score, reasons: [reason] });
  };

  // Motivation vs Logic: Code Space may not have a live language-server process, but planning still needs LSP-like
  // evidence before asking questions or editing. This pass follows local imports and reverse importers so the agent
  // sees nearby definitions/callers instead of relying on prompt terms alone.
  for (const item of selected) {
    const content = await readCandidate(item.file);
    for (const specifier of extractLocalImportSpecifiers(content)) {
      const resolved = resolveLocalImport(item.file, specifier, candidateSet);
      if (resolved) addExpanded(resolved, item.score - 1, `code-intelligence dependency of ${item.file}`);
    }
  }

  const selectedAfterDeps = Array.from(byFile.keys());
  for (const candidate of candidates.map(normalizeRelativePath)) {
    if (byFile.has(candidate)) continue;
    const content = await readCandidate(candidate);
    if (!content) continue;
    for (const specifier of extractLocalImportSpecifiers(content)) {
      const resolved = resolveLocalImport(candidate, specifier, candidateSet);
      if (resolved && selectedAfterDeps.includes(resolved)) {
        addExpanded(candidate, 28, `code-intelligence importer of ${resolved}`);
        break;
      }
    }
  }

  return Array.from(byFile.values())
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 48);
}

function extractLocalImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /export\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return Array.from(specifiers);
}

function resolveLocalImport(fromFile: string, specifier: string, candidateSet: Set<string>): string | null {
  const baseDir = path.posix.dirname(normalizeRelativePath(fromFile));
  const raw = normalizeRelativePath(path.posix.normalize(path.posix.join(baseDir, specifier)));
  const possible = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.json`,
    `${raw}/index.ts`,
    `${raw}/index.tsx`,
    `${raw}/index.js`,
    `${raw}/index.jsx`,
  ];
  return possible.find((candidate) => candidateSet.has(candidate)) ?? null;
}

function lowerContentHint(filePath: string): string {
  return filePath
    .replace(/[-_.\/]/g, ' ')
    .replace(/api/g, 'api endpoint route service controller request response')
    .replace(/search/g, 'search web evidence query lookup retrieval source engine')
    .replace(/retrieval/g, 'retrieval ranking vector similarity evidence')
    .replace(/evidence/g, 'evidence source citation provenance quality')
    .replace(/coordinator/g, 'coordinator orchestration strategy planning')
    .replace(/processor/g, 'processor ranking filtering extraction normalization')
    .toLowerCase();
}

function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/g,
    /class\s+([A-Za-z0-9_]+)/g,
    /interface\s+([A-Za-z0-9_]+)/g,
    /(?:async\s+)?def\s+([A-Za-z0-9_]+)/g,
    /class\s+([A-Za-z0-9_]+)\s*[:(]/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) && symbols.size < 16) {
      if (match[1] && !match[1].startsWith('_')) symbols.add(match[1]);
    }
  }
  return Array.from(symbols);
}

function summarizeContextFile(filePath: string, content: string, symbols: string[]): string {
  const lowerPath = filePath.toLowerCase();
  const lower = content.toLowerCase();
  const symbolHint = symbols.length ? ` Key surfaces: ${symbols.slice(0, 4).join(', ')}.` : '';
  if (/readme|docs?\//i.test(filePath)) return `Project documentation describing setup, architecture, usage, or operational constraints.${symbolHint}`;
  if (/routes?\.py|app\.py|route\.ts|controller/i.test(lowerPath)) return `API entrypoints and request routing; useful for understanding how user requests reach backend services.${symbolHint}`;
  if (/chatbot|agent|orchestrator|coordinator/i.test(lowerPath)) return `Agent orchestration logic, task routing, strategy selection, and service coordination.${symbolHint}`;
  if (/retrieval|vector|embedding|similarity/i.test(lowerPath)) return `Retrieval services, ranking inputs, similarity scoring, and evidence/context selection.${symbolHint}`;
  if (/evidence|citation|source|provenance/i.test(lowerPath)) return `Evidence management, source quality handling, citation/provenance shaping, and response grounding.${symbolHint}`;
  if (/research|strategy|planner/i.test(lowerPath)) return `Planning and research strategy rules that decide how evidence should be collected or expanded.${symbolHint}`;
  if (/duckduckgo|google|bing|search\.py|engine/i.test(lowerPath)) return `Search engine integration and web lookup behavior, including query execution, result parsing, and fallback handling.${symbolHint}`;
  if (/medical|clinical|pubmed|mesh|guideline/i.test(lowerPath) || /pubmed|clinical|guideline|mesh/.test(lower)) return `Medical/clinical search specialization, query expansion, source filtering, and evidence quality constraints.${symbolHint}`;
  if (/multilingual|language|translate/i.test(lowerPath)) return `Multilingual processing, language detection, translation-aware search, and locale-sensitive result handling.${symbolHint}`;
  if (/processor|extractor|content/i.test(lowerPath)) return `Result processing, content extraction, deduplication, normalization, and ranking preparation.${symbolHint}`;
  if (/config|settings|env/i.test(lowerPath)) return `Configuration surface for runtime settings, provider credentials, feature toggles, and environment behavior.${symbolHint}`;
  if (/database|store|repository/i.test(lowerPath)) return `Persistence layer and data access utilities used by the backend services.${symbolHint}`;
  if (/test|spec/i.test(lowerPath)) return `Validation surface showing expected behavior, test patterns, or executable checks.${symbolHint}`;
  return `Implementation surface selected from the request and repo context.${symbolHint}`;
}

async function detectValidationCommands(root: string): Promise<{ commands: Array<{ kind: 'typecheck' | 'lint' | 'test' | 'build'; command: string; reason: string }>; packageManager: string | null }> {
  const commands: Array<{ kind: 'typecheck' | 'lint' | 'test' | 'build'; command: string; reason: string }> = [];
  let packageManager: string | null = null;
  const packageJsonPath = await findFirst(root, ['package.json', 'frontend/package.json', 'client/package.json', 'app/package.json', 'web/package.json']);
  if (packageJsonPath) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, packageJsonPath), 'utf8')) as { scripts?: Record<string, string>; packageManager?: string };
      const packageRoot = path.dirname(packageJsonPath);
      packageManager = await detectPackageManager(path.join(root, packageRoot), pkg.packageManager);
      const prefix = packageRoot === '.' ? '' : `cd ${packageRoot} && `;
      const scripts = pkg.scripts ?? {};
      if (scripts.typecheck) commands.push({ kind: 'typecheck', command: `${prefix}${packageManager} run typecheck`, reason: 'TypeScript/no-emit validation is available.' });
      if (scripts.lint) commands.push({ kind: 'lint', command: `${prefix}${packageManager} run lint`, reason: 'Lint validation is available.' });
      if (scripts.test) commands.push({ kind: 'test', command: `${prefix}${packageManager} run test`, reason: 'Automated tests are available.' });
      if (scripts.build) commands.push({ kind: 'build', command: `${prefix}${packageManager} run build`, reason: 'Production build validation is available.' });
    } catch {}
  }
  const pythonConfig = await findFirst(root, ['pyproject.toml', 'requirements.txt', 'backend/requirements.txt', 'api/requirements.txt', 'pytest.ini', 'setup.py']);
  if (pythonConfig) {
    const pythonRoot = path.dirname(pythonConfig);
    const prefix = pythonRoot === '.' ? '' : `cd ${pythonRoot} && `;
    commands.push({ kind: 'typecheck', command: `${prefix}python -m compileall .`, reason: 'Python syntax compilation is available.' });
    if (await hasAny(root, ['tests', 'test', `${pythonRoot}/tests`, `${pythonRoot}/test`, 'pytest.ini', 'pyproject.toml'])) commands.push({ kind: 'test', command: `${prefix}python -m pytest`, reason: 'Python pytest validation appears available.' });
  }
  if (!commands.length && (await hasAny(root, ['go.mod']))) commands.push({ kind: 'test', command: 'go test ./...', reason: 'Go module validation is available.' });
  if (!commands.length) commands.push({ kind: 'typecheck', command: 'manual review', reason: 'No project-specific validation command was detected; review the proposed diff manually.' });
  return { commands, packageManager };
}

async function runValidationCommands(
  root: string,
  commands: Array<{ kind: 'typecheck' | 'lint' | 'test' | 'build'; command: string; reason: string }>,
): Promise<Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; output: string }>> {
  const results: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; output: string }> = [];
  for (const entry of commands) {
    if (entry.command === 'manual review') {
      results.push({ command: entry.command, status: 'skipped', output: entry.reason });
      continue;
    }
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', entry.command], {
        cwd: root,
        env: { ...process.env },
        maxBuffer: 1024 * 1024 * 10,
      });
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      results.push({ command: entry.command, status: 'passed', output: output || entry.reason });
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string };
      const output = [execError.stdout ?? '', execError.stderr ?? '', execError.message ?? 'Command failed']
        .filter(Boolean)
        .join('\n')
        .trim();
      results.push({ command: entry.command, status: 'failed', output: output || entry.reason });
    }
  }
  return results;
}

async function findFirst(root: string, relativePaths: string[]): Promise<string | null> {
  for (const relativePath of relativePaths) if (await exists(path.join(root, relativePath))) return relativePath.includes('/') ? relativePath : `./${relativePath}`.replace(/^\.\//, '');
  return null;
}

async function hasAny(root: string, relativePaths: string[]): Promise<boolean> {
  for (const relativePath of relativePaths) if (await exists(path.join(root, relativePath))) return true;
  return false;
}

async function detectPackageManager(root: string, packageManager?: string): Promise<string> {
  if (packageManager?.startsWith('pnpm')) return 'pnpm';
  if (packageManager?.startsWith('yarn')) return 'yarn';
  if (packageManager?.startsWith('bun')) return 'bun';
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writePlanArtifact(
  root: string,
  sessionId: string,
  projectName: string,
  prompt: string,
  context: ContextSearchResult,
  validation: Awaited<ReturnType<typeof detectValidationCommands>>,
  answers: PlanClarificationAnswer[] = [],
  request?: AgentRequest,
  workflowOutline?: WorkflowOutline,
): Promise<{ filePath: string; content: string }> {
  const filePath = `.agent/plans/${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.md`;
  const absolute = path.join(root, filePath);
  const fallback = buildStrategyDocument({ projectName, prompt, context, validation, codeMode: false, answers, workflowOutline });
  const content = request
    ? sanitizePlanArtifact(
        await buildModelBackedStrategyDocument(root, { projectName, prompt, context, validation, answers, fallback, request, workflowOutline }).catch(() => fallback),
        fallback,
      )
    : fallback;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
  return { filePath, content };
}

// Motivation vs Logic: plan artifacts need to be authored by the selected model from real repository evidence, not assembled as a shallow template.
// The artifact itself should stay artifact-like: no mirrored prompt transcript, no chatty closing offer, and no extra request section that just repeats the user input.
// The deterministic document remains only as a safe fallback when the provider is unavailable.
async function buildModelBackedStrategyDocument(
  root: string,
  input: {
    projectName: string;
    prompt: string;
    context: ContextSearchResult;
    validation: Awaited<ReturnType<typeof detectValidationCommands>>;
    answers: PlanClarificationAnswer[];
    fallback: string;
    request: AgentRequest;
    workflowOutline?: WorkflowOutline;
  },
): Promise<string> {
  const credentials = await resolveProviderCredentials(root, input.request);
  if (!credentials.apiKey && input.request.providerId !== 'local') return input.fallback;
  const system = [
    'You are Code Space Plan Mode: a senior implementation planner for a coding agent.',
    'Write markdown only. Do not include code fences around the whole document.',
    'Create a concise, execution-oriented implementation plan that a Code mode agent can follow directly.',
    'Ground every claim in the provided repository evidence. Do not invent files or describe work that was not supported by the inspected code.',
    'Do not include MCQ questions, option menus, A/B/C choices, questionnaire transcripts, or conversational closing offers.',
    'If sidebar answers were provided, summarize only the selected inputs as concise planning constraints without reproducing the original question text.',
    'Prefer concrete file paths, sequencing, tests, and fallback behavior over generic advice.',
    'End the document after the Assumptions or optional Notice section and keep the output strictly to the plan artifact.',
  ].join('\n');
  const evidence = input.context.files
    .slice(0, 16)
    .map((file) => [`--- FILE ${file.path} (${file.summary}) ---`, file.content.slice(0, 10_000), file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');
  const user = [
    `Project: ${input.projectName}`,
    `Request: ${input.prompt}`,
    '',
    'Planning inputs and assumptions:',
    input.answers.length ? input.answers.map((answer, index) => `- Input ${index + 1}: ${answer.answer}`).join('\n') : '- No sidebar answers were provided; encode assumptions explicitly without inventing MCQ choices.',
    input.workflowOutline?.intentSummary ? `- Intent summary: ${input.workflowOutline.intentSummary}` : '',
    '',
    'Validation commands discovered:',
    ...input.validation.commands.map((command) => `- ${command.command} — ${command.reason}`),
    '',
    'Required markdown shape:',
    '# Code Space Plan — <project>',
    ...PLAN_ARTIFACT_SECTION_TITLES.map((title) => formatPlanArtifactSectionHeading(title)),
    'Optional sections like Notice, Disclaimer, or Risks should be added only when they materially help the implementer.',
    'Keep the plan focused on implementation, validation, and concrete context analysis only.',
    '',
    'Repository evidence:',
    evidence || '(No readable evidence was found.)',
  ].join('\n');
  const text = await chatWithRetry(
    { id: input.request.providerId, model: input.request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' },
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  );
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith('#')) return input.fallback;
  return trimmed;
}

function sanitizePlanArtifact(candidate: string, fallback: string): string {
  return containsMcqTranscript(candidate) ? fallback : candidate;
}

function containsMcqTranscript(content: string): boolean {
  return /\bMCQ\s*\d+\s*:/i.test(content) || /^\s*[-*]\s*[A-E]\)\s+/im.test(content) || /I encode MCQ-style decisions/i.test(content);
}

async function buildAskResponse(root: string, projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>, request: AgentRequest): Promise<string> {
  const fallback = buildGroundedFallbackAnswer(projectName, prompt, context, validation);
  const credentials = await resolveProviderCredentials(root, request);
  if (!credentials.apiKey && request.providerId !== 'local') return fallback;
  try {
    const system = [
      'You are the Code Space Ask-mode assistant.',
      'Answer the user directly from the repository evidence provided.',
      'Do not mention internal workflow, file counts, validation discovery, audit trails, or tool calls unless the user asked for them.',
      'Keep the answer focused and practical. Say when evidence is missing instead of inventing details.',
    ].join('\n');
    const contextBlock = context.files
      .slice(0, 12)
      .map((file) => [`--- FILE ${file.path} ---`, file.content.slice(0, 8_000), file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
      .join('\n\n');
    const user = [`Project: ${projectName}`, `Question: ${prompt}`, '', 'Repository evidence:', contextBlock || '(No readable evidence was found.)'].join('\n');
    const text = await chatWithRetry(
      { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' },
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    );
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

function buildGroundedFallbackAnswer(projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>): string {
  if (!context.files.length) {
    return `I could not find readable project files for ${projectName}, so I cannot answer that confidently yet.`;
  }
  const terms = promptTerms(prompt);
  const evidence = context.files.slice(0, 6).map((file) => {
    const snippet = selectRelevantLine(file.content, terms);
    return snippet ? `- ${file.path}: ${snippet}` : `- ${file.path}: ${file.summary}`;
  });
  const validationHint = /test|lint|build|typecheck|validate|check/i.test(prompt)
    ? ['', 'Relevant validation commands:', ...validation.commands.map((command) => `- ${command.command} — ${command.reason}`)]
    : [];
  return ['Here is the most relevant project evidence I found:', ...evidence, ...validationHint].join('\n');
}

function selectRelevantLine(content: string, terms: string[]): string | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const scored = lines
    .map((line) => ({ line, score: terms.reduce((sum, term) => sum + (line.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return (scored[0]?.line ?? lines.find((line) => /export |function |class |interface |const |def /.test(line)) ?? null)?.slice(0, 220) ?? null;
}

function buildPlanClarificationResponse(projectName: string, context: ContextSearchResult, questions: CodeSpaceClarifyingQuestion[]): string {
  const fileHint = context.files.slice(0, 4).map((file) => file.path).join(', ');
  return [
    `I inspected the likely implementation area in ${projectName}${fileHint ? ` (${fileHint})` : ''}.`,
    '',
    questions.length === 1 ? 'One decision should be clarified before I write the final plan.' : `${questions.length} decisions should be clarified before I write the final plan.`,
    'Please choose from the clarification panel, then I will generate the editable implementation plan with TODOs and validation steps.',
  ].join('\n');
}

function buildPlanResponse(
  projectName: string,
  planPath: string,
  planContent: string,
  context: ContextSearchResult,
  validation: Awaited<ReturnType<typeof detectValidationCommands>>,
): string {
  return buildPlanCompletionResponse({
    projectName,
    planPath,
    planContent,
    inspectedFiles: context.files.map((file) => ({ path: file.path, summary: file.summary })),
    validationCommands: validation.commands,
  });
}

function userFacingPlannerSummary(summary?: string): string {
  if (!summary) return 'The planner did not return a concrete edit.';
  if (/OpenAI-compatible|Model-backed|404|Resource not found|API key|rate limit|cooling down|failed/i.test(summary)) {
    return 'The selected model provider was not available for this run, so I stopped instead of creating unrelated fallback files.';
  }
  return summary;
}

function buildCodeResponse(
  projectName: string,
  files: ProposedPatchFile[],
  validationRuns: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; output: string }>,
  summary?: string,
  checkpointRef?: string,
): string {
  if (!files.length) {
    return ['No files were changed.', userFacingPlannerSummary(summary)].filter(Boolean).join(' ');
  }
  return buildCodeCompletionResponse({
    projectName,
    files: files.map((file) => ({ path: file.path, explanation: file.explanation })),
    validationRuns,
    summary,
    checkpointRef,
  });
}

function findOriginalPlanPrompt(messages: AgentRequest['messages'], fallback: string): string {
  return messages.find((message) => message.role === 'user' && !message.content.startsWith('Plan clarification answers:'))?.content ?? fallback;
}

function extractPlanClarificationAnswers(messages: AgentRequest['messages']): PlanClarificationAnswer[] {
  const answers: PlanClarificationAnswer[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !message.content.startsWith('Plan clarification answers:')) continue;
    const blocks = message.content.split(/\n(?=\d+\. )/g);
    for (const block of blocks) {
      const question = block.match(/^\d+\.\s*(.*?)\nAnswer:/ms)?.[1]?.trim();
      const answer = block.match(/Answer:\s*([\s\S]*)$/m)?.[1]?.trim();
      if (question && answer) answers.push({ question, answer });
    }
  }
  return answers;
}

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function buildPlanSummary(prompt: string, context: ContextSearchResult, answers: PlanClarificationAnswer[], outline?: WorkflowOutline): string {
  const inspectedFiles = context.files.slice(0, 4).map((file) => `\`${file.path}\``);
  const intentSummary = outline?.intentSummary?.trim();
  const evidenceText = inspectedFiles.length
    ? `Ground the change in ${formatList(inspectedFiles)} and keep the implementation inside the existing boundary.`
    : 'Ground the change in the inspected repository evidence and keep the implementation inside the existing boundary.';
  const assumptionText = answers.length
    ? 'Reflect the selected sidebar decisions directly in the implementation scope.'
    : 'State any unresolved assumptions explicitly so the implementer can validate them.';
  return `${(intentSummary || prompt.trim().replace(/\s+/g, ' '))}. ${evidenceText} ${assumptionText}`;
}

function buildPlanKeyChanges(context: ContextSearchResult, prompt: string, outline?: WorkflowOutline): string[] {
  if (outline?.planItems.length) {
    return outline.planItems.map((item) => `- ${item}`);
  }
  const files = context.files.map((file) => file.path.toLowerCase());
  const topFiles = context.files.slice(0, 4).map((file) => `\`${file.path}\``);
  const bullets: string[] = [];
  if (!files.length) {
    bullets.push('- Base the plan on the inspected repository evidence and keep the scope narrow.');
  } else {
    bullets.push(`- Ground the plan in ${formatList(topFiles)}.`);
  }
  if (files.some((file) => /route|app\/api|server/.test(file))) bullets.push('- Keep the change within the existing API or orchestration boundary.');
  if (files.some((file) => /component|ui|panel|workspace|editor/.test(file))) bullets.push('- Keep the user-facing work aligned with the current Code Space surface.');
  if (files.some((file) => /markdown|preview|renderer|asset|path/.test(file))) bullets.push('- Keep markdown and preview behavior aligned with the shared helpers.');
  if (files.some((file) => /test|spec|vitest|playwright/.test(file))) bullets.push('- Preserve the nearby test surface that already covers this seam.');
  if (/preview|editor|toggle|markdown/i.test(prompt)) bullets.push('- Preserve tab-scoped preview behavior for markdown-related changes.');
  return bullets.length ? bullets : ['- Reuse the inspected implementation seam and keep the work incremental.'];
}

function buildPlanTestPlans(validation: Awaited<ReturnType<typeof detectValidationCommands>>): string[] {
  return validation.commands.length
    ? validation.commands.map((command) => `- ${command.command} — ${command.reason}`)
    : ['- Manual review — no project-specific validation command was detected.'];
}

function buildPlanAssumptions(context: ContextSearchResult, answers: PlanClarificationAnswer[]): string[] {
  if (answers.length) {
    return answers.map((answer, index) => `- Input ${index + 1}: ${answer.answer}`);
  }
  const hasMarkdownSurface = context.files.some((file) => /markdown|preview|renderer/.test(file.path.toLowerCase()));
  return [
    '- The implementation should preserve the narrowest safe scope and avoid introducing a second workflow path unless the inspected code requires it.',
    hasMarkdownSurface
      ? '- Shared markdown rendering should remain the source of truth for preview behavior so Code Space and other markdown surfaces stay aligned.'
      : '- The plan should stay grounded in the inspected repository evidence and treat the current boundary as the default integration point.',
  ];
}

export function buildStrategyDocument({ projectName, prompt, context, validation, codeMode: _codeMode, reason, answers = [], workflowOutline }: { projectName: string; prompt: string; context: ContextSearchResult; validation: Awaited<ReturnType<typeof detectValidationCommands>>; codeMode: boolean; reason?: string; answers?: PlanClarificationAnswer[]; workflowOutline?: WorkflowOutline }): string {
  const summary = buildPlanSummary(prompt, context, answers, workflowOutline);
  const keyChanges = buildPlanKeyChanges(context, prompt, workflowOutline);
  const testPlans = buildPlanTestPlans(validation);
  const assumptions = buildPlanAssumptions(context, answers);
  const notice = reason?.trim() ? [`- ${reason.trim()}`] : [];
  // Motivation vs Logic: keep the fallback plan artifact aligned with the exact markdown template so the
  // model-backed and deterministic paths both produce the same structural contract for Plan mode.
  return [
    `# Code Space Plan — ${projectName}`,
    '',
    '## Summary',
    summary,
    '',
    '## Key Changes',
    ...keyChanges,
    '',
    '## Test Plans',
    ...testPlans,
    '',
    '## Assumptions',
    ...assumptions,
    '',
    ...(notice.length ? ['## Notice', ...notice, ''] : []),
  ].join('\n');
}

// Root Cause vs Logic: earlier workflow text was synthesized from fixed heuristics, which meant the runtime could
// promise plan steps or clarifying questions before it had actually reasoned over the inspected evidence.
async function generateWorkflowOutline(
  root: string,
  request: AgentRequest,
  prompt: string,
  intents: string[],
  context: ContextSearchResult,
  mode: CodeSpaceAgentMode,
): Promise<WorkflowOutline> {
  const credentials = await resolveProviderCredentials(root, request);
  if (!credentials.apiKey && request.providerId !== 'local') {
    return { intentSummary: '', planItems: [], clarifyingQuestions: [] };
  }

  const evidence = context.files
    .slice(0, 12)
    .map((file) => [`--- FILE ${file.path} (${file.summary}) ---`, file.content.slice(0, 2500), file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        'You are Code Space, synthesizing a workflow outline from repository evidence and the user request. ' +
        'Return only JSON. No markdown, no code fences, no commentary. ' +
        'Infer the user intent from the prompt and the inspected files before choosing any implementation steps or clarifications. ' +
        'Only ask clarifying questions when the evidence still leaves a meaningful implementation ambiguity. ' +
        'Keep plan items concrete, short, and action-oriented. They should reflect actual next steps implied by the repo evidence, not generic workflow templates. ' +
        'Do not emit architecture MCQs unless the evidence really points to multiple plausible implementation boundaries. ' +
        'When you do ask clarifying questions, keep each question tied to a concrete decision that blocks implementation.',
    },
    {
      role: 'user' as const,
      content: [
        `Mode: ${mode}`,
        `Prompt: ${prompt}`,
        `Intents: ${intents.join(', ') || '(none)'}`,
        '',
        'Observed repository evidence:',
        evidence || '(No readable evidence was found.)',
      ].join('\n'),
    },
  ];

  try {
    const outline = await chatStructuredWithRetry(
      { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' },
      messages,
      {
        jsonSchema: WORKFLOW_OUTLINE_SCHEMA,
        schema: WorkflowOutlineSchema,
      },
    );

    return {
      intentSummary: outline.intent_summary.trim(),
      planItems: outline.plan_items.map((item) => item.trim()).filter(Boolean).slice(0, 6),
      clarifyingQuestions: outline.clarifying_questions
        .map((question) => ({
          id: question.id.trim(),
          question: question.question.trim(),
          choices: question.choices.map((choice) => choice.trim()).filter(Boolean).slice(0, 5),
          allowMultiple: question.allowMultiple,
        }))
        .filter((question) => question.question && question.choices.length >= 2)
        .slice(0, 6),
    };
  } catch {
    return { intentSummary: '', planItems: [], clarifyingQuestions: [] };
  }
}

async function proposeAutonomousPatch(root: string, prompt: string, context: ContextSearchResult, request: AgentRequest): Promise<{ summary: string; files: ProposedPatchFile[] }> {
  const modelResult = await callPatchPlannerModel(root, prompt, context, request).catch((error) => deterministicPlannerResult(error));
  const files: ProposedPatchFile[] = [];
  for (const file of modelResult.files ?? []) {
    const relativePath = normalizeRelativePath(file.path);
    if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) continue;
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    let beforeContent = '';
    let fileExists = true;
    try {
      beforeContent = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fileExists = false;
    }
    const deleted = shouldDeleteFile(prompt, file, fileExists);
    if (!deleted && beforeContent === file.afterContent) continue;
    const diagnostics = deleted ? [] : validateSyntaxLightweight(relativePath, file.afterContent);
    const firstDiagnostic = diagnostics[0];
    if (firstDiagnostic) throw new Error(`Generated patch for ${relativePath} failed syntax pre-validation: ${firstDiagnostic.message}`);
    // Root Cause vs Logic: deletes used to collapse into empty afterContent, which left the file on disk; keep an explicit delete flag so the apply path can remove the path instead of rewriting it empty.
    files.push({
      path: relativePath,
      beforeContent,
      afterContent: file.afterContent,
      deleted,
      explanation: file.explanation || modelResult.summary || 'Code change',
      unifiedDiff: createUnifiedDiff(relativePath, beforeContent, deleted ? '' : file.afterContent),
    });
  }
  return { summary: modelResult.summary || 'Planning completed.', files };
}

async function callPatchPlannerModel(root: string, prompt: string, context: ContextSearchResult, request: AgentRequest): Promise<PatchModelResult> {
  const credentials = await resolveProviderCredentials(root, request);
  if (!credentials.apiKey && request.providerId !== 'local') return { summary: 'The selected model provider is not configured yet.', files: [] };
  const system = [
    'You are Code Space Autonomous Patch Planner.',
    'Choose files from repository evidence. Do not ask the user to provide an exact @File.',
    'Return only JSON. No markdown. No code fences.',
    'Schema: {"summary":"string","files":[{"path":"relative/path","afterContent":"complete full file content","deleted":false,"explanation":"why changed"}],"validationCommands":["optional command"]}.',
    'Preserve existing style, keep the smallest safe change, and include complete afterContent for every changed or new file. If the task removes a file, set deleted:true and leave afterContent empty instead of simulating deletion by blanking the file.',
    REFACTOR_WORKFLOW,
    TERMINAL_DECISION_GUIDE,
  ].join('\n');
  const contextBlock = context.files.map((file) => [`--- FILE ${file.path} (${file.summary}) ---`, file.content, file.truncated ? '\n[TRUNCATED]' : ''].join('\n')).join('\n\n');
  const user = [`Task: ${prompt}`, '', 'Repository evidence:', contextBlock].join('\n');
  const text = await chatWithRetry(
    { id: request.providerId, model: request.model, endpoint: credentials.endpoint, apiKey: credentials.apiKey || 'local' },
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  );
  return parsePlannerJson(text);
}

async function resolveProviderCredentials(root: string, request: AgentRequest): Promise<{ apiKey: string; endpoint?: string; source: string }> {
  const env = await loadWorkspaceEnv(root);
  const endpoint = request.endpoint ?? providerEndpointFromEnv(request.providerId, env);
  if (request.apiKey) return { apiKey: request.apiKey, endpoint, source: 'ui' };
  for (const key of providerApiKeyNames(request.providerId)) {
    const value = env[key] ?? process.env[key];
    if (value) return { apiKey: value, endpoint, source: key };
  }
  return { apiKey: '', endpoint, source: 'missing' };
}

function providerEndpointFromEnv(provider: ProviderId, env: Record<string, string>): string | undefined {
  const read = (keys: string[]) => keys.map((key) => env[key] ?? process.env[key]).find(Boolean);
  if (provider === 'foundry') return read(['FOUNDRY_ENDPOINT', 'AZURE_AI_FOUNDRY_ENDPOINT', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_BASE_URL']);
  if (provider === 'anthropic') return read(['ANTHROPIC_BASE_URL', 'ANTHROPIC_ENDPOINT']);
  if (provider === 'gemini') return read(['GEMINI_BASE_URL', 'GOOGLE_GENERATIVE_AI_BASE_URL']);
  if (provider === 'grok') return read(['XAI_BASE_URL', 'GROK_BASE_URL']);
  if (provider === 'local') return read(['LOCAL_MODEL_BASE_URL', 'LOCAL_BASE_URL', 'OLLAMA_BASE_URL', 'LM_STUDIO_BASE_URL', 'OPENAI_BASE_URL']);
  return read(['OPENAI_BASE_URL', 'OPENAI_ENDPOINT']);
}

function providerApiKeyNames(provider: ProviderId): string[] {
  if (provider === 'anthropic') return ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];
  if (provider === 'openai') return ['OPENAI_API_KEY'];
  if (provider === 'gemini') return ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  if (provider === 'grok') return ['XAI_API_KEY', 'GROK_API_KEY'];
  if (provider === 'foundry') return ['FOUNDRY_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_AI_FOUNDRY_API_KEY'];
  return ['LOCAL_API_KEY', 'OLLAMA_API_KEY', 'LM_STUDIO_API_KEY'];
}

async function loadWorkspaceEnv(root: string): Promise<Record<string, string>> {
  const files = ['.env.local', '.env', '.env.development.local', '.env.development', 'backend/.env.local', 'backend/.env', 'api/.env.local', 'api/.env', 'server/.env.local', 'server/.env'];
  const env: Record<string, string> = {};
  for (const file of files) {
    const absolute = path.resolve(root, file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      Object.assign(env, parseEnv(await fs.readFile(absolute, 'utf8')));
    } catch {}
  }
  return env;
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (typeof key !== 'string' || typeof rawValue !== 'string') continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

async function deterministicPlannerResult(error: unknown): Promise<PatchModelResult> {
  const message = error instanceof Error ? error.message : String(error);
  return { summary: message, files: [], unableReason: message };
}

async function applyGeneratedPatch({ root, projectId, runId, files }: { root: string; projectId: string; runId: string; files: ProposedPatchFile[] }): Promise<{ checkpoint: Awaited<ReturnType<typeof createFileCheckpoint>> | null; files: AppliedFileResult[] }> {
  if (!files.length) return { checkpoint: null, files: [] };
  const checkpoint = await createFileCheckpoint({ projectId, projectRoot: root, runId, reason: 'before autonomous Code mode apply', files: files.map((file) => file.path) });
  const applied: AppliedFileResult[] = [];
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes project root: ${file.path}`);
    let current = '';
    try {
      current = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (file.deleted) {
      const fileExists = await exists(target);
      if (current && current !== file.beforeContent) throw new Error(`Patch conflict in ${file.path}. File changed before autonomous apply.`);
      if (!fileExists) {
        applied.push({ path: file.path, hash: createHash('sha256').update(`deleted:${file.path}`).digest('hex'), unifiedDiff: file.unifiedDiff, explanation: file.explanation, deleted: true });
        continue;
      }
      await fs.rm(target, { force: false, recursive: true });
      applied.push({ path: file.path, hash: createHash('sha256').update(`deleted:${file.path}`).digest('hex'), unifiedDiff: file.unifiedDiff, explanation: file.explanation, deleted: true });
      continue;
    }
    if (current !== file.beforeContent) throw new Error(`Patch conflict in ${file.path}. File changed before autonomous apply.`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.afterContent, 'utf8');
    applied.push({ path: file.path, hash: createHash('sha256').update(file.afterContent).digest('hex'), unifiedDiff: file.unifiedDiff, explanation: file.explanation });
  }
  return { checkpoint, files: applied };
}

function parsePlannerJson(raw: string): PatchModelResult {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  const parsed = JSON.parse(candidate) as Partial<PatchModelResult>;
  return {
    summary: String(parsed.summary ?? parsed.unableReason ?? 'Patch planner returned a response.'),
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
    validationCommands: Array.isArray(parsed.validationCommands) ? parsed.validationCommands.map(String) : undefined,
    unableReason: parsed.unableReason ? String(parsed.unableReason) : undefined,
  };
}

function shouldDeleteFile(prompt: string, file: { path: string; afterContent: string; deleted?: boolean; explanation: string }, fileExists: boolean): boolean {
  if (file.deleted) return true;
  if (!fileExists) return false;
  if (file.afterContent.trim().length > 0) return false;
  return /\b(delete|remove|unlink|rm|erase|drop)\b/i.test(`${prompt} ${file.explanation} ${file.path}`);
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}
