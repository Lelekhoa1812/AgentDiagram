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

interface RepoMap {
  filesConsidered: number;
  directories: Array<{ path: string; fileCount: number }>;
  keyFiles: string[];
  extensionCounts: Array<{ extension: string; count: number }>;
  stack: ProjectStack;
}

interface ProjectStack {
  packageManager: string | null;
  languages: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  testRunners: string[];
  lintTools: string[];
  buildTools: string[];
}

interface ContextSearchResult {
  filesConsidered: number;
  terms: string[];
  files: ContextFile[];
  omittedRelevantFiles: string[];
}

interface DependencyTrace {
  imports: Array<{ from: string; imports: string[] }>;
  relatedFiles: string[];
  unresolvedImports: string[];
}

interface ValidationStrategy {
  packageManager: string | null;
  commands: Array<{ kind: 'typecheck' | 'lint' | 'test' | 'build' | 'format' | 'preview'; command: string; reason: string }>;
  missing: string[];
}

interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  reasons: string[];
  approvalGates: string[];
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

      try {
        await emitRuntime('run.created', { mode, toolBudget });
        await emitRuntime('run.started', { projectName });

        const plan = buildPlan(mode, intents, latestUserMessage.content);
        emit({ type: 'plan_created', items: plan });
        await emitRuntime('plan.created', { items: plan });
        plan.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));

        const classifyToolId = `tool:${Date.now()}:classify`;
        emit({ type: 'tool_start', toolCallId: classifyToolId, tool: 'classify_task', input: { prompt: latestUserMessage.content, intents } });
        await emitRuntime('tool.started', { tool: 'classify_task', riskLevel: 'safe' });
        emit({ type: 'tool_result', toolCallId: classifyToolId, tool: 'classify_task', output: { intents, mode }, durationMs: 1 });
        await emitRuntime('tool.completed', { tool: 'classify_task', intents, mode });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:0`, done: true });

        const contextToolId = `tool:${Date.now()}:context`;
        const contextStart = Date.now();
        emit({
          type: 'tool_start',
          toolCallId: contextToolId,
          tool: 'context_search',
          input: { openTabs, attachments, tools: registry.list().map((tool) => tool.name) },
        });
        await emitRuntime('context.search.started', { openTabs, attachments });
        const context = await collectProjectContext(guarded.resolved, latestUserMessage.content, openTabs, attachments);
        emit({
          type: 'tool_result',
          toolCallId: contextToolId,
          tool: 'context_search',
          output: {
            filesConsidered: context.filesConsidered,
            selectedFiles: context.files.map((file) => ({ path: file.path, score: file.score, reasons: file.reasons })),
          },
          durationMs: Date.now() - contextStart,
        });
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path), terms: context.terms });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const validationCommands: string[] = [];
        const answer = [
          `Mode: ${mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Plan' : 'Code'}`,
          '',
          `For ${projectName}, I reviewed the selected project context.`,
          '',
          'Evidence reviewed:',
          ...(context.files.length ? context.files.slice(0, 8).map((file) => `- ${file.path}`) : ['- No readable source files were found.']),
          '',
          mode === 'code'
            ? 'Code mode requires the patch generation/apply loop before it can safely mutate source files. No source changes were applied by this run.'
            : 'No source changes were made by this run.',
        ].join('\n');

        for (const chunk of chunkText(answer)) {
          emit({ type: 'text_delta', delta: chunk });
          await emitRuntime('message.assistant.delta', { text: chunk });
        }
        await emitRuntime('message.assistant.completed', { content: answer });

        emit({
          type: 'validation_result',
          id: `validation:${runId}:static`,
          command: validationCommands.length ? validationCommands.join(', ') : 'context review',
          status: 'skipped',
          output: 'No file mutation validation was run because no source files were changed.',
        });
        await emitRuntime('run.completed', { status: 'completed', filesChanged: [] });
        emit({ type: 'agent_done', summary: answer, filesChanged: [] });
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

export function buildPlan(mode: CodeSpaceAgentMode, _intents: string[], _prompt: string): string[] {
  if (mode === 'ask') {
    return ['Classify request', 'Search relevant project context', 'Answer without changing files'];
  }

  if (mode === 'plan') {
    return ['Classify request', 'Search relevant project context', 'Prepare implementation plan'];
  }

  return ['Classify request', 'Search relevant project context', 'Prepare source changes'];
}

export function buildClarifyingQuestions(): CodeSpaceClarifyingQuestion[] {
  return [];
}

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2))).slice(0, 32);
}

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
      add(attachedFiles.has(file) ? 60 : 0, '@ mentioned file');
      add(attachedFolders.some((folder) => folder && file.startsWith(`${folder}/`)) ? 30 : 0, '@ mentioned folder');
      add(openTabs.includes(file) ? 20 : 0, 'open tab');
      add(terms.reduce((sum, term) => sum + (lower.includes(term) ? 4 : 0), 0), 'prompt/path overlap');
      return { file, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 12);

  const files: ContextFile[] = [];
  for (const item of selected) {
    const absolute = path.resolve(root, item.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const content = await fs.readFile(absolute, 'utf8');
      files.push({ path: item.file, content: content.slice(0, 8_000), truncated: content.length > 8_000, lineCount: content.split('\n').length, score: item.score, reasons: item.reasons });
    } catch {}
  }

  return { filesConsidered: candidates.length, files, terms, omittedRelevantFiles: [] };
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}
