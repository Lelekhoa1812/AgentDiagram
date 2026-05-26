import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const Body = z.object({
  rootPath: z.string().min(1),
  path: z.string().optional(),
});

async function git(rootPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', rootPath, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout.toString();
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) return NextResponse.json({ error: guarded.reason ?? 'Invalid repository path' }, { status: 400 });

  try {
    await git(guarded.resolved, ['rev-parse', '--is-inside-work-tree']);
    const args = ['diff', '--', ...(parsed.data.path ? [parsed.data.path] : [])];
    const diff = await git(guarded.resolved, args);
    const stagedDiff = await git(guarded.resolved, ['diff', '--cached', '--', ...(parsed.data.path ? [parsed.data.path] : [])]);
    return NextResponse.json({ diff, stagedDiff });
  } catch (err) {
    return NextResponse.json({ diff: '', stagedDiff: '', unavailable: err instanceof Error ? err.message : String(err) });
  }
}
