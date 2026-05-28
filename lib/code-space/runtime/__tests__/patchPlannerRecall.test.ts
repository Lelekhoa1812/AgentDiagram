import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatWithRetry } from '@/lib/agent/providers';
import { callPatchPlannerModel, parsePlannerJson, recallPlannerFiles, selectPlannerEvidenceFiles } from '../agentRuntime';

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

  it('recalls likely Code Space page files even when the model forgets needsMoreFiles', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'planner-auto-recall-'));
    try {
      await mkdir(path.join(root, 'components/code-space'), { recursive: true });
      await writeFile(path.join(root, 'runtime.ts'), 'export const runtime = true;\n');
      await writeFile(path.join(root, 'components/code-space/CodeSpaceWorkspace.tsx'), 'export function CodeSpaceWorkspace() { return null; }\n');
      await writeFile(path.join(root, 'components/code-space/AgentPanel.tsx'), 'export function AgentPanel() { return null; }\n');
      mockedChatWithRetry
        .mockResolvedValueOnce(JSON.stringify({
          summary: 'I need more repository evidence before I can safely produce a patch.',
          files: [],
        }))
        .mockResolvedValueOnce(JSON.stringify({
          summary: 'Patch ready.',
          files: [
            {
              path: 'components/code-space/AgentPanel.tsx',
              afterContent: 'export function AgentPanel() { return "diff rail"; }\n',
              explanation: 'Open changed files from the review rail.',
            },
          ],
        }));

      const result = await callPatchPlannerModel(
        root,
        'Review the Code Space page and make changed files open in the editor before accept or reject.',
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
      expect(mockedChatWithRetry.mock.calls[1]?.[1]?.[1]?.content).toContain('--- RECALLED FILE components/code-space/AgentPanel.tsx ---');
      expect(result.files[0]?.path).toBe('components/code-space/AgentPanel.tsx');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('balances planner evidence so Code Space UI files are not crowded out by runtime files', () => {
    const files = [
      'lib/code-space/runtime/agentRuntime.ts',
      'lib/code-space/runtime/toolRegistry.ts',
      'lib/code-space/runtime/patchReview.ts',
      'lib/code-space/runtime/permissionManager.ts',
      'lib/code-space/runtime/terminalPolicy.ts',
      'lib/code-space/runtime/validationRunner.ts',
      'components/code-space/CodeSpaceWorkspace.tsx',
      'components/code-space/AgentPanel.tsx',
      'components/code-space/__tests__/AgentPanel.test.tsx',
      'app/page.tsx',
    ].map((filePath, index) => ({
      path: filePath,
      content: `// ${filePath}`,
      truncated: false,
      mode: 'full' as const,
      lineCount: 1,
      score: 100 - index,
      reasons: filePath.startsWith('components/code-space') ? ['ui_surface' as const] : ['route_runtime_surface' as const],
      reasonDetails: [],
      summary: filePath,
      symbols: [],
    }));

    const selected = selectPlannerEvidenceFiles(
      {
        files,
        selectedFiles: files.map((file) => file.path),
      } as never,
      'Review the Code Space page and make changed files open in the editor diff before accept or reject.',
      6,
    ).map((file) => file.path);

    expect(selected).toContain('components/code-space/CodeSpaceWorkspace.tsx');
    expect(selected).toContain('components/code-space/AgentPanel.tsx');
    expect(selected).toContain('components/code-space/__tests__/AgentPanel.test.tsx');
  });
});
