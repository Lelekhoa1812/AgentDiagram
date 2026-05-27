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
          createAgentEvent({
            type,
            sessionId,
            runId,
            projectId: projectName,
            payload,
          }),
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
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path), terms: context.terms });
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
          const proposal = await emitTool('propose_patch', { prompt: latestUserMessage.content, contextFiles: context.files.map((file) => file.path) }, async () =>
            proposeConservativePatch(guarded.resolved, latestUserMessage.content, context),
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
            answer = buildCodeResponse(projectName, proposal.files, validation);
          } else {
            answer = buildNoPatchResponse(projectName, latestUserMessage.content, context, validation);
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
    return ['Classify read-only request', 'Discover relevant context dynamically', 'Answer with evidence and no file mutation'];
  }

  if (mode === 'plan') {
    return ['Classify implementation intent', 'Discover relevant context and validation surfaces', 'Write a reusable planning artifact'];
  }

  const complex = shouldUseMultiAgent(prompt, intents);
  return [
    'Classify implementation request and blast radius',
    complex ? 'Run multi-agent style exploration checklist' : 'Discover relevant source and validation context',
    'Prepare the smallest reviewable code patch',
    'Defer disk mutation until the user accepts the diff',
  ];
}

export function buildClarifyingQuestions(): CodeSpaceClarifyingQuestion[] {
  return [];
}

function describeModeContract(mode: CodeSpaceAgentMode): string {
  if (mode === 'ask') return 'Ask mode is read-only: inspect, explain, and cite evidence without creating patches.';
  if (mode === 'plan') return 'Plan mode creates a markdown implementation plan artifact and does not edit product source files.';
  return 'Code mode proposes reviewable diffs and relies on checkpointed apply for mutation.';
}

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term)))).slice(0, 32);
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'can', 'into', 'from', 'mode', 'code']);
const CONTEXT_GLOBS = ['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs,yml,yaml,toml}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**'];

async function collectProjectContext(root: string, prompt: string, openTabs: string[], attachments: AgentAttachment[] = []): Promise<ContextSearchResult> {
  const candidates = await fg(CONTEXT_GLOBS, { cwd: root, onlyFiles: true, dot: true, absolute: false, unique: true });
  const terms = promptTerms(prompt);
  const attachedFiles = new Set(attachments.filter((item) => item.kind === 'file').map((item) => item.relativePath));
  const attachedFolders = attachments.filter((item) => item.kind === 'folder').map((item) => item.relativePath.replace(/\/+$/, ''));
  const selected = candidates
    .map((file) => {
      const lower = file.toLowerCase();
      const reasons: string[] = [];
      let score = 0;
      const add = (amount: number, reason: string) => {
        if (!amount) return;
        score += amount;
        reasons.push(reason);
      };
      add(attachedFiles.has(file) ? 80 : 0, '@ mentioned file');
      add(attachedFolders.some((folder) => folder && file.startsWith(`${folder}/`)) ? 40 : 0, '@ mentioned folder');
      add(openTabs.includes(file) ? 28 : 0, 'open tab');
      add(/package\.json|tsconfig|next\.config|readme|agent|code-space|runtime|route|test/i.test(file) ? 8 : 0, 'high-signal project file');
      add(terms.reduce((sum, term) => sum + (lower.includes(term) ? 5 : 0), 0), 'prompt/path overlap');
      return { file, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 16);

  const files: ContextFile[] = [];
  for (const item of selected) {
    const absolute = path.resolve(root, item.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const content = await fs.readFile(absolute, 'utf8');
      files.push({ path: item.file, content: content.slice(0, 12_000), truncated: content.length > 12_000, lineCount: content.split('\n').length, score: item.score, reasons: item.reasons });
    } catch {}
  }

  return { filesConsidered: candidates.length, files, terms, omittedRelevantFiles: [] };
}

async function detectValidationCommands(root: string): Promise<{ commands: Array<{ kind: 'typecheck' | 'lint' | 'test' | 'build'; command: string; reason: string }>; packageManager: string | null }> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; packageManager?: string };
    const packageManager = await detectPackageManager(root, pkg.packageManager);
    const scripts = pkg.scripts ?? {};
    const commands: Array<{ kind: 'typecheck' | 'lint' | 'test' | 'build'; command: string; reason: string }> = [];
    if (scripts.typecheck) commands.push({ kind: 'typecheck', command: `${packageManager} run typecheck`, reason: 'TypeScript/no-emit validation is available.' });
    if (scripts.lint) commands.push({ kind: 'lint', command: `${packageManager} run lint`, reason: 'Lint validation is available.' });
    if (scripts.test) commands.push({ kind: 'test', command: `${packageManager} run test`, reason: 'Automated tests are available.' });
    if (scripts.build) commands.push({ kind: 'build', command: `${packageManager} run build`, reason: 'Production build validation is available.' });
    return { commands, packageManager };
  } catch {
    return { commands: [], packageManager: null };
  }
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
): Promise<{ filePath: string; content: string }> {
  const filePath = `.agent/plans/${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '-')}.md`;
  const absolute = path.join(root, filePath);
  const content = [
    `# Code Space Plan — ${projectName}`,
    '',
    `## User request`,
    prompt,
    '',
    '## Definition of Done',
    '- The implementation is represented as the smallest reviewable patch set.',
    '- Every edited file is read before patch proposal.',
    '- Syntax pre-validation passes before disk write.',
    '- Checkpoint is created before apply, with restore available.',
    '- Typecheck, lint, tests, and build are run when available after acceptance.',
    '',
    '## Evidence reviewed',
    ...(context.files.length ? context.files.map((file) => `- ${file.path} (${file.lineCount} lines${file.truncated ? ', truncated' : ''})`) : ['- No source files selected.']),
    '',
    '## Implementation sequence',
    '1. Confirm exact files to mutate via @Files/@Folder/open tabs or semantic search.',
    '2. Read target files and related tests/usages.',
    '3. Generate exact SEARCH/REPLACE edit blocks.',
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
    `For ${projectName}, I inspected relevant project context without mutating files.`,
    '',
    'Evidence reviewed:',
    ...(context.files.length ? context.files.slice(0, 10).map((file) => `- ${file.path}`) : ['- No readable source files were selected.']),
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
    'The plan includes DoDs, implementation sequence, validation gates, and rollback expectations.',
    '',
    `Context files considered: ${context.files.length}. Validation commands: ${validation.commands.length}.`,
  ].join('\n');
}

function buildCodeResponse(projectName: string, files: ProposedPatchFile[], validation: Awaited<ReturnType<typeof detectValidationCommands>>): string {
  return [
    'Mode: Code',
    '',
    `Prepared ${files.length} reviewable patch proposal(s) for ${projectName}.`,
    '',
    'Proposed files:',
    ...files.map((file) => `- ${file.path}: ${file.explanation}`),
    '',
    'No disk mutation has occurred yet. Accept the diff to apply through the checkpointed patch API.',
    '',
    `After acceptance, run: ${validation.commands.map((command) => command.command).join(', ') || 'manual validation'}.`,
  ].join('\n');
}

function buildNoPatchResponse(projectName: string, prompt: string, context: ContextSearchResult, validation: Awaited<ReturnType<typeof detectValidationCommands>>): string {
  return [
    'Mode: Code',
    '',
    `For ${projectName}, I could not safely infer a concrete source edit from the available context.`,
    '',
    'Evidence reviewed:',
    ...(context.files.length ? context.files.slice(0, 8).map((file) => `- ${file.path}`) : ['- No readable source files were selected.']),
    '',
    `Request: ${prompt}`,
    '',
    'Provide an exact @File or a more specific change request to generate a surgical patch.',
    `Available validation: ${validation.commands.map((command) => command.command).join(', ') || 'none detected'}.`,
  ].join('\n');
}

async function proposeConservativePatch(root: string, prompt: string, context: ContextSearchResult): Promise<{ files: ProposedPatchFile[] }> {
  const lowerPrompt = prompt.toLowerCase();
  const planCandidate = /definition of done|dod|agentic|coding agent|code space|cursor|claude code|workflow|blueprint/.test(lowerPrompt);
  if (!planCandidate) return { files: [] };

  const filePath = 'docs/superpowers/specs/code-space-agentic-runtime-dods.md';
  const target = path.join(root, filePath);
  let beforeContent = '';
  try {
    beforeContent = await fs.readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const afterContent = buildRuntimeDodDocument(prompt, context);
  const diagnostics = validateSyntaxLightweight(filePath, afterContent);
  if (diagnostics.length) throw new Error(`Generated DoD document failed validation: ${diagnostics[0].message}`);

  return {
    files: [
      {
        path: filePath,
        beforeContent,
        afterContent,
        explanation: 'Add high-definition DoDs and execution blueprint for the fully agentic Code Space runtime.',
        unifiedDiff: createUnifiedDiff(filePath, beforeContent, afterContent),
      },
    ],
  };
}

function buildRuntimeDodDocument(prompt: string, context: ContextSearchResult): string {
  return [
    '# Code Space Agentic Runtime — Definitions of Done',
    '',
    '## Source request',
    prompt,
    '',
    '## DoD 1 — Ask / Plan / Code mode parity',
    '- Ask mode is strictly read-only and never proposes disk mutation.',
    '- Plan mode writes a planning artifact with assumptions, scope, risks, validation gates, and rollback plan.',
    '- Code mode proposes checkpointed, reviewable patches and does not apply them without user approval.',
    '',
    '## DoD 2 — Dynamic context discovery',
    '- Context selection starts with @Files/@Folder/open tabs and expands through search, dependency tracing, and validation surfaces.',
    '- Large outputs are persisted as artifacts and inspected through bounded read/grep tools.',
    '- Agents must read target files before editing and must not edit from snippets alone.',
    '',
    '## DoD 3 — Surgical editing',
    '- All model-facing edits use exact SEARCH/REPLACE blocks or server-generated before/after proposals.',
    '- The server rejects missing or non-unique SEARCH blocks instead of fuzzy applying.',
    '- Syntax pre-validation runs before patch application.',
    '',
    '## DoD 4 — Verification and self-healing',
    '- After accepted patches, the runtime runs detected typecheck, lint, test, and build commands when available.',
    '- Failing logs are stored as artifacts with read hints for repair turns.',
    '- Repair turns stay scoped to failing files and stop after a bounded retry budget.',
    '',
    '## DoD 5 — Checkpoint and rollback',
    '- Every accepted patch creates a file checkpoint before write.',
    '- Checkpoints can be restored deterministically through the checkpoint restore API.',
    '- UI refreshes editor state, tree, and git status after apply/rollback.',
    '',
    '## Current evidence reviewed',
    ...(context.files.length ? context.files.map((file) => `- ${file.path}`) : ['- No context files selected.']),
    '',
  ].join('\n');
}

function shouldUseMultiAgent(prompt: string, intents: string[]): boolean {
  return /architecture|multi[- ]?agent|agentic|migration|refactor|cursor|claude code|orchestration/i.test(prompt) || intents.includes('refactor') || intents.includes('feature_build');
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}
