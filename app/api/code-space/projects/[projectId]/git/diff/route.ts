import { NextResponse } from 'next/server';
import { GitManager, ProjectManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  const project = await new ProjectManager().getProject(params.projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  const url = new URL(req.url);
  return NextResponse.json(await new GitManager().diff(project.rootPath, url.searchParams.get('path') ?? undefined));
}

