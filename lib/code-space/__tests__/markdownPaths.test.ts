import { describe, expect, it } from 'vitest';
import {
  buildMarkdownAssetUrl,
  resolveMarkdownLinkTarget,
  resolveMarkdownPath,
} from '../markdownPaths';

describe('markdown path helpers', () => {
  it('resolves relative file links from the current markdown folder', () => {
    expect(resolveMarkdownPath('docs/guide/readme.md', '../notes/todo.md')).toBe('docs/notes/todo.md');
    expect(resolveMarkdownLinkTarget('docs/guide/readme.md', '../notes/todo.md')).toEqual({
      kind: 'file',
      path: 'docs/notes/todo.md',
      hash: undefined,
    });
  });

  it('keeps external URLs external', () => {
    expect(resolveMarkdownLinkTarget('docs/readme.md', 'https://example.com/path?q=1')).toEqual({
      kind: 'external',
      href: 'https://example.com/path?q=1',
    });
  });

  it('builds guarded asset URLs for relative images', () => {
    expect(buildMarkdownAssetUrl('/repo', 'docs/readme.md', './images/chart.png')).toContain(
      '/api/code-space/assets?',
    );
    expect(buildMarkdownAssetUrl('/repo', 'docs/readme.md', './images/chart.png')).toContain(
      'rootPath=%2Frepo',
    );
    expect(buildMarkdownAssetUrl('/repo', 'docs/readme.md', './images/chart.png')).toContain(
      'path=docs%2Fimages%2Fchart.png',
    );
  });
});
