import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AgentModeSchema } from '@/lib/code-space/domain';
import { SessionManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const Body = z.object({
  projectId: z.string().min(1),
  userId: z.string().optional(),
  mode: AgentModeSchema.optional(),
  title: z.string().optional(),
});

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get('projectId') ?? undefined;
  return NextResponse.json({ sessions: await new SessionManager().listSessions(projectId) });
}

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  return NextResponse.json({ session: await new SessionManager().createSession(parsed.data) }, { status: 201 });
}

