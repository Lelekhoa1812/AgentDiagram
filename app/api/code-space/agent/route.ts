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
  // Motivation vs Logic: The composer surfaces structured @ mention attachments. They flow as a
  // first-class field so the context resolver can prioritise these files/folders ahead of its
  // generic keyword search. The field is optional + defaulted so older clients still validate.
  attachments: z.array(AttachmentSchema).optional().default([]),
});

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
        await emitRuntime('run.created', { mode, toolBudget });
        await emitRuntime('run.started', { projectName });

        const plan = buildPlan(mode, intents, latestUserMessage.content);
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
            selectedFiles: context.files.map((file) => file.path),
          },
          durationMs: Date.now() - contextStart,
        });
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path) });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const clarifyingQuestions = buildClarifyingQuestions(mode, latestUserMessage.content, intents);
        if (clarifyingQuestions.length) {
          emit({ type: 'clarifying_questions_created', questions: clarifyingQuestions });
          await emitRuntime('plan.updated', { clarifyingQuestions });
        }

        let planMarkdownPath: string | null = null;
        let planMarkdownContent = '';
        if (mode === 'plan') {
          const planMarkdown = await writePlanMarkdown({
            root: guarded.resolved,
            sessionId,
            projectName,
            prompt: latestUserMessage.content,
            intents,
            contextFiles: context.files,
            plan,
            clarifyingQuestions,
          });
          planMarkdownPath = planMarkdown.filePath;
          planMarkdownContent = planMarkdown.content;
          emit({ type: 'plan_markdown_created', filePath: planMarkdown.filePath, content: planMarkdown.content });
          await emitRuntime('plan.updated', { filePath: planMarkdown.filePath });
        }

        const answer = buildGroundedResponse({
          mode,
          projectName,
          prompt: latestUserMessage.content,
          intents,
          contextFiles: context.files,
          plan,
          planMarkdownPath,
          planMarkdownContent,
          clarifyingQuestions,
        });
        for (const chunk of chunkText(answer)) {
          emit({ type: 'text_delta', delta: chunk });
          await emitRuntime('message.assistant.delta', { text: chunk });
        }
        await emitRuntime('message.assistant.completed', { content: answer });

        emit({
          type: 'validation_result',
          id: `validation:${runId}:static`,
          command: mode === 'plan' ? 'plan markdown write check' : 'static context/read-only check',
          status: 'passed',
          output: mode === 'plan'
            ? `Plan mode only created or updated ${planMarkdownPath}. Source files were not changed.`
            : 'The run used safe read/search tooling only. No workspace files were changed.',
        });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });
        await emitRuntime('validation.completed', { command: mode === 'plan' ? 'plan markdown write check' : 'static context/read-only check', status: 'passed' });
        await emitRuntime('run.completed', { status: 'completed', filesChanged: planMarkdownPath ? [planMarkdownPath] : [] });
        emit({
          type: 'agent_done',
          summary: answer,
          filesChanged: planMarkdownPath ? [planMarkdownPath] : [],
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

export function buildPlan(mode: CodeSpaceAgentMode, _intents: string[], _prompt: string): string[] {
  if (mode === 'ask') {
    return [
      'Classify the request and keep this run read-only.',
      'Search and read the most relevant project files.',
      'Answer with file-grounded citations and note that no edits were made.',
    ];
  }

  if (mode === 'plan') {
    return [
      'Scan the project structure, prompt, open tabs, and likely implementation surfaces before asking anything.',
      'Search and read the most relevant project files, docs, and existing patterns.',
      'Ask only task-solving clarifications in the sidebar, then write the final planning doc with assumptions, strategy, TODOs, and validation steps.',
    ];
  }

  return [
    'Classify the implementation/debugging request and identify likely scope.',
    'Search and read relevant project files before proposing edits.',
    'Prepare a visible plan, validation strategy, and approval-gated patch path.',
  ];
}

export function buildClarifyingQuestions(mode: CodeSpaceAgentMode, prompt: string, intents: string[]): CodeSpaceClarifyingQuestion[] {
  if (mode !== 'plan') return [];
  const ambiguous =
    prompt.trim().length < 120 ||
    intents.includes('answer/question') ||
    !/\b(test|verify|ui|api|backend|frontend|bug|feature|refactor|design|database|auth|deploy)\b/i.test(prompt);
  if (!ambiguous) return [];
  return [
    {
      id: 'scope',
      question: 'What scope should the implementation plan optimize for?',
      choices: ['Smallest safe change', 'Production-ready feature pass', 'Deep refactor plus feature work'],
    },
    {
      id: 'validation',
      question: 'What validation should be treated as the acceptance gate?',
      choices: ['Typecheck and unit tests', 'Build plus targeted tests', 'Full build, tests, and browser verification'],
    },
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

interface AgentAttachment {
  kind: 'file' | 'folder';
  relativePath: string;
  displayName: string;
}

async function collectProjectContext(
  root: string,
  prompt: string,
  openTabs: string[],
  attachments: AgentAttachment[] = [],
) {
  const candidates = await fg(['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**'], {
    cwd: root,
    onlyFiles: true,
    dot: false,
    absolute: false,
    unique: true,
  });
  const terms = promptTerms(prompt);

  // Motivation vs Logic: User-attached mentions are an explicit, structured signal that this file
  // (or folder) matters. Bias the scorer heavily for files attached directly, and tag folder
  // attachments so any candidate inside them inherits a non-trivial boost.
  const attachedFiles = new Set(
    attachments.filter((item) => item.kind === 'file').map((item) => item.relativePath),
  );
  const attachedFolders = attachments
    .filter((item) => item.kind === 'folder')
    .map((item) => item.relativePath.replace(/\/+$/, ''));

  const scored = candidates.map((file) => {
    const lower = file.toLowerCase();
    const attachedFile = attachedFiles.has(file);
    const inAttachedFolder = attachedFolders.some(
      (folder) => folder && file.startsWith(`${folder}/`),
    );
    const score =
      (attachedFile ? 40 : 0) +
      (inAttachedFolder ? 16 : 0) +
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

export async function writePlanMarkdown({
  root,
  sessionId,
  projectName,
  prompt,
  intents,
  contextFiles,
  plan,
  clarifyingQuestions,
}: {
  root: string;
  sessionId: string;
  projectName: string;
  prompt: string;
  intents: string[];
  contextFiles: Array<{ path: string; content: string; truncated: boolean }>;
  plan: string[];
  clarifyingQuestions: Array<{ id: string; question: string; choices: string[] }>;
}) {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96) || 'session';
  const filePath = `.codex/plans/${safeSessionId}.md`;
  const absolute = path.resolve(root, filePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('Plan markdown path escapes project root');
  }
  const contextList = contextFiles.length
    ? contextFiles.map((file) => `- \`${file.path}\`${file.truncated ? ' (partial)' : ''}`).join('\n')
    : '- No matching readable source files were found.';
  const questions = clarifyingQuestions.length
    ? clarifyingQuestions
        .map((question, index) => [
          `${index + 1}. ${question.question}`,
          ...question.choices.map((choice, choiceIndex) => `   ${String.fromCharCode(65 + choiceIndex)}. ${choice}`),
          '   Other. Replace this line with a custom answer.',
        ].join('\n'))
        .join('\n\n')
    : 'No blocking clarification questions were detected.';
  const content = [
    `# ${projectName} Agent Plan`,
    '',
    `Prompt: ${prompt}`,
    '',
    `Intents: ${intents.join(', ')}`,
    '',
    '## Clarifying Questions',
    '',
    questions,
    '',
    '## Context Reviewed',
    '',
    contextList,
    '',
    '## Strategy',
    '',
    ...plan.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## Acceptance Criteria',
    '',
    '- User confirms or edits the clarifying answers above.',
    '- Implementation tasks are traceable to the strategy.',
    '- Validation commands are listed before source-file edits begin.',
    '',
    '## Validation Plan',
    '',
    '- Run `npm run typecheck` for TypeScript correctness.',
    '- Run targeted tests for changed modules.',
    '- Run a production build or browser verification when UI behavior changes.',
    '',
  ].join('\n');

  // Motivation vs Logic: Plan mode needs an editable artifact the user can refine in Monaco, so we write only this hidden markdown plan and leave source files untouched until Code mode runs.
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
  return { filePath, content };
}

export function buildGroundedResponse({
  mode,
  projectName,
  prompt,
  intents,
  contextFiles,
  plan,
  planMarkdownPath,
  planMarkdownContent,
  clarifyingQuestions,
}: {
  mode: CodeSpaceAgentMode;
  projectName: string;
  prompt: string;
  intents: string[];
  contextFiles: Array<{ path: string; content: string; truncated: boolean }>;
  plan: string[];
  planMarkdownPath: string | null;
  planMarkdownContent: string;
  clarifyingQuestions: Array<{ id: string; question: string; choices: string[] }>;
}) {
  const citations = contextFiles
    .slice(0, 5)
    .map((file) => `- ${file.path}${file.truncated ? ' (partial)' : ''}`)
    .join('\n');
  const primaryMode = mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Plan' : 'Code';
  const contextSummary = contextFiles.length
    ? `I inspected these files:\n${citations}`
    : 'I did not find readable source files that matched the prompt.';
  const clarifyingSummary = clarifyingQuestions.length
    ? 'Answer the sidebar clarifying questions to refine the next implementation pass.'
    : 'No blocking clarification questions were needed for this pass.';
  const planFileSummary = planMarkdownPath
    ? mode === 'plan'
      ? `Full planning doc is ready at ${planMarkdownPath} (${planMarkdownContent.length} characters).`
      : `Editable plan file: ${planMarkdownPath} (${planMarkdownContent.length} characters).`
    : '';
  if (mode === 'plan') {
    return [
      `Mode: ${primaryMode}`,
      '',
      `For ${projectName}, I classified the request as: ${intents.join(', ')}.`,
      '',
      contextSummary,
      '',
      clarifyingSummary,
      planFileSummary,
      'The chat stays concise in Plan mode; the complete markdown plan is surfaced only at wrap-up.',
      'Next step: answer the sidebar MCQs or open the final plan artifact when you want to review the full document.',
    ]
      .filter(Boolean)
      .join('\n');
  }

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
    planFileSummary,
    primaryMode === 'Plan' ? clarifyingSummary : '',
    primaryMode === 'Ask'
      ? `Answer: based on the available context, this is a read-only codebase question. Prompt: "${prompt}". No file edits or commands were performed.`
      : primaryMode === 'Plan'
        ? 'Next step: edit the markdown plan directly or reply with clarifications, then switch to Code mode when ready to implement.'
        : 'Next step: proceed with checkpointed patch proposals and validation commands as implementation support becomes available.',
  ].join('\n');
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) {
    chunks.push(text.slice(index, index + 220));
  }
  return chunks;
}
