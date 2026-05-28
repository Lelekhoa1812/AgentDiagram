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
});
