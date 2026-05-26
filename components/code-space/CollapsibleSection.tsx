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
        className="flex w-full items-center gap-1.5 rounded border border-[#2a2a2a] bg-[#151515] px-2 py-1 text-left hover:bg-[#1b1b1b]"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {open ? <ChevronDown size={11} className="text-[#8b8b8b]" /> : <ChevronRight size={11} className="text-[#8b8b8b]" />}
          <span className="truncate text-[9px] font-semibold uppercase tracking-wider text-[#cccccc]">{title}</span>
        </span>
        {rightSlot}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}
