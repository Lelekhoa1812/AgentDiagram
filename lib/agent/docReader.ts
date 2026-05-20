/**
 * Documentation reader — pulls README, ADRs, and major doc files to use
 * as priors for the planner. Documentation often names the very
 * subsystems we want the diagram to surface, so feeding it in early
 * dramatically improves layer / group naming.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoMap } from './repoScanner';

export interface DocPrior {
  path: string;
  bytes: number;
  excerpt: string; // first ~6 KB
  kind: 'readme' | 'adr' | 'doc';
}

function classify(p: string): DocPrior['kind'] {
  const lower = p.toLowerCase();
  if (/(^|\/)readme\.(md|mdx|txt|rst)$/.test(lower)) return 'readme';
  if (/(^|\/)(adr|docs\/adr|architecture-decision)/.test(lower)) return 'adr';
  return 'doc';
}

const PRIORITY: Array<RegExp> = [
  /^readme\.(md|mdx|txt|rst)$/i,
  /^docs?\/readme\.(md|mdx)$/i,
  /^docs?\/architecture\.(md|mdx)$/i,
  /^docs?\/overview\.(md|mdx)$/i,
  /^architecture\.(md|mdx)$/i,
  /^contributing\.(md|mdx)$/i,
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
