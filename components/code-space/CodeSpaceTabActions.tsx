'use client';

import { Save } from 'lucide-react';
import type { CodeSpaceEditorTab } from '@/lib/code-space/core';

interface CodeSpaceTabActionsProps {
  activeTab: CodeSpaceEditorTab | null;
  onSave: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onTogglePreview: () => void;
}

export function CodeSpaceTabActions({
  activeTab,
  onSave,
  onRename,
  onDuplicate,
  onDelete,
  onTogglePreview,
}: CodeSpaceTabActionsProps) {
  const isMarkdownTab = activeTab?.language === 'markdown';
  const previewLabel = activeTab?.preview ? 'Editor' : 'Preview';

  return (
    <>
      <button
        type="button"
        onClick={onSave}
        disabled={!activeTab?.dirty}
        className="mx-1 rounded p-1.5 text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40"
        title="Save active file (Cmd/Ctrl+S)"
      >
        <Save size={15} />
      </button>
      <button
        type="button"
        onClick={onRename}
        disabled={!activeTab}
        className="rounded px-2 py-1 text-[11px] text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40"
      >
        Rename
      </button>
      {isMarkdownTab ? (
        <button
          type="button"
          onClick={onTogglePreview}
          disabled={!activeTab}
          className="rounded px-2 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
        >
          {previewLabel}
        </button>
      ) : (
        <button
          type="button"
          onClick={onDuplicate}
          disabled={!activeTab}
          className="rounded px-2 py-1 text-[11px] text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40"
        >
          Duplicate
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        disabled={!activeTab}
        className="rounded px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
      >
        Delete
      </button>
    </>
  );
}
