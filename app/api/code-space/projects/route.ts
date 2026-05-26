import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ProjectManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const CreateProjectBody = z.object({
  name: z.string().min(1).optional(),
  rootPath: z.string().min(1),
  repoUrl: z.string().url().optional(),
  defaultBranch: z.string().optional(),
});

export async function GET() {
  const manager = new ProjectManager();
  return NextResponse.json({ projects: await manager.listProjects() });
}

export async function POST(req: Request) {
  const parsed = CreateProjectBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  }

  try {
    const project = await new ProjectManager().createProject(parsed.data);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

