'use client';

import { useRef, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useDiagramStore } from '@/lib/state/store';

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-4 mt-1 text-2xl font-semibold tracking-tight text-ink-100">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-3 mt-6 border-b border-ink-700 pb-2 text-lg font-semibold text-ink-100">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-ink-100">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-ink-300">{children}</h4>,
  p: ({ children }) => <p className="my-3 leading-7 text-ink-200">{children}</p>,
  a: ({ children, href }) => (
    <a className="text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent" href={href} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-3 list-disc space-y-2 pl-5 text-ink-200">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-2 pl-5 text-ink-200">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-accent/70 bg-accent/10 px-4 py-2 text-ink-200">{children}</blockquote>
  ),
  hr: () => <hr className="my-6 border-ink-700" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-ink-700">
      <table className="min-w-full divide-y divide-ink-700 text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-ink-850 text-ink-100">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-ink-700">{children}</tbody>,
  th: ({ children }) => <th className="px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-3 py-2 align-top text-ink-200">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-[11px] leading-6 text-ink-100 shadow-inner">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return <code className={`${className} font-mono`}>{children}</code>;
    }
    return <code className="rounded border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-[0.92em] text-accent-cool">{children}</code>;
  },
  img: ({ alt, src }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt ?? ''} className="my-4 max-w-full rounded-lg border border-ink-700" src={src ?? ''} />
  ),
};

function downloadBlob(content: string, mime: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function InstructionPanel() {
  const instructionMarkdown = useDiagramStore((s) => s.instructionMarkdown);
  const theme = useDiagramStore((s) => s.theme);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  const onDownloadMarkdown = () => {
    if (!instructionMarkdown.trim()) return;
    downloadBlob(instructionMarkdown, 'text/markdown;charset=utf-8', 'instruction-guide.md');
  };

  const onDownloadPdf = async () => {
    const node = contentRef.current;
    if (!node || !instructionMarkdown.trim()) return;
    setIsExportingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);
      const canvas = await html2canvas(node, {
        backgroundColor: theme === 'light' ? '#ffffff' : '#0b0e13',
        scale: 2,
        useCORS: true,
      });
      const pdf = new jsPDF('p', 'pt', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 36;
      const imageWidth = pageWidth - margin * 2;
      const imageHeight = (canvas.height * imageWidth) / canvas.width;
      const imageData = canvas.toDataURL('image/png');
      let y = margin;
      let remainingHeight = imageHeight;

      pdf.addImage(imageData, 'PNG', margin, y, imageWidth, imageHeight);
      remainingHeight -= pageHeight - margin * 2;

      while (remainingHeight > 0) {
        pdf.addPage();
        y -= pageHeight - margin * 2;
        pdf.addImage(imageData, 'PNG', margin, y, imageWidth, imageHeight);
        remainingHeight -= pageHeight - margin * 2;
      }

      pdf.save('instruction-guide.pdf');
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
            <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
              {instructionMarkdown}
            </ReactMarkdown>
          </article>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-ink-700 bg-ink-850/50 p-6 text-center text-xs leading-6 text-ink-400">
            Enable Instruction Mode in Custom App, generate a diagram, and the AI mentor guide will appear here.
          </div>
        )}
      </div>
    </div>
  );
}
