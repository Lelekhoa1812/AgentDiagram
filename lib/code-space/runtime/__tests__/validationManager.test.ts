import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationManager } from '../validationManager';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('ValidationManager', () => {
  it('detects package validation scripts and npm as the default package manager', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-code-space-validation-'));
    await writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', build: 'next build' } }),
      'utf8',
    );

    const commands = await new ValidationManager().detectValidationCommands(tmpDir);

    expect(commands).toEqual([
      { kind: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
      { kind: 'test', command: 'npm', args: ['run', 'test'] },
      { kind: 'build', command: 'npm', args: ['run', 'build'] },
    ]);
  });
});
