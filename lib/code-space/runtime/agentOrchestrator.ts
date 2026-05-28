import type { RunRecord } from '@/lib/code-space/domain';
import { guardPath } from '@/lib/security/pathGuard';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { AgentRuntime } from './agentRuntime';
import { getEventStore, type EventStore } from './eventStore';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';

export class AgentOrchestrator {
  constructor(
    private readonly store: JsonCodeSpaceStore = getCodeSpaceStore(),
    private readonly events: EventStore = getEventStore(),
    private readonly runtime = new AgentRuntime(),
  ) {}

  async run(run: RunRecord, projectRoot: string, projectName: string, options: { openTabs?: string[] } = {}): Promise<void> {
    const guarded = guardPath(projectRoot);
    if (!guarded.ok) throw new Error(guarded.reason ?? 'Invalid project root');

    // Motivation vs Logic: RunManager and the API route used to execute different agent workflows. This adapter
    // keeps the legacy orchestrator reachable while delegating all behavior to AgentRuntime as the single source.
    const emit = async (event: AgentSSEEvent) => {
      if (event.type === 'structured_event') return;
      if (event.type === 'text_delta') {
        await this.events.emit({ type: 'message.assistant.delta', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { text: event.delta } });
      }
      if (event.type === 'agent_done') {
        await this.events.emit({ type: 'message.assistant.completed', projectId: run.projectId, sessionId: run.sessionId, runId: run.id, payload: { content: event.summary } });
      }
    };

    await this.runtime.run(
      {
        sessionId: run.sessionId,
        projectRoot: guarded.resolved,
        projectName,
        messages: [{ role: 'user', content: run.prompt }],
        model: run.model ?? '',
        providerId: 'openai',
        apiKey: '',
        openTabs: options.openTabs ?? [],
        mode: run.mode === 'ask' || run.mode === 'plan' || run.mode === 'code' ? run.mode : 'code',
        toolBudget: 50,
        attachments: [],
      },
      emit,
    );
  }
}
