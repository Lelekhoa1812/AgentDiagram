import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileMentionInput } from '../FileMentionInput';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderInput(props: Partial<React.ComponentProps<typeof FileMentionInput>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = props.onChange ?? vi.fn();
  act(() => {
    root?.render(
      <FileMentionInput
        value={props.value ?? ''}
        onChange={onChange}
        onSubmit={props.onSubmit ?? vi.fn()}
        filePaths={props.filePaths ?? ['src/foo.ts', 'src/bar/baz.tsx', 'lib/utils.ts']}
        disabled={props.disabled ?? false}
        placeholder={props.placeholder ?? 'Type here...'}
      />
    );
  });
  return { container, onChange };
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('FileMentionInput', () => {
  it('renders a textarea', () => {
    const { container } = renderInput();
    expect(container.querySelector('textarea')).toBeTruthy();
  });

  it('does not show dropdown when text has no @', () => {
    renderInput({ value: 'hello world' });
    const dropdown = container!.querySelector('[data-testid="mention-dropdown"]');
    expect(dropdown).toBeNull();
  });

  it('calls onSubmit when Enter pressed without Shift', () => {
    const onSubmit = vi.fn();
    const { container } = renderInput({ value: 'do the thing', onSubmit });
    const textarea = container.querySelector('textarea')!;

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true })
      );
    });

    expect(onSubmit).toHaveBeenCalled();
  });

  it('does NOT call onSubmit when Shift+Enter pressed', () => {
    const onSubmit = vi.fn();
    const { container } = renderInput({ value: 'line one', onSubmit });
    const textarea = container.querySelector('textarea')!;

    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
      );
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows dropdown with data-testid="mention-dropdown" when value starts with @', () => {
    renderInput({ value: '@foo' });
    const dropdown = container!.querySelector('[data-testid="mention-dropdown"]');
    expect(dropdown).toBeTruthy();
  });
});
