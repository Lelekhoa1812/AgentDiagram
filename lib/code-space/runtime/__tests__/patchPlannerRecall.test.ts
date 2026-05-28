import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatWithRetry } from '@/lib/agent/providers';
import { callPatchPlannerModel, parsePlannerJson, recallPlannerFiles } from '../agentRuntime';

vi.mock('@/lib/agent/providers', () => ({
  chatWithRetry: vi.fn(),
}));

const mockedChatWithRetry = vi.mocked(chatWithRetry);

describe('patch planner recall', () => {
  beforeEach(() => {
    mockedChatWithRetry.mockReset();
  });

  it('parses requested files from planner JSON', () => {
    const parsed = parsePlannerJson(
      JSON.stringify({
        summary: 'Need the Code Space UI surface before patching.',
        needsMoreFiles: ['components/code-space/CodeSpaceWorkspace.tsx', '../outside.ts', ''],
        files: [],
      }),
    );

    expect(parsed.needsMoreFiles).toEqual(['components/code-space/CodeSpaceWorkspace.tsx']);
    expect(parsed.files).toEqual([]);
  });

  it('reads additional repository files by safe relative path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'planner-recall-'));
    try {
      await mkdir(path.join(root, 'components/code-space'), { recursive: true });
      await writeFile(path.join(root, 'components/code-space/CodeSpaceWorkspace.tsx'), 'export function CodeSpaceWorkspace() { return null; }\n');
      await writeFile(path.join(root, 'runtime.ts'), 'export const runtime = true;\n');

      const recalled = await recallPlannerFiles(root, [
        'components/code-space/CodeSpaceWorkspace.tsx',
        '../outside.ts',
        'missing.ts',
      ], new Set(['runtime.ts']));

      expect(recalled.map((file) => file.path)).toEqual(['components/code-space/CodeSpaceWorkspace.tsx']);
      expect(recalled[0]?.content).toContain('CodeSpaceWorkspace');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries patch planning with recalled file evidence before giving up', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'planner-retry-'));
    try {
      await mkdir(path.join(root, 'components/code-space'), { recursive: true });
      await writeFile(path.join(root, 'runtime.ts'), 'export const runtime = true;\n');
      await writeFile(path.join(root, 'components/code-space/CodeSpaceWorkspace.tsx'), 'export function CodeSpaceWorkspace() { return null; }\n');
      mockedChatWithRetry
        .mockResolvedValueOnce(JSON.stringify({
          summary: 'Need Code Space UI evidence.',
          needsMoreFiles: ['components/code-space/CodeSpaceWorkspace.tsx'],
          files: [],
        }))
        .mockResolvedValueOnce(JSON.stringify({
          summary: 'Patch ready.',
          files: [
            {
              path: 'components/code-space/CodeSpaceWorkspace.tsx',
              afterContent: 'export function CodeSpaceWorkspace() { return "diff"; }\n',
              explanation: 'Show the full diff editor.',
            },
          ],
        }));

      const result = await callPatchPlannerModel(
        root,
        'Review the Code Space page and show changed files in the editor.',
        {
          files: [
            {
              path: 'runtime.ts',
              content: 'export const runtime = true;\n',
              truncated: false,
              mode: 'full',
              lineCount: 1,
              score: 10,
              reasons: ['route_runtime_surface'],
              reasonDetails: [],
              summary: 'Runtime evidence',
              symbols: [],
            },
          ],
        } as never,
        { providerId: 'local', model: 'local' } as never,
        [],
      );

      expect(mockedChatWithRetry).toHaveBeenCalledTimes(2);
      expect(mockedChatWithRetry.mock.calls[1]?.[1]?.[1]?.content).toContain('--- RECALLED FILE components/code-space/CodeSpaceWorkspace.tsx ---');
      expect(result.files[0]?.path).toBe('components/code-space/CodeSpaceWorkspace.tsx');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
