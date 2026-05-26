import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardPath } from '@/lib/security/pathGuard';
import type { FileCheckpoint } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

const Body = z.object({
  rootPath: z.string().min(1),
  snapshotRef: z.string().min(1),
});

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return target;
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) return NextResponse.json({ error: guarded.reason ?? 'Invalid project root' }, { status: 400 });

  try {
    const checkpoint = JSON.parse(await fs.readFile(parsed.data.snapshotRef, 'utf8')) as FileCheckpoint;
    for (const file of checkpoint.files) {
      const target = resolveInside(guarded.resolved, file.path);
      if (!file.existed) {
        await fs.rm(target, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content ?? '', 'utf8');
    }
    return NextResponse.json({ checkpointId: checkpoint.id, restoredAt: Date.now(), files: checkpoint.files.map((file) => file.path) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
