import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeSpaceTabActions } from '../CodeSpaceTabActions';
import type { CodeSpaceEditorTab } from '@/lib/code-space/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderHarness(initialTab: CodeSpaceEditorTab) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  function Harness() {
    const [tab, setTab] = useState(initialTab);
    return (
      <div data-preview={String(tab.preview)}>
        <CodeSpaceTabActions
          activeTab={tab}
          onSave={vi.fn()}
          onRename={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onTogglePreview={() => setTab((current) => ({ ...current, preview: !current.preview }))}
        />
      </div>
    );
  }

  act(() => {
    root?.render(<Harness />);
  });

  return { container };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('CodeSpaceTabActions', () => {
  it('shows the markdown preview toggle instead of duplicate', () => {
    const tab: CodeSpaceEditorTab = {
      id: 'tab-1',
      projectId: 'project-1',
      path: 'docs/readme.md',
      language: 'markdown',
      contentHash: 'hash',
      dirty: false,
      pinned: true,
      preview: true,
      lastOpenedAt: Date.now(),
    };

    const { container } = renderHarness(tab);

    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Duplicate'))).toBe(false);
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Editor'))).toBe(true);
  });

  it('toggles the tab object between preview and editor modes', () => {
    const tab: CodeSpaceEditorTab = {
      id: 'tab-2',
      projectId: 'project-1',
      path: 'docs/readme.md',
      language: 'markdown',
      contentHash: 'hash',
      dirty: false,
      pinned: true,
      preview: false,
      lastOpenedAt: Date.now(),
    };

    const { container } = renderHarness(tab);
    const toggleButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Preview'));
    expect(toggleButton).toBeTruthy();

    act(() => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-preview="true"]')).toBeTruthy();
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Editor'))).toBe(true);
  });
});
