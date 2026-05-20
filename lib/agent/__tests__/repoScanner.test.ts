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

  it('also honors individual file entries in the ignore list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdiagram-scan-ignore-file-'));
    try {
      await write(root, 'src/keep.ts', 'export const keep = true;\n');
      await write(root, 'src/skip.ts', 'export const skip = true;\n');
      await write(root, 'top-level.ts', 'export const top = true;\n');

      const repo = await scanRepo(root, {
        allowlist: AGENT_FILE_ALLOWLIST,
        ignoredFolders: ['src/skip.ts', 'top-level.ts'],
      });
      const paths = repo.files.map((file) => file.path).sort();

      expect(paths).toEqual(['src/keep.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bypasses dotfiles, docker, lockfiles, markdown, logs and test/log folders by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdiagram-scan-defaults-'));
    try {
      await write(root, 'src/app.ts', 'export const app = true;\n');
      // Files the user explicitly asked to bypass
      await write(root, 'Dockerfile', 'FROM node:20\n');
      await write(root, 'Dockerfile.prod', 'FROM node:20\n');
      await write(root, 'docker-compose.yml', 'services: {}\n');
      await write(root, 'requirements.txt', 'flask\n');
      await write(root, 'README.md', '# Project\n');
      await write(root, 'CLAUDE.md', '# Agent guide\n');
      await write(root, 'docs/architecture.md', '# Architecture\n');
      await write(root, '.claude/config.json', '{}\n');
      await write(root, '.rtk/cache.bin', 'x');
      await write(root, '.gitignore', 'node_modules\n');
      await write(root, '.dockerignore', '*\n');
      await write(root, '.hintrc', '{}\n');
      await write(root, 'package-lock.json', '{}\n');
      // Folders
      await write(root, 'tests/foo.ts', 'export const foo = true;\n');
      await write(root, 'test/bar.ts', 'export const bar = true;\n');
      await write(root, 'logs/app.log', 'log entry\n');
      await write(root, 'log/older.log', 'older log\n');
      await write(root, 'src/feature.log', 'should not be scanned\n');

      const repo = await scanRepo(root, { allowlist: AGENT_FILE_ALLOWLIST });
      const paths = repo.files.map((file) => file.path).sort();

      expect(paths).toEqual(['src/app.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
