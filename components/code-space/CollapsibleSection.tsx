'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  rightSlot?: ReactNode;
  className?: string;
}

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  rightSlot,
  className = '',
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={className}>
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
        {rightSlot}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}
