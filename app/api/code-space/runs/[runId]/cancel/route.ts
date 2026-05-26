import { NextResponse } from 'next/server';
import { RunManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  try {
    return NextResponse.json({ run: await new RunManager().cancelRun(params.runId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

