export interface DiffHunk {
  id: string;
  index: number;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export type DiffHunkStatus = Record<string, 'accepted' | 'rejected'>;

function parseHunkHeader(header: string): Pick<DiffHunk, 'oldStart' | 'oldCount' | 'newStart' | 'newCount'> | null {
  const match = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1] ?? '1', 10),
    oldCount: Number.parseInt(match[2] ?? '1', 10),
    newStart: Number.parseInt(match[3] ?? '1', 10),
    newCount: Number.parseInt(match[4] ?? '1', 10),
  };
}

function syntheticHunk(oldContent: string, newContent: string): DiffHunk {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  return {
    id: 'hunk:0',
    index: 0,
    header: '@@ full file change @@',
    oldStart: 1,
    oldCount: oldLines.length,
    newStart: 1,
    newCount: newLines.length,
    lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
  };
}

export function splitUnifiedDiffIntoHunks(unifiedDiff: string | undefined, oldContent: string, newContent: string): DiffHunk[] {
  if (!unifiedDiff) return [syntheticHunk(oldContent, newContent)];

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      const parsed = parseHunkHeader(line);
      current = {
        id: `hunk:${hunks.length}`,
        index: hunks.length,
        header: line,
        oldStart: parsed?.oldStart ?? 1,
        oldCount: parsed?.oldCount ?? 0,
        newStart: parsed?.newStart ?? 1,
        newCount: parsed?.newCount ?? 0,
        lines: [],
      };
      continue;
    }

    if (!current || line.startsWith('---') || line.startsWith('+++')) continue;
    current.lines.push(line);
  }

  if (current) hunks.push(current);
  return hunks.length ? hunks : [syntheticHunk(oldContent, newContent)];
}

export function acceptedHunkIdSet(status: DiffHunkStatus, extraAcceptedHunkId?: string): Set<string> {
  const ids = new Set<string>();
  for (const [hunkId, value] of Object.entries(status)) {
    if (value === 'accepted') ids.add(hunkId);
  }
  if (extraAcceptedHunkId) ids.add(extraAcceptedHunkId);
  return ids;
}

export function applyAcceptedDiffHunks(originalContent: string, hunks: DiffHunk[], acceptedIds: ReadonlySet<string>): string {
  const originalLines = originalContent.split('\n');
  const orderedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart || a.index - b.index);
  const nextLines: string[] = [];
  let cursor = 0;

  for (const hunk of orderedHunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    const end = Math.max(start, start + hunk.oldCount);
    nextLines.push(...originalLines.slice(cursor, start));

    if (acceptedIds.has(hunk.id)) {
      nextLines.push(
        ...hunk.lines
          .filter((line) => line.startsWith(' ') || line.startsWith('+'))
          .map((line) => line.slice(1)),
      );
    } else {
      nextLines.push(...originalLines.slice(start, end));
    }

    cursor = end;
  }

  nextLines.push(...originalLines.slice(cursor));
  return nextLines.join('\n');
}

export function everyHunkResolved(hunks: DiffHunk[], status: DiffHunkStatus): boolean {
  return hunks.every((hunk) => status[hunk.id] === 'accepted' || status[hunk.id] === 'rejected');
}
