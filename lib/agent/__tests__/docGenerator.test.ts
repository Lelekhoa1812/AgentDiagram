import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTechnicalDocumentation } from '../docs/docGenerator';
import { chatWithRetry } from '../providers';

vi.mock('../providers', () => ({
  chatWithRetry: vi.fn(),
}));

const mockedChat = vi.mocked(chatWithRetry);

function makeSummary(i: number) {
  return {
    path: `lib/section-${Math.floor(i / 10)}/file-${i}.ts`,
    summary: {
      role: `Implements feature ${i}`,
      category: 'service',
      layer: 'core',
      exports: [`feature${i}`],
      imports: i > 0 ? [`lib/section-${Math.floor((i - 1) / 10)}/file-${i - 1}.ts`] : [],
      surface: [`feature${i}()`],
      external_deps: ['zod'],
      side_effects: ['emits progress'],
      notes: `Detailed summary ${i}`,
    },
  };
}

function makeInput(summaryCount: number) {
  const summaries = Array.from({ length: summaryCount }, (_, i) => makeSummary(i));
  return {
    repoMap: {
      root: '/repo',
      fileCount: summaryCount,
      totalBytes: summaryCount * 1000,
      likelyStack: ['Next.js', 'TypeScript'],
      entrypoints: [{ path: 'app/page.tsx' }],
      files: summaries.map((item) => ({ path: item.path, bytes: 1000 })),
    },
    summaries,
    importGraph: {
      files: new Map(),
      externals: new Map([['zod', summaryCount]]),
      edges: [],
    },
    docs: [],
    repoContext: {
      likelyStack: ['Next.js', 'TypeScript'],
      depHints: ['zod'],
      folderClusters: [],
      centralFiles: [],
      routes: [],
      exportsByFile: [],
      envVars: [],
      crossFolderEdges: [],
      signals: { manifests: ['package.json'], schemas: [], infra: [], tests: 1 },
    },
    diagramStyle: 'single',
    diagramTitle: 'Test diagram',
  } as any;
}

describe('generateTechnicalDocumentation', () => {
  beforeEach(() => {
    mockedChat.mockReset();
    mockedChat.mockImplementation(async (_session, messages) => {
      const user = messages[1]?.content ?? '';
      if (user.includes('Generate sections 1')) {
        return '## 1. Project Overview\nArchitecture pass\n\n## 5. API Contracts\nRoutes';
      }
      const files = user.match(/#### [^\n]+/g) ?? [];
      return `## Module Reference\n${files.join('\n')}`;
    });
  });

  it('keeps small repo documentation in a single call', async () => {
    const markdown = await generateTechnicalDocumentation(
      { id: 'openai', model: 'test-model', apiKey: 'test-key' },
      makeInput(3),
    );

    expect(mockedChat).toHaveBeenCalledTimes(1);
    expect(markdown).toContain('#### lib/section-0/file-0.ts');
  });

  it('splits large module references into bounded section calls', async () => {
    const progress: string[] = [];
    const markdown = await generateTechnicalDocumentation(
      { id: 'openai', model: 'test-model', apiKey: 'test-key' },
      makeInput(82),
      { onProgress: (message) => progress.push(message) },
    );

    expect(mockedChat).toHaveBeenCalledTimes(5);
    expect(progress[0]).toBe('Module reference split into 4 bounded sections');

    const moduleCalls = mockedChat.mock.calls.slice(1);
    const fileCounts = moduleCalls.map((call) => {
      const messages = call[1];
      const user = messages[1]?.content ?? '';
      return user.match(/#### [^\n]+/g)?.length ?? 0;
    });
    expect(Math.max(...fileCounts)).toBeLessThanOrEqual(24);
    expect(fileCounts.reduce((sum, count) => sum + count, 0)).toBe(82);
    expect(markdown).toContain('## Module Reference');
    expect(markdown).toContain('#### lib/section-0/file-0.ts');
    expect(markdown).toContain('#### lib/section-8/file-81.ts');
  });
});
