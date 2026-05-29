import { describe, expect, it, vi } from 'vitest';
import { RepairLoop, type RepairRunParams } from '../repairLoop';
import type { ValidationRunResult } from '../validationRunner';

function failing(command = 'npm run test'): ValidationRunResult {
  return { kind: 'test', command, status: 'failed', output: 'boom', durationMs: 1 };
}

function passing(command = 'npm run test'): ValidationRunResult {
  return { kind: 'test', command, status: 'passed', output: 'ok', durationMs: 1 };
}

function makeParams(overrides: Partial<RepairRunParams>): RepairRunParams {
  const budget = { turnsExhausted: () => false, mutationBudgetExhausted: () => false };
  return {
    loop: { continueWith: vi.fn(async () => {}) } as never,
    ctx: { artifacts: new Map() } as never,
    loopOptions: { signal: undefined, budget } as never,
    initialResults: [failing()],
    runValidation: vi.fn(async () => [passing()]),
    emit: vi.fn(),
    emitRuntime: vi.fn(async () => {}),
    runId: 'run-1',
    ...overrides,
  };
}

describe('RepairLoop', () => {
  it('shouldRepair is true only when a result failed', () => {
    const loop = new RepairLoop();
    expect(loop.shouldRepair([failing()])).toBe(true);
    expect(loop.shouldRepair([passing()])).toBe(false);
    expect(loop.shouldRepair([])).toBe(false);
  });

  it('feeds failures back into the live loop and re-validates until green', async () => {
    const loop = new RepairLoop(3);
    const params = makeParams({ runValidation: vi.fn(async () => [passing()]) });

    const result = await loop.run(params);

    expect(params.loop.continueWith).toHaveBeenCalledTimes(1);
    expect(params.runValidation).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.repaired).toBe(true);
    expect(loop.shouldRepair(result.results)).toBe(false);
  });

  it('stops after the bounded attempt count when still failing', async () => {
    const loop = new RepairLoop(2);
    const params = makeParams({ runValidation: vi.fn(async () => [failing()]) });

    const result = await loop.run(params);

    expect(params.loop.continueWith).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.repaired).toBe(false);
  });
});
