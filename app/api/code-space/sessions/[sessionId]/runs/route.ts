import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AgentModeSchema, AutonomyLevelSchema } from '@/lib/code-space/domain';
import { RunManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const Body = z.object({
  prompt: z.string().min(1),
  mode: AgentModeSchema.optional(),
  autonomy: AutonomyLevelSchema.optional(),
  model: z.string().optional(),
  openTabs: z.array(z.string()).optional(),
});

export async function POST(req: Request, { params }: { params: { sessionId: string } }) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });

  try {
    const run = await new RunManager().createRun({ sessionId: params.sessionId, ...parsed.data }, { openTabs: parsed.data.openTabs });
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

