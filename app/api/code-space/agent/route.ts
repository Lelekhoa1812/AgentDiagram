import { NextRequest } from 'next/server';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { classifyCodeSpaceIntent, type CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { normalizeCodeSpaceAgentMode, type CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { createAgentEvent, createDefaultToolRegistry, encodeSseEvent, getEventStore } from '@/lib/code-space/runtime';
import type { AgentEventType } from '@/lib/code-space/runtime';
import { createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
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
  explanation: string;
  unifiedDiff: string;
}

interface PatchModelResult {
  summary: string;
  files: Array<{ path: string; afterContent: string; explanation: string }>;
  validationCommands?: string[];
  unableReason?: string;
}

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const { messages, projectName, projectRoot, sessionId, toolBudget, openTabs, attachments } = body.data;
  const mode = normalizeCodeSpaceAgentMode(body.data.mode);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) {
    return Response.json({ error: 'A user message is required to start the agent.' }, { status: 400 });
  }

  const intents = classifyCodeSpaceIntent(latestUserMessage.content);
  const registry = createDefaultToolRegistry();
  const guarded = guardPath(projectRoot);
  if (!guarded.ok) {
    return Response.json({ error: guarded.reason ?? 'Invalid project path' }, { status: 400 });
  }

  const runId = `run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  const eventStore = getEventStore();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: AgentSSEEvent) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      };
      const emitRuntime = async (type: AgentEventType, payload: unknown) => {
        const event = await eventStore.append(
          createAgentEvent({ type, sessionId, runId, projectId: projectName, payload }),
        );
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

        const plan = buildPlan(mode, intents, latestUserMessage.content);
        emit({ type: 'plan_created', items: plan });
        await emitRuntime('plan.created', { items: plan });
        plan.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));

        await emitTool('classify_task', { prompt: latestUserMessage.content, intents, mode }, async () => ({ intents, mode, modeContract: describeModeContract(mode) }));
        emit({ type: 'todo_updated', todoId: `todo:${runId}:0`, done: true });

        const context = await emitTool('context_search', { openTabs, attachments, tools: registry.list().map((tool) => tool.name) }, async () =>
          collectProjectContext(guarded.resolved, latestUserMessage.content, openTabs, attachments),
        );
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path), terms: context.terms, attachments });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const validation = await emitTool('validation_strategy', { mode, changedPaths: context.files.map((file) => file.path) }, async () => detectValidationCommands(guarded.resolved));
        emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });

        let filesChanged: string[] = [];
        let answer = '';

        if (mode === 'ask') {
          answer = buildAskResponse(projectName, latestUserMessage.content, context, validation);
        } else if (mode === 'plan') {
          const planArtifact = await emitTool('write_plan_artifact', { projectName, prompt: latestUserMessage.content }, async () => writePlanArtifact(guarded.resolved, sessionId, projectName, latestUserMessage.content, context, validation));
          filesChanged = [planArtifact.filePath];
          emit({ type: 'plan_markdown_created', filePath: planArtifact.filePath, content: planArtifact.content });
          answer = buildPlanResponse(projectName, planArtifact.filePath, context, validation);
        } else {
          const proposal = await emitTool('autonomous_patch_planner', { prompt: latestUserMessage.content, contextFiles: context.files.map((file) => file.path), folderScopes: attachments.filter((item) => item.kind === 'folder').map((item) => item.relativePath) }, async () =>
            proposeAutonomousPatch(guarded.resolved, latestUserMessage.content, context, body.data),
          );
          if (proposal.files.length) {
            for (const file of proposal.files) {
              emit({
                type: 'diff_proposed',
                diffId: `patch:${runId}:${file.path}`,
                filePath: file.path,
                oldContent: file.beforeContent,
                newContent: file.afterContent,
                explanation: file.explanation,
                unifiedDiff: file.unifiedDiff,
              });
              await emitRuntime('patch.proposed', { path: file.path, explanation: file.explanation });
            }
            filesChanged = proposal.files.map((file) => file.path);
            answer = buildCodeResponse(projectName, proposal.files, validation, proposal.summary);
          } else {
            answer = buildNoPatchResponse(projectName, latestUserMessage.content, context, validation, proposal.summary);
          }
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
          output:
            mode === 'code' && filesChanged.length
              ? 'Patch proposed for review. Run validation after accepting the diff so checks execute against the updated workspace.'
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
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export function buildPlan(mode: CodeSpaceAgentMode, intents: string[], prompt: string): string[] {
  if (mode === 'ask') {
    return ['Classify read-only request', 'Autonomously discover relevant context', 'Answer with evidence and no file mutation'];
  }

  if (mode === 'plan') {
    return ['Classify implementation intent', 'Autonomously discover files, folders, and validation surfaces', 'Write a reusable planning artifact'];
  }

  const complex = shouldUseMultiAgent(prompt, intents);
  return [
    'Classify implementation request and blast radius',
    complex ? 'Run multi-agent style exploration checklist' : 'Autonomously explore source, tests, configs, and mentioned folders',
    'Let the agent choose target files and prepare the smallest reviewable patch',
    'Defer disk mutation until the user accepts the diff',
  ];
}

export function buildClarifyingQuestions(): CodeSpaceClarifyingQuestion[] {
  return [];
}

function describeModeContract(mode: CodeSpaceAgentMode): string {
  if (mode === 'ask') return 'Ask mode is read-only: inspect, explain, and cite evidence without creating patches.';
  if (mode === 'plan') return 'Plan mode creates a markdown implementation plan artifact and does not edit product source files.';
  return 'Code mode autonomously explores context, chooses target files, proposes reviewable diffs, and relies on checkpointed apply for mutation.';
}

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term)))).slice(0, 48);
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'can', 'into', 'from', 'mode', 'code', 'make', 'please', 'need']);
const CONTEXT_GLOBS = ['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs,java,kt,php,rb,sh,yml,yaml,toml}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**', '!coverage/**', '!__pycache__/**'];

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
    add(/(__tests__|\.test\.|\.spec\.|tests?\/)/i.test(normalizedFile) ? 10 : 0, 'test surface');
    return { file: normalizedFile, score, reasons };
  });

  const explicitFolderFiles = scored.filter((item) => item.reasons.some((reason) => reason.startsWith('@Folder scope'))).slice(0, 40);
  const selected = [...explicitFolderFiles, ...scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))]
    .filter((item, index, arr) => arr.findIndex((other) => other.file === item.file) === index)
    .slice(0, 32);

  const files: ContextFile[] = [];
  for (const item of selected) {
    const absolute = path.resolve(root, item.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const content = await fs.readFile(absolute, 'utf8');
      files.push({ path: item.file, content: content.slice(0, 18_000), truncated: content.length > 18_000, lineCount: content.split('\n').length, score: item.score, reasons: item.reasons });
    } catch {}
  }

  return { filesConsidered: candidates.length, files, terms, omittedRelevantFiles: [] };
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
    if (await hasAny(root, ['tests', 'test', `${pythonRoot}/tests`, `${pythonRoot}/test`, 'pytest.ini', 'pyproject.toml'])) {
      commands.push({ kind: 'test', command: `${prefix}python -m pytest`, reason: 'Python pytest validation appears available.' });
    }
  }

  if (!commands.length && (await hasAny(root, ['go.mod']))) {
    commands.push({ kind: 'test', command: 'go test ./...', reason: 'Go module validation is available.' });
  }

  if (!commands.length) {
    commands.push({ kind: 'typecheck', command: 'manual review', reason: 'No project-specific validation command was detected; review the proposed diff manually.' });
  }

  return { commands, packageManager };
}

async function findFirst(root: string, relativePaths: string[]): Promise<string | null> {
  for (const relativePath of relativePaths) {
    if (await exists(path.join(root, relativePath))) return relativePath.includes('/') ? relativePath : `./${relativePath}`.replace(/^\.\//, '');
  }
  return null;
}

async function hasAny(root: string, relativePaths: string[]): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await exists(path.join(root, relativePath))) return true;
  }
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

async function writePlanArtifact(root: string, sessionId: string, projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>): Promise<{ filePath: string; content: string }> {
  const filePath = `.agent/plans/${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.md`;
  const absolute = path.join(root, filePath);
  const content = [
    `# Code Space Plan — ${projectName}`,
    '',
    '## User request',
    prompt,
    '',
    '## Definition of Done',
    '- The agent chooses implementation files autonomously from repository evidence; users may narrow scope with @File or @Folder, but are not required to.',
    '- Every edited file is read before patch proposal.',
    '- Syntax pre-validation passes before disk write.',
    '- Checkpoint is created before apply, with restore available.',
    '- Typecheck, lint, tests, and build are run when available after acceptance.',
    '',
    '## Evidence reviewed',
    ...(context.files.length ? context.files.map((file) => `- ${file.path} (${file.lineCount} lines${file.truncated ? ', truncated' : ''}; ${file.reasons.join(', ') || 'selected'})`) : ['- No source files selected.']),
    '',
    '## Implementation sequence',
    '1. Explore @Folder scopes, @File scopes, open tabs, tests, configs, and prompt-matching files.',
    '2. Let the model choose the mutation targets from the discovered evidence.',
    '3. Generate exact reviewable diffs.',
    '4. Preview patch and run syntax pre-validation.',
    '5. Request user diff approval.',
    '6. Apply with checkpoint and run validation commands.',
    '7. Self-heal failures with additional surgical patches.',
    '',
    '## Validation commands',
    ...(validation.commands.length ? validation.commands.map((command) => `- ${command.command} — ${command.reason}`) : ['- No package validation commands detected.']),
    '',
    '## Rollback',
    '- Use the checkpoint restore endpoint for any accepted patch that corrupts the workspace.',
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
  return { filePath, content };
}

function buildAskResponse(projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>): string {
  return [
    'Mode: Ask',
    '',
    `For ${projectName}, I autonomously inspected relevant project context without mutating files.`,
    '',
    'Evidence reviewed:',
    ...(context.files.length ? context.files.slice(0, 12).map((file) => `- ${file.path}`) : ['- No readable source files were selected.']),
    '',
    `Request interpreted as: ${prompt}`,
    '',
    `Available validation: ${validation.commands.map((command) => command.command).join(', ') || 'none detected'}.`,
    '',
    'Ask mode is read-only. Switch to Plan for an implementation plan or Code for a reviewable patch.',
  ].join('\n');
}

function buildPlanResponse(projectName: string, planPath: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>): string {
  return [
    'Mode: Plan',
    '',
    `Created an implementation plan for ${projectName}:`,
    `- ${planPath}`,
    '',
    'The plan includes autonomous context discovery, DoDs, implementation sequence, validation gates, and rollback expectations.',
    '',
    `Context files considered: ${context.files.length}. Validation commands: ${validation.commands.length}.`,
  ].join('\n');
}

function buildCodeResponse(projectName: string, files: ProposedPatchFile[], validation: Awaited<ReturnType<typeof detectValidationCommands>>, summary?: string): string {
  return [
    'Mode: Code',
    '',
    `Prepared ${files.length} autonomous, reviewable patch proposal(s) for ${projectName}.`,
    summary ? `\nPlanner summary: ${summary}\n` : '',
    'Proposed files:',
    ...files.map((file) => `- ${file.path}: ${file.explanation}`),
    '',
    'No disk mutation has occurred yet. Accept the diff to apply through the checkpointed patch API.',
    '',
    `After acceptance, run: ${validation.commands.map((command) => command.command).join(', ') || 'manual validation'}.`,
  ].join('\n');
}

function buildNoPatchResponse(projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>, summary?: string): string {
  return [
    'Mode: Code',
    '',
    `For ${projectName}, I explored the codebase autonomously but did not produce a safe patch proposal.`,
    summary ? `Planner summary: ${summary}` : '',
    '',
    'Evidence reviewed:',
    ...(context.files.length ? context.files.slice(0, 12).map((file) => `- ${file.path}`) : ['- No readable source files were selected.']),
    '',
    `Request: ${prompt}`,
    '',
    'The agent no longer requires an exact @File. Use @Folder only when you want to narrow the autonomous search scope to a directory.',
    `Available validation: ${validation.commands.map((command) => command.command).join(', ') || 'none detected'}.`,
  ].join('\n');
}

async function proposeAutonomousPatch(root: string, prompt: string, context: ContextSearchResult, request: AgentRequest): Promise<{ summary: string; files: ProposedPatchFile[] }> {
  if (!context.files.length) return { summary: 'No readable files were discovered in the workspace.', files: [] };

  const modelResult = await callPatchPlannerModel(prompt, context, request).catch((error) => ({
    summary: `Model-backed patch planning failed: ${error instanceof Error ? error.message : String(error)}`,
    files: [] as PatchModelResult['files'],
    unableReason: 'model_failed',
  }));

  const files: ProposedPatchFile[] = [];
  for (const file of modelResult.files ?? []) {
    const relativePath = normalizeRelativePath(file.path);
    if (!relativePath || relativePath.startsWith('../') || relativePath.includes('/../')) continue;
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    let beforeContent = '';
    try {
      beforeContent = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (beforeContent === file.afterContent) continue;
    const diagnostics = validateSyntaxLightweight(relativePath, file.afterContent);
    if (diagnostics.length) throw new Error(`Generated patch for ${relativePath} failed syntax pre-validation: ${diagnostics[0].message}`);
    files.push({
      path: relativePath,
      beforeContent,
      afterContent: file.afterContent,
      explanation: file.explanation || modelResult.summary || 'Autonomous code patch',
      unifiedDiff: createUnifiedDiff(relativePath, beforeContent, file.afterContent),
    });
  }

  return { summary: modelResult.summary || modelResult.unableReason || 'Autonomous patch planner completed.', files };
}

async function callPatchPlannerModel(prompt: string, context: ContextSearchResult, request: AgentRequest): Promise<PatchModelResult> {
  if (!request.apiKey && request.providerId !== 'local') {
    return { summary: 'No provider API key is configured, so autonomous code generation cannot call a model yet.', files: [], unableReason: 'missing_api_key' };
  }

  const system = [
    'You are Code Space Autonomous Patch Planner.',
    'You are allowed to choose files yourself from repository evidence. Do not ask the user to provide an exact @File.',
    'If @Folder context is present, treat it as an exact directory scope and prefer files inside it.',
    'Return only JSON. No markdown. No code fences.',
    'Schema: {"summary":"string","files":[{"path":"relative/path","afterContent":"complete full file content","explanation":"why changed"}],"validationCommands":["optional command"]}.',
    'Rules: preserve existing style, keep the smallest safe change, and include complete afterContent for every changed or new file.',
  ].join('\n');
  const contextBlock = context.files
    .map((file) => [`--- FILE ${file.path} (${file.reasons.join(', ') || 'selected'}) ---`, file.content, file.truncated ? '\n[TRUNCATED]' : ''].join('\n'))
    .join('\n\n');
  const user = [`Task: ${prompt}`, '', 'Repository evidence:', contextBlock].join('\n');

  if (request.providerId === 'anthropic') {
    const response = await fetch(request.endpoint ?? 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': request.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 8096,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic patch planner failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    return parsePlannerJson(json.content?.map((block) => block.text ?? '').join('\n') ?? '');
  }

  const baseUrl = request.providerId === 'local' ? request.endpoint || 'http://localhost:11434/v1' : request.endpoint || 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: request.model,
      temperature: request.localTemperature ?? 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI-compatible patch planner failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parsePlannerJson(json.choices?.[0]?.message?.content ?? '');
}

function parsePlannerJson(raw: string): PatchModelResult {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(trimmed) as Partial<PatchModelResult>;
  return {
    summary: String(parsed.summary ?? parsed.unableReason ?? 'Patch planner returned a response.'),
    files: Array.isArray(parsed.files)
      ? parsed.files
          .filter((file) => file && typeof file.path === 'string' && typeof file.afterContent === 'string')
          .map((file) => ({ path: file.path, afterContent: file.afterContent, explanation: String(file.explanation ?? 'Autonomous patch') }))
      : [],
    validationCommands: Array.isArray(parsed.validationCommands) ? parsed.validationCommands.map(String) : undefined,
    unableReason: parsed.unableReason ? String(parsed.unableReason) : undefined,
  };
}

function shouldUseMultiAgent(prompt: string, intents: string[]): boolean {
  return /architecture|multi[- ]?agent|agentic|migration|refactor|cursor|claude code|orchestration/i.test(prompt) || intents.includes('refactor') || intents.includes('feature_build');
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}
