import { NextResponse } from 'next/server';
import { getCodeSpaceStore, getEventStore, ProjectManager, loadFileCheckpoint, restoreFileCheckpoint } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { checkpointId: string } }) {
  const data = await getCodeSpaceStore().read();
  const record = data.checkpoints.find((checkpoint) => checkpoint.id === params.checkpointId);
  if (!record) return NextResponse.json({ error: 'Checkpoint not found' }, { status: 404 });
  const project = await new ProjectManager().getProject(record.projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  try {
    const checkpoint = await loadFileCheckpoint(record.snapshotRef);
    const files = await restoreFileCheckpoint(project.rootPath, checkpoint);
    await getEventStore().emit({ type: 'checkpoint.restored', projectId: project.id, runId: record.runId, payload: { checkpointId: record.id, files } });
    return NextResponse.json({ checkpointId: record.id, restoredAt: Date.now(), files });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

