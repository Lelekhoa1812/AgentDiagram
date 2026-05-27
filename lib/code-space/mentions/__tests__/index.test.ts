import { describe, expect, it } from 'vitest';
import { buildMentionIndex, normalizeMentionPath } from '../index';

describe('normalizeMentionPath', () => {
  it('keeps already-clean paths intact', () => {
    expect(normalizeMentionPath('app/components/Button.tsx')).toBe('app/components/Button.tsx');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeMentionPath('app\\components\\Button.tsx')).toBe('app/components/Button.tsx');
  });

  it('collapses duplicate slashes', () => {
    expect(normalizeMentionPath('app///components//Button.tsx')).toBe('app/components/Button.tsx');
  });

  it('strips leading ./ and trailing slashes', () => {
    expect(normalizeMentionPath('./app/components/')).toBe('app/components');
  });

  it('strips leading slash', () => {
    expect(normalizeMentionPath('/app/components')).toBe('app/components');
  });

  it('rejects parent-directory traversal', () => {
    expect(normalizeMentionPath('../secret')).toBeNull();
    expect(normalizeMentionPath('app/../secret')).toBeNull();
  });

  it('returns empty string for empty input', () => {
    expect(normalizeMentionPath('')).toBe('');
    expect(normalizeMentionPath('   ')).toBe('');
  });
});

describe('buildMentionIndex', () => {
  const fixture = [
    'app/components/control/controlPanel.tsx',
    'app/components/Button.tsx',
    'backend/main.py',
    'backend/components/AuthCard.tsx',
    'backend/components/controlPanel.tsx',
    'backend/routes/user.ts',
    'frontend/App.tsx',
    'package.json',
    'README.md',
    'docker-compose.yml',
    'node_modules/foo/index.js',
    '.git/HEAD',
    '.github/workflows/deploy.yml',
  ];

  it('derives folder entries from file paths', () => {
    const index = buildMentionIndex(fixture);
    const folderPaths = index.entries.filter((entry) => entry.type === 'folder').map((entry) => entry.relativePath);
    expect(folderPaths).toContain('app');
    expect(folderPaths).toContain('app/components');
    expect(folderPaths).toContain('app/components/control');
    expect(folderPaths).toContain('backend');
    expect(folderPaths).toContain('backend/components');
    expect(folderPaths).toContain('frontend');
  });

  it('drops ignored folder subtrees from the index', () => {
    const index = buildMentionIndex(fixture);
    const paths = index.entries.map((entry) => entry.relativePath);
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(paths.some((p) => p === '.git')).toBe(false);
  });

  it('keeps explicitly-useful dot folders accessible (down-ranked, but discoverable)', () => {
    const index = buildMentionIndex(['.github/workflows/deploy.yml']);
    expect(index.hasEntry('.github')).toBe(true);
    expect(index.byPath.get('.github')?.isHidden).toBe(true);
  });

  it('exposes hasDirectory for exact directory matches', () => {
    const index = buildMentionIndex(fixture);
    expect(index.hasDirectory('backend')).toBe(true);
    expect(index.hasDirectory('backend/components')).toBe(true);
    expect(index.hasDirectory('backend/components/')).toBe(true);
    expect(index.hasDirectory('package.json')).toBe(false);
  });

  it('returns direct children only for childrenOf', () => {
    const index = buildMentionIndex(fixture);
    const backendChildren = index.childrenOf('backend').map((entry) => entry.relativePath).sort();
    expect(backendChildren).toEqual([
      'backend/components',
      'backend/main.py',
      'backend/routes',
    ]);
  });

  it('returns root entries for childrenOf("")', () => {
    const index = buildMentionIndex(fixture);
    const rootPaths = index.rootEntries().map((entry) => entry.relativePath).sort();
    expect(rootPaths).toContain('package.json');
    expect(rootPaths).toContain('README.md');
    expect(rootPaths).toContain('docker-compose.yml');
    expect(rootPaths).toContain('app');
    expect(rootPaths).toContain('backend');
    expect(rootPaths).toContain('frontend');
  });

  it('tags important config files and binaries via the ignore policy', () => {
    const index = buildMentionIndex(['package.json', 'README.md', 'public/logo.png', 'app/foo.ts']);
    const pkg = index.byPath.get('package.json');
    const readme = index.byPath.get('README.md');
    const logo = index.byPath.get('public/logo.png');
    expect(pkg?.isImportantConfig).toBe(true);
    expect(readme?.isImportantConfig).toBe(true);
    expect(logo?.isBinary).toBe(true);
  });

  it('rejects path-traversal entries silently', () => {
    const index = buildMentionIndex(['../etc/passwd', 'app/main.ts']);
    expect(index.byPath.get('../etc/passwd')).toBeUndefined();
    expect(index.byPath.get('etc/passwd')).toBeUndefined();
    expect(index.byPath.get('app/main.ts')).toBeDefined();
  });
});
