// Motivation vs Logic: The mention index turns a flat list of file paths (from the server scan
// or the client tree) into a queryable model with folders derived from path prefixes. We
// precompute every per-entry field the query/scorer needs — normalized name/path, segments,
// depth, ignore signals — so the per-keystroke query is just a cheap iteration over `entries`
// plus map lookups. Paths are always project-root-relative with forward slashes and no leading
// slash; absolute paths and `..` traversal are rejected at build time.

import { classifyMentionPath } from './ignorePolicy';
import type { MentionEntry, MentionEntryType, MentionIndexEntryInput } from './types';

export interface FileMentionIndex {
  entries: MentionEntry[];
  byPath: Map<string, MentionEntry>;
  hasDirectory(relativePath: string): boolean;
  hasEntry(relativePath: string): boolean;
  /** Direct children (depth = scopeDepth + 1) of `relativePath`. Pass '' for project root. */
  childrenOf(relativePath: string): MentionEntry[];
  /** All entries strictly inside `relativePath` (any depth below). */
  descendantsOf(relativePath: string): MentionEntry[];
  /** Project-root children (depth === 1). */
  rootEntries(): MentionEntry[];
}

/** Normalize a raw path to the picker's canonical form. Returns null if traversal is detected. */
export function normalizeMentionPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return '';

  const slashed = trimmed.replace(/\\/g, '/');
  const collapsed = slashed.replace(/\/+/g, '/');
  const noLeadingDot = collapsed.replace(/^\.\//, '');
  const noLeadingSlash = noLeadingDot.replace(/^\/+/, '');
  const noTrailingSlash = noLeadingSlash.replace(/\/+$/, '');
  const segments = noTrailingSlash.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

function makeEntry(
  type: MentionEntryType,
  relativePath: string,
  size?: number,
  mtime?: number,
): MentionEntry {
  const segments = relativePath ? relativePath.split('/') : [];
  const basename = segments[segments.length - 1] ?? '';
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : '';
  const lowerBase = basename.toLowerCase();
  const dotIndex = lowerBase.lastIndexOf('.');
  const extension = type === 'file' && dotIndex > 0 ? lowerBase.slice(dotIndex) : undefined;
  const signals = classifyMentionPath(relativePath, type);

  return {
    id: `${type}:${relativePath}`,
    type,
    name: basename,
    basename,
    extension,
    relativePath,
    parentPath,
    segments,
    depth: segments.length,
    normalizedName: lowerBase,
    normalizedPath: relativePath.toLowerCase(),
    size,
    mtime,
    isHidden: signals.isHidden,
    isIgnored: signals.isIgnored,
    isBinary: signals.isBinary,
    isLockFile: signals.isLockFile,
    isImportantConfig: signals.isImportantConfig,
  };
}

/**
 * Build a FileMentionIndex from a list of project-relative paths. Files are deduped, folders are
 * derived from each file's parent chain, and ignored entries are dropped entirely so the query
 * service never has to filter them out per keystroke.
 */
export function buildMentionIndex(inputs: ReadonlyArray<MentionIndexEntryInput | string>): FileMentionIndex {
  const seen = new Map<string, MentionEntry>();
  const folderHints = new Set<string>();

  for (const raw of inputs) {
    const input: MentionIndexEntryInput = typeof raw === 'string' ? { path: raw } : raw;
    const normalized = normalizeMentionPath(input.path);
    if (normalized === null || normalized === '') continue;

    const type: MentionEntryType = input.type ?? 'file';

    if (type === 'folder') {
      folderHints.add(normalized);
      continue;
    }

    const entry = makeEntry('file', normalized, input.size, input.mtime);
    if (entry.isIgnored) continue;
    seen.set(`file:${normalized}`, entry);

    const parts = normalized.split('/');
    for (let i = 1; i < parts.length; i++) {
      folderHints.add(parts.slice(0, i).join('/'));
    }
  }

  for (const folderPath of folderHints) {
    const folderEntry = makeEntry('folder', folderPath);
    if (folderEntry.isIgnored) continue;
    if (!seen.has(`folder:${folderPath}`)) seen.set(`folder:${folderPath}`, folderEntry);
  }

  const entries = [...seen.values()];

  const byPath = new Map<string, MentionEntry>();
  const directorySet = new Set<string>();
  for (const entry of entries) {
    byPath.set(entry.relativePath, entry);
    if (entry.type === 'folder') directorySet.add(entry.relativePath);
  }

  const childrenByParent = new Map<string, MentionEntry[]>();
  for (const entry of entries) {
    const bucket = childrenByParent.get(entry.parentPath);
    if (bucket) bucket.push(entry);
    else childrenByParent.set(entry.parentPath, [entry]);
  }

  return {
    entries,
    byPath,
    hasDirectory(relativePath: string): boolean {
      const normalized = normalizeMentionPath(relativePath);
      if (normalized === null) return false;
      if (normalized === '') return true;
      return directorySet.has(normalized);
    },
    hasEntry(relativePath: string): boolean {
      const normalized = normalizeMentionPath(relativePath);
      if (normalized === null) return false;
      if (normalized === '') return true;
      return byPath.has(normalized);
    },
    childrenOf(relativePath: string): MentionEntry[] {
      const normalized = normalizeMentionPath(relativePath);
      if (normalized === null) return [];
      return childrenByParent.get(normalized) ?? [];
    },
    descendantsOf(relativePath: string): MentionEntry[] {
      const normalized = normalizeMentionPath(relativePath);
      if (normalized === null) return [];
      if (normalized === '') return entries;
      const prefix = `${normalized}/`;
      return entries.filter((entry) => entry.relativePath.startsWith(prefix));
    },
    rootEntries(): MentionEntry[] {
      return childrenByParent.get('') ?? [];
    },
  };
}

/** Convenience: build an index when the caller only has plain string paths. */
export function buildMentionIndexFromPaths(paths: ReadonlyArray<string>): FileMentionIndex {
  return buildMentionIndex(paths);
}
