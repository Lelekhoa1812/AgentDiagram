'use client';

import { useRef, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useDiagramStore } from '@/lib/state/store';
import { downloadTextFile } from '@/lib/export/download';
import { downloadInstructionPdf } from '@/lib/export/instructionPdf';
import { instructionMarkdownComponents } from './instructionMarkdown';

export function InstructionPanel() {
  const instructionMarkdown = useDiagramStore((s) => s.instructionMarkdown);
  const theme = useDiagramStore((s) => s.theme);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  const onDownloadMarkdown = () => {
    if (!instructionMarkdown.trim()) return;
    downloadTextFile(instructionMarkdown, 'instruction-guide.md', 'text/markdown;charset=utf-8');
  };

  const onDownloadPdf = async () => {
    const node = contentRef.current;
    if (!node || !instructionMarkdown.trim()) return;
    setIsExportingPdf(true);
    try {
      await downloadInstructionPdf(node, 'instruction-guide.pdf', theme);
    } finally {
      setIsExportingPdf(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-ink-700 bg-ink-850 px-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400">Instruction</div>
          <div className="text-xs text-ink-300">AI step-by-step guide</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Download Instruction guide as Markdown"
            className="surface-transition inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900 px-2 text-[11px] text-ink-200 hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!instructionMarkdown.trim()}
            onClick={onDownloadMarkdown}
            type="button"
          >
            <FileText size={13} />
            MD
          </button>
          <button
            aria-label="Download rendered Instruction guide as PDF"
            className="surface-transition inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 text-[11px] text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!instructionMarkdown.trim() || isExportingPdf}
            onClick={onDownloadPdf}
            type="button"
          >
            {isExportingPdf ? <Loader2 className="animate-spin" size={13} /> : <Download size={13} />}
            PDF
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-ink-900/70 p-4">
        {instructionMarkdown.trim() ? (
          <article ref={contentRef} className="rounded-xl border border-ink-700 bg-ink-900 px-5 py-4 text-sm shadow-inner">
            <ReactMarkdown
              components={instructionMarkdownComponents}
              rehypePlugins={[rehypeSanitize]}
              remarkPlugins={[remarkGfm]}
            >
              {instructionMarkdown}
            </ReactMarkdown>
          </article>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-ink-700 bg-ink-850/50 p-6 text-center text-xs leading-6 text-ink-400">
            Enable Instruction Mode in any diagram mode, generate a diagram, and the AI mentor guide will appear here.
          </div>
        )}
      </div>
    </div>
  );
}
