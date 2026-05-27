import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { classifyCodeSpaceIntent, type CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { normalizeCodeSpaceAgentMode, type CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { createAgentEvent, createDefaultToolRegistry, createFileCheckpoint, encodeSseEvent, getEventStore } from '@/lib/code-space/runtime';
import type { AgentEventType } from '@/lib/code-space/runtime';
import { createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { chatWithRetry } from '@/lib/agent/providers';
import { guardPath } from '@/lib/security/pathGuard';

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

        const plan = buildPlan(mode, intents, promptForContext);
        emit({ type: 'plan_created', items: plan });
        await emitRuntime('plan.created', { items: plan });
        plan.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));

        await emitTool('classify_task', { prompt: promptForContext, intents, mode }, async () => ({ intents, mode, modeContract: describeModeContract(mode) }));
        emit({ type: 'todo_updated', todoId: `todo:${runId}:0`, done: true });

        const context = await emitTool('context_search', { openTabs, attachments, tools: registry.list().map((tool) => tool.name) }, async () =>
          collectProjectContext(guarded.resolved, promptForContext, openTabs, attachments),
        );
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path), summaries: context.files.map((file) => ({ path: file.path, summary: file.summary })), terms: context.terms, attachments });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const validation = await emitTool('validation_strategy', { mode, changedPaths: context.files.map((file) => file.path) }, async () => detectValidationCommands(guarded.resolved));
        emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });

        let filesChanged: string[] = [];
        let answer = '';

        if (mode === 'ask') {
          answer = await buildAskResponse(guarded.resolved, projectName, latestUserMessage.content, context, validation, body.data);
        } else if (mode === 'plan') {
          const clarificationAnswers = extractPlanClarificationAnswers(messages);
          const questions = buildClarifyingQuestions(planningPrompt, intents, context);
          const shouldAskClarification = questions.length > 0 && clarificationAnswers.length === 0;
          if (shouldAskClarification) {
            emit({ type: 'clarifying_questions_created', questions });
            await emitRuntime('plan.clarification.created', { questions: questions.map((question) => question.question) });
            answer = buildPlanClarificationResponse(projectName, context, questions);
          } else {
            const planArtifact = await emitTool('write_plan_artifact', { projectName, prompt: planningPrompt, inspectedFiles: context.files.map((file) => file.path), answers: clarificationAnswers }, async () =>
              writePlanArtifact(guarded.resolved, sessionId, projectName, planningPrompt, context, validation, clarificationAnswers),
            );
            filesChanged = [planArtifact.filePath];
            emit({ type: 'plan_markdown_created', filePath: planArtifact.filePath, content: planArtifact.content });
            answer = buildPlanResponse(projectName, planArtifact.filePath, context, validation);
          }
        } else {
          const proposal = await emitTool('autonomous_patch_planner', { provider: body.data.providerId, model: body.data.model, prompt: latestUserMessage.content, contextFiles: context.files.map((file) => file.path), folderScopes: attachments.filter((item) => item.kind === 'folder').map((item) => item.relativePath) }, async () =>
            proposeAutonomousPatch(guarded.resolved, latestUserMessage.content, context, body.data),
          );
          const applied = await emitTool('apply_autonomous_patch', { files: proposal.files.map((file) => file.path), checkpointed: true }, async () =>
            applyGeneratedPatch({ root: guarded.resolved, projectId: projectName, runId, files: proposal.files }),
          );
          for (const file of proposal.files) {
            emit({ type: 'diff_proposed', diffId: `patch:${runId}:${file.path}`, filePath: file.path, oldContent: file.beforeContent, newContent: file.afterContent, deleted: file.deleted, explanation: file.explanation, unifiedDiff: file.unifiedDiff, autoApplied: true });
            await emitRuntime('patch.proposed', { path: file.path, explanation: file.explanation, autoApplied: true });
          }
          for (const file of applied.files) {
            emit({ type: 'file_applied', filePath: file.path, deleted: file.deleted, explanation: file.explanation, unifiedDiff: file.unifiedDiff, hash: file.hash });
            await emitRuntime('patch.applied', { path: file.path, hash: file.hash });
          }
          filesChanged = proposal.files.map((file) => file.path);
          answer = buildCodeResponse(projectName, proposal.files, validation, proposal.summary, applied.checkpoint?.snapshotRef);
        }

        for (const chunk of chunkText(answer)) {
          emit({ type: 'text_delta', delta: chunk });
          await emitRuntime('message.assistant.delta', { text: chunk });
        }
        await emitRuntime('message.assistant.completed', { content: answer });

        const validationStatus = mode === 'code' && filesChanged.length ? 'skipped' : 'passed';
        emit({
          type: 'validation_result',
          id: `validation:${runId}:strategy`,
          command: validation.commands.map((command) => command.command).join(', ') || 'validation strategy discovery',
          status: validationStatus,
          output: mode === 'code' && filesChanged.length ? 'Changes were applied with checkpoint protection. Run validation commands against the updated workspace.' : `Detected ${validation.commands.length} validation command(s).`,
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

export function buildPlan(mode: CodeSpaceAgentMode, intents: string[], prompt: string): string[] {
  if (mode === 'ask') return ['Understand the question', 'Gather relevant project context', 'Answer directly'];
  if (mode === 'plan') return ['Understand the implementation goal', 'Inspect files and summarize existing behavior', 'Clarify critical decisions when needed', 'Write the final editable plan'];
  if (isRefactorTask(prompt, intents)) return ['Inspect the current file, imports, exports, and references', 'Move or rename files on disk with shell-native operations instead of duplicating them', 'Search and repair every affected importer, export, and test', 'Run validation commands to confirm the refactor compiles cleanly'];
  const complex = shouldUseMultiAgent(prompt, intents);
  return ['Understand the requested change', complex ? 'Explore likely implementation paths' : 'Inspect relevant source and tests', 'Apply the smallest safe change', 'Report changed files and validation'];
}

export function buildClarifyingQuestions(prompt = '', intents: string[] = [], context?: ContextSearchResult): CodeSpaceClarifyingQuestion[] {
  const text = prompt.toLowerCase();
  const questions: CodeSpaceClarifyingQuestion[] = [];
  const files = context?.files.map((file) => file.path) ?? [];
  const hasBackend = files.some((file) => /api|server|backend|route|controller|service/i.test(file));
  const hasFrontend = files.some((file) => /component|page|app|ui|style|css|tsx$/i.test(file));
  const featureLike = intents.some((intent) => ['feature_build', 'refactor', 'dependency/setup', 'styling/ui_change'].includes(intent));

  if (featureLike && (hasBackend || hasFrontend) && !/only|frontend|backend|api|full[- ]?stack|end[- ]?to[- ]?end/i.test(text)) {
    questions.push({
      id: 'implementation-boundary',
      question: 'Which implementation boundary should the plan optimize for?',
      choices: [
        'End-to-end vertical slice (Recommended) — plan UI, API/state, persistence, and validation together when the repo evidence supports it.',
        'Frontend-only — keep backend and data model behavior unchanged.',
        'Backend/core-only — expose behavior without changing user-facing UI yet.',
      ],
    });
  }

  if (/auth|payment|billing|database|migration|schema|external|integration|security|permission|delete|destructive/i.test(text)) {
    questions.push({
      id: 'risk-policy',
      question: 'How should risky or externally-coupled changes be handled?',
      choices: [
        'Safe staged rollout (Recommended) — isolate risky changes, add guards, and require explicit validation before broad rollout.',
        'Prototype behind a feature flag — ship inactive scaffolding first, then enable after review.',
        'Direct implementation — plan the full change now because the risk is already accepted.',
      ],
    });
  }

  if (/ui|design|layout|component|sidebar|panel|button|modal|responsive|ux/i.test(text)) {
    questions.push({
      id: 'ux-priority',
      question: 'What UX priority should guide implementation details?',
      choices: [
        'Production workflow clarity (Recommended) — concise status, clear actions, and no internal reasoning in chat.',
        'Maximum transparency — show more progress detail and diagnostics in expandable panels.',
        'Minimal surface change — preserve existing layout while fixing the requested behavior.',
      ],
    });
  }

  return questions.slice(0, 2);
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

async function collectProjectContext(root: string, prompt: string, openTabs: string[], attachments: AgentAttachment[] = []): Promise<ContextSearchResult> {
  const candidates = await fg(CONTEXT_GLOBS, { cwd: root, onlyFiles: true, dot: true, absolute: false, unique: true });
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
  const files: ContextFile[] = [];
  for (const item of selected) {
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
  return { filesConsidered: candidates.length, files, terms, omittedRelevantFiles: [] };
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

async function writePlanArtifact(root: string, sessionId: string, projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>, answers: PlanClarificationAnswer[] = []): Promise<{ filePath: string; content: string }> {
  const filePath = `.agent/plans/${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.md`;
  const absolute = path.join(root, filePath);
  const content = buildStrategyDocument({ projectName, prompt, context, validation, codeMode: false, answers });
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
  return { filePath, content };
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

function buildPlanResponse(projectName: string, planPath: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>): string {
  return [`Plan ready for ${projectName}.`, '', `View plan: ${planPath}`, '', `I inspected ${context.files.length} relevant file${context.files.length === 1 ? '' : 's'} and summarized the implementation surfaces in the plan. It includes concrete TODOs, validation commands, acceptance criteria, and remaining risks.`, '', `Primary validation: ${validation.commands.map((command) => command.command).join(', ') || 'manual review'}.`, '', 'Use Build when you are ready for Code mode to implement it.'].join('\n');
}

function buildCodeResponse(projectName: string, files: ProposedPatchFile[], validation: Awaited<ReturnType<typeof detectValidationCommands>>, summary?: string, checkpointRef?: string): string {
  if (!files.length) {
    return ['I could not safely make a code change yet.', '', userFacingPlannerSummary(summary), '', 'No files were changed.'].filter(Boolean).join('\n');
  }
  return [
    `Done — I updated ${files.length} file${files.length === 1 ? '' : 's'} in ${projectName}.`,
    '',
    'Changed:',
    ...files.map((file) => `- ${file.path}: ${file.explanation}`),
    '',
    checkpointRef ? 'A rollback checkpoint was created.' : 'The change was checkpointed before writing.',
    `Next: ${validation.commands.map((command) => command.command).join(', ') || 'run your usual validation'}.`,
  ].join('\n');
}

function userFacingPlannerSummary(summary?: string): string {
  if (!summary) return 'The planner did not return a concrete edit.';
  if (/OpenAI-compatible|Model-backed|404|Resource not found|API key|rate limit|cooling down|failed/i.test(summary)) {
    return 'The selected model provider was not available for this run, so I stopped instead of creating unrelated fallback files.';
  }
  return summary;
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

function buildStrategyDocument({ projectName, prompt, context, validation, codeMode, reason, answers = [] }: { projectName: string; prompt: string; context: ContextSearchResult; validation: Awaited<ReturnType<typeof detectValidationCommands>>; codeMode: boolean; reason?: string; answers?: PlanClarificationAnswer[] }): string {
  const evidence = formatInspectedEvidence(context);
  const architecture = buildCurrentArchitectureSummary(context, prompt);
  const implementationTasks = buildImplementationTodos(prompt, context);
  const riskItems = buildRiskItems(context, prompt);
  const clarifiedSection = answers.length ? ['## Clarified decisions', ...answers.map((answer) => `- **${answer.question}** ${answer.answer}`), ''] : [];
  const noteSection = reason ? ['## Note', reason, ''] : [];
  return [
    `# Code Space Plan — ${projectName}`,
    '',
    '## Request',
    prompt,
    '',
    ...noteSection,
    ...clarifiedSection,
    '## Context already inspected',
    'The agent inspected the repository files below before writing this plan. Each item is summarized by implementation responsibility rather than internal ranking metadata.',
    ...evidence,
    '',
    '## Current behavior inferred from the codebase',
    ...architecture,
    '',
    '## Recommended implementation strategy',
    ...buildRecommendedStrategy(prompt, context),
    '',
    '## TODO tasks',
    ...implementationTasks.map((task, index) => `${index + 1}. ${task}`),
    '',
    '## Testing and validation strategy',
    ...(validation.commands.length ? validation.commands.map((command) => `- ${command.command} — ${command.reason}`) : ['- Manual review — no project-specific validation command was detected.']),
    '- Add focused unit or integration coverage around the changed service boundary where an existing test pattern is present.',
    '- Run validation after each correction pass and record unresolved risks before marking the session complete.',
    '',
    '## Risks and acceptance criteria',
    ...riskItems,
    '',
    '## Definition of done',
    '- The final implementation follows the inspected service boundaries instead of introducing a parallel workflow.',
    '- Public user-facing chat remains concise while tool/audit details stay in structured panels or plan artifacts.',
    '- The plan can be opened directly in the Code Space editor through View plan.',
    '- Code mode can use this plan as the source of truth and apply checkpointed changes with validation.',
    '- Validation passes, or remaining failures are explicitly summarized with next actions.',
    '',
    codeMode ? '## Code behavior\nChanges should be applied through checkpointed Code mode.\n' : '## Plan behavior\nThis file is an editable planning artifact. Review or edit it before choosing Build.\n',
  ].join('\n');
}

function formatInspectedEvidence(context: ContextSearchResult): string[] {
  if (!context.files.length) return ['- No readable files were discovered before this plan was created.'];
  return context.files.slice(0, 32).map((file) => `- **${file.path}** — ${file.summary}`);
}

function buildCurrentArchitectureSummary(context: ContextSearchResult, prompt: string): string[] {
  const lines: string[] = [];
  const files = context.files.map((file) => file.path.toLowerCase());
  if (files.some((file) => /routes?|app/.test(file))) lines.push('- Request routing is handled through API entrypoints before reaching orchestration/search/retrieval services.');
  if (files.some((file) => /chatbot|coordinator|agent/.test(file))) lines.push('- Agent coordination appears separated from low-level retrieval/search utilities, so strategy changes should be introduced at the orchestration boundary rather than inside every engine.');
  if (files.some((file) => /search|engine|duckduckgo|medical|multilingual|video/.test(file))) lines.push('- Search capability is engine-oriented: query construction, external lookup, multilingual/medical specialization, extraction, and result post-processing are implemented as separate surfaces.');
  if (files.some((file) => /retrieval|evidence|source/.test(file))) lines.push('- Evidence/retrieval layers are responsible for ranking, provenance, grounding, and selecting context for the final response.');
  if (/web|search|evidence|api|lookup/i.test(prompt)) lines.push('- The requested improvement should therefore add a decision policy for when to search, how to expand queries, how to rank clinical evidence, and how to expose evidence provenance to downstream agents.');
  return lines.length ? lines : ['- The selected files define the implementation surfaces that should be changed; no reliable architecture summary could be inferred beyond the inspected evidence.'];
}

function buildRecommendedStrategy(prompt: string, context: ContextSearchResult): string[] {
  if (/search|web|evidence|clinical|lookup|api/i.test(prompt)) {
    return [
      '- Introduce a search decision policy that classifies the query intent, required freshness, clinical specificity, source quality requirement, and whether local retrieval is sufficient before web lookup.',
      '- Add a strategy layer between API/agent orchestration and concrete search engines so query expansion, engine choice, retries, and evidence ranking are deterministic and auditable.',
      '- Normalize search results into a shared clinical evidence contract with title, URL/source, date, source type, relevance score, quality tier, snippet, extracted content, and provenance metadata.',
      '- Feed normalized evidence into retrieval/evidence managers for reranking, deduplication, contradiction checks, and final context assembly instead of letting each engine shape output independently.',
      '- Keep provider/network failures recoverable: return partial evidence with warnings, avoid hallucinated citations, and preserve enough trace detail for the internal tool panel.',
    ];
  }
  return [
    '- Implement the change at the narrowest service boundary already present in the inspected code.',
    '- Preserve existing naming, configuration, and validation patterns from the inspected files.',
    '- Keep the user-facing workflow simple while keeping diagnostics available in internal panels and plan artifacts.',
  ];
}

function buildImplementationTodos(prompt: string, context: ContextSearchResult): string[] {
  const files = context.files.map((file) => file.path);
  const tasks: string[] = [];
  const routingFile = files.find((file) => /routes?\.py|app\.py|route\.ts/i.test(file));
  const coordinatorFile = files.find((file) => /coordinator|chatbot|agent|orchestrator/i.test(file));
  const searchFiles = files.filter((file) => /search|engine|duckduckgo|medical|multilingual|video/i.test(file)).slice(0, 5);
  const evidenceFile = files.find((file) => /evidence|retrieval|source/i.test(file));

  if (/search|web|evidence|clinical|lookup|api/i.test(prompt)) {
    tasks.push(`Map the request flow from ${routingFile ?? 'the API entrypoint'} into ${coordinatorFile ?? 'the agent/search coordinator'} and identify the exact hook where search strategy should be selected.`);
    tasks.push(`Design a typed SearchStrategy/EvidenceRequest contract covering freshness, clinical source quality, query expansion, engine selection, retries, and provenance.`);
    tasks.push(`Refactor ${searchFiles.join(', ') || 'the search engine modules'} so engine outputs normalize into one evidence schema before downstream ranking.`);
    tasks.push(`Update ${evidenceFile ?? 'the retrieval/evidence layer'} to consume normalized web evidence, deduplicate sources, score clinical reliability, and expose citations safely.`);
    tasks.push('Add tests for strategy selection, engine fallback, source normalization, deduplication, and clinical evidence ranking using mocked search responses.');
    tasks.push('Add concise user-facing failure behavior for no-results, stale evidence, low-quality sources, and provider/network timeouts.');
    return tasks;
  }

  tasks.push(`Use the inspected files (${files.slice(0, 6).join(', ') || 'selected project files'}) as the implementation boundary.`);
  tasks.push('Apply the change through the existing routing/state/service pattern rather than introducing a duplicate path.');
  tasks.push('Update tests, fixtures, or documentation where the inspected project pattern shows an existing validation surface.');
  tasks.push('Run validation and repair issues before summarizing completion.');
  return tasks;
}

function buildRiskItems(context: ContextSearchResult, prompt: string): string[] {
  const risks = ['- Acceptance: the implementation uses inspected files and does not create an unrelated parallel subsystem.'];
  if (/clinical|medical|evidence|citation|search|web/i.test(prompt)) {
    risks.push('- Acceptance: clinical/web evidence includes provenance, source quality, recency handling, and clear fallback behavior when evidence is insufficient.');
    risks.push('- Risk: external search providers may fail or return low-quality results; mitigation is deterministic fallback, partial-result handling, and internal trace capture.');
  }
  if (context.files.some((file) => file.truncated)) risks.push('- Risk: some large files were summarized from truncated content; Code mode should re-open the specific sections before editing them.');
  risks.push('- Acceptance: validation commands complete successfully or unresolved failures are listed with file-level next steps.');
  return risks;
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

function shouldUseMultiAgent(prompt: string, intents: string[]): boolean {
  return /architecture|multi[- ]?agent|agentic|migration|refactor|cursor|claude code|orchestration/i.test(prompt) || intents.includes('refactor') || intents.includes('feature_build');
}

function isRefactorTask(prompt: string, intents: string[]): boolean {
  return /(?:rename|move|relocat|reorgani[sz]e|folder|file|path|import|export)/i.test(prompt) && (intents.includes('refactor') || /(?:rename|move|folder|path)/i.test(prompt));
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
