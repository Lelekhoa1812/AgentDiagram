import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '../repoScanner';

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('repoScanner', () => {
  it('only scans allowed code/config files and skips docs plus tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdiagram-scan-'));
    try {
      await write(root, 'package.json', JSON.stringify({ dependencies: { next: 'latest' } }));
      await write(root, 'src/app.ts', 'export const app = true;\n');
      await write(root, 'db/schema.prisma', 'model User { id String @id }\n');
      await write(root, 'README.md', '# Project\n');
      await write(root, 'src/app.test.ts', 'import { app } from "./app";\n');
      await write(root, '__tests__/fixture.ts', 'export const fixture = true;\n');
      await write(root, 'notes/diagram.txt', 'not source\n');

      const repo = await scanRepo(root, { allowlist: AGENT_FILE_ALLOWLIST });
      const paths = repo.files.map((file) => file.path);

      expect(paths).toEqual(expect.arrayContaining(['package.json', 'src/app.ts', 'db/schema.prisma']));
      expect(paths).not.toEqual(expect.arrayContaining(['README.md', 'src/app.test.ts', '__tests__/fixture.ts', 'notes/diagram.txt']));
      expect(repo.docs).toHaveLength(0);
      expect(repo.tests).toHaveLength(0);
      expect(repo.byExt.md).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
