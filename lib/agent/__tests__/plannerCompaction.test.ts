import { describe, expect, it } from 'vitest';
import { buildPlanUserMessage } from '../planner';
import type { AnalysisDigest } from '../analysisBudget';
import type { ImportGraph } from '../importGraph';
import type { RepoMap, ScannedFile } from '../repoScanner';
import type { FileSummary } from '../summarizer';

function scanned(path: string): ScannedFile {
  return { path, bytes: 100, ext: 'ts' };
}

function repo(files: ScannedFile[]): RepoMap {
  return {
    root: '/tmp/repo',
    fileCount: files.length,
    totalBytes: files.length * 100,
    byExt: { ts: files.length },
    files,
    manifests: [],
    entrypoints: [files[0]!],
    apiRoutes: [],
    components: [],
    schemas: [],
    configs: [],
    infra: [],
    tests: [],
    docs: [],
    depHints: [],
    ignoredFolders: [],
    likelyStack: ['TypeScript'],
  };
}

function summary(index: number): FileSummary {
  return {
    role: `Synthetic file summary ${index}`,
    category: 'service',
    layer: 'service',
    exports: [`run${index}`],
    imports: [],
    surface: [`run${index}`],
    external_deps: ['react'],
    side_effects: [],
    notes: null,
  };
}

describe('planner prompt compaction', () => {
  it('keeps thousands of summaries bounded when an analysis digest is present', () => {
    const files = Array.from({ length: 3000 }, (_, index) => scanned(`lib/module-${index % 30}/file-${index}.ts`));
    const summaries = files.map((file, index) => ({ path: file.path, summary: summary(index) }));
    const imports: ImportGraph = { files: new Map(), edges: [], externals: new Map([['react', 3000]]) };
    const digest: AnalysisDigest = {
      tier: 4,
      label: 'Tier 4 DSL abstraction',
      totalRelevantFiles: 3000,
      analyzedFiles: 1200,
      deepFiles: 120,
      signatureFiles: 1080,
      structuralFiles: 1800,
      bypassedFiles: 1800,
      global: {
        externals: ['react (3000)'],
        centralFiles: ['lib/module-1/file-1.ts (in 10, out 8)'],
        crossFolderEdges: ['app/api->lib/service (30)'],
        folderClusters: ['lib/service (800 files, in 20, out 40)'],
      },
      moduleRollups: Array.from({ length: 60 }, (_, index) => ({
        module: `lib/module-${index}`,
        fileCount: 100,
        deepFiles: index < 5 ? 4 : 0,
        signatureFiles: 20,
        representativeFiles: [`lib/module-${index}/file-${index}.ts`],
        layers: ['service'],
        categories: ['service'],
        surface: [`run${index}`],
        externalDeps: ['react'],
        sideEffects: [],
      })),
      notes: ['Synthetic large repo digest.'],
    };

    const msg = buildPlanUserMessage({
      repoMap: repo(files),
      summaries,
      imports,
      docs: [],
      repoContext: undefined,
      analysisDigest: digest,
      kind: 'architecture',
      focus: '',
    });

    expect(msg.length).toBeLessThan(120_000);
    expect(msg).toContain('Progressive analysis digest');
    expect(msg).toContain('showing 120 of 3000');
    expect(msg).not.toContain('file-2999.ts');
  });
});

