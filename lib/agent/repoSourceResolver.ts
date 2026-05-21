import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultRepoPath, guardPath } from '@/lib/security/pathGuard';

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export type RepoSourceInput =
  | { sourceType?: 'local'; rootPath?: string; allowSensitive?: boolean }
  | { sourceType: 'github'; githubUrl: string; githubPat?: string };

export type RepoSourceErrorCode = 'invalid_url' | 'private_repo_auth_required' | 'bad_pat' | 'clone_failed' | 'path_denied';
export type RepoSourceResolution =
  | { ok: true; sourceType: 'local' | 'github'; resolvedRootPath: string }
  | { ok: false; code: RepoSourceErrorCode; message: string; details?: string };

function parseGithubUrl(input: string): { owner: string; repo: string; httpsUrl: string } | null {
  const raw = input.trim();
  const httpsMatch = raw.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]!, httpsUrl: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}.git` };
  const sshMatch = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]!, httpsUrl: `https://github.com/${sshMatch[1]}/${sshMatch[2]}.git` };
  return null;
}

function authHeaderFromPat(pat: string): string {
  const token = Buffer.from(`x-access-token:${pat.trim()}`).toString('base64');
  return `AUTHORIZATION: basic ${token}`;
}

async function runGit(args: string[]): Promise<{ ok: true } | { ok: false; output: string }> {
  try {
    await execFileAsync('git', args, { timeout: 120_000, env: GIT_ENV });
    return { ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [e.stderr, e.stdout, e.message].filter(Boolean).join('\n') };
  }
}

function classifyAuthError(output: string): 'bad_pat' | 'private_repo_auth_required' | 'clone_failed' {
  const text = output.toLowerCase();
  if (text.includes('authentication failed') || text.includes('invalid username or password')) return 'bad_pat';
  if (text.includes('could not read username') || text.includes('repository not found') || text.includes('403') || text.includes('401')) return 'private_repo_auth_required';
  return 'clone_failed';
}

async function cloneGithubRepo(parsed: { owner: string; repo: string; httpsUrl: string }, pat?: string): Promise<RepoSourceResolution> {
  const baseDir = path.join(os.tmpdir(), 'agentdiagram-repos');
  await fs.mkdir(baseDir, { recursive: true });
  const targetDir = path.join(baseDir, `${parsed.owner}-${parsed.repo}-${Date.now()}-${randomBytes(4).toString('hex')}`);

  const publicProbe = await runGit(['ls-remote', '--heads', parsed.httpsUrl]);
  if (!publicProbe.ok) {
    if (!pat?.trim()) {
      return { ok: false, code: 'private_repo_auth_required', message: 'GitHub Personal Access Token is required for this repository.', details: publicProbe.output };
    }

    const authProbe = await runGit([
      '-c',
      `http.https://github.com/.extraheader=${authHeaderFromPat(pat)}`,
      'ls-remote',
      '--heads',
      parsed.httpsUrl,
    ]);
    if (!authProbe.ok) {
      const code = classifyAuthError(authProbe.output);
      return { ok: false, code, message: code === 'bad_pat' ? 'Provided GitHub PAT is invalid.' : 'Failed to authenticate to GitHub repository.', details: authProbe.output };
    }

    const authedClone = await runGit([
      '-c',
      `http.https://github.com/.extraheader=${authHeaderFromPat(pat)}`,
      'clone',
      '--depth',
      '1',
      parsed.httpsUrl,
      targetDir,
    ]);
    if (!authedClone.ok) {
      return { ok: false, code: classifyAuthError(authedClone.output), message: 'Failed to clone GitHub repository.', details: authedClone.output };
    }

    return { ok: true, sourceType: 'github', resolvedRootPath: targetDir };
  }

  const clone = await runGit(['clone', '--depth', '1', parsed.httpsUrl, targetDir]);
  if (!clone.ok) return { ok: false, code: classifyAuthError(clone.output), message: 'Failed to clone GitHub repository.', details: clone.output };
  return { ok: true, sourceType: 'github', resolvedRootPath: targetDir };
}

export async function resolveRepoSource(input: RepoSourceInput): Promise<RepoSourceResolution> {
  if (input.sourceType === 'github') {
    const parsed = parseGithubUrl(input.githubUrl || '');
    if (!parsed) return { ok: false, code: 'invalid_url', message: 'Invalid GitHub URL. Expected github.com/<owner>/<repo>.' };
    return cloneGithubRepo(parsed, input.githubPat);
  }

  const guard = guardPath(input.rootPath ?? defaultRepoPath(), { allowSensitive: input.allowSensitive });
  if (!guard.ok) return { ok: false, code: 'path_denied', message: guard.reason ?? 'Path denied', details: guard.resolved };
  return { ok: true, sourceType: 'local', resolvedRootPath: guard.resolved };
}
