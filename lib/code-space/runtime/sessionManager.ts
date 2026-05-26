import type { CreateSessionInput, SessionRecord } from '@/lib/code-space/domain';
import { createCodeSpaceId } from './ids';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';

export class SessionManager {
  constructor(private readonly store: JsonCodeSpaceStore = getCodeSpaceStore()) {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now();
    const session: SessionRecord = {
      id: createCodeSpaceId('session', now),
      projectId: input.projectId,
      userId: input.userId ?? 'local-user',
      mode: input.mode ?? 'agent',
      title: input.title ?? 'New coding session',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsert('sessions', session);
    return session;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const data = await this.store.read();
    return data.sessions.find((session) => session.id === sessionId) ?? null;
  }

  async listSessions(projectId?: string): Promise<SessionRecord[]> {
    const data = await this.store.read();
    return data.sessions
      .filter((session) => !projectId || session.projectId === projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

