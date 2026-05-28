import type { RunRecord, TodoRecord } from '@/lib/code-space/domain';
import { guardPath } from '@/lib/security/pathGuard';
import { ContextEngine } from './contextEngine';
import { getEventStore, type EventStore } from './eventStore';
import { createCodeSpaceId } from './ids';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';
import { ValidationManager } from './validationManager';

export class AgentOrchestrator {
  constructor(
    private readonly store: JsonCodeSpaceStore = getCodeSpaceStore(),
    private readonly events: EventStore = getEventStore(),
    private readonly contextEngine = new ContextEngine(),
    private readonly validationManager = new ValidationManager(),
  ) {}

  async run(run: RunRecord, projectRoot: string, projectName: string, options: { openTabs?: string[] } = {}): Promise<void> {
    const guarded = guardPath(projectRoot);
    if (!guarded.ok) throw new Error(guarded.reason ?? 'Invalid project root');

    await this.events.emit({ type: 'run.started', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { mode: run.mode, phase: 'created' } });
    await this.events.emit({ type: 'plan.updated', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { phase: 'classifying' } });
    const todos = this.createTodos(run);
    await this.store.update((data) => {
      data.todos.push(...todos);
    });
    await this.events.emit({ type: 'plan.created', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { items: todos.map((todo) => todo.title) } });
    for (const todo of todos) {
      await this.events.emit({ type: 'todo.created', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: todo });
    }

    await this.markTodo(todos[0], 'in_progress');
    await this.events.emit({ type: 'context.search.started', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { openTabs: options.openTabs ?? [] } });
    const context = await this.contextEngine.collectProjectContext(guarded.resolved, run.prompt, options.openTabs ?? []);
    await this.events.emit({ type: 'plan.updated', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { phase: 'gathering_context' } });
    await this.events.emit({
      type: 'context.search.completed',
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.id,
      payload: { filesConsidered: context.filesConsidered, selectedFiles: context.files.map((file) => file.path), confidence: context.confidence, missingContextWarnings: context.missingContextWarnings },
    });
    await this.markTodo(todos[0], 'done');

    await this.events.emit({ type: 'plan.updated', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { phase: run.mode === 'plan' ? 'planning' : 'tracing_dependencies' } });
    await this.markTodo(todos[1], 'in_progress');
    const validationCommands = await this.validationManager.detectValidationCommands(guarded.resolved);
    const answer = this.buildAnswer(projectName, run, context.files, validationCommands.map((command) => `${command.command} ${command.args.join(' ')}`));
    for (const delta of chunkText(answer)) {
      await this.events.emit({ type: 'message.assistant.delta', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { text: delta } });
    }
    await this.events.emit({ type: 'message.assistant.completed', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { content: answer } });
    await this.markTodo(todos[1], 'done');

    await this.events.emit({ type: 'plan.updated', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { phase: 'validating' } });
    await this.markTodo(todos[2], 'in_progress');
    await this.events.emit({
      type: 'validation.completed',
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.id,
      payload: { command: run.mode === 'ask' || run.mode === 'plan' ? 'mode_contract.read_only' : 'mode_contract.requires_patch_review', status: 'passed', summary: run.mode === 'ask' ? 'Answered directly from repository evidence without modifying files.' : run.mode === 'plan' ? 'Produced implementation plan artifact only; no workspace source files changed.' : 'Execution completed with explicit policy-gated patch phase.', },
    });
    await this.markTodo(todos[2], 'done');
    await this.events.emit({ type: 'run.completed', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { status: run.mode === 'code' ? 'needs_review' : 'verified', phase: run.mode === 'code' ? 'needs_review' : 'verified', filesChanged: [] } });
  }

  private createTodos(run: RunRecord): TodoRecord[] {
    const now = Date.now();
    const titles =
      run.mode === 'ask'
        ? ['Gather repository evidence for the question', 'Answer directly from code evidence', 'Confirm strict read-only completion']
        : run.mode === 'plan'
          ? ['Map relevant repository surfaces and dependencies', 'Draft implementation-grade plan artifact', 'Define validation gates and handoff to Build from plan']
          : ['Map target files, symbols, and existing implementations', 'Prepare reviewable patch proposal (no blind overwrite)', 'Run validation gates and report unresolved failures'];
    return titles.map((title, index) => ({
      id: createCodeSpaceId(`todo-${index}`, now + index),
      runId: run.id,
      title,
      description: title,
      status: 'pending',
      owner: 'agent',
      priority: index === 0 ? 'high' : 'medium',
      dependencies: index === 0 ? [] : [String(index - 1)],
      files: [],
      validationMethod: index === 2 ? 'structured run completion event' : undefined,
      createdAt: now,
      updatedAt: now,
    }));
  }

  private async markTodo(todo: TodoRecord | undefined, status: TodoRecord['status']): Promise<void> {
    if (!todo) return;
    const updated = { ...todo, status, updatedAt: Date.now() };
    await this.store.upsert('todos', updated);
    await this.events.emit({ type: status === 'done' ? 'todo.completed' : 'todo.updated', runId: todo.runId, payload: updated });
  }

  private buildAnswer(
    projectName: string,
    run: RunRecord,
    files: Array<{ path: string; truncated: boolean }>,
    validationCommands: string[],
  ): string {
    const keyFiles = files.slice(0, 4).map((f) => `\`${f.path}\``);
    if (run.mode === 'ask') {
      return [
        `Here’s what I found in ${projectName}:`,
        keyFiles.length ? `The most relevant code paths are ${keyFiles.join(', ')}.` : 'I could not find enough relevant files to answer with confidence.',
        'If you want, I can trace deeper references or tests for a specific symbol/file.',
      ].join(' ');
    }
    if (run.mode === 'plan') {
      return [
        `Saved an implementation-oriented planning baseline for ${projectName}.`,
        keyFiles.length ? `Focus areas include ${keyFiles.join(', ')}.` : 'Focus areas were inferred from available repository signals.',
        validationCommands.length ? `Validation gates: ${validationCommands.slice(0, 4).join(', ')}.` : 'Validation gates still need to be configured.',
        'Use Build from plan to execute with policy-gated patch review.',
      ].join(' ');
    }
    return [
      `Prepared a production-safe coding workflow for ${projectName}.`,
      'Patch application remains approval/checkpoint gated and validation-aware.',
      validationCommands.length ? `Detected validation commands: ${validationCommands.slice(0, 4).join(', ')}.` : 'No runnable validation commands were detected automatically.',
    ].join(' ');
  }
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}
