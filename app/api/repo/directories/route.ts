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

// Motivation vs Logic: every browse response should mirror the agent's own ignore conventions so users never see and try to ignore folders we already silently skip (caches, VCS metadata, build outputs). Centralising the list here also keeps the picker visually quiet on cluttered monorepos.
const HIDDEN_DIRS = new Set([
  '.agentdiagram-cache',
  '.cache',
  '.git',
  '.hg',
  '.idea',
  '.next',
  '.parcel-cache',
  '.svn',
  '.turbo',
  '.vercel',
  '.vscode',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'playwright-report',
  'vendor',
]);

const HIDDEN_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.tsbuildinfo',
]);

const SELF_ROOT = path.resolve(process.cwd());

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
    const dirents = await fs.readdir(absParent, { withFileTypes: true });

    const entries = dirents
      .filter((dirent) => {
        if (dirent.isDirectory()) {
          if (HIDDEN_DIRS.has(dirent.name)) return false;
        } else if (dirent.isFile()) {
          if (HIDDEN_FILES.has(dirent.name)) return false;
        } else {
          return false;
        }
        // Skip the AgentDiagram app folder itself so users never accidentally
        // pipe our own source back into the agent when scanning a parent dir.
        const abs = path.resolve(absParent, dirent.name);
        if (abs === SELF_ROOT) return false;
        return true;
      })
      .map((dirent) => {
        const abs = path.resolve(absParent, dirent.name);
        const rel = path.relative(guard.resolved, abs).replace(/\\/g, '/');
        return {
          name: dirent.name,
          path: rel,
          type: dirent.isDirectory() ? ('dir' as const) : ('file' as const),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({
      root: guard.resolved,
      parent: normalizeIgnoredFolders([relParent])[0] ?? '',
      entries,
      // Kept for older clients that still read `directories`; new UI uses `entries`.
      directories: entries.filter((entry) => entry.type === 'dir').map(({ name, path: p }) => ({ name, path: p })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
