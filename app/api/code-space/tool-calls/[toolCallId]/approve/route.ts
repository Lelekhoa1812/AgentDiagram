import { NextResponse } from 'next/server';
import { getCodeSpaceStore, getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { toolCallId: string } }) {
  const store = getCodeSpaceStore();
  const data = await store.read();
  const toolCall = data.toolCalls.find((item) => item.id === params.toolCallId);
  if (!toolCall) return NextResponse.json({ error: 'Tool call not found' }, { status: 404 });
  const updated = { ...toolCall, approvalStatus: 'approved' as const, updatedAt: Date.now() };
  await store.upsert('toolCalls', updated);
  await getEventStore().emit({ type: 'tool.approved', runId: updated.runId, payload: { toolCallId: updated.id } });
  return NextResponse.json({ toolCall: updated });
}

