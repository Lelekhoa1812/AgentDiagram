import { describe, expect, it } from 'vitest';
import { RepairLoop } from '../repairLoop';

describe('RepairLoop', () => {
  it('stops as needs_review after the retry budget', () => {
    const loop = new RepairLoop(2);
    const failed = [{ kind: 'test' as const, command: 'npm run test', status: 'failed' as const, output: 'boom', durationMs: 1 }];

    const first = loop.runBoundedRepair(failed);
    const second = loop.runBoundedRepair(failed, [first]);
    const third = loop.runBoundedRepair(failed, [first, second]);

    expect(first.status).toBe('needs_review');
    expect(second.status).toBe('needs_review');
    expect(third.reason).toBe('Repair retry budget exhausted.');
  });
});
