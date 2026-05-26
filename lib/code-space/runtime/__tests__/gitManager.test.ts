import { describe, expect, it } from 'vitest';
import { parseGitStatus } from '../gitManager';

describe('parseGitStatus', () => {
  it('extracts branch counters and file projections from porcelain output', () => {
    const status = parseGitStatus(
      'feature/code-space',
      ['## feature/code-space...origin/feature/code-space [ahead 2, behind 1]', ' M src/app.ts', 'A  src/new.ts', '?? notes.md'].join('\n'),
      'abc123 commit',
    );

    expect(status.branch).toBe('feature/code-space');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.changedFiles).toBe(3);
    expect(status.stagedFiles).toBe(1);
    expect(status.untrackedFiles).toBe(1);
    expect(status.files).toEqual([
      { status: ' M', path: 'src/app.ts' },
      { status: 'A ', path: 'src/new.ts' },
      { status: '??', path: 'notes.md' },
    ]);
  });
});

