'use client';

import React, { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

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

  // -------------------------------------------------------------------------
  // Auto-grow: max 5 rows (5 × 20px line-height + 12px padding = 112px)
  // -------------------------------------------------------------------------
  const MAX_HEIGHT = 112;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  // -------------------------------------------------------------------------
  // Handle text change — detect @ trigger
  // -------------------------------------------------------------------------
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
        const query = match[1] ?? '';
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

  // -------------------------------------------------------------------------
  // Insert a file mention into the textarea value
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Keyboard navigation inside textarea
  // -------------------------------------------------------------------------
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
          const selected = matchedFiles[activeIndex];
          if (selected) insertMention(selected);
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

  // -------------------------------------------------------------------------
  // Close dropdown on outside click
  // -------------------------------------------------------------------------
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

  // Sync dropdown when value prop changes externally and contains an @ trigger
  useEffect(() => {
    const match = value.match(/@(\S*)$/);
    if (match) {
      const query = match[1] ?? '';
      const filtered = fuzzyFilter(filePaths, query);
      if (filtered.length > 0 && mentionQuery === null) {
        setMentionQuery(query);
        setMatchedFiles(filtered);
        setActiveIndex(0);
      }
    }
    // Only run when value or filePaths changes — not mentionQuery to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, filePaths]);

  const dropdownOpen = mentionQuery !== null && matchedFiles.length > 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
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
        {/* Mirror div — shows ALL text; plain text in normal color, mentions highlighted */}
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-1.5 font-mono text-[11px] leading-5"
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {splitSegments(value).map((seg, i) =>
            seg.kind === 'mention' ? (
              <mark
                key={i}
                className="rounded px-0.5 not-italic"
                style={{ background: 'rgba(31,111,235,0.2)', color: '#79b8ff' }}
              >
                {seg.value}
              </mark>
            ) : (
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
