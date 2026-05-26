import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardPath } from '@/lib/security/pathGuard';

const execFileAsync = promisify(execFile);

const Body = z.object({
  rootPath: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).max(64).optional(),
});

const COMMAND_PATTERN = /^[\w@./:-]+$/;

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { rootPath, command, args = [] } = parsed.data;
  if (!COMMAND_PATTERN.test(command) || command.includes('..')) {
    return NextResponse.json({ error: 'Command contains unsupported characters' }, { status: 400 });
  }

  const guarded = guardPath(rootPath);
  if (!guarded.ok) {
    return NextResponse.json(
      { error: guarded.reason ?? 'The requested path is not allowed' },
      { status: 400 },
    );
  }

  const start = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: guarded.resolved,
      env: { ...process.env },
      maxBuffer: 1024 * 1024 * 10,
    });
    return NextResponse.json({
      stdout: result.stdout?.toString() ?? '',
      stderr: result.stderr?.toString() ?? '',
      exitCode: 0,
      durationMs: Date.now() - start,
    });
  } catch (error) {
    const execError = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return NextResponse.json(
      {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? '',
        exitCode: typeof execError.code === 'number' ? execError.code : 1,
        error: execError.message ?? 'Command failed',
        durationMs: Date.now() - start,
      },
      { status: 500 },
    );
  }
}
