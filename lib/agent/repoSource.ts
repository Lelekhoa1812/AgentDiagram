import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultRepoPath, guardPath } from '@/lib/security/pathGuard';
import type { RepoSourceConfig, RepoSourceType } from './repoTypes';

const execFileAsync = promisify(execFile);

export interface ResolveRepoSourceInput {
  path?: string;
  rootPath?: string;
  repoUrl?: string;
  pat?: string;
  allowSensitive?: boolean;
  source?: Partial<RepoSourceConfig> | null;
}

export interface ResolvedRepoSource {
  sourceType: RepoSourceType;
  rootPath: string;
  clonedFrom: string | null;
}

export type { RepoAuthMode, RepoSourceConfig, RepoSourceType } from './repoTypes';

export class RepoSourceError extends Error {
  constructor(
    message: string,
    public code: 'INVALID_GITHUB_URL' | 'PAT_REQUIRED' | 'GIT_CLONE_FAILED' | 'INVALID_LOCAL_PATH',
  ) {
    super(message);
    this.name = 'RepoSourceError';
  }
}

function getRepoCacheRoot(): string {
  return join(process.cwd(), '.cache', 'github-repos');
}

function getRepoIgnorePath(): string {
  return join(process.cwd(), '.gitignore');
}

function isCachedCheckoutPath(candidate: string): boolean {
  const cacheRoot = resolvePath(getRepoCacheRoot());
  const resolved = resolvePath(candidate);
  return resolved === cacheRoot || resolved.startsWith(`${cacheRoot}${sep}`);
}

function getCheckoutPath(normalizedUrl: string): string {
  const hash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 16);
  return join(getRepoCacheRoot(), hash);
}

function getCheckoutMetadataPath(checkoutPath: string): string {
  return join(checkoutPath, '.agentdiagram-source.json');
}

function extractGitErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & { stdout?: unknown; stderr?: unknown };
    const parts = [err.message];
    if (typeof extra.stderr === 'string' && extra.stderr.trim()) parts.push(extra.stderr);
    if (typeof extra.stdout === 'string' && extra.stdout.trim()) parts.push(extra.stdout);
    return parts.filter(Boolean).join('\n');
  }
  return String(err);
}

function redactSecrets(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function isAuthFailure(msg: string): boolean {
  const haystack = msg.toLowerCase();
  return [
    'authentication failed',
    'auth failed',
    'could not read username',
    'could not read password',
    'permission denied',
    'repository not found',
    'http basic: access denied',
    'fatal: authentication failed',
    'fatal: could not read from remote repository',
  ].some((signature) => haystack.includes(signature));
}

function isGitHubHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'github.com' || lower === 'www.github.com';
}

function normalizeGitHubPath(repoUrl: string): string {
  const parsed = new URL(repoUrl);
  if (parsed.protocol !== 'https:') {
    throw new RepoSourceError('GitHub repository URLs must use https://', 'INVALID_GITHUB_URL');
  }
  if (!isGitHubHostname(parsed.hostname)) {
    throw new RepoSourceError('Only github.com repositories are supported', 'INVALID_GITHUB_URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RepoSourceError('GitHub repository URL must not contain credentials, query parameters, or fragments', 'INVALID_GITHUB_URL');
  }

  const cleanedPath = parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '');
  const segments = cleanedPath.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new RepoSourceError(
      'GitHub repository URL must be in the form https://github.com/<owner>/<repo>',
      'INVALID_GITHUB_URL',
    );
  }

  const [owner, repo] = segments;
  return `https://github.com/${owner}/${repo}.git`;
}

export function normalizeGitHubRepoUrl(repoUrl: string): string {
  return normalizeGitHubPath(repoUrl);
}

async function ensureAskPassScript(): Promise<string> {
  const root = getRepoCacheRoot();
  await mkdir(root, { recursive: true });
  const scriptPath = join(root, 'askpass.sh');
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s' 'x-access-token' ;;
  *) printf '%s' "$GITHUB_PAT" ;;
esac
`;
  let shouldWrite = true;
  try {
    const current = await readFile(scriptPath, 'utf8');
    shouldWrite = current !== script;
  } catch {
    shouldWrite = true;
  }
  if (shouldWrite) {
    await writeFile(scriptPath, script, 'utf8');
    await chmod(scriptPath, 0o700);
  }
  return scriptPath;
}

async function ensureGithubCacheIgnored(): Promise<void> {
  const ignoreLine = '.cache/github-repos/';
  try {
    const current = await readFile(getRepoIgnorePath(), 'utf8');
    const lines = current.split(/\r?\n/);
    if (lines.some((line) => line.trim() === ignoreLine)) return;
    const next = current.endsWith('\n') || current.length === 0 ? `${current}${ignoreLine}\n` : `${current}\n${ignoreLine}\n`;
    await writeFile(getRepoIgnorePath(), next, 'utf8');
  } catch {
    await writeFile(getRepoIgnorePath(), `${ignoreLine}\n`, 'utf8');
  }
}

async function writeCheckoutMetadata(checkoutPath: string, normalizedUrl: string): Promise<void> {
  await writeFile(getCheckoutMetadataPath(checkoutPath), JSON.stringify({ clonedFrom: normalizedUrl }), 'utf8');
}

async function readCheckoutMetadata(checkoutPath: string): Promise<string | null> {
  try {
    const raw = await readFile(getCheckoutMetadataPath(checkoutPath), 'utf8');
    const parsed = JSON.parse(raw) as { clonedFrom?: unknown };
    return typeof parsed.clonedFrom === 'string' ? parsed.clonedFrom : null;
  } catch {
    return null;
  }
}

async function readOriginUrl(checkoutPath: string): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', checkoutPath, 'remote', 'get-url', 'origin'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 1024 * 1024 * 16,
    });
    const url = result.stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

async function runGit(args: string[], pat?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (pat) {
    env.GIT_ASKPASS = await ensureAskPassScript();
    env.SSH_ASKPASS = env.GIT_ASKPASS;
    env.GITHUB_PAT = pat;
  }
  await execFileAsync('git', args, { env, maxBuffer: 1024 * 1024 * 16 });
}

async function isGitRepository(checkoutPath: string): Promise<boolean> {
  try {
    await runGit(['-C', checkoutPath, 'rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

async function cloneOrUpdateGitHubRepo(repoUrl: string, pat?: string): Promise<{ rootPath: string; clonedFrom: string }> {
  const normalizedUrl = normalizeGitHubPath(repoUrl);
  const checkoutPath = getCheckoutPath(normalizedUrl);
  const cacheRoot = getRepoCacheRoot();
  await mkdir(dirname(checkoutPath), { recursive: true });
  await ensureGithubCacheIgnored();

  if (await isGitRepository(checkoutPath)) {
    try {
      await runGit(['-C', checkoutPath, 'pull', '--ff-only'], pat);
      await mkdir(checkoutPath, { recursive: true });
      await writeCheckoutMetadata(checkoutPath, normalizedUrl);
      return { rootPath: checkoutPath, clonedFrom: normalizedUrl };
    } catch (err) {
      const message = redactSecrets(extractGitErrorMessage(err), [pat ?? '']);
      if (!pat && isAuthFailure(message)) {
        throw new RepoSourceError('Private repository access requires a personal access token.', 'PAT_REQUIRED');
      }
      await rm(checkoutPath, { recursive: true, force: true });
    }
  } else {
    await rm(checkoutPath, { recursive: true, force: true });
  }

  try {
    await runGit(['clone', '--depth', '1', normalizedUrl, checkoutPath], pat);
    await mkdir(checkoutPath, { recursive: true });
    await writeCheckoutMetadata(checkoutPath, normalizedUrl);
    return { rootPath: checkoutPath, clonedFrom: normalizedUrl };
  } catch (err) {
    const message = redactSecrets(extractGitErrorMessage(err), [pat ?? '']);
    if (!pat && isAuthFailure(message)) {
      throw new RepoSourceError('Private repository access requires a personal access token.', 'PAT_REQUIRED');
    }
    throw new RepoSourceError(message || `Unable to clone repository into ${cacheRoot}`, 'GIT_CLONE_FAILED');
  }
}

function resolveLocalPath(input: ResolveRepoSourceInput): ResolvedRepoSource {
  const localPath = input.source?.repoPath ?? input.rootPath ?? input.path ?? defaultRepoPath();
  const guard = guardPath(localPath, { allowSensitive: input.allowSensitive });
  if (!guard.ok) {
    throw new RepoSourceError(guard.reason ?? 'Invalid repository path', 'INVALID_LOCAL_PATH');
  }
  return { sourceType: 'local', rootPath: guard.resolved, clonedFrom: null };
}

export async function resolveRepoSource(input: ResolveRepoSourceInput = {}): Promise<ResolvedRepoSource> {
  const sourceType = input.source?.sourceType ?? (input.repoUrl ? 'github' : 'local');
  if (sourceType === 'github') {
    const candidatePath = input.source?.repoPath ?? input.rootPath ?? input.path;
    const repoUrl = input.source?.repoUrl ?? input.repoUrl ?? '';
    if (!repoUrl.trim()) {
      throw new RepoSourceError('GitHub repository URL is required', 'INVALID_GITHUB_URL');
    }
    const normalizedUrl = normalizeGitHubPath(repoUrl);
    if (candidatePath && isCachedCheckoutPath(candidatePath) && (await isGitRepository(candidatePath))) {
      const clonedFrom = (await readCheckoutMetadata(candidatePath)) ?? (await readOriginUrl(candidatePath));
      let matches = false;
      if (!clonedFrom) {
        matches = true;
      } else {
        try {
          matches = normalizeGitHubPath(clonedFrom) === normalizedUrl;
        } catch {
          matches = false;
        }
      }
      if (matches) {
        return {
          sourceType: 'github',
          rootPath: resolvePath(candidatePath),
          clonedFrom: normalizedUrl,
        };
      }
    }
    const pat = input.source?.pat ?? input.pat ?? undefined;
    const checkout = await cloneOrUpdateGitHubRepo(normalizedUrl, pat?.trim() || undefined);
    return { sourceType: 'github', rootPath: checkout.rootPath, clonedFrom: checkout.clonedFrom };
  }

  return resolveLocalPath(input);
}
