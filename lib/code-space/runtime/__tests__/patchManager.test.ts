import { describe, expect, it } from 'vitest';
import { createPatchProposal, splitDiffHunks } from '../patchManager';

describe('createPatchProposal', () => {
  it('creates a reviewable patch proposal with file stats and unified diff', () => {
    const proposal = createPatchProposal({
      id: 'patch-1',
      runId: 'run-1',
      projectId: 'project-1',
      explanation: 'Update greeting',
      files: [
        {
          path: 'src/hello.ts',
          beforeContent: 'export const hello = "hi";\n',
          afterContent: 'export const hello = "hello";\n',
        },
      ],
    });

    expect(proposal.filesChanged).toEqual(['src/hello.ts']);
    expect(proposal.additions).toBe(1);
    expect(proposal.deletions).toBe(1);
    expect(proposal.diff).toContain('--- a/src/hello.ts');
    expect(proposal.diff).toContain('+++ b/src/hello.ts');
    expect(proposal.diff).toContain('-export const hello = "hi";');
    expect(proposal.diff).toContain('+export const hello = "hello";');
  });

  it('renders deleted files as removals instead of empty writes', () => {
    const proposal = createPatchProposal({
      id: 'patch-2',
      runId: 'run-2',
      projectId: 'project-2',
      explanation: 'Delete obsolete strategy file',
      files: [
        {
          path: 'src/agentic_research_strategy.py',
          beforeContent: 'print("obsolete")\n',
          afterContent: '',
          deleted: true,
        },
      ],
    });

    expect(proposal.filesChanged).toEqual(['src/agentic_research_strategy.py']);
    expect(proposal.additions).toBe(0);
    expect(proposal.deletions).toBe(1);
    expect(proposal.diff).toContain('-print("obsolete")');
  });
});

describe('splitDiffHunks', () => {
  it('returns file-scoped hunks for the diff UI', () => {
    const proposal = createPatchProposal({
      id: 'patch-1',
      runId: 'run-1',
      projectId: 'project-1',
      explanation: 'Update greeting',
      files: [{ path: 'src/hello.ts', beforeContent: 'a\n', afterContent: 'b\n' }],
    });

    expect(splitDiffHunks(proposal.diff)).toEqual([
      expect.objectContaining({ filePath: 'src/hello.ts', patch: expect.stringContaining('+b') }),
    ]);
  });
});
