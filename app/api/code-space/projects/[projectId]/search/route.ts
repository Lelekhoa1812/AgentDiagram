import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { NextResponse } from 'next/server';
import { ProjectManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  const project = await new ProjectManager().getProject(params.projectId);
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const url = new URL(req.url);
  const query = url.searchParams.get('q')?.trim();
  if (!query) return NextResponse.json({ error: 'q is required' }, { status: 400 });

  const files = await fg(['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**'], {
    cwd: project.rootPath,
    onlyFiles: true,
    dot: false,
    absolute: false,
  });
  const matches: Array<{ path: string; line: number; preview: string }> = [];
  for (const file of files.slice(0, 2_000)) {
    try {
      const content = await fs.readFile(path.join(project.rootPath, file), 'utf8');
      content.split(/\r?\n/).forEach((line, index) => {
        if (matches.length < 100 && line.toLowerCase().includes(query.toLowerCase())) {
          matches.push({ path: file, line: index + 1, preview: line.trim().slice(0, 240) });
        }
      });
    } catch {
      // Skip unreadable files.
    }
  }
  return NextResponse.json({ matches });
}

