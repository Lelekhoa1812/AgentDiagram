import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createFileCheckpoint } from '@/lib/code-space/runtime';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const PatchFile = z.object({
  path: z.string().min(1),
  beforeContent: z.string(),
  afterContent: z.string(),
});

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    rootPath: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().optional(),
    patchId: z.string().min(1),
    files: z.array(PatchFile).min(1),
  }),
]);

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
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  }

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) {
    return NextResponse.json({ error: guarded.reason ?? 'Invalid project root' }, { status: 400 });
  }

  try {
    // Motivation vs Logic: patch acceptance is intentionally server-side so every write is
    // preceded by an auditable checkpoint and conflict check instead of trusting client state.
    const checkpoint = await createFileCheckpoint({
      projectId: parsed.data.projectId,
      projectRoot: guarded.resolved,
      runId: parsed.data.runId,
      reason: `before applying ${parsed.data.patchId}`,
      files: parsed.data.files.map((file) => file.path),
    });

    for (const file of parsed.data.files) {
      const target = resolveInside(guarded.resolved, file.path);
      let current = '';
      try {
        current = await fs.readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (current !== file.beforeContent) {
        return NextResponse.json(
          {
            error: `Patch conflict in ${file.path}. The file changed since the proposal was created.`,
            code: 'PATCH_CONFLICT',
            checkpoint,
          },
          { status: 409 },
        );
      }
    }

    for (const file of parsed.data.files) {
      const target = resolveInside(guarded.resolved, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.afterContent, 'utf8');
    }

    return NextResponse.json({
      patchId: parsed.data.patchId,
      status: 'applied',
      filesChanged: parsed.data.files.map((file) => file.path),
      checkpoint,
      appliedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
