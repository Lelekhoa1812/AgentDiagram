import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultRepoPath, guardPath } from '@/lib/security/pathGuard';

const execFileAsync = promisify(execFile);

export type RepoSourceInput =
  | { sourceType?: 'local'; rootPath?: string; allowSensitive?: boolean }
  | { sourceType: 'github'; githubUrl: string; githubPat?: string };

export type RepoSourceErrorCode = 'invalid_url' | 'private_repo_auth_required' | 'bad_pat' | 'clone_failed' | 'path_denied';
export type RepoSourceResolution =
  | { ok: true; sourceType: 'local' | 'github'; resolvedRootPath: string }
  | { ok: false; code: RepoSourceErrorCode; message: string; details?: string };

function parseGithubUrl(input: string): { owner: string; repo: string; httpsUrl: string } | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  const httpsMatch = raw.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]!, httpsUrl: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}.git` };
  const sshMatch = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]!, httpsUrl: `https://github.com/${sshMatch[1]}/${sshMatch[2]}.git` };
  return null;
}

async function gitLsRemote(url: string): Promise<{ ok: true } | { ok: false; output: string }> {
  try {
    await execFileAsync('git', ['ls-remote', '--heads', url], { timeout: 30_000 });
    return { ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [e.stderr, e.stdout, e.message].filter(Boolean).join('\n') };
  }
}

const withPat = (url: string, pat: string) => url.replace('https://', `https://${encodeURIComponent(pat.trim())}@`);

function classifyAuthError(output: string): 'bad_pat' | 'private_repo_auth_required' | 'clone_failed' {
  const text = output.toLowerCase();
  if (text.includes('authentication failed') || text.includes('invalid username or password')) return 'bad_pat';
  if (text.includes('could not read username') || text.includes('repository not found') || text.includes('403')) return 'private_repo_auth_required';
  return 'clone_failed';
}

async function cloneGithubRepo(parsed: { owner: string; repo: string; httpsUrl: string }, pat?: string): Promise<RepoSourceResolution> {
  const baseDir = path.join(os.tmpdir(), 'agentdiagram-repos');
  await fs.mkdir(baseDir, { recursive: true });
  const targetDir = path.join(baseDir, `${parsed.owner}-${parsed.repo}-${Date.now()}-${randomBytes(4).toString('hex')}`);

  const publicProbe = await gitLsRemote(parsed.httpsUrl);
  let cloneUrl = parsed.httpsUrl;
  if (!publicProbe.ok) {
    if (!pat?.trim()) return { ok: false, code: 'private_repo_auth_required', message: 'GitHub Personal Access Token is required for this repository.', details: publicProbe.output };
    cloneUrl = withPat(parsed.httpsUrl, pat);
    const authProbe = await gitLsRemote(cloneUrl);
    if (!authProbe.ok) {
      const code = classifyAuthError(authProbe.output);
      return { ok: false, code, message: code === 'bad_pat' ? 'Provided GitHub PAT is invalid.' : 'Failed to authenticate to GitHub repository.', details: authProbe.output };
    }
  }

  try {
    await execFileAsync('git', ['clone', '--depth', '1', cloneUrl, targetDir], { timeout: 120_000 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n');
    return { ok: false, code: classifyAuthError(output), message: 'Failed to clone GitHub repository.', details: output };
  }
  return { ok: true, sourceType: 'github', resolvedRootPath: targetDir };
}

export async function resolveRepoSource(input: RepoSourceInput): Promise<RepoSourceResolution> {
  if (input.sourceType === 'github') {
    const parsed = parseGithubUrl(input.githubUrl);
    if (!parsed) return { ok: false, code: 'invalid_url', message: 'Invalid GitHub URL. Expected github.com/<owner>/<repo>.' };
    return cloneGithubRepo(parsed, input.githubPat);
  }

  const guard = guardPath(input.rootPath ?? defaultRepoPath(), { allowSensitive: input.allowSensitive });
  if (!guard.ok) return { ok: false, code: 'path_denied', message: guard.reason ?? 'Path denied', details: guard.resolved };
  return { ok: true, sourceType: 'local', resolvedRootPath: guard.resolved };
}
