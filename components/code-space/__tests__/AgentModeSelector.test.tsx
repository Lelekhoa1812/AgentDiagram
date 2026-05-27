import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeSelector } from '../AgentModeSelector';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderSelector(mode: 'ask' | 'plan' | 'code', onChange = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<AgentModeSelector mode={mode} onChange={onChange} />);
  });
  return { container, onChange };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('AgentModeSelector', () => {
  it('shows Code by default and uses the blue mode class', () => {
    const view = renderSelector('code');
    const button = view.container.querySelector('button');

    expect(button?.textContent).toContain('Code');
    expect(button?.className).toContain('text-[#79b8ff]');
  });

  it('shows Ask in green and Plan in purple', () => {
    let view = renderSelector('ask');
    expect(view.container.querySelector('button')?.className).toContain('text-[#7ee787]');

    act(() => root?.unmount());
    view.container.remove();
    root = null;
    container = null;

    view = renderSelector('plan');
    expect(view.container.querySelector('button')?.className).toContain('text-[#d2a8ff]');
  });

  it('calls onChange when a menu item is selected', () => {
    const onChange = vi.fn();
    const view = renderSelector('code', onChange);
    const button = view.container.querySelector('button');

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const planOption = Array.from(view.container.querySelectorAll('button')).find((item) => item.textContent?.includes('Plan'));
    act(() => {
      planOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith('plan');
  });
});
