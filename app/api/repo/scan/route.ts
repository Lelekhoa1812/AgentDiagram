import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '@/lib/agent/repoScanner';
import { guardPath, defaultRepoPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const Body = z.object({
  path: z.string().optional(),
  allowSensitive: z.boolean().optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const inputPath = parsed.data.path ?? defaultRepoPath();
  const guard = guardPath(inputPath, { allowSensitive: parsed.data.allowSensitive });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason, resolved: guard.resolved }, { status: 400 });
  }

  try {
    const map = await scanRepo(guard.resolved, {
      allowlist: AGENT_FILE_ALLOWLIST,
      ignoredFolders: parsed.data.ignoredFolders,
    });
    return NextResponse.json({
      resolved: guard.resolved,
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
