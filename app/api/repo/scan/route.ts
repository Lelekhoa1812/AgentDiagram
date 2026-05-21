import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '@/lib/agent/repoScanner';
import { defaultRepoPath } from '@/lib/security/pathGuard';
import { RepoSourceError, resolveRepoSource } from '@/lib/agent/repoSource';
import { optionalUrl } from '@/lib/agent/requestValidation';

export const runtime = 'nodejs';

const RepoSourceBody = z.object({
  sourceType: z.enum(['local', 'github']).optional(),
  repoPath: z.string().optional(),
  repoUrl: optionalUrl,
  authMode: z.enum(['none', 'pat']).optional(),
  pat: z.string().optional(),
});

const Body = z.object({
  path: z.string().min(1).optional(),
  rootPath: z.string().min(1).optional(),
  repoUrl: optionalUrl,
  pat: z.string().min(1).optional(),
  source: RepoSourceBody.partial().optional(),
  allowSensitive: z.boolean().optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  }

  try {
    const resolved = await resolveRepoSource({
      path: parsed.data.path ?? parsed.data.rootPath ?? defaultRepoPath(),
      repoUrl: parsed.data.repoUrl,
      pat: parsed.data.pat,
      allowSensitive: parsed.data.allowSensitive,
      source: parsed.data.source
        ? {
            sourceType: parsed.data.source.sourceType,
            repoPath: parsed.data.source.repoPath,
            repoUrl: parsed.data.source.repoUrl,
            authMode: parsed.data.source.authMode,
            pat: parsed.data.source.pat,
          }
        : undefined,
    });

    const map = await scanRepo(resolved.rootPath, {
      allowlist: AGENT_FILE_ALLOWLIST,
      ignoredFolders: parsed.data.ignoredFolders,
    });

    return NextResponse.json({
      sourceType: resolved.sourceType,
      clonedFrom: resolved.clonedFrom,
      resolved: resolved.rootPath,
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
    if (err instanceof RepoSourceError && err.code === 'PAT_REQUIRED') {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 401 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export function GET() {
  return NextResponse.json({ defaultPath: defaultRepoPath() });
}
