import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContextEngine } from '@/lib/code-space/runtime/contextEngine';

describe('ContextEngine', () => {
  it('prioritizes mentioned files, folders, tabs, tests, and config surfaces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ctx-engine-'));
    await mkdir(path.join(root, 'components/code-space'), { recursive: true });
    await mkdir(path.join(root, 'lib/code-space/runtime'), { recursive: true });
    await mkdir(path.join(root, '.agent/plans'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
    await writeFile(path.join(root, 'components/code-space/AgentPanel.tsx'), 'export const x = 1;', 'utf8');
    await writeFile(path.join(root, 'lib/code-space/runtime/contextEngine.ts'), 'export const y = 2;', 'utf8');
    await writeFile(path.join(root, 'lib/code-space/runtime/contextEngine.test.ts'), 'describe("x",()=>{});', 'utf8');
    await writeFile(path.join(root, '.agent/plans/s1.md'), '# plan', 'utf8');

    const engine = new ContextEngine();
    const result = await engine.collectProjectContext(root, 'Review @lib/code-space/runtime/contextEngine.ts and @components/code-space for agent runtime plan artifact', ['components/code-space/AgentPanel.tsx'], 20);

    expect(result.files.length).toBeGreaterThan(0);
    const selected = result.files.map((f) => f.path);
    expect(selected).toContain('lib/code-space/runtime/contextEngine.ts');
    expect(selected).toContain('components/code-space/AgentPanel.tsx');
    expect(selected.some((f) => f.includes('.agent/plans'))).toBe(true);
    expect(['low','medium','high']).toContain(result.confidence);
  });

  it('expands its own evidence by mining references from seed files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ctx-engine-ref-'));
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await mkdir(path.join(root, 'lib/code-space/runtime'), { recursive: true });
    await writeFile(
      path.join(root, 'README.md'),
      'The Code Space runtime lives in `lib/code-space/runtime/agentRuntime.ts` and should be reused for all agent runs.',
      'utf8',
    );
    await writeFile(path.join(root, 'lib/code-space/runtime/agentRuntime.ts'), 'export const runtime = true;', 'utf8');

    const engine = new ContextEngine();
    const result = await engine.collectProjectContext(root, 'Review the coding workflow for evidence gathering', [], 10);

    expect(result.files.map((file) => file.path)).toContain('lib/code-space/runtime/agentRuntime.ts');
    expect(result.files.map((file) => file.path)).toContain('README.md');
  });

  it('routes Code Space page review prompts toward workspace, sidebar, and editor tests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ctx-engine-code-space-page-'));
    await mkdir(path.join(root, 'components/code-space/__tests__'), { recursive: true });
    await mkdir(path.join(root, 'lib/code-space/runtime'), { recursive: true });
    await mkdir(path.join(root, 'app'), { recursive: true });
    await writeFile(path.join(root, 'app/page.tsx'), 'import { CodeSpaceWorkspace } from "../components/code-space/CodeSpaceWorkspace";\n');
    await writeFile(path.join(root, 'components/code-space/CodeSpaceWorkspace.tsx'), 'export function CodeSpaceWorkspace() { return "editor diff"; }\n');
    await writeFile(path.join(root, 'components/code-space/AgentPanel.tsx'), 'export function AgentPanel() { return "Code changes sidebar"; }\n');
    await writeFile(path.join(root, 'components/code-space/__tests__/AgentPanel.test.tsx'), 'describe("diff sidebar", () => {});\n');
    await writeFile(path.join(root, 'lib/code-space/runtime/agentRuntime.ts'), 'export const runtime = true;\n');
    await writeFile(path.join(root, 'lib/code-space/runtime/patchReview.ts'), 'export const patchReview = true;\n');

    const engine = new ContextEngine();
    const result = await engine.collectProjectContext(
      root,
      'Review the Code Space page so changed files open in the code editor with red and green patches before accept or reject.',
      [],
      8,
    );
    const selected = result.files.map((file) => file.path);

    expect(selected).toContain('components/code-space/CodeSpaceWorkspace.tsx');
    expect(selected).toContain('components/code-space/AgentPanel.tsx');
    expect(selected).toContain('components/code-space/__tests__/AgentPanel.test.tsx');
    expect(selected.indexOf('components/code-space/CodeSpaceWorkspace.tsx')).toBeLessThan(
      selected.indexOf('lib/code-space/runtime/agentRuntime.ts'),
    );
  });
});
