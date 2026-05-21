import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '@/lib/agent/repoScanner';
import { guardPath, defaultRepoPath } from '@/lib/security/pathGuard';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);

const LocalBody = z.object({
  path: z.string().min(1),
  allowSensitive: z.boolean().optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
});

const GitHubBody = z.object({
  repoUrl: z.string().url(),
  pat: z.string().min(1).optional(),
  allowSensitive: z.boolean().optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
});

const Body = z.union([LocalBody, GitHubBody]).superRefine((input, ctx) => {
  const hasPath = 'path' in input;
  const hasRepoUrl = 'repoUrl' in input;
  if (hasPath === hasRepoUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide exactly one of "path" or "repoUrl"',
      path: ['path'],
    });
  }
});

type SourceMeta =
  | { sourceType: 'local'; clonedFrom: null }
  | { sourceType: 'github'; clonedFrom: string };

function normalizeGitHubRepoUrl(repoUrl: string): string {
  const parsed = new URL(repoUrl);
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only github.com repositories are supported');
  }

  const cleanedPath = parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '');
  const segments = cleanedPath.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new Error('GitHub repository URL must be in the form https://github.com/<owner>/<repo>');
  }

  const [owner, repo] = segments;
  return `https://github.com/${owner}/${repo}.git`;
}

function getRepoCacheRoot() {
  return join(process.cwd(), '.cache', 'github-repos');
}

function getRepoCheckoutPath(normalizedUrl: string): string {
  const hash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 16);
  return join(getRepoCacheRoot(), hash);
}

function isAuthFailure(msg: string): boolean {
  const haystack = msg.toLowerCase();
  return [
    'authentication failed',
    'could not read username',
    'permission denied',
    'repository not found',
    'http basic: access denied',
    'fatal: could not',
  ].some((signature) => haystack.includes(signature));
}

function redactSecrets(input: string, secrets: string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

async function runGit(args: string[], cwd?: string, pat?: string) {
  const env = { ...process.env };
  if (pat) {
    env.GIT_ASKPASS = 'echo';
    env.GITHUB_PAT = pat;
  }
  return execFileAsync('git', args, { cwd, env, maxBuffer: 1024 * 1024 * 16 });
}

async function resolveCheckoutFromGitHub(repoUrl: string, pat?: string): Promise<{ path: string; normalizedUrl: string }> {
  const normalizedUrl = normalizeGitHubRepoUrl(repoUrl);
  const checkoutPath = getRepoCheckoutPath(normalizedUrl);
  await mkdir(getRepoCacheRoot(), { recursive: true });

  const authUrl = pat ? normalizedUrl.replace('https://', `https://${encodeURIComponent(pat)}@`) : normalizedUrl;

  try {
    await mkdir(dirname(checkoutPath), { recursive: true });
    await runGit(['clone', '--depth', '1', normalizedUrl, checkoutPath]);
    return { path: checkoutPath, normalizedUrl };
  } catch (cloneErr) {
    try {
      await runGit(['-C', checkoutPath, 'rev-parse', '--is-inside-work-tree']);
      await runGit(['-C', checkoutPath, 'fetch', '--all', '--prune']);
      await runGit(['-C', checkoutPath, 'pull', '--ff-only']);
      return { path: checkoutPath, normalizedUrl };
    } catch {
      const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
      const redacted = redactSecrets(msg, [pat ?? '']);
      if (!pat && isAuthFailure(redacted)) {
        throw new Error(JSON.stringify({ code: 'PAT_REQUIRED', message: 'Private repository access requires a personal access token.' }));
      }
      if (pat) {
        try {
          await runGit(['clone', '--depth', '1', authUrl, checkoutPath], undefined, pat);
          return { path: checkoutPath, normalizedUrl };
        } catch (authErr) {
          const authMsg = authErr instanceof Error ? authErr.message : String(authErr);
          throw new Error(redactSecrets(authMsg, [pat]));
        }
      }
      throw new Error(redacted);
    }
  }
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  }

  let resolvedPath: string;
  let sourceMeta: SourceMeta;

  if ('repoUrl' in parsed.data) {
    try {
      const checkout = await resolveCheckoutFromGitHub(parsed.data.repoUrl, parsed.data.pat);
      resolvedPath = checkout.path;
      sourceMeta = { sourceType: 'github', clonedFrom: checkout.normalizedUrl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        const structured = JSON.parse(msg) as { code?: string; message?: string };
        if (structured.code === 'PAT_REQUIRED') {
          return NextResponse.json({ error: structured.message, code: 'PAT_REQUIRED' }, { status: 401 });
        }
      } catch {
        // ignore parsing failures
      }
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } else {
    const inputPath = parsed.data.path ?? defaultRepoPath();
    const guard = guardPath(inputPath, { allowSensitive: parsed.data.allowSensitive });
    if (!guard.ok) {
      return NextResponse.json({ error: guard.reason, resolved: guard.resolved }, { status: 400 });
    }
    resolvedPath = guard.resolved;
    sourceMeta = { sourceType: 'local', clonedFrom: null };
  }

  try {
    const map = await scanRepo(resolvedPath, {
      allowlist: AGENT_FILE_ALLOWLIST,
      ignoredFolders: parsed.data.ignoredFolders,
    });
    return NextResponse.json({
      sourceType: sourceMeta.sourceType,
      clonedFrom: sourceMeta.clonedFrom,
      resolved: resolvedPath,
      root: map.root,
      fileCount: map.fileCount,
      totalBytes: map.totalBytes,
      byExt: map.byExt,
      manifests: map.manifests.map((f) => f.path),
      entrypoints: map.entrypoints.map((f) => f.path),
      apiRoutes: map.apiRoutes.map((f) => f.path),
      components: map.components.map((f) => f.path).slice(0, 80),
      schemas: map.schemas.map((f) => f.path),
      configs: map.configs.map((f) => f.path),
      infra: map.infra.map((f) => f.path),
      tests: map.tests.length,
      docs: map.docs.map((f) => f.path).slice(0, 30),
      depHints: map.depHints,
      ignoredFolders: map.ignoredFolders,
      likelyStack: map.likelyStack,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ defaultPath: defaultRepoPath() });
}
