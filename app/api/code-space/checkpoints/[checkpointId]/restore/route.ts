import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getCodeSpaceStore, getEventStore, ProjectManager, type FileCheckpoint } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes project root: ${relativePath}`);
  return target;
}

export async function POST(_req: Request, { params }: { params: { checkpointId: string } }) {
  const data = await getCodeSpaceStore().read();
  const record = data.checkpoints.find((checkpoint) => checkpoint.id === params.checkpointId);
  if (!record) return NextResponse.json({ error: 'Checkpoint not found' }, { status: 404 });
  const project = await new ProjectManager().getProject(record.projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  try {
    const checkpoint = JSON.parse(await fs.readFile(record.snapshotRef, 'utf8')) as FileCheckpoint;
    for (const file of checkpoint.files) {
      const target = resolveInside(project.rootPath, file.path);
      if (!file.existed) {
        await fs.rm(target, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content ?? '', 'utf8');
    }
    await getEventStore().emit({ type: 'checkpoint.restored', projectId: project.id, runId: record.runId, payload: { checkpointId: record.id, files: checkpoint.files.map((file) => file.path) } });
    return NextResponse.json({ checkpointId: record.id, restoredAt: Date.now(), files: checkpoint.files.map((file) => file.path) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

