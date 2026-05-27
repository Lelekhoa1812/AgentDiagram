import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '../MarkdownRenderer';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-testid="mermaid-diagram"></svg>' })),
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderMarkdown(markdown: string, onOpenFile = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <MarkdownRenderer
        markdown={markdown}
        currentFilePath="docs/readme.md"
        rootPath="/repo"
        onOpenFile={onOpenFile}
      />,
    );
  });

  return { container, onOpenFile };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('MarkdownRenderer', () => {
  it('renders links, images, and mermaid diagrams', async () => {
    const markdown = [
      '# Guide',
      '',
      'See [notes](notes.txt).',
      '',
      '![Diagram caption](images/diagram.png)',
      '',
      '```mermaid',
      'graph TD;',
      '  A-->B;',
      '```',
    ].join('\n');
    const { container, onOpenFile } = renderMarkdown(markdown);

    const link = container.querySelector('a[href="notes.txt"]');
    expect(link).toBeTruthy();

    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onOpenFile).toHaveBeenCalledWith('docs/notes.txt', { preview: false });

    const image = container.querySelector('img[alt="Diagram caption"]') as HTMLImageElement | null;
    expect(image?.src).toContain('/api/code-space/assets?');
    expect(container.textContent).toContain('Diagram caption');

    for (let i = 0; i < 20 && !container.querySelector('[data-testid="mermaid-diagram"]'); i += 1) {
      await act(async () => {
        await flush();
      });
    }

    expect(container.querySelector('[data-testid="mermaid-diagram"]')).toBeTruthy();
  });
});
