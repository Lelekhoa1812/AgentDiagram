import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCodeSpaceStore, getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const Body = z.object({ reason: z.string().optional() });

export async function POST(req: Request, { params }: { params: { patchId: string } }) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const store = getCodeSpaceStore();
  const data = await store.read();
  const patch = data.patches.find((item) => item.id === params.patchId);
  if (!patch) return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
  const updated = { ...patch, status: 'rejected' as const, rejectedAt: Date.now() };
  await store.upsert('patches', updated);
  await getEventStore().emit({ type: 'patch.rejected', projectId: updated.projectId, runId: updated.runId, payload: { patchId: updated.id, reason: parsed.data.reason } });
  return NextResponse.json({ patch: updated });
}

