import { describe, it, expect } from 'vitest';
import { guardPath } from '../pathGuard';

describe('guardPath', () => {
  it('rejects root', () => {
    expect(guardPath('/').ok).toBe(false);
  });
  it('rejects /etc', () => {
    expect(guardPath('/etc/passwd').ok).toBe(false);
  });
  it('rejects ~/.ssh', () => {
    expect(guardPath('~/.ssh').ok).toBe(false);
  });
  it('accepts a reasonable user path', () => {
    const r = guardPath('/Users/test/projects/foo');
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe('/Users/test/projects/foo');
  });
  it('expands ~ home', () => {
    const r = guardPath('~/projects/foo');
    expect(r.ok).toBe(true);
  });
});
