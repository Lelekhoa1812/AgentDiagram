import { describe, expect, it } from 'vitest';
import { createSignatureSummary } from '../analysis/sourceProfiler';

describe('createSignatureSummary', () => {
  it('captures deterministic public surface and side effects without an LLM call', () => {
    const summary = createSignatureSummary(
      { path: 'lib/services/user.ts', bytes: 200, ext: 'ts' },
      `
import { db } from '../data/db';
export async function createUser() {
  await fetch(process.env.USER_WEBHOOK!);
  return db.user.create({});
}
export class UserService {}
`,
      {
        files: new Map([['lib/services/user.ts', ['lib/data/db.ts', 'stripe']]]),
        edges: [
          { from: 'lib/services/user.ts', to: 'lib/data/db.ts', external: false },
          { from: 'lib/services/user.ts', to: 'stripe', external: true },
        ],
        externals: new Map([['stripe', 1]]),
      },
    );

    expect(summary.category).toBe('service');
    expect(summary.layer).toBe('service');
    expect(summary.surface).toEqual(expect.arrayContaining(['createUser', 'UserService']));
    expect(summary.external_deps).toContain('stripe');
    expect(summary.side_effects).toEqual(expect.arrayContaining(['env-var reads', 'HTTP calls', 'database access']));
  });
});

