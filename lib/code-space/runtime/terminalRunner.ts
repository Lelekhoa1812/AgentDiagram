import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatCommand, isRiskyTerminalCommand, redactTerminalOutput, type TerminalCommand } from './terminalPolicy';

const execFileAsync = promisify(execFile);

export interface TerminalRunResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
}

export class TerminalRunner {
  async run(command: TerminalCommand, root: string, signal?: AbortSignal): Promise<TerminalRunResult> {
    const startedAt = Date.now();
    const displayCommand = formatCommand(command);
    if (isRiskyTerminalCommand(command)) {
      return {
        command: displayCommand,
        status: 'skipped',
        output: `Command requires explicit approval: ${displayCommand}`,
        durationMs: Date.now() - startedAt,
      };
    }
    if (signal?.aborted) {
      return {
        command: displayCommand,
        status: 'skipped',
        output: 'Command skipped because the run was cancelled.',
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(command.command, command.args, {
        cwd: command.cwd ?? root,
        env: { ...process.env },
        timeout: command.timeoutMs ?? 120_000,
        maxBuffer: 1024 * 1024 * 12,
        signal,
      });
      return {
        command: displayCommand,
        status: 'passed',
        output: redactTerminalOutput([stdout, stderr].filter(Boolean).join('\n').trim() || command.reason),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const execError = error as Error & { stdout?: string; stderr?: string; code?: unknown };
      const output = [execError.stdout ?? '', execError.stderr ?? '', execError.message ?? 'Command failed'].filter(Boolean).join('\n').trim();
      return {
        command: displayCommand,
        status: signal?.aborted ? 'skipped' : 'failed',
        output: redactTerminalOutput(output || command.reason),
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
