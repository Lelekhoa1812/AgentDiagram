import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '@/lib/agent/repoScanner';
import { defaultRepoPath } from '@/lib/security/pathGuard';
import { resolveRepoSource } from '@/lib/agent/repoSourceResolver';

export const runtime = 'nodejs';

const Body = z.object({
  sourceType: z.enum(['local', 'github']).optional(),
  path: z.string().optional(),
  rootPath: z.string().optional(),
  githubUrl: z.string().optional(),
  githubPat: z.string().optional(),
  allowSensitive: z.boolean().optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const source =
    parsed.data.sourceType === 'github'
      ? await resolveRepoSource({
          sourceType: 'github',
          githubUrl: parsed.data.githubUrl ?? '',
          githubPat: parsed.data.githubPat,
        })
      : await resolveRepoSource({
          sourceType: 'local',
          rootPath: parsed.data.rootPath ?? parsed.data.path,
          allowSensitive: parsed.data.allowSensitive,
        });

  if (!source.ok) {
    return NextResponse.json({ error: source.message, code: source.code, details: source.details }, { status: 400 });
  }

  try {
    const map = await scanRepo(source.resolvedRootPath, {
      allowlist: AGENT_FILE_ALLOWLIST,
      ignoredFolders: parsed.data.ignoredFolders,
    });
    return NextResponse.json({
      resolved: source.resolvedRootPath,
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
