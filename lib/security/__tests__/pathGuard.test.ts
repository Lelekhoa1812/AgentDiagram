import { describe, it, expect } from 'vitest';
import { guardPath, resolveBrowsePath } from '../pathGuard';

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

  it('treats a trailing ~ as a sibling prefix search', () => {
    const r = resolveBrowsePath('/Users/test/projects/Back~');
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe('/Users/test/projects/Back');
    expect(r.browseRoot).toBe('/Users/test/projects');
    expect(r.prefix).toBe('Back');
  });

  it('keeps exact paths as exact browse roots', () => {
    const r = resolveBrowsePath('/Users/test/projects/foo');
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe('/Users/test/projects/foo');
    expect(r.browseRoot).toBe('/Users/test/projects/foo');
    expect(r.prefix).toBeNull();
  });
});
