import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TerminalRunner } from '@/lib/code-space/runtime/terminalRunner';
import { guardPath } from '@/lib/security/pathGuard';

const Body = z.object({
  rootPath: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).max(64).optional(),
  cwd: z.string().optional(),
  reason: z.string().optional(),
  timeoutMs: z.number().positive().max(600_000).optional(),
});

const COMMAND_PATTERN = /^[\w@./:-]+$/;
const terminalRunner = new TerminalRunner();

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { rootPath, command, args = [], cwd, reason, timeoutMs } = parsed.data;
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

  const cwdPath = cwd ? guardPath(cwd) : null;
  if (cwdPath && !cwdPath.ok) {
    return NextResponse.json({ error: cwdPath.reason ?? 'The requested cwd is not allowed' }, { status: 400 });
  }

  // Motivation vs Logic: terminal execution is the agent's escape hatch for repo discovery,
  // validation, and shell-native maintenance. Route it through the shared runner so Code Space
  // has one redaction/risky-command/timeout contract instead of parallel exec implementations.
  const result = await terminalRunner.run(
    {
      kind: 'shell',
      command,
      args,
      cwd: cwdPath?.resolved,
      reason: reason ?? 'Code Space terminal command',
      timeoutMs,
    },
    guarded.resolved,
  );
  return NextResponse.json({
    stdout: result.status === 'passed' ? result.output : '',
    stderr: result.status === 'passed' ? '' : result.output,
    exitCode: result.status === 'passed' ? 0 : 1,
    status: result.status,
    command: result.command,
    durationMs: result.durationMs,
    error: result.status === 'failed' ? result.output : undefined,
  }, { status: result.status === 'failed' ? 500 : 200 });
}
