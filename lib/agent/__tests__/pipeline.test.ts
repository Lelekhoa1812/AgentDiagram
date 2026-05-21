import { describe, expect, it } from 'vitest';
import { validateRenderableDsl } from '../pipeline';

describe('validateRenderableDsl', () => {
  it('rejects unrenderable slash output before it can be persisted as a generated project', () => {
    expect(validateRenderableDsl('/')).toBe('Generated DSL did not contain any renderable node or group labels.');
  });

  it('rejects malformed DSL before it can be persisted as a generated project', () => {
    expect(validateRenderableDsl('Group {')).toContain('Generated DSL is still invalid');
  });

  it('rejects syntactically valid output that has nothing to render', () => {
    expect(validateRenderableDsl('// only a comment')).toBe('Generated DSL did not contain any nodes or groups.');
  });

  it('accepts renderable DSL', () => {
    expect(validateRenderableDsl('Frontend\nBackend\nFrontend > Backend')).toBeNull();
  });
});
