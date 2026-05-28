'use client';

import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X } from 'lucide-react';

interface Props {
  open: boolean;
  currentName: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Motivation vs Logic: Renaming sessions is a frequent, low-risk edit, so it
 * should feel like an in-app form rather than a browser alert. We keep the
 * modal focused on a single text field with clear validation, keyboard support,
 * and the same dark chrome used elsewhere in CodeSpace.
 */
export function SessionRenameDialog({ open, currentName, onChange, onSave, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmedName = useMemo(() => currentName.trim(), [currentName]);
  const isValid = trimmedName.length > 0;
  const canSave = isValid;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter' && !event.shiftKey && canSave) {
        event.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSave, onCancel, onSave, open]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.select());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="dialog"
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 bg-slate-850 px-4 py-3">
          <div className="flex items-center gap-2">
            <Pencil size={14} className="shrink-0 text-accent" />
            <span className="text-[13px] font-medium text-slate-100">Rename session</span>
          </div>
          <button
            aria-label="Close dialog"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-100"
            onClick={onCancel}
            type="button"
          >
            <X size={13} />
          </button>
        </div>

        <div className="px-4 py-4">
          <label className="block text-[12px] font-medium text-slate-200" htmlFor="code-space-session-rename">
            Session name
          </label>
          <input
            ref={inputRef}
            id="code-space-session-rename"
            value={currentName}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Enter a session name"
            className={`mt-2 h-10 w-full rounded-lg border bg-slate-950 px-3 text-[13px] text-slate-100 outline-none transition-colors focus:border-accent/70 focus:ring-2 focus:ring-accent/20 ${
              isValid ? 'border-slate-700' : 'border-red-500/50'
            }`}
            aria-invalid={!isValid}
          />
          <p className={`mt-2 text-[12px] leading-relaxed ${isValid ? 'text-slate-400' : 'text-red-300'}`}>
            {isValid
              ? 'Use a short, descriptive title so the session is easy to scan later.'
              : 'Please enter a session name before saving.'}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-700 bg-slate-850 px-4 py-3">
          <button
            className="inline-flex h-9 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-[12px] text-slate-200 transition-colors hover:bg-slate-700 hover:text-slate-100"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-9 items-center rounded-md border border-accent/40 bg-accent/20 px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onSave}
            disabled={!canSave}
            type="button"
          >
            Save changes
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
