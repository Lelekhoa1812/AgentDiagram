import { NextResponse } from 'next/server';
import { getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  return NextResponse.json({ events: await getEventStore().list(params.runId) });
}

