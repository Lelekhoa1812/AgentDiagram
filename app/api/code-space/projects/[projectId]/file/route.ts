import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ProjectManager } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const PutBody = z.object({
  path: z.string().min(1),
  content: z.string(),
  expectedHash: z.string().optional(),
});

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function resolveProjectFile(projectId: string, filePath: string) {
  const project = await new ProjectManager().getProject(projectId);
  if (!project) throw new Error('Project not found');
  const target = path.resolve(project.rootPath, filePath);
  if (target !== project.rootPath && !target.startsWith(`${project.rootPath}${path.sep}`)) {
    throw new Error('File path escapes project root');
  }
  return { project, target };
}

export async function GET(req: Request, { params }: { params: { projectId: string } }) {
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  if (!filePath) return NextResponse.json({ error: 'path is required' }, { status: 400 });

  try {
    const { target } = await resolveProjectFile(params.projectId, filePath);
    const buffer = await fs.readFile(target);
    if (buffer.includes(0)) return NextResponse.json({ error: 'Binary files cannot be opened in Code Space yet.' }, { status: 415 });
    const content = buffer.toString('utf8');
    return NextResponse.json({ path: filePath, content, hash: sha256(content), modifiedAt: (await fs.stat(target)).mtimeMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 });
  }
}

export async function PUT(req: Request, { params }: { params: { projectId: string } }) {
  const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });

  try {
    const { target } = await resolveProjectFile(params.projectId, parsed.data.path);
    let currentHash: string | null = null;
    try {
      currentHash = sha256(await fs.readFile(target, 'utf8'));
    } catch {
      currentHash = null;
    }
    if (parsed.data.expectedHash && currentHash && parsed.data.expectedHash !== currentHash) {
      return NextResponse.json({ error: 'File changed externally. Review latest content before overwriting.', code: 'CONFLICT', currentHash }, { status: 409 });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, parsed.data.content, 'utf8');
    return NextResponse.json({ path: parsed.data.path, hash: sha256(parsed.data.content), savedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === 'Project not found' ? 404 : 500 });
  }
}

