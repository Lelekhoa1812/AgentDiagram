import { describe, expect, it } from 'vitest';
import { selectEvidenceFiles } from '../codeAgentLoop';

describe('code agent evidence ranking', () => {
  it('balances evidence so Code Space UI files are not crowded out by runtime files', () => {
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

    const selected = selectEvidenceFiles(
      { files, selectedFiles: files.map((file) => file.path) } as never,
      'Review the Code Space page and make changed files open in the editor diff before accept or reject.',
      6,
    ).map((file: { path: string }) => file.path);

    expect(selected).toContain('components/code-space/CodeSpaceWorkspace.tsx');
    expect(selected).toContain('components/code-space/AgentPanel.tsx');
    expect(selected).toContain('components/code-space/__tests__/AgentPanel.test.tsx');
  });
});
