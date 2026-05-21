import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  __esModule: true,
  execFile: childProcessMock.execFile,
  default: { execFile: childProcessMock.execFile },
}));

import { normalizeGitHubRepoUrl, RepoSourceError, resolveRepoSource } from '../repoSource';
import * as childProcess from 'node:child_process';

const mockedExecFile = vi.mocked(childProcess.execFile);

type ExecCallback = (err: Error | null, stdout?: string, stderr?: string) => void;

function setGitMock(
  handler: (args: string[], options: { env?: NodeJS.ProcessEnv } | undefined) => { stdout?: string; stderr?: string } | Error,
): void {
  const implementation = ((...mockArgs: any[]) => {
    const [file, args, options, callback] = mockArgs as [
      string,
      string[] | undefined,
      { env?: NodeJS.ProcessEnv } | null | undefined,
      ExecCallback | undefined,
    ];
    const cb = (typeof options === 'function' ? options : callback) as ExecCallback;
    const actualArgs = Array.isArray(args) ? args.map(String) : [];
    const actualOptions = typeof options === 'function' ? undefined : options ?? undefined;
    if (file !== 'git') {
      cb(new Error(`Unexpected command: ${file}`));
      return;
    }
    const result = handler(actualArgs, actualOptions);
    if (result instanceof Error) {
      cb(result);
      return;
    }
    cb(null, result.stdout ?? '', result.stderr ?? '');
  }) as any;
  mockedExecFile.mockImplementation(implementation);
}

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const cwd = await mkdtemp(join(tmpdir(), 'agentdiagram-repo-source-'));
  process.chdir(cwd);
  try {
    await fn();
  } finally {
    process.chdir(previous);
    await rm(cwd, { recursive: true, force: true });
  }
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

afterEach(() => {
  mockedExecFile.mockReset();
});

describe('repoSource', () => {
  it('normalizes GitHub URLs to the canonical clone URL', () => {
    expect(normalizeGitHubRepoUrl('https://github.com/openai/gym/')).toBe('https://github.com/openai/gym.git');
    expect(() => normalizeGitHubRepoUrl('https://gitlab.com/openai/gym')).toThrow(RepoSourceError);
  });

  it('clones public GitHub repos once and reuses the cached checkout on subsequent resolves', async () => {
    await withTempCwd(async () => {
      const clonedPaths = new Set<string>();
      setGitMock((args, options) => {
        const cwdIndex = args.indexOf('-C');
        const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
        const command = (cwdIndex >= 0 ? args[cwdIndex + 2] : args[0]) ?? '';
        if (command === 'rev-parse') {
          return cwd && clonedPaths.has(cwd) ? { stdout: 'true\n' } : new Error('fatal: not a git repository');
        }
        if (command === 'clone') {
          const target = args[args.length - 1];
          if (target) clonedPaths.add(target);
          expect(options?.env?.GITHUB_PAT).toBeUndefined();
          return { stdout: '' };
        }
        if (command === 'pull') {
          return { stdout: '' };
        }
        return { stdout: '' };
      });

      const first = await resolveRepoSource({
        source: {
          sourceType: 'github',
          repoUrl: 'https://github.com/openai/example',
          repoPath: '',
          authMode: 'none',
        },
      });

      expect(first.sourceType).toBe('github');
      expect(first.rootPath).toContain(join('.cache', 'github-repos'));
      expect(first.clonedFrom).toBe('https://github.com/openai/example.git');
      expect(
        mockedExecFile.mock.calls.filter(
          ([file, args]) => file === 'git' && Array.isArray(args) && args.includes('clone'),
        ),
      ).toHaveLength(1);

      const second = await resolveRepoSource({
        source: {
          sourceType: 'github',
          repoUrl: 'https://github.com/openai/example',
          repoPath: first.rootPath,
          authMode: 'none',
        },
      });

      expect(second.rootPath).toBe(first.rootPath);
      expect(
        mockedExecFile.mock.calls.filter(
          ([file, args]) => file === 'git' && Array.isArray(args) && args.includes('clone'),
        ),
      ).toHaveLength(1);
    });
  });

  it('returns PAT_REQUIRED for private repos when no token is supplied', async () => {
    await withTempCwd(async () => {
      setGitMock((args) => {
        const cwdIndex = args.indexOf('-C');
        const command = (cwdIndex >= 0 ? args[cwdIndex + 2] : args[0]) ?? '';
        if (command === 'rev-parse') {
          return new Error('fatal: not a git repository');
        }
        if (command === 'clone') {
          return new Error('fatal: Authentication failed for https://github.com/openai/private.git');
        }
        return { stdout: '' };
      });

      await expect(
        resolveRepoSource({
          source: {
            sourceType: 'github',
            repoUrl: 'https://github.com/openai/private',
            repoPath: '',
            authMode: 'none',
          },
        }),
      ).rejects.toMatchObject({ code: 'PAT_REQUIRED' });
    });
  });

  it('passes PATs through environment variables when cloning private repos', async () => {
    await withTempCwd(async () => {
      let sawPat = false;
      setGitMock((args, options) => {
        const cwdIndex = args.indexOf('-C');
        const command = (cwdIndex >= 0 ? args[cwdIndex + 2] : args[0]) ?? '';
        if (command === 'rev-parse') {
          return new Error('fatal: not a git repository');
        }
        if (command === 'clone') {
          sawPat = Boolean(options?.env?.GITHUB_PAT);
          expect(options?.env?.GIT_ASKPASS).toBeTruthy();
          return { stdout: '' };
        }
        return { stdout: '' };
      });

      const resolved = await resolveRepoSource({
        source: {
          sourceType: 'github',
          repoUrl: 'https://github.com/openai/private',
          repoPath: '',
          authMode: 'pat',
          pat: 'ghp_example_pat',
        },
      });

      expect(resolved.sourceType).toBe('github');
      expect(sawPat).toBe(true);
    });
  });
});
