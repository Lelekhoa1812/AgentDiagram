/**
 * Documentation reader — pulls the single README exception to use as a
 * planning prior. We intentionally avoid general doc surfaces so the agent
 * stays focused on source code, not prose-heavy repo scaffolding.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoMap } from '../repo/repoScanner';

export interface DocPrior {
  path: string;
  bytes: number;
  excerpt: string; // first ~6 KB
  kind: 'readme' | 'adr' | 'doc';
}

function classify(p: string): DocPrior['kind'] {
  const lower = p.toLowerCase();
  if (/(^|\/)readme\.md$/.test(lower)) return 'readme';
  return 'doc';
}

const PRIORITY: Array<RegExp> = [
  /^readme\.md$/i,
  /^docs?\/readme\.md$/i,
];

function priorityFor(p: string): number {
  for (let i = 0; i < PRIORITY.length; i++) {
    if (PRIORITY[i]!.test(p)) return i;
  }
  return PRIORITY.length + 1;
}

export async function readDocPriors(repo: RepoMap, maxBytes = 6000, maxDocs = 6): Promise<DocPrior[]> {
  const candidates = repo.docs
    .map((f) => f.path)
    .sort((a, b) => priorityFor(a) - priorityFor(b))
    .slice(0, maxDocs);
  const out: DocPrior[] = [];
  for (const rel of candidates) {
    try {
      const buf = await fs.readFile(path.join(repo.root, rel));
      out.push({
        path: rel,
        bytes: buf.length,
        excerpt: buf.subarray(0, maxBytes).toString('utf8'),
        kind: classify(rel),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}
