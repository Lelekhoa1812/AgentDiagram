import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEditBlocksToContent } from '@/lib/code-space/agent/editBlocks';
import { applyPatchFiles, PatchApplyError } from '../patchApply';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('unified patch lifecycle', () => {
  it('rejects path traversal before preview/apply', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-patch-traversal-'));
    await expect(
      applyPatchFiles({
        root: tmpDir,
        projectId: 'project',
        runId: 'run',
        patchId: 'patch',
        files: [{ path: '../escape.ts', beforeContent: '', afterContent: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects non-unique search blocks', () => {
    const result = applyEditBlocksToContent('src/a.ts', 'const x = 1;\nconst x = 1;\n', [
      { path: 'src/a.ts', search: 'const x = 1;', replace: 'const x = 2;', reason: 'change duplicate' },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe('SEARCH_NOT_UNIQUE');
  });

  it('rejects stale beforeContent and preserves disk content', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-patch-stale-'));
    await writeFile(path.join(tmpDir, 'file.ts'), 'current\n', 'utf8');

    await expect(
      applyPatchFiles({
        root: tmpDir,
        projectId: 'project',
        runId: 'run',
        patchId: 'patch',
        files: [{ path: 'file.ts', beforeContent: 'old\n', afterContent: 'new\n' }],
      }),
    ).rejects.toBeInstanceOf(PatchApplyError);
    expect(await readFile(path.join(tmpDir, 'file.ts'), 'utf8')).toBe('current\n');
  });

  it('creates a checkpoint before writing files', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-patch-checkpoint-'));
    await writeFile(path.join(tmpDir, 'file.ts'), 'old\n', 'utf8');

    const result = await applyPatchFiles({
      root: tmpDir,
      projectId: 'project',
      runId: 'run',
      patchId: 'patch',
      files: [{ path: 'file.ts', beforeContent: 'old\n', afterContent: 'new\n' }],
    });

    expect(result.checkpoint?.snapshotRef).toBeTruthy();
    expect(await readFile(path.join(tmpDir, 'file.ts'), 'utf8')).toBe('new\n');
  });
});
