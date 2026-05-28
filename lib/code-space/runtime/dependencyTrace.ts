import path from 'node:path';
import { normalizeContextPath, safeReadTextFile } from './repoMap';
import { extractLocalImportSpecifiers } from './symbolScanner';

export interface DependencyEdge {
  from: string;
  to: string;
  reason: 'direct_import' | 'reverse_importer';
}

export function resolveLocalImport(
  fromFile: string,
  specifier: string,
  candidateSet: Set<string>,
): string | null {
  const baseDir = path.posix.dirname(normalizeContextPath(fromFile));
  const raw = normalizeContextPath(path.posix.normalize(path.posix.join(baseDir, specifier)));
  const possible = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.json`,
    `${raw}/index.ts`,
    `${raw}/index.tsx`,
    `${raw}/index.js`,
    `${raw}/index.jsx`,
  ];
  return possible.find((candidate) => candidateSet.has(candidate)) ?? null;
}

export async function traceDependencyEdges({
  root,
  candidates,
  selected,
}: {
  root: string;
  candidates: string[];
  selected: string[];
}): Promise<{ files: Set<string>; edges: DependencyEdge[] }> {
  const candidateSet = new Set(candidates.map(normalizeContextPath));
  const selectedSet = new Set(selected.map(normalizeContextPath));
  const expanded = new Set(selectedSet);
  const edges: DependencyEdge[] = [];
  const contentCache = new Map<string, string>();

  const read = async (file: string) => {
    const normalized = normalizeContextPath(file);
    if (contentCache.has(normalized)) return contentCache.get(normalized) ?? '';
    const content = (await safeReadTextFile(root, normalized)) ?? '';
    contentCache.set(normalized, content);
    return content;
  };

  for (const file of selectedSet) {
    const content = await read(file);
    for (const specifier of extractLocalImportSpecifiers(content)) {
      const resolved = resolveLocalImport(file, specifier, candidateSet);
      if (!resolved) continue;
      expanded.add(resolved);
      edges.push({ from: file, to: resolved, reason: 'direct_import' });
    }
  }

  const selectedAfterDeps = new Set(expanded);
  for (const candidate of candidateSet) {
    if (expanded.has(candidate)) continue;
    const content = await read(candidate);
    if (!content) continue;
    for (const specifier of extractLocalImportSpecifiers(content)) {
      const resolved = resolveLocalImport(candidate, specifier, candidateSet);
      if (!resolved || !selectedAfterDeps.has(resolved)) continue;
      expanded.add(candidate);
      edges.push({ from: candidate, to: resolved, reason: 'reverse_importer' });
      break;
    }
  }

  return { files: expanded, edges };
}
