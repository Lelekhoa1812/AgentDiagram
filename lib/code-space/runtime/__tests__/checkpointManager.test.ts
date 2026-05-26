import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileCheckpoint } from '../checkpointManager';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('createFileCheckpoint', () => {
  it('snapshots only requested files inside the project root', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-code-space-checkpoint-'));
    await writeFile(path.join(tmpDir, 'app.ts'), 'console.log("before");\n', 'utf8');

    const checkpoint = await createFileCheckpoint({
      projectId: 'project-1',
      projectRoot: tmpDir,
      runId: 'run-1',
      reason: 'before patch',
      files: ['app.ts'],
    });

    expect(checkpoint.id).toMatch(/^checkpoint:/);
    expect(checkpoint.files).toHaveLength(1);
    expect(checkpoint.files[0]).toMatchObject({
      path: 'app.ts',
      content: 'console.log("before");\n',
      existed: true,
    });
    await expect(readFile(checkpoint.snapshotRef, 'utf8')).resolves.toContain('before patch');
  });
});
