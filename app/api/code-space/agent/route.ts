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
        emit({ type: 'tool_result', toolCallId: classifyToolId, tool: 'classify_task', output: { intents, mode }, durationMs: 1 });
        await emitRuntime('tool.completed', { tool: 'classify_task', intents, mode });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:0`, done: true });

        const repoMapToolId = `tool:${Date.now()}:repo-map`;
        const repoMapStart = Date.now();
        emit({ type: 'tool_start', toolCallId: repoMapToolId, tool: 'repo_map', input: { root: projectName, depth: 3 } });
        await emitRuntime('tool.started', { tool: 'repo_map', riskLevel: 'safe' });
        const repoMap = await buildRepoMap(guarded.resolved);
        emit({
          type: 'tool_result',
          toolCallId: repoMapToolId,
          tool: 'repo_map',
          output: {
            filesConsidered: repoMap.filesConsidered,
            topDirectories: repoMap.directories.slice(0, 12),
            keyFiles: repoMap.keyFiles,
            stack: repoMap.stack,
          },
          durationMs: Date.now() - repoMapStart,
        });
        await emitRuntime('tool.completed', { tool: 'repo_map', filesConsidered: repoMap.filesConsidered, stack: repoMap.stack });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:1`, done: true });

        const contextToolId = `tool:${Date.now()}:context`;
        const contextStart = Date.now();
        emit({
          type: 'tool_start',
          toolCallId: contextToolId,
          tool: 'context_search',
          input: { openTabs, attachments, tools: registry.list().map((tool) => tool.name) },
        });
        await emitRuntime('context.search.started', { openTabs, attachments });
        const context = await collectProjectContext(guarded.resolved, latestUserMessage.content, openTabs, attachments, repoMap);
        emit({
          type: 'tool_result',
          toolCallId: contextToolId,
          tool: 'context_search',
          output: {
            filesConsidered: context.filesConsidered,
            selectedFiles: context.files.map((file) => ({ path: file.path, score: file.score, reasons: file.reasons })),
            omittedRelevantFiles: context.omittedRelevantFiles,
            terms: context.terms,
          },
          durationMs: Date.now() - contextStart,
        });
        await emitRuntime('context.search.completed', { selectedFiles: context.files.map((file) => file.path), terms: context.terms });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:2`, done: true });

        const traceToolId = `tool:${Date.now()}:trace`;
        const traceStart = Date.now();
        emit({ type: 'tool_start', toolCallId: traceToolId, tool: 'dependency_trace', input: { selectedFiles: context.files.map((file) => file.path) } });
        const dependencyTrace = buildDependencyTrace(context.files, repoMap);
        emit({
          type: 'tool_result',
          toolCallId: traceToolId,
          tool: 'dependency_trace',
          output: dependencyTrace,
          durationMs: Date.now() - traceStart,
        });
        await emitRuntime('tool.completed', { tool: 'dependency_trace', relatedFiles: dependencyTrace.relatedFiles });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:3`, done: true });

        const validationToolId = `tool:${Date.now()}:validation`;
        const validationStart = Date.now();
        emit({ type: 'tool_start', toolCallId: validationToolId, tool: 'validation_strategy', input: { stack: repoMap.stack, mode } });
        const validation = await detectValidationStrategy(guarded.resolved, repoMap.stack);
        emit({
          type: 'tool_result',
          toolCallId: validationToolId,
          tool: 'validation_strategy',
          output: validation,
          durationMs: Date.now() - validationStart,
        });
        await emitRuntime('validation.completed', { command: 'validation strategy discovery', status: 'passed', validation });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:4`, done: true });

        const riskToolId = `tool:${Date.now()}:risk`;
        const risk = buildRiskAssessment(mode, intents, latestUserMessage.content, context, validation);
        emit({ type: 'tool_start', toolCallId: riskToolId, tool: 'risk_assessment', input: { mode, intents } });
        emit({ type: 'tool_result', toolCallId: riskToolId, tool: 'risk_assessment', output: risk, durationMs: 1 });
        await emitRuntime('tool.completed', { tool: 'risk_assessment', risk });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:5`, done: true });

        const clarifyingQuestions = buildClarifyingQuestions(mode, latestUserMessage.content, intents, risk);
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
            repoMap,
            dependencyTrace,
            validation,
            risk,
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
          repoMap,
          dependencyTrace,
          validation,
          risk,
        });
        for (const chunk of chunkText(answer)) {
          emit({ type: 'text_delta', delta: chunk });
          await emitRuntime('message.assistant.delta', { text: chunk });
        }
        await emitRuntime('message.assistant.completed', { content: answer });

        emit({
          type: 'validation_result',
          id: `validation:${runId}:workflow`,
          command: mode === 'plan' ? 'planning artifact + workflow readiness check' : 'workflow readiness analysis',
          status: 'passed',
          output: buildValidationSummary(mode, planMarkdownPath, validation, risk),
        });
        emit({ type: 'todo_updated', todoId: `todo:${runId}:6`, done: true });
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

export function buildPlan(mode: CodeSpaceAgentMode, intents: string[], prompt: string): string[] {
  const wantsImplementation = mode === 'code' || intents.some((intent) => ['code_edit', 'feature_build', 'bug_fix', 'refactor', 'test_generation'].includes(intent));
  const asksForArchitecture = /cursor|codex|claude code|agentic|workflow|multi[- ]?agent|tool use|deep/i.test(prompt);

  if (mode === 'ask') {
    return [
      'Classify the request and keep this run read-only.',
      'Build a repository map before answering so file citations are grounded.',
      'Search and read the most relevant project files and open tabs.',
      'Answer with inspected files, assumptions, and no-edit confirmation.',
    ];
  }

  if (mode === 'plan') {
    return [
      'Classify user intent, implementation risk, and expected autonomy level.',
      'Map the repository structure, stack, key configuration files, and likely ownership boundaries.',
      'Search and read relevant files, docs, open tabs, and explicit @ mentions before asking questions.',
      'Trace imports/usages around selected files to avoid isolated edits.',
      'Create a task breakdown with approval gates, validation commands, and rollback strategy.',
      asksForArchitecture
        ? 'Benchmark the workflow against Cursor, Codex, and Claude Code patterns: planning loop, tool loop, patch loop, validation loop, and handoff loop.'
        : 'Write the final planning artifact with assumptions, TODOs, implementation order, and validation steps.',
      'Stop before source-file mutation until Code mode has an approved patch path.',
    ];
  }

  return [
    'Classify the implementation/debugging request and identify likely blast radius.',
    'Map the repository before choosing files to read.',
    'Search, read, and cite the most relevant source/config/test files.',
    'Trace related imports/usages so edits fit existing patterns.',
    wantsImplementation
      ? 'Prepare an approval-gated patch sequence: smallest safe diff first, then follow-up edits by dependency order.'
      : 'Prepare a read-only implementation strategy because the prompt does not require mutation.',
    'Discover typecheck, lint, test, build, and preview commands before claiming completion.',
    'Report current limitations clearly: this route now performs deep workflow analysis but still requires the provider-backed edit loop to execute autonomous mutations.',
  ];
}

export function buildClarifyingQuestions(
  mode: CodeSpaceAgentMode,
  prompt: string,
  intents: string[],
  risk: RiskAssessment,
): CodeSpaceClarifyingQuestion[] {
  if (mode !== 'plan') return [];
  const ambiguous =
    prompt.trim().length < 120 ||
    intents.includes('answer/question') ||
    risk.level === 'high' ||
    !/\b(test|verify|ui|api|backend|frontend|bug|feature|refactor|design|database|auth|deploy|agent|workflow)\b/i.test(prompt);
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
    {
      id: 'autonomy',
      question: 'How autonomous should Code Space be allowed to become for this task?',
      choices: ['Plan only', 'Propose diffs for approval', 'Run safe commands automatically and ask for risky actions'],
    },
  ];
}

function promptTerms(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/)
        .filter((term) => term.length > 2 && !STOP_WORDS.has(term)),
    ),
  ).slice(0, 32);
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'you',
  'our',
  'your',
  'are',
  'not',
  'but',
  'can',
  'what',
  'when',
  'where',
  'how',
  'why',
  'into',
  'from',
  'after',
  'before',
  'then',
  'etc',
]);

const CONTEXT_GLOBS = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,mdx,css,scss,html,py,go,rs,rb,java,kt,php,cs,cpp,c,h,yml,yaml,toml,prisma,graphql,gql,sql,sh}',
  '!node_modules/**',
  '!.git/**',
  '!dist/**',
  '!build/**',
  '!.next/**',
  '!coverage/**',
  '!tmp/**',
  '!temp/**',
  '!vendor/**',
];

const KEY_FILE_PATTERNS = [
  /^package\.json$/,
  /^README\.md$/i,
  /^AGENTS\.md$/i,
  /^CLAUDE\.md$/i,
  /^tsconfig.*\.json$/,
  /^next\.config\./,
  /^vite\.config\./,
  /^vitest\.config\./,
  /^jest\.config\./,
  /^eslint\.config\./,
  /^\.eslintrc/,
  /^tailwind\.config\./,
  /^playwright\.config\./,
];

async function buildRepoMap(root: string): Promise<RepoMap> {
  const candidates = await fg(CONTEXT_GLOBS, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    absolute: false,
    unique: true,
  });
  const directoryCounts = new Map<string, number>();
  const extensionCounts = new Map<string, number>();
  const keyFiles: string[] = [];

  for (const file of candidates) {
    const parts = file.split('/');
    const topDir = parts.length > 1 ? parts[0] : '.';
    directoryCounts.set(topDir, (directoryCounts.get(topDir) ?? 0) + 1);
    const basename = parts[parts.length - 1] ?? file;
    const extension = basename.includes('.') ? `.${basename.split('.').pop()}`.toLowerCase() : basename;
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
    if (KEY_FILE_PATTERNS.some((pattern) => pattern.test(file) || pattern.test(basename))) {
      keyFiles.push(file);
    }
  }

  return {
    filesConsidered: candidates.length,
    directories: Array.from(directoryCounts.entries())
      .map(([dirPath, fileCount]) => ({ path: dirPath, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path)),
    keyFiles: keyFiles.sort((a, b) => a.localeCompare(b)).slice(0, 40),
    extensionCounts: Array.from(extensionCounts.entries())
      .map(([extension, count]) => ({ extension, count }))
      .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension))
      .slice(0, 24),
    stack: await detectProjectStack(root),
  };
}

async function detectProjectStack(root: string): Promise<ProjectStack> {
  const packageJson = await readJsonFile<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string }>(path.join(root, 'package.json'));
  const dependencies = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const dependencyNames = Object.keys(dependencies);
  const scripts = packageJson?.scripts ?? {};
  const frameworks = new Set<string>();
  const languages = new Set<string>();
  const testRunners = new Set<string>();
  const lintTools = new Set<string>();
  const buildTools = new Set<string>();

  if (dependencyNames.some((name) => ['next', 'react', 'react-dom'].includes(name))) frameworks.add('React/Next.js');
  if (dependencyNames.includes('next')) frameworks.add('Next.js');
  if (dependencyNames.includes('vite')) frameworks.add('Vite');
  if (dependencyNames.includes('express')) frameworks.add('Express');
  if (dependencyNames.includes('@nestjs/core')) frameworks.add('NestJS');
  if (dependencyNames.includes('typescript') || (await exists(path.join(root, 'tsconfig.json')))) languages.add('TypeScript');
  if (dependencyNames.length || (await exists(path.join(root, 'package.json')))) languages.add('JavaScript');
  if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'requirements.txt'))) languages.add('Python');
  if (await exists(path.join(root, 'go.mod'))) languages.add('Go');
  if (await exists(path.join(root, 'Cargo.toml'))) languages.add('Rust');

  for (const [name, command] of Object.entries(scripts)) {
    const combined = `${name} ${command}`.toLowerCase();
    if (/vitest|jest|playwright|cypress|test/.test(combined)) testRunners.add(name);
    if (/eslint|biome|lint/.test(combined)) lintTools.add(name);
    if (/tsc|typecheck/.test(combined)) lintTools.add(name);
    if (/next build|vite build|webpack|rollup|build/.test(combined)) buildTools.add(name);
  }

  return {
    packageManager: await detectPackageManager(root, packageJson?.packageManager),
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    scripts,
    testRunners: Array.from(testRunners),
    lintTools: Array.from(lintTools),
    buildTools: Array.from(buildTools),
  };
}

async function collectProjectContext(
  root: string,
  prompt: string,
  openTabs: string[],
  attachments: AgentAttachment[] = [],
  repoMap?: RepoMap,
): Promise<ContextSearchResult> {
  const candidates = await fg(CONTEXT_GLOBS, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    absolute: false,
    unique: true,
  });
  const terms = promptTerms(prompt);
  const attachedFiles = new Set(attachments.filter((item) => item.kind === 'file').map((item) => item.relativePath));
  const attachedFolders = attachments
    .filter((item) => item.kind === 'folder')
    .map((item) => item.relativePath.replace(/\/+$/, ''));
  const keyFiles = new Set(repoMap?.keyFiles ?? []);
  const promptMentionsCodeSpace = /code[- ]?space|codespace|agent|cursor|codex|claude code|workflow|tool use|multi[- ]?agent/i.test(prompt);

  const scored = candidates.map((file) => {
    const lower = file.toLowerCase();
    const basename = lower.split('/').pop() ?? lower;
    const attachedFile = attachedFiles.has(file);
    const inAttachedFolder = attachedFolders.some((folder) => folder && file.startsWith(`${folder}/`));
    const reasons: string[] = [];
    let score = 0;

    const addScore = (amount: number, reason: string) => {
      if (!amount) return;
      score += amount;
      reasons.push(reason);
    };

    addScore(attachedFile ? 60 : 0, '@ mentioned file');
    addScore(inAttachedFolder ? 28 : 0, '@ mentioned folder');
    addScore(openTabs.includes(file) ? 24 : 0, 'open editor tab');
    addScore(keyFiles.has(file) ? 18 : 0, 'project configuration or docs');
    addScore(terms.reduce((sum, term) => sum + (lower.includes(term) ? 5 : 0), 0), 'prompt/path keyword overlap');
    addScore(promptMentionsCodeSpace && /code-space|codespace|agent|runtime|provider|workspace|panel|route/.test(lower) ? 26 : 0, 'Code Space/agent implementation surface');
    addScore(/readme|package\.json|architecture|provider|runtime|validation|patch|checkpoint|session|tool|workflow/.test(basename) ? 5 : 0, 'agentically important file kind');
    addScore(/\.test\.|\.spec\.|__tests__/.test(lower) ? 3 : 0, 'test surface');

    return { file, score, reasons };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 18);
  const omittedRelevantFiles = scored
    .filter((item) => item.score > 0 && !selected.some((selectedItem) => selectedItem.file === item.file))
    .slice(0, 24)
    .map((item) => item.file);

  const files: ContextFile[] = [];
  for (const item of selected) {
    const absolute = path.resolve(root, item.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    try {
      const content = await fs.readFile(absolute, 'utf8');
      const lineCount = content.split('\n').length;
      files.push({
        path: item.file,
        content: content.slice(0, 12_000),
        truncated: content.length > 12_000,
        lineCount,
        score: item.score,
        reasons: item.reasons.length ? item.reasons : ['low-score fallback candidate'],
      });
    } catch {
      // Ignore unreadable files during context search; the tool result still reports selected paths.
    }
  }
  return { filesConsidered: candidates.length, terms, files, omittedRelevantFiles };
}

function buildDependencyTrace(contextFiles: ContextFile[], repoMap: RepoMap): DependencyTrace {
  const allKnownFiles = new Set<string>([
    ...repoMap.keyFiles,
    ...contextFiles.map((file) => file.path),
  ]);
  const imports: DependencyTrace['imports'] = [];
  const relatedFiles = new Set<string>();
  const unresolvedImports = new Set<string>();

  for (const file of contextFiles) {
    const importSpecs = Array.from(file.content.matchAll(/(?:import|export)\s+(?:[^'\"]+\s+from\s+)?['\"]([^'\"]+)['\"]|require\(['\"]([^'\"]+)['\"]\)/g))
      .map((match) => match[1] ?? match[2])
      .filter(Boolean)
      .slice(0, 24);
    imports.push({ from: file.path, imports: importSpecs });

    for (const spec of importSpecs) {
      if (!spec.startsWith('.')) continue;
      const resolvedBase = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec));
      const candidates = [
        resolvedBase,
        `${resolvedBase}.ts`,
        `${resolvedBase}.tsx`,
        `${resolvedBase}.js`,
        `${resolvedBase}.jsx`,
        `${resolvedBase}.json`,
        `${resolvedBase}/index.ts`,
        `${resolvedBase}/index.tsx`,
      ];
      const match = candidates.find((candidate) => allKnownFiles.has(candidate) || contextFiles.some((contextFile) => contextFile.path === candidate));
      if (match) relatedFiles.add(match);
      else unresolvedImports.add(spec);
    }
  }

  return {
    imports,
    relatedFiles: Array.from(relatedFiles).sort(),
    unresolvedImports: Array.from(unresolvedImports).sort().slice(0, 40),
  };
}

async function detectValidationStrategy(root: string, stack: ProjectStack): Promise<ValidationStrategy> {
  const packageManager = stack.packageManager ?? (await detectPackageManager(root));
  const scripts = stack.scripts;
  const commands: ValidationStrategy['commands'] = [];
  const missing: string[] = [];
  const addScript = (kind: ValidationStrategy['commands'][number]['kind'], scriptName: string, reason: string) => {
    if (scripts[scriptName]) commands.push({ kind, command: `${packageManager} run ${scriptName}`, reason });
  };

  addScript('typecheck', 'typecheck', 'TypeScript correctness before and after edits');
  addScript('lint', 'lint', 'Static lint and style guard');
  addScript('test', 'test', 'Regression test gate');
  addScript('build', 'build', 'Production build gate for UI/API changes');
  addScript('format', 'format', 'Formatting consistency if configured');
  addScript('preview', 'dev', 'Manual browser/preview verification when UI behavior changes');

  if (!commands.some((command) => command.kind === 'typecheck') && (await exists(path.join(root, 'tsconfig.json')))) {
    commands.push({ kind: 'typecheck', command: `${packageManager} exec tsc --noEmit`, reason: 'Fallback TypeScript check because tsconfig.json exists' });
  }
  if (!commands.some((command) => command.kind === 'test')) missing.push('No test script detected');
  if (!commands.some((command) => command.kind === 'lint')) missing.push('No lint script detected');
  if (!commands.some((command) => command.kind === 'build')) missing.push('No build script detected');

  return { packageManager, commands, missing };
}

function buildRiskAssessment(
  mode: CodeSpaceAgentMode,
  intents: string[],
  prompt: string,
  context: ContextSearchResult,
  validation: ValidationStrategy,
): RiskAssessment {
  const reasons: string[] = [];
  const approvalGates = [
    'Show file-level diff before writing to disk.',
    'Require approval for shell commands, dependency changes, deletions, generated migrations, and git writes.',
    'Run validation commands after accepted edits and keep terminal output attached to the session.',
  ];
  let level: RiskAssessment['level'] = mode === 'ask' ? 'low' : mode === 'plan' ? 'medium' : 'medium';

  if (intents.some((intent) => ['dependency/setup', 'git_operation', 'fresh_build_from_plan'].includes(intent))) {
    level = 'high';
    reasons.push('Request can affect dependencies, git history, or large generated surfaces.');
  }
  if (/delete|remove|migration|database|auth|security|secret|env|deploy|production/i.test(prompt)) {
    level = 'high';
    reasons.push('Prompt mentions high-blast-radius operations.');
  }
  if (context.files.some((file) => /route|api|auth|middleware|db|schema|config|package\.json/i.test(file.path))) {
    if (level === 'low') level = 'medium';
    reasons.push('Selected context includes API/config/runtime-sensitive files.');
  }
  if (validation.missing.length) {
    reasons.push(`Validation gaps detected: ${validation.missing.join(', ')}.`);
  }
  if (!reasons.length) reasons.push('Request appears limited to local source understanding or low-risk edits.');

  return { level, reasons, approvalGates };
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
  repoMap,
  dependencyTrace,
  validation,
  risk,
}: {
  root: string;
  sessionId: string;
  projectName: string;
  prompt: string;
  intents: string[];
  contextFiles: ContextFile[];
  plan: string[];
  clarifyingQuestions: Array<{ id: string; question: string; choices: string[] }>;
  repoMap: RepoMap;
  dependencyTrace: DependencyTrace;
  validation: ValidationStrategy;
  risk: RiskAssessment;
}) {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96) || 'session';
  const filePath = `.codex/plans/${safeSessionId}.md`;
  const absolute = path.resolve(root, filePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('Plan markdown path escapes project root');
  }
  const contextList = contextFiles.length
    ? contextFiles.map((file) => `- \`${file.path}\` — score ${file.score}; ${file.lineCount} lines; ${file.reasons.join(', ')}${file.truncated ? ' (partial)' : ''}`).join('\n')
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
  const validationLines = validation.commands.length
    ? validation.commands.map((command) => `- \`${command.command}\` — ${command.reason}`).join('\n')
    : '- No executable validation commands detected.';
  const content = [
    `# ${projectName} Agent Workflow Plan`,
    '',
    `Prompt: ${prompt}`,
    '',
    `Intents: ${intents.join(', ')}`,
    `Risk: ${risk.level}`,
    '',
    '## Clarifying Questions',
    '',
    questions,
    '',
    '## Cursor/Codex/Claude-Code Gap Analysis',
    '',
    '- Current Code Space now performs repo mapping, context search, dependency tracing, risk assessment, and validation discovery in one run.',
    '- Remaining product gap: connect the provider-backed model loop to tool execution so Code mode can iteratively call read/search/patch/validate tools instead of only producing a grounded strategy.',
    '- Remaining product gap: add multi-agent work queues for researcher, implementer, reviewer, and validator roles with isolated patch/checkpoint state.',
    '- Remaining product gap: add preview/browser verification and persistent memory files such as AGENTS.md/CLAUDE.md-style project instructions.',
    '',
    '## Repository Map',
    '',
    `- Files considered: ${repoMap.filesConsidered}`,
    `- Languages: ${repoMap.stack.languages.join(', ') || 'unknown'}`,
    `- Frameworks: ${repoMap.stack.frameworks.join(', ') || 'unknown'}`,
    `- Package manager: ${repoMap.stack.packageManager ?? 'unknown'}`,
    `- Key files: ${repoMap.keyFiles.slice(0, 16).map((file) => `\`${file}\``).join(', ') || 'none detected'}`,
    '',
    '## Context Reviewed',
    '',
    contextList,
    '',
    '## Dependency Trace',
    '',
    dependencyTrace.imports.length
      ? dependencyTrace.imports.map((entry) => `- \`${entry.from}\` imports ${entry.imports.length ? entry.imports.map((item) => `\`${item}\``).join(', ') : 'nothing detected'}`).join('\n')
      : '- No import edges detected in selected context.',
    '',
    '## Task Breakdown',
    '',
    ...plan.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## Implementation Workflow',
    '',
    '1. Research agent maps relevant files, imports, tests, and validation commands.',
    '2. Planner agent decomposes the request into smallest reviewable patch units.',
    '3. Implementer agent proposes diffs only after reading target files and nearby patterns.',
    '4. Reviewer agent checks blast radius, style consistency, and missing tests.',
    '5. Validator agent runs typecheck/lint/tests/build and feeds failures back into repair turns.',
    '6. Handoff summarizes changed files, validation evidence, rollback notes, and follow-up risks.',
    '',
    '## Approval Gates',
    '',
    ...risk.approvalGates.map((gate) => `- ${gate}`),
    '',
    '## Validation Plan',
    '',
    validationLines,
    validation.missing.length ? `\nMissing validation signals: ${validation.missing.join(', ')}` : '',
    '',
  ].join('\n');

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
  repoMap,
  dependencyTrace,
  validation,
  risk,
}: {
  mode: CodeSpaceAgentMode;
  projectName: string;
  prompt: string;
  intents: string[];
  contextFiles: ContextFile[];
  plan: string[];
  planMarkdownPath: string | null;
  planMarkdownContent: string;
  clarifyingQuestions: Array<{ id: string; question: string; choices: string[] }>;
  repoMap: RepoMap;
  dependencyTrace: DependencyTrace;
  validation: ValidationStrategy;
  risk: RiskAssessment;
}) {
  const citations = contextFiles
    .slice(0, 8)
    .map((file) => `- ${file.path}${file.truncated ? ' (partial)' : ''} — ${file.reasons.join(', ')}`)
    .join('\n');
  const primaryMode = mode === 'ask' ? 'Ask' : mode === 'plan' ? 'Plan' : 'Code';
  const contextSummary = contextFiles.length
    ? `I inspected these files:\n${citations}`
    : 'I did not find readable source files that matched the prompt.';
  const validationSummary = validation.commands.length
    ? validation.commands.map((command) => `- ${command.command} (${command.kind})`).join('\n')
    : '- No package validation commands detected yet.';
  const clarifyingSummary = clarifyingQuestions.length
    ? 'Answer the sidebar clarifying questions to refine the next implementation pass.'
    : 'No blocking clarification questions were needed for this pass.';
  const planFileSummary = planMarkdownPath
    ? `Full planning doc is ready at ${planMarkdownPath} (${planMarkdownContent.length} characters).`
    : '';

  return [
    `Mode: ${primaryMode}`,
    '',
    `For ${projectName}, I classified the request as: ${intents.join(', ')}.`,
    `Risk: ${risk.level} — ${risk.reasons.join(' ')}`,
    '',
    'Repository map:',
    `- ${repoMap.filesConsidered} code/config/doc files considered`,
    `- Stack: ${[...repoMap.stack.languages, ...repoMap.stack.frameworks].join(', ') || 'unknown'}`,
    `- Key files detected: ${repoMap.keyFiles.slice(0, 8).join(', ') || 'none'}`,
    '',
    contextSummary,
    '',
    'Dependency trace:',
    dependencyTrace.relatedFiles.length
      ? `Related files inferred from imports: ${dependencyTrace.relatedFiles.join(', ')}`
      : 'No additional related files were confidently inferred from selected imports.',
    '',
    'Visible workflow:',
    ...plan.map((item, index) => `${index + 1}. ${item}`),
    '',
    'Validation candidates:',
    validationSummary,
    validation.missing.length ? `Validation gaps: ${validation.missing.join(', ')}` : '',
    '',
    planFileSummary,
    primaryMode === 'Plan' ? clarifyingSummary : '',
    primaryMode === 'Ask'
      ? `Answer: based on the available context, this is a read-only codebase question. Prompt: "${prompt}". No file edits or commands were performed.`
      : primaryMode === 'Plan'
        ? 'Next step: edit the markdown plan directly or reply with clarifications, then switch to Code mode when ready to implement.'
        : 'Code mode now performs deep workflow analysis and validation discovery. The remaining implementation gap is the provider-backed edit loop that can execute approved patch proposals and repair turns.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildValidationSummary(mode: CodeSpaceAgentMode, planMarkdownPath: string | null, validation: ValidationStrategy, risk: RiskAssessment): string {
  const commands = validation.commands.map((command) => command.command).join('\n');
  return [
    mode === 'plan' && planMarkdownPath
      ? `Plan mode created or updated ${planMarkdownPath}. Source files were not changed.`
      : 'No workspace source files were changed by this analysis run.',
    `Risk gate: ${risk.level}.`,
    commands ? `Detected validation commands:\n${commands}` : 'No validation commands were detected.',
  ].join('\n');
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function detectPackageManager(rootPath: string, packageManager?: string): Promise<string> {
  if (packageManager?.startsWith('pnpm')) return 'pnpm';
  if (packageManager?.startsWith('yarn')) return 'yarn';
  if (packageManager?.startsWith('bun')) return 'bun';
  if (await exists(path.join(rootPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(rootPath, 'yarn.lock'))) return 'yarn';
  if (await exists(path.join(rootPath, 'bun.lockb'))) return 'bun';
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

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) {
    chunks.push(text.slice(index, index + 220));
  }
  return chunks;
}
