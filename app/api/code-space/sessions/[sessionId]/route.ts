import { NextResponse } from 'next/server';
import { SessionManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { sessionId: string } }) {
  const session = await new SessionManager().getSession(params.sessionId);
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  return NextResponse.json({ session });
}

