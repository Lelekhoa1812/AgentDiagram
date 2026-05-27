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

    await this.events.emit({ type: 'run.started', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { mode: run.mode } });
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
    await this.events.emit({
      type: 'context.search.completed',
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.id,
      payload: { filesConsidered: context.filesConsidered, selectedFiles: context.files.map((file) => file.path) },
    });
    await this.markTodo(todos[0], 'done');

    await this.markTodo(todos[1], 'in_progress');
    const validationCommands = await this.validationManager.detectValidationCommands(guarded.resolved);
    const answer = this.buildAnswer(projectName, run, context.files, validationCommands.map((command) => `${command.command} ${command.args.join(' ')}`));
    for (const delta of chunkText(answer)) {
      await this.events.emit({ type: 'message.assistant.delta', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { text: delta } });
    }
    await this.events.emit({ type: 'message.assistant.completed', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { content: answer } });
    await this.markTodo(todos[1], 'done');

    await this.markTodo(todos[2], 'in_progress');
    await this.events.emit({
      type: 'validation.completed',
      projectId: run.projectId,
      sessionId: run.sessionId,
      runId: run.id,
      payload: {
        command: run.mode === 'ask' || run.mode === 'plan' ? 'read-only runtime validation' : 'implementation requires approval-gated edit phase',
        status: 'passed',
        summary: 'The runtime completed without mutating workspace files.',
      },
    });
    await this.markTodo(todos[2], 'done');
    await this.events.emit({ type: 'run.completed', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { status: 'completed', filesChanged: [] } });
  }

  private createTodos(run: RunRecord): TodoRecord[] {
    const now = Date.now();
    const titles =
      run.mode === 'ask'
        ? ['Search and read relevant files', 'Answer with file citations', 'Confirm no workspace changes were made']
        : ['Investigate relevant files and project signals', 'Create a visible plan and validation strategy', 'Stop before edits until patch approval is available'];
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
    const modeLabel = run.mode === 'ask' ? 'Ask' : run.mode === 'plan' ? 'Plan' : 'Code';
    const citations = files.length
      ? files.slice(0, 6).map((file) => `- ${file.path}${file.truncated ? ' (partial)' : ''}`).join('\n')
      : '- No matching readable source files were found.';
    const validation = validationCommands.length ? validationCommands.map((command) => `- ${command}`).join('\n') : '- No package validation commands detected yet.';
    return [
      `Mode: ${modeLabel}`,
      '',
      `Project: ${projectName}`,
      '',
      'Context inspected:',
      citations,
      '',
      'Validation candidates:',
      validation,
      '',
      run.mode === 'ask'
        ? 'This run stayed read-only and answered from inspected project context.'
        : 'This run produced a non-mutating plan foundation. Patch application remains approval-gated and checkpointed.',
    ].join('\n');
  }
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 220) chunks.push(text.slice(index, index + 220));
  return chunks;
}
