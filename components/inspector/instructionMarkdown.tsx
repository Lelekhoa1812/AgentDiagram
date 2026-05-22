'use client';

import type { Components } from 'react-markdown';

export const instructionMarkdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-4 mt-1 text-2xl font-semibold tracking-tight text-ink-100">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="mb-3 mt-6 border-b border-ink-700 pb-2 text-lg font-semibold text-ink-100">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-ink-100">{children}</h3>,
  h4: ({ children }) => (
    <h4 className="mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-ink-300">{children}</h4>
  ),
  p: ({ children }) => <p className="my-3 leading-7 text-ink-200">{children}</p>,
  a: ({ children, href }) => (
    <a
      className="text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
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
    return (
      <code className="rounded border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-[0.92em] text-accent-cool">
        {children}
      </code>
    );
  },
  img: ({ alt, src }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt ?? ''} className="my-4 max-w-full rounded-lg border border-ink-700" src={src ?? ''} />
  ),
};
