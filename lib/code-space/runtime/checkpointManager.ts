import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardPath } from '@/lib/security/pathGuard';

export interface CheckpointFileSnapshot {
  path: string;
  content: string | null;
  existed: boolean;
}

export interface FileCheckpoint {
  id: string;
  projectId: string;
  runId?: string;
  reason: string;
  snapshotRef: string;
  files: CheckpointFileSnapshot[];
  createdAt: number;
}

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Checkpoint path escapes project root: ${relativePath}`);
  }
  return target;
}

export async function createFileCheckpoint({
  projectId,
  projectRoot,
  runId,
  reason,
  files,
  createdAt = Date.now(),
}: {
  projectId: string;
  projectRoot: string;
  runId?: string;
  reason: string;
  files: string[];
  createdAt?: number;
}): Promise<FileCheckpoint> {
  const guarded = guardPath(projectRoot);
  if (!guarded.ok) {
    throw new Error(guarded.reason ?? 'Invalid project root');
  }

  const snapshots: CheckpointFileSnapshot[] = [];
  for (const file of files) {
    const target = resolveInside(guarded.resolved, file);
    try {
      snapshots.push({ path: file, content: await fs.readFile(target, 'utf8'), existed: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      snapshots.push({ path: file, content: null, existed: false });
    }
  }

  const checkpoint: FileCheckpoint = {
    id: `checkpoint:${createdAt}:${Math.random().toString(36).slice(2, 10)}`,
    projectId,
    runId,
    reason,
    snapshotRef: '',
    files: snapshots,
    createdAt,
  };
  const checkpointDir = path.join(os.tmpdir(), 'code-space-checkpoints');
  await fs.mkdir(checkpointDir, { recursive: true });
  checkpoint.snapshotRef = path.join(checkpointDir, `${checkpoint.id.replace(/[:/]/g, '-')}.json`);
  await fs.writeFile(checkpoint.snapshotRef, JSON.stringify(checkpoint, null, 2), 'utf8');
  return checkpoint;
}
