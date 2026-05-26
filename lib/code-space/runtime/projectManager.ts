import path from 'node:path';
import type { ProjectRecord } from '@/lib/code-space/domain';
import { guardPath } from '@/lib/security/pathGuard';
import { createCodeSpaceId } from './ids';
import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';

export class ProjectManager {
  constructor(private readonly store: JsonCodeSpaceStore = getCodeSpaceStore()) {}

  async createProject(input: { name?: string; rootPath: string; repoUrl?: string; defaultBranch?: string }): Promise<ProjectRecord> {
    const guarded = guardPath(input.rootPath);
    if (!guarded.ok) throw new Error(guarded.reason ?? 'Invalid project path');
    const now = Date.now();
    const project: ProjectRecord = {
      id: createCodeSpaceId('project', now),
      name: input.name ?? path.basename(guarded.resolved),
      rootPath: guarded.resolved,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      createdAt: now,
      updatedAt: now,
      settings: {},
    };
    await this.store.upsert('projects', project);
    return project;
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const data = await this.store.read();
    return data.projects.find((project) => project.id === projectId) ?? null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const data = await this.store.read();
    return data.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

