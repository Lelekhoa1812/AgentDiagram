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
      await write(root, 'docs/example.ts', 'export const docExample = true;\n');
      await write(root, '.agentdiagram-cache/summary.json', '{"role":"cache"}\n');
      await write(root, 'public/diagram.svg', '<svg />\n');

      const repo = await scanRepo(root, { allowlist: AGENT_FILE_ALLOWLIST });
      const paths = repo.files.map((file) => file.path);

      expect(paths).toEqual(expect.arrayContaining(['package.json', 'src/app.ts', 'db/schema.prisma']));
      expect(paths).not.toEqual(
        expect.arrayContaining([
          'README.md',
          'src/app.test.ts',
          '__tests__/fixture.ts',
          'notes/diagram.txt',
          'docs/example.ts',
          '.agentdiagram-cache/summary.json',
          'public/diagram.svg',
        ]),
      );
      expect(repo.docs).toHaveLength(0);
      expect(repo.tests).toHaveLength(0);
      expect(repo.byExt.md).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies user-selected ignored folders before scanning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdiagram-scan-ignore-'));
    try {
      await write(root, 'src/app.ts', 'export const app = true;\n');
      await write(root, 'generated/client.ts', 'export const generated = true;\n');
      await write(root, 'packages/ignored/index.ts', 'export const ignored = true;\n');

      const repo = await scanRepo(root, {
        allowlist: AGENT_FILE_ALLOWLIST,
        ignoredFolders: ['generated', 'packages/ignored'],
      });
      const paths = repo.files.map((file) => file.path);

      expect(paths).toEqual(['src/app.ts']);
      expect(repo.ignoredFolders).toEqual(expect.arrayContaining(['generated/**', 'packages/ignored/**']));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
