'use client';

interface PlanLinkProps {
  filePath?: string;
  disabled?: boolean;
  onView: (filePath: string) => void;
  onRun: (filePath: string) => void;
}

export function PlanLink({ filePath, disabled = false, onView, onRun }: PlanLinkProps) {
  if (!filePath) return null;
  return (
    <div className="rounded border border-[#8957e566] bg-[#160f24] p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[#f0e6ff]">Editable plan generated</div>
          <div className="mt-0.5 truncate text-[9px] text-[#8b949e]" title={filePath}>{filePath}</div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRun(filePath)}
          className="rounded bg-[#8957e5] px-2 py-1 text-[10px] font-semibold text-white hover:bg-[#a371f7] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Build
        </button>
      </div>
      <button
        type="button"
        onClick={() => onView(filePath)}
        className="mt-2 text-[10px] text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]"
      >
        View plan...
      </button>
    </div>
  );
}
