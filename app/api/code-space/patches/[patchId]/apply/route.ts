import { NextResponse } from 'next/server';
import { getCodeSpaceStore, getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { patchId: string } }) {
  const store = getCodeSpaceStore();
  const data = await store.read();
  const patch = data.patches.find((item) => item.id === params.patchId);
  if (!patch) return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
  const updated = { ...patch, status: 'applied' as const, appliedAt: Date.now() };
  await store.upsert('patches', updated);
  await getEventStore().emit({ type: 'patch.applied', projectId: updated.projectId, runId: updated.runId, payload: { patchId: updated.id, filesChanged: updated.filesChanged } });
  return NextResponse.json({ patch: updated });
}

