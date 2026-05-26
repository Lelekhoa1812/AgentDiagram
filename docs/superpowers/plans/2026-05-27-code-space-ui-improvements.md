# Code Space UI Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Code Space right panel (compact tabs, rename "Patch Review" → "Review", expand chat input to 5 rows, and add @ file-mention with ghost-overlay highlight).

**Architecture:** All four tasks touch `components/code-space/`. Tasks 1–2 are in-place edits. Task 3 creates a new standalone `FileMentionInput` component; Task 4 wires it in and propagates `filePaths` from `CodeSpaceWorkspace` → `AgentPanel` → `FileMentionInput`.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Vitest + happy-dom, `react-dom/client` for tests.

---

## File Map

| Action  | Path |
|---------|------|
| Modify  | `components/code-space/CollapsibleSection.tsx` |
| Modify  | `components/code-space/AgentPanel.tsx` |
| Create  | `components/code-space/FileMentionInput.tsx` |
| Create  | `components/code-space/__tests__/FileMentionInput.test.tsx` |
| Modify  | `components/code-space/CodeSpaceWorkspace.tsx` |

---

## Task 1: Rename tab + compact CollapsibleSection headers

**Files:**
- Modify: `components/code-space/AgentPanel.tsx:203-205`
- Modify: `components/code-space/CollapsibleSection.tsx:29-33`

- [ ] **Step 1: Rename "Patch Review" to "Review" in AgentPanel.tsx**

  Open `components/code-space/AgentPanel.tsx`. On line 204 change:
  ```tsx
  // BEFORE
  title="Patch Review"
  // AFTER
  title="Review"
  ```

- [ ] **Step 2: Compact CollapsibleSection header — reduce padding and font size**

  Open `components/code-space/CollapsibleSection.tsx`. Replace the button className and chevron icon sizes:

  ```tsx
  // BEFORE (line 29-33)
  <button
    type="button"
    aria-expanded={open}
    onClick={() => setOpen((value) => !value)}
    className="flex w-full items-center gap-2 rounded border border-[#2a2a2a] bg-[#151515] px-3 py-2 text-left hover:bg-[#1b1b1b]"
  >
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {open ? <ChevronDown size={14} className="text-[#8b8b8b]" /> : <ChevronRight size={14} className="text-[#8b8b8b]" />}
      <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">{title}</span>
    </span>

  // AFTER
  <button
    type="button"
    aria-expanded={open}
    onClick={() => setOpen((value) => !value)}
    className="flex w-full items-center gap-1.5 rounded border border-[#2a2a2a] bg-[#151515] px-2 py-1 text-left hover:bg-[#1b1b1b]"
  >
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {open ? <ChevronDown size={11} className="text-[#8b8b8b]" /> : <ChevronRight size={11} className="text-[#8b8b8b]" />}
      <span className="truncate text-[9px] font-semibold uppercase tracking-wider text-[#cccccc]">{title}</span>
    </span>
  ```

- [ ] **Step 3: Verify the app compiles and looks correct**

  ```bash
  cd /Users/liamle/Downloads/diagram
  npx tsc --noEmit
  ```
  Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

  ```bash
  git add components/code-space/AgentPanel.tsx components/code-space/CollapsibleSection.tsx
  git commit -m "feat(code-space): rename Patch Review tab to Review, compact section headers"
  ```

---

## Task 2: Expand chat input to auto-growing textarea (max 5 rows)

**Files:**
- Modify: `components/code-space/AgentPanel.tsx:74,333-359`

- [ ] **Step 1: Add `textareaRef` and auto-grow helper to AgentPanel**

  In `AgentPanel.tsx`, add to the existing imports and state block (after line 76):

  ```tsx
  // add to imports at top
  import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent } from 'react';

  // add after existing useRef declarations (line 76)
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // 5 rows × 20px line-height + 12px padding (py-1.5 top+bottom)
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, []);
  ```

- [ ] **Step 2: Replace `<input>` with auto-growing `<textarea>` and handle Shift+Enter**

  In `AgentPanel.tsx`, replace the form body (lines 333–359). The existing `handleSubmit` stays unchanged.

  ```tsx
  // BEFORE — the form JSX (lines 333–381)
  <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-[#30363d] p-2">
    <div className="flex gap-2">
      <input
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe a task..."
        className="flex-1 rounded border border-[#30363d] bg-[#161b22] px-2 py-1 text-[11px] text-[#e6edf3] outline-none placeholder:text-[#6e7681] focus:border-[#58a6ff]"
        disabled={isRunning}
      />
      {isRunning ? (
        <button
          type="button"
          onClick={onCancelRun}
          className="rounded bg-[#b91c1c] px-2 py-1 text-[10px] text-white"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!prompt.trim()}
          className="rounded bg-[#1f6feb] px-2 py-1 text-[10px] text-white disabled:opacity-40"
        >
          <Zap size={10} />
        </button>
      )}
    </div>

  // AFTER
  <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-[#30363d] p-2">
    <div className="flex items-end gap-2">
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value);
          adjustHeight();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSubmit(event as unknown as FormEvent);
          }
        }}
        placeholder="Describe a task..."
        rows={1}
        style={{ minHeight: '28px', maxHeight: '112px' }}
        className="flex-1 resize-none rounded border border-[#30363d] bg-[#161b22] px-2 py-1.5 text-[11px] leading-5 text-[#e6edf3] outline-none placeholder:text-[#6e7681] focus:border-[#58a6ff] overflow-y-auto"
        disabled={isRunning}
      />
      {isRunning ? (
        <button
          type="button"
          onClick={onCancelRun}
          className="mb-0 rounded bg-[#b91c1c] px-2 py-1 text-[10px] text-white"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!prompt.trim()}
          className="rounded bg-[#1f6feb] px-2 py-1 text-[10px] text-white disabled:opacity-40"
        >
          <Zap size={10} />
        </button>
      )}
    </div>
  ```

  > Note: `items-end` on the flex row keeps the button pinned to the bottom of the textarea as it grows.

- [ ] **Step 3: Clear height when prompt is cleared after submit**

  In the existing `handleSubmit` function, add a height reset after `setPrompt('')`:

  ```tsx
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || isRunning) return;
    onSubmitPrompt(value);
    setPrompt('');
    // Reset textarea height after clearing
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };
  ```

- [ ] **Step 4: Type-check**

  ```bash
  cd /Users/liamle/Downloads/diagram
  npx tsc --noEmit
  ```
  Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

  ```bash
  git add components/code-space/AgentPanel.tsx
  git commit -m "feat(code-space): replace single-line input with auto-growing textarea (max 5 rows)"
  ```

---

## Task 3: Create FileMentionInput — ghost overlay + fuzzy @ file search

**Files:**
- Create: `components/code-space/FileMentionInput.tsx`
- Create: `components/code-space/__tests__/FileMentionInput.test.tsx`

- [ ] **Step 1: Write the failing test first**

  Create `components/code-space/__tests__/FileMentionInput.test.tsx`:

  ```tsx
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

    it('shows dropdown when @ is typed', () => {
      const onChange = vi.fn();
      const { container } = renderInput({ onChange });
      const textarea = container.querySelector('textarea')!;

      act(() => {
        Object.defineProperty(textarea, 'value', { writable: true, value: '@foo' });
        Object.defineProperty(textarea, 'selectionStart', { writable: true, value: 4 });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        // Trigger React onChange
        const event = { target: { value: '@foo', selectionStart: 4 } };
        (textarea as HTMLTextAreaElement & { _reactFiber?: unknown }); // typed for sim
      });

      // Simulate internal state: component should surface dropdown list
      // Re-render with value '@foo'
      act(() => {
        root?.render(
          <FileMentionInput
            value="@foo"
            onChange={onChange}
            onSubmit={vi.fn()}
            filePaths={['src/foo.ts', 'src/bar/baz.tsx']}
            disabled={false}
            placeholder=""
          />
        );
      });

      const dropdown = container.querySelector('[data-testid="mention-dropdown"]');
      expect(dropdown).toBeTruthy();
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
  });
  ```

- [ ] **Step 2: Run tests — verify they fail**

  ```bash
  cd /Users/liamle/Downloads/diagram
  npx vitest run components/code-space/__tests__/FileMentionInput.test.tsx 2>&1 | tail -20
  ```
  Expected: FAIL with `Cannot find module '../FileMentionInput'`

- [ ] **Step 3: Create FileMentionInput.tsx**

  Create `components/code-space/FileMentionInput.tsx`:

  ```tsx
  'use client';

  import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

  // ---------------------------------------------------------------------------
  // Fuzzy filter: rank filePaths by how well they match the query.
  // Priority: filename starts with query > filename contains query > path contains query.
  // ---------------------------------------------------------------------------
  function fuzzyFilter(paths: string[], query: string): string[] {
    if (!query) return paths.slice(0, 8);
    const q = query.toLowerCase();
    return paths
      .filter((p) => {
        const name = (p.split('/').pop() ?? '').toLowerCase();
        return name.includes(q) || p.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const nameA = (a.split('/').pop() ?? '').toLowerCase();
        const nameB = (b.split('/').pop() ?? '').toLowerCase();
        const scoreA = nameA.startsWith(q) ? 0 : nameA.includes(q) ? 1 : 2;
        const scoreB = nameB.startsWith(q) ? 0 : nameB.includes(q) ? 1 : 2;
        return scoreA - scoreB;
      })
      .slice(0, 8);
  }

  // ---------------------------------------------------------------------------
  // Split text into plain/mention segments for the mirror div.
  // Matches [filename](path) markdown links inserted by the mention handler.
  // ---------------------------------------------------------------------------
  function splitSegments(text: string): Array<{ kind: 'plain' | 'mention'; value: string }> {
    const pattern = /(\[[^\]]+\]\([^)]+\))/g;
    const segments: Array<{ kind: 'plain' | 'mention'; value: string }> = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        segments.push({ kind: 'plain', value: text.slice(last, match.index) });
      }
      segments.push({ kind: 'mention', value: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ kind: 'plain', value: text.slice(last) });
    return segments;
  }

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------
  export interface FileMentionInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    filePaths: string[];
    disabled?: boolean;
    placeholder?: string;
  }

  // ---------------------------------------------------------------------------
  // Component
  // ---------------------------------------------------------------------------
  export function FileMentionInput({
    value,
    onChange,
    onSubmit,
    filePaths,
    disabled = false,
    placeholder = 'Describe a task...',
  }: FileMentionInputProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const mirrorRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLUListElement>(null);

    // mentionQuery: the text after @ up to cursor; null means dropdown is closed
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [matchedFiles, setMatchedFiles] = useState<string[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);

    // -----------------------------------------------------------------------
    // Auto-grow: max 5 rows (5 × 20px line-height + 12px padding = 112px)
    // -----------------------------------------------------------------------
    const adjustHeight = useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
    }, []);

    // -----------------------------------------------------------------------
    // Handle text change — detect @ trigger
    // -----------------------------------------------------------------------
    const handleChange = useCallback(
      (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = event.target.value;
        onChange(newValue);
        adjustHeight();

        const cursor = event.target.selectionStart ?? newValue.length;
        const before = newValue.slice(0, cursor);
        // Match @ followed by non-whitespace chars (the in-progress mention)
        const match = before.match(/@(\S*)$/);
        if (match) {
          const query = match[1];
          const filtered = fuzzyFilter(filePaths, query);
          setMentionQuery(query);
          setMatchedFiles(filtered);
          setActiveIndex(0);
        } else {
          setMentionQuery(null);
          setMatchedFiles([]);
        }
      },
      [onChange, adjustHeight, filePaths]
    );

    // -----------------------------------------------------------------------
    // Insert a file mention into the textarea value
    // -----------------------------------------------------------------------
    const insertMention = useCallback(
      (filePath: string) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const cursor = textarea.selectionStart ?? value.length;
        const before = value.slice(0, cursor);
        const match = before.match(/@(\S*)$/);
        if (!match) return;

        const fileName = filePath.split('/').pop() ?? filePath;
        const start = cursor - match[0].length;
        const mention = `[${fileName}](${filePath})`;
        const newValue = value.slice(0, start) + mention + value.slice(cursor);
        onChange(newValue);
        setMentionQuery(null);
        setMatchedFiles([]);

        // Restore focus + move cursor after the inserted mention
        requestAnimationFrame(() => {
          textarea.focus();
          const newCursor = start + mention.length;
          textarea.setSelectionRange(newCursor, newCursor);
          adjustHeight();
        });
      },
      [value, onChange, adjustHeight]
    );

    // -----------------------------------------------------------------------
    // Keyboard navigation inside textarea
    // -----------------------------------------------------------------------
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const dropdownOpen = mentionQuery !== null && matchedFiles.length > 0;

        if (dropdownOpen) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((i) => (i + 1) % matchedFiles.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((i) => (i - 1 + matchedFiles.length) % matchedFiles.length);
            return;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            insertMention(matchedFiles[activeIndex]);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setMentionQuery(null);
            setMatchedFiles([]);
            return;
          }
        }

        // Enter without Shift → submit; Shift+Enter → newline (default)
        if (event.key === 'Enter' && !event.shiftKey && !dropdownOpen) {
          event.preventDefault();
          if (value.trim()) onSubmit();
        }
      },
      [mentionQuery, matchedFiles, activeIndex, insertMention, value, onSubmit]
    );

    // -----------------------------------------------------------------------
    // Close dropdown on outside click
    // -----------------------------------------------------------------------
    useEffect(() => {
      if (mentionQuery === null) return;
      const handler = (event: MouseEvent) => {
        if (
          !textareaRef.current?.contains(event.target as Node) &&
          !dropdownRef.current?.contains(event.target as Node)
        ) {
          setMentionQuery(null);
          setMatchedFiles([]);
        }
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [mentionQuery]);

    const dropdownOpen = mentionQuery !== null && matchedFiles.length > 0;

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------
    return (
      <div className="relative flex-1">
        {/* Mention dropdown — floats above the input */}
        {dropdownOpen && (
          <ul
            ref={dropdownRef}
            data-testid="mention-dropdown"
            className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded border border-[#30363d] bg-[#161b22] shadow-lg"
            role="listbox"
          >
            {matchedFiles.map((filePath, index) => {
              const fileName = filePath.split('/').pop() ?? filePath;
              const dir = filePath.slice(0, filePath.lastIndexOf('/') + 1);
              return (
                <li
                  key={filePath}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent textarea blur
                    insertMention(filePath);
                  }}
                  className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-[10px] ${
                    index === activeIndex ? 'bg-[#1f6feb33] text-[#e6edf3]' : 'text-[#8b949e] hover:bg-[#1f1f1f]'
                  }`}
                >
                  <span className="font-semibold text-[#58a6ff]">{fileName}</span>
                  <span className="truncate text-[#6e7681]">{dir}</span>
                </li>
              );
            })}
          </ul>
        )}

        {/* Ghost overlay stack */}
        <div className="relative overflow-hidden rounded border border-[#30363d] bg-[#161b22] focus-within:border-[#58a6ff]">
          {/* Mirror div — shows highlighted mention text */}
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-1.5 font-mono text-[11px] leading-5"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {splitSegments(value).map((seg, i) =>
              seg.kind === 'mention' ? (
                // Mention segments: blue bg highlight + blue text visible from mirror
                <mark
                  key={i}
                  className="rounded px-0.5 not-italic"
                  style={{ background: 'rgba(31,111,235,0.2)', color: '#79b8ff' }}
                >
                  {seg.value}
                </mark>
              ) : (
                // Plain segments: show in normal text color from mirror
                // (textarea text is transparent, so mirror provides all visible text)
                <span key={i} style={{ color: '#e6edf3' }}>
                  {seg.value}
                </span>
              )
            )}
            {/* trailing newline keeps mirror height in sync with textarea */}
            {'\n'}
          </div>

          {/* Textarea on top — TRANSPARENT text so mirror shows through; caret visible */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="relative w-full resize-none bg-transparent px-2 py-1.5 font-mono text-[11px] leading-5 outline-none placeholder:text-[#6e7681] overflow-y-auto"
            style={{
              minHeight: '28px',
              maxHeight: '112px',
              color: 'transparent',   // hide textarea text — mirror renders it
              caretColor: '#e6edf3',  // caret stays visible
            }}
          />
        </div>
      </div>
    );
  }
  ```

  > **Ghost overlay technique:** The textarea has `color: transparent` so its text is invisible — only the caret remains visible via `caretColor`. The mirror div sits behind it and renders ALL text: plain segments in `#e6edf3` (normal color) and mention segments with a blue background + `#79b8ff` text. Result: text appears to come from the mirror, highlights are visible at mention positions, and the user still types normally into the textarea.

- [ ] **Step 4: Run tests — verify they pass**

  ```bash
  cd /Users/liamle/Downloads/diagram
  npx vitest run components/code-space/__tests__/FileMentionInput.test.tsx 2>&1 | tail -30
  ```
  Expected: all 5 tests PASS.

- [ ] **Step 5: Type-check**

  ```bash
  npx tsc --noEmit
  ```
  Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

  ```bash
  git add components/code-space/FileMentionInput.tsx components/code-space/__tests__/FileMentionInput.test.tsx
  git commit -m "feat(code-space): add FileMentionInput with ghost overlay and @ fuzzy file mention"
  ```

---

## Task 4: Wire FileMentionInput into AgentPanel + CodeSpaceWorkspace

**Files:**
- Modify: `components/code-space/AgentPanel.tsx` (add `filePaths` prop, swap `<textarea>` for `<FileMentionInput>`)
- Modify: `components/code-space/CodeSpaceWorkspace.tsx` (derive flat `filePaths` from `treeChildren`, pass to `AgentPanel`)

- [ ] **Step 1: Add `filePaths` prop to AgentPanel + replace textarea with FileMentionInput**

  In `components/code-space/AgentPanel.tsx`:

  **1a. Update imports** (add FileMentionInput, remove useCallback and useRef for textarea since FileMentionInput owns them):

  ```tsx
  // Add to imports
  import { FileMentionInput } from './FileMentionInput';
  ```

  **1b. Add `filePaths` to the props interface** (after `onRejectDiff`):

  ```tsx
  // In AgentPanelProps interface, add:
  filePaths?: string[];
  ```

  **1c. Destructure the new prop** in the function signature:

  ```tsx
  // In the function parameter destructuring, add:
  filePaths = [],
  ```

  **1d. Remove the textarea additions from Task 2** — delete `textareaRef`, `adjustHeight`, and the `<textarea>` block. Replace the form input area with:

  ```tsx
  // REPLACE the entire <div className="flex items-end gap-2"> block with:
  <div className="flex items-end gap-2">
    <FileMentionInput
      value={prompt}
      onChange={setPrompt}
      onSubmit={() => {
        const value = prompt.trim();
        if (!value || isRunning) return;
        onSubmitPrompt(value);
        setPrompt('');
      }}
      filePaths={filePaths}
      disabled={isRunning}
      placeholder="Describe a task..."
    />
    {isRunning ? (
      <button
        type="button"
        onClick={onCancelRun}
        className="rounded bg-[#b91c1c] px-2 py-1 text-[10px] text-white"
      >
        Stop
      </button>
    ) : (
      <button
        type="submit"
        disabled={!prompt.trim()}
        className="rounded bg-[#1f6feb] px-2 py-1 text-[10px] text-white disabled:opacity-40"
      >
        <Zap size={10} />
      </button>
    )}
  </div>
  ```

  **1e. Also update `handleSubmit`** to clear prompt (FileMentionInput calls `onSubmit` directly, but the form submit button still calls `handleSubmit`):

  ```tsx
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || isRunning) return;
    onSubmitPrompt(value);
    setPrompt('');
  };
  ```
  _(This is already present; no change needed — just ensure it stays.)_

  **1f. Clean up unused refs/callbacks** — remove `textareaRef`, `adjustHeight`, and the `useCallback` import if it is no longer used elsewhere in the file.

- [ ] **Step 2: Flatten the file tree in CodeSpaceWorkspace**

  In `components/code-space/CodeSpaceWorkspace.tsx`, add a `useMemo` near the other state declarations (around line 224). It needs to import `useMemo` (already imported). Add after the `treeChildren` state:

  ```tsx
  // Derive a flat list of all known file paths for the @ mention feature.
  // treeChildren maps parentPath → CodeSpaceTreeNode[]; we recurse to collect files.
  const flatFilePaths = useMemo(() => {
    const paths: string[] = [];
    function collect(nodes: import('@/lib/code-space/core').CodeSpaceTreeNode[]) {
      for (const node of nodes) {
        if (node.type === 'file') paths.push(node.path);
        if (node.children) collect(node.children);
      }
    }
    for (const nodes of Object.values(treeChildren)) {
      collect(nodes);
    }
    return paths;
  }, [treeChildren]);
  ```

- [ ] **Step 3: Pass `filePaths` to AgentPanel in CodeSpaceWorkspace**

  Find the `<AgentPanel` JSX (around line 1915). Add the new prop:

  ```tsx
  // Add this line inside <AgentPanel ...>:
  filePaths={flatFilePaths}
  ```

- [ ] **Step 4: Type-check**

  ```bash
  cd /Users/liamle/Downloads/diagram
  npx tsc --noEmit
  ```
  Expected: no TypeScript errors.

- [ ] **Step 5: Run full test suite**

  ```bash
  npx vitest run 2>&1 | tail -30
  ```
  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add components/code-space/AgentPanel.tsx components/code-space/CodeSpaceWorkspace.tsx
  git commit -m "feat(code-space): wire FileMentionInput into AgentPanel; propagate filePaths from workspace tree"
  ```

---

## Done ✓

All four tasks complete:
- "Patch Review" renamed to "Review"
- Section headers are visually compact (9px text, 4px vertical padding)
- Chat input auto-grows to 5 rows, Shift+Enter for newlines
- `@` triggers fuzzy file search dropdown; selected file inserts `[name](path)` with blue ghost overlay highlight
