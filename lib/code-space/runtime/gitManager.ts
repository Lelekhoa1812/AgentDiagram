import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitStatusFile {
  status: string;
  path: string;
}

export interface GitStatusSnapshot {
  branch: string | null;
  changedFiles: number;
  stagedFiles: number;
  untrackedFiles: number;
  ahead: number;
  behind: number;
  latestCommit: string;
  files: GitStatusFile[];
  unavailable?: string;
}

async function git(rootPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', rootPath, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 * 1024 * 8,
  });
  return result.stdout.trim();
}

export class GitManager {
  async status(rootPath: string): Promise<GitStatusSnapshot> {
    try {
      await git(rootPath, ['rev-parse', '--is-inside-work-tree']);
      const [branch, porcelain, latestCommit] = await Promise.all([
        git(rootPath, ['branch', '--show-current']).catch(() => 'detached'),
        git(rootPath, ['status', '--porcelain=v1', '--branch']),
        git(rootPath, ['log', '-1', '--pretty=%h %s']).catch(() => ''),
      ]);
      return parseGitStatus(branch || 'detached', porcelain, latestCommit);
    } catch (error) {
      return {
        branch: null,
        changedFiles: 0,
        stagedFiles: 0,
        untrackedFiles: 0,
        ahead: 0,
        behind: 0,
        latestCommit: '',
        files: [],
        unavailable: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async diff(rootPath: string, filePath?: string): Promise<{ diff: string; stagedDiff: string; unavailable?: string }> {
    try {
      await git(rootPath, ['rev-parse', '--is-inside-work-tree']);
      const pathArgs = filePath ? ['--', filePath] : ['--'];
      const [diff, stagedDiff] = await Promise.all([
        git(rootPath, ['diff', ...pathArgs]),
        git(rootPath, ['diff', '--cached', ...pathArgs]),
      ]);
      return { diff, stagedDiff };
    } catch (error) {
      return { diff: '', stagedDiff: '', unavailable: error instanceof Error ? error.message : String(error) };
    }
  }
}

export function parseGitStatus(branch: string, porcelain: string, latestCommit = ''): GitStatusSnapshot {
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith('## ')) ?? '';
  const fileLines = lines.filter((line) => !line.startsWith('## '));
  return {
    branch,
    changedFiles: fileLines.length,
    stagedFiles: fileLines.filter((line) => line[0] !== ' ' && line[0] !== '?').length,
    untrackedFiles: fileLines.filter((line) => line.startsWith('??')).length,
    ahead: Number(branchLine.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(branchLine.match(/behind (\d+)/)?.[1] ?? 0),
    latestCommit,
    files: fileLines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) })),
  };
}

