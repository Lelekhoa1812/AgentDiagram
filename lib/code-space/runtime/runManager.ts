import type { CreateRunInput, RunRecord } from '@/lib/code-space/domain';
import { AgentOrchestrator } from './agentOrchestrator';
import { getEventStore, type EventStore } from './eventStore';
import { createCodeSpaceId } from './ids';
import { ProjectManager } from './projectManager';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';
import { SessionManager } from './sessionManager';

export class RunManager {
  constructor(
    private readonly store: JsonCodeSpaceStore = getCodeSpaceStore(),
    private readonly events: EventStore = getEventStore(),
    private readonly sessions = new SessionManager(store),
    private readonly projects = new ProjectManager(store),
    private readonly orchestrator = new AgentOrchestrator(store, events),
  ) {}

  async createRun(input: CreateRunInput, options: { openTabs?: string[]; start?: boolean } = {}): Promise<RunRecord> {
    const session = await this.sessions.getSession(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    const project = await this.projects.getProject(session.projectId);
    if (!project) throw new Error(`Project not found: ${session.projectId}`);
    const now = Date.now();
    const run: RunRecord = {
      id: createCodeSpaceId('run', now),
      sessionId: session.id,
      projectId: project.id,
      status: options.start === false ? 'queued' : 'running',
      mode: input.mode ?? session.mode,
      autonomy: input.autonomy ?? 'approval_required',
      model: input.model,
      prompt: input.prompt,
      startedAt: options.start === false ? undefined : now,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsert('runs', run);
    await this.events.emit({ type: 'run.created', projectId: project.id, sessionId: session.id, runId: run.id, payload: { mode: run.mode, autonomy: run.autonomy } });

    if (options.start !== false) {
      void this.startRun(run, project.rootPath, project.name, options).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.failRun(run.id, message);
      });
    }

    return run;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const data = await this.store.read();
    return data.runs.find((run) => run.id === runId) ?? null;
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const updated: RunRecord = { ...run, status: 'cancelled', completedAt: Date.now(), updatedAt: Date.now() };
    await this.store.upsert('runs', updated);
    await this.events.emit({ type: 'run.cancelled', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { status: 'cancelled' } });
    return updated;
  }

  private async startRun(run: RunRecord, projectRoot: string, projectName: string, options: { openTabs?: string[] }): Promise<void> {
    await this.orchestrator.run(run, projectRoot, projectName, { openTabs: options.openTabs });
    const completed: RunRecord = { ...run, status: 'completed', completedAt: Date.now(), updatedAt: Date.now() };
    await this.store.upsert('runs', completed);
  }

  private async failRun(runId: string, message: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run) return;
    const failed: RunRecord = { ...run, status: 'failed', error: message, completedAt: Date.now(), updatedAt: Date.now() };
    await this.store.upsert('runs', failed);
    await this.events.emit({ type: 'run.failed', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { message } });
  }
}

