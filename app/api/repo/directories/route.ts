import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { defaultRepoPath, guardPath } from '@/lib/security/pathGuard';
import { normalizeIgnoredFolders } from '@/lib/agent/repoScanner';

export const runtime = 'nodejs';

const Body = z.object({
  rootPath: z.string().optional(),
  parent: z.string().optional(),
});

const HIDDEN_BY_DEFAULT = new Set([
  '.agentdiagram-cache',
  '.cache',
  '.git',
  '.next',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  'coverage',
  'node_modules',
  'playwright-report',
]);

function childPath(root: string, rel: string): string | null {
  const [normalized] = normalizeIgnoredFolders([rel]);
  if (rel && !normalized) return null;
  const resolved = path.resolve(root, normalized ?? '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const guard = guardPath(parsed.data.rootPath ?? defaultRepoPath());
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason, resolved: guard.resolved }, { status: 400 });
  }

  const relParent = parsed.data.parent ?? '';
  const absParent = childPath(guard.resolved, relParent);
  if (!absParent) {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 });
  }

  try {
    const entries = await fs.readdir(absParent, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !HIDDEN_BY_DEFAULT.has(entry.name))
      .map((entry) => {
        const rel = path.relative(guard.resolved, path.join(absParent, entry.name)).replace(/\\/g, '/');
        return { name: entry.name, path: rel };
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    return NextResponse.json({
      root: guard.resolved,
      parent: normalizeIgnoredFolders([relParent])[0] ?? '',
      directories,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
