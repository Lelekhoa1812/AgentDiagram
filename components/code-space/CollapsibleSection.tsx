'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  compact?: boolean;
  rightSlot?: ReactNode;
  className?: string;
}

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  compact = false,
  rightSlot,
  className = '',
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Motivation vs Logic: Code Space's right sidebar is density-sensitive, so the shared header supports a compact mode
  // instead of duplicating thin-tab styling in each section that needs it.
  const headerClassName = compact
    ? 'flex w-full items-center gap-1 rounded border border-[#2a2a2a] bg-[#151515] px-1.5 py-0.5 text-left hover:bg-[#1b1b1b]'
    : 'flex w-full items-center gap-1.5 rounded border border-[#2a2a2a] bg-[#151515] px-2 py-1 text-left hover:bg-[#1b1b1b]';
  const titleClassName = compact
    ? 'truncate text-[9px] font-semibold uppercase tracking-[0.2em] text-[#cccccc]'
    : 'truncate text-[10px] font-semibold uppercase tracking-wider text-[#cccccc]';

  return (
    <section className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={headerClassName}
      >
        <span className={`flex min-w-0 flex-1 items-center ${compact ? 'gap-1' : 'gap-1.5'}`}>
          {open ? (
            <ChevronDown size={compact ? 10 : 11} className="text-[#8b8b8b]" />
          ) : (
            <ChevronRight size={compact ? 10 : 11} className="text-[#8b8b8b]" />
          )}
          <span className={titleClassName}>{title}</span>
        </span>
        {rightSlot}
      </button>
      {open && <div className={compact ? 'mt-1.5' : 'mt-2'}>{children}</div>}
    </section>
  );
}
