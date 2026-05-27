import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('restore'),
    rootPath: z.string().min(1),
    checkpointRef: z.string().min(1),
  }),
]);

interface CheckpointFileSnapshot {
  path: string;
  content: string | null;
  existed: boolean;
}

interface FileCheckpoint {
  id: string;
  projectId: string;
  runId?: string;
  reason: string;
  snapshotRef: string;
  files: CheckpointFileSnapshot[];
  createdAt: number;
}

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Checkpoint path escapes project root: ${relativePath}`);
  }
  return target;
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) return NextResponse.json({ error: guarded.reason ?? 'Invalid project root' }, { status: 400 });

  try {
    const raw = await fs.readFile(parsed.data.checkpointRef, 'utf8');
    const checkpoint = JSON.parse(raw) as FileCheckpoint;
    const restored: Array<{ path: string; action: 'restored' | 'deleted' }> = [];

    for (const file of [...checkpoint.files].reverse()) {
      const target = resolveInside(guarded.resolved, file.path);
      if (file.existed) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content ?? '', 'utf8');
        restored.push({ path: file.path, action: 'restored' });
      } else {
        await fs.rm(target, { force: true, recursive: true });
        restored.push({ path: file.path, action: 'deleted' });
      }
    }

    return NextResponse.json({
      checkpointId: checkpoint.id,
      status: 'restored',
      restored,
      restoredAt: Date.now(),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
