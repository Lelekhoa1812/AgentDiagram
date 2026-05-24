'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';

interface Props {
  open: boolean;
  title: string;
  message: string;
  /** Label for the destructive action button. Defaults to "Delete". */
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A small portal-based confirmation modal used before destructive operations
 * (deleting a project, deleting a layer, etc.).
 *
 * - Escape → cancel
 * - Enter  → confirm
 * - Click backdrop → cancel
 *
 * Colours are hardcoded slate/ink values so the dialog looks correct in both
 * dark and light themes (ink-* remaps to near-white in light theme).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
    >
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 bg-slate-850 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0 text-red-400" />
            <span className="text-[13px] font-medium text-slate-100">{title}</span>
          </div>
          <button
            aria-label="Cancel"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-100"
            onClick={onCancel}
            type="button"
          >
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4">
          <p className="text-[13px] leading-relaxed text-slate-300">{message}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-700 bg-slate-850 px-4 py-3">
          <button
            className="inline-flex h-8 items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-[12px] text-slate-200 transition-colors hover:bg-slate-700 hover:text-slate-100"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex h-8 items-center rounded-md border border-red-500/50 bg-red-500/15 px-3 text-[12px] text-red-300 transition-colors hover:bg-red-500/25 hover:text-red-200"
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
