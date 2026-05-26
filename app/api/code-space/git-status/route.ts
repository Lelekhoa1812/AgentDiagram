import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const Body = z.object({ rootPath: z.string().min(1) });

async function git(rootPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', rootPath, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout.trim();
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) return NextResponse.json({ error: guarded.reason ?? 'Invalid repository path' }, { status: 400 });

  try {
    await git(guarded.resolved, ['rev-parse', '--is-inside-work-tree']);
    const [branch, porcelain, latestCommit] = await Promise.all([
      git(guarded.resolved, ['branch', '--show-current']).catch(() => 'detached'),
      git(guarded.resolved, ['status', '--porcelain=v1', '--branch']),
      git(guarded.resolved, ['log', '-1', '--pretty=%h %s']).catch(() => ''),
    ]);

    const lines = porcelain.split(/\r?\n/).filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith('## ')) ?? '';
    const fileLines = lines.filter((line) => !line.startsWith('## '));
    const stagedFiles = fileLines.filter((line) => line[0] !== ' ' && line[0] !== '?').length;
    const untrackedFiles = fileLines.filter((line) => line.startsWith('??')).length;
    const ahead = Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0);

    return NextResponse.json({
      branch: branch || 'detached',
      changedFiles: fileLines.length,
      stagedFiles,
      untrackedFiles,
      ahead,
      behind,
      latestCommit,
      files: fileLines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) })),
    });
  } catch (err) {
    return NextResponse.json({
      branch: null,
      changedFiles: 0,
      stagedFiles: 0,
      untrackedFiles: 0,
      ahead: 0,
      behind: 0,
      latestCommit: '',
      unavailable: err instanceof Error ? err.message : String(err),
    });
  }
}
