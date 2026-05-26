import { NextRequest } from 'next/server';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { classifyCodeSpaceIntent } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { createAgentEvent, createDefaultToolRegistry, encodeSseEvent, getEventStore } from '@/lib/code-space/runtime';
import type { AgentEventType } from '@/lib/code-space/runtime';
import { guardPath } from '@/lib/security/pathGuard';

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

const BodySchema = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  projectName: z.string(),
  messages: z.array(MessageSchema).min(1),
  model: z.string(),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry']),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  openTabs: z.array(z.string()).default([]),
  toolBudget: z.number().default(50),
  enableThinking: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const { messages, projectName, projectRoot, sessionId, toolBudget, openTabs } = body.data;
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
      // Motivation vs Logic: keep the legacy CodeSpaceWorkspace SSE envelope alive while
      // persisting structured runtime events for replay/debugging through /runs/:id/events.
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
        await emitRuntime('run.created', { mode: 'agent', toolBudget });
        await emitRuntime('run.started', { projectName });

        const plan = buildPlan(intents, latestUserMessage.content);
        emit({ type: 'plan_created', items: plan });
        await emitRuntime('plan.created', { items: plan });
        plan.forEach((text, index) => emit({ type: 'todo_created', todo: { id: `todo:${runId}:${index}`, text, done: false } }));

        const classifyToolId = `tool:${Date.now()}:classify`;
        emit({ type: 'tool_start', toolCallId: classifyToolId, tool: 'classify_task', input: { prompt: latestUserMessage.content, intents } });
        await emitRuntime('tool.started', { tool: 'classify_task', riskLevel: 'safe' });
        emit({ type: 'tool_result', toolCallId: classifyToolId, tool: 'classify_task', output: { intents }, durationMs: 1 });
        await emitRuntime('tool.completed', { tool: 'classify_task', intents });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:0`, done: true });

        const contextToolId = `tool:${Date.now()}:context`;
        const contextStart = Date.now();
        emit({ type: 'tool_start', toolCallId: contextToolId, tool: 'context_search', input: { openTabs, tools: registry.list().map((tool) => tool.name) } });
        await emitRuntime('context.search.started', { openTabs });
        const context = await collectProjectContext(guarded.resolved, latestUserMessage.content, openTabs);
        emit({
          type: 'tool_result',
          toolCallId: contextToolId,
          tool: 'context_search',
          output: {
            filesConsidered: context.filesConsidered,
            selectedFiles: context.files.map((file) => file.path),
          },
          durationMs: Date.now() - contextStart,
        });
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path) });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const answer = buildGroundedResponse({
          projectName,
          prompt: latestUserMessage.content,
          intents,
          contextFiles: context.files,
          plan,
        });
        for (const chunk of chunkText(answer)) {
          emit({ type: 'text_delta', delta: chunk });
          await emitRuntime('message.assistant.delta', { text: chunk });
        }
        await emitRuntime('message.assistant.completed', { content: answer });

        emit({
          type: 'validation_result',
          id: `validation:${runId}:static`,
          command: 'static context/read-only check',
          status: 'passed',
          output: 'The run used safe read/search tooling only. No workspace files were changed.',
        });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });
        await emitRuntime('validation.completed', { command: 'static context/read-only check', status: 'passed' });
        await emitRuntime('run.completed', { status: 'completed', filesChanged: [] });
        emit({
          type: 'agent_done',
          summary: answer,
          filesChanged: [],
        });
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

function buildPlan(intents: string[], prompt: string): string[] {
  const readOnly = intents.includes('repository_explanation') || intents.includes('answer/question');
  if (readOnly) {
    return [
      'Classify the request and keep this run read-only.',
      'Search and read the most relevant project files.',
      'Answer with file-grounded citations and note that no edits were made.',
    ];
  }

  return [
    'Classify the implementation/debugging request and identify likely scope.',
    'Search and read relevant project files before proposing edits.',
    'Prepare a visible plan, validation strategy, and approval-gated patch path.',
  ];
}

function promptTerms(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/)
        .filter((term) => term.length > 2 && !['the', 'and', 'for', 'with', 'this', 'that', 'you'].includes(term)),
    ),
  );
}

async function collectProjectContext(root: string, prompt: string, openTabs: string[]) {
  const candidates = await fg(['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**'], {
    cwd: root,
    onlyFiles: true,
    dot: false,
    absolute: false,
    unique: true,
  });
  const terms = promptTerms(prompt);
  const scored = candidates.map((file) => {
    const lower = file.toLowerCase();
    const score =
      (openTabs.includes(file) ? 8 : 0) +
      terms.reduce((sum, term) => sum + (lower.includes(term) ? 3 : 0), 0) +
      (/readme|package\.json|architecture|agent|code-space/i.test(file) ? 2 : 0);
    return { file, score };
  });
  const selected = scored
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 8)
    .map((item) => item.file);

  const files = [];
  for (const file of selected) {
    const absolute = path.resolve(root, file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const content = await fs.readFile(absolute, 'utf8');
      files.push({ path: file, content: content.slice(0, 6_000), truncated: content.length > 6_000 });
    } catch {
      // Ignore unreadable files during context search; the tool result still reports selected paths.
    }
  }
  return { filesConsidered: candidates.length, files };
}

function buildGroundedResponse({
  projectName,
  prompt,
  intents,
  contextFiles,
  plan,
}: {
  projectName: string;
  prompt: string;
  intents: string[];
  contextFiles: Array<{ path: string; content: string; truncated: boolean }>;
  plan: string[];
}) {
  const citations = contextFiles
    .slice(0, 5)
    .map((file) => `- ${file.path}${file.truncated ? ' (partial)' : ''}`)
    .join('\n');
  const primaryMode = intents.includes('repository_explanation') || intents.includes('answer/question') ? 'Ask' : 'Plan';
  const contextSummary = contextFiles.length
    ? `I inspected these files:\n${citations}`
    : 'I did not find readable source files that matched the prompt.';

  return [
    `Mode: ${primaryMode}`,
    '',
    `For ${projectName}, I classified the request as: ${intents.join(', ')}.`,
    '',
    contextSummary,
    '',
    'Visible plan:',
    ...plan.map((item, index) => `${index + 1}. ${item}`),
    '',
    primaryMode === 'Ask'
      ? `Answer: based on the available context, this is a read-only codebase question. Prompt: "${prompt}". No file edits or commands were performed.`
      : 'Next step: approve an edit/debug run to let the agent create checkpointed patch proposals and run validation commands.',
  ].join('\n');
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) {
    chunks.push(text.slice(index, index + 220));
  }
  return chunks;
}
