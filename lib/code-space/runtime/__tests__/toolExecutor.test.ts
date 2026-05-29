import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@/lib/agent/providers';
import { ToolExecutor, type CodeAgentContext } from '../toolExecutor';
import { createDefaultToolRegistry } from '../toolRegistry';
import { PermissionManager } from '../permissionManager';
import { TerminalRunner } from '../terminalRunner';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { AutonomyLevel } from '@/lib/code-space/domain';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-tool-exec-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeContext(events: AgentSSEEvent[], autonomy: AutonomyLevel = 'auto_safe_tools'): CodeAgentContext {
  return {
    root: tmpDir,
    runId: 'run-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    autonomy,
    emit: (event) => {
      events.push(event);
    },
    emitRuntime: async () => {},
    ledger: new Map(),
    proposedFiles: new Set(),
    proposedLedger: new Map(),
    editFailures: new Map(),
    readFiles: new Set(),
    artifacts: new Map(),
    checkpoints: [],
    registry: createDefaultToolRegistry(),
    permission: new PermissionManager(),
    terminal: new TerminalRunner(),
  };
}

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `${name}-1`, name, input };
}

describe('ToolExecutor.edit_file', () => {
  it('applies a clean edit to disk and records a checkpoint', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toContain('x = 2');
    expect(ctx.checkpoints.length).toBe(1);
    expect(events.some((event) => event.type === 'file_applied')).toBe(true);
  });

  it('returns an actionable diagnostic (not a throw) when the search block does not match', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'NONEXISTENT LINE', replace: 'whatever', reason: 'x' }] }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/could not apply|SEARCH/i);
    expect(result.content).toMatch(/Current state of a\.ts/);
    expect(result.content).toMatch(/Repair protocol:/);
    expect(ctx.editFailures.get('a.ts')?.length).toBeGreaterThan(0);
    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(ctx.checkpoints.length).toBe(0);
  });

  it('proposes instead of writing under suggest_only autonomy', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );

    expect(await readFile(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(events.some((event) => event.type === 'diff_proposed')).toBe(true);
    expect(events.some((event) => event.type === 'file_applied')).toBe(false);
    expect(ctx.proposedFiles.has('a.ts')).toBe(true);
    expect(ctx.proposedLedger.get('a.ts')?.afterContent).toContain('x = 2');
    expect(ctx.ledger.size).toBe(0);
  });

  it('rejects invalid Python proposals under suggest_only instead of surfacing them for review', async () => {
    const target = path.join(tmpDir, 'backend/api/config.py');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      ['class Config:', '    def __init__(self):', '        self.value = 1', ''].join('\n'),
      'utf8',
    );
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events, 'suggest_only');
    const executor = new ToolExecutor();

    const result = await executor.execute(
      call('edit_file', {
        edits: [
          {
            path: 'backend/api/config.py',
            search: '        self.value = 1',
            replace: '    def broken(self):\n        pass\n        self.value = 1',
            reason: 'bad indent',
          },
        ],
      }),
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/syntax pre-validation/i);
    expect(events.some((event) => event.type === 'diff_proposed')).toBe(false);
    expect(ctx.proposedFiles.size).toBe(0);
    expect(ctx.proposedLedger.size).toBe(0);
    expect(ctx.editFailures.get('backend/api/config.py')?.length).toBeGreaterThan(0);
  });

  it('clears editFailures after a successful retry on the same file', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'export const x = 1;\n', 'utf8');
    const events: AgentSSEEvent[] = [];
    const ctx = makeContext(events);
    const executor = new ToolExecutor();

    await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'NONEXISTENT LINE', replace: 'whatever', reason: 'x' }] }),
      ctx,
    );
    expect(ctx.editFailures.get('a.ts')?.length).toBeGreaterThan(0);

    const result = await executor.execute(
      call('edit_file', { edits: [{ path: 'a.ts', search: 'export const x = 1;', replace: 'export const x = 2;', reason: 'bump' }] }),
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(ctx.editFailures.has('a.ts')).toBe(false);
  });
});
