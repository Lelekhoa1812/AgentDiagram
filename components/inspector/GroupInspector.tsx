'use client';

import { useDiagramStore } from '@/lib/state/store';
import type { IRGroup } from '@/lib/ir/types';
import { hex } from '@/lib/ir/colors';
import { COLORS, ICONS, rewriteDeclProp } from './shared';

export function GroupInspector({ group }: { group: IRGroup }) {
  const dsl = useDiagramStore((s) => s.dslText);
  const setDsl = useDiagramStore((s) => s.setDsl);

  const update = (key: string, value: string) => {
    setDsl(rewriteDeclProp(dsl, group.name, key, value));
  };

  return (
    <div className="space-y-4 p-4 text-xs">
      <header>
        <div className="text-[10px] uppercase tracking-widest text-ink-400">Group</div>
        <div className="font-mono text-sm text-ink-100">{group.name}</div>
      </header>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Color</div>
        <div className="grid grid-cols-8 gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => update('color', c)}
              className={`h-6 w-6 rounded border ${group.color === c ? 'ring-2 ring-accent' : 'border-ink-700'}`}
              title={c}
            >
              <div className="h-full w-full rounded" style={{ background: hex(c) }} />
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Icon</div>
        <select
          value={group.icon ?? ''}
          onChange={(e) => update('icon', e.target.value)}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs"
        >
          <option value="">(none)</option>
          {ICONS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Direction</div>
        <select
          value={group.direction ?? 'DOWN'}
          onChange={(e) => update('direction', e.target.value)}
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs"
        >
          <option value="DOWN">DOWN</option>
          <option value="RIGHT">RIGHT</option>
          <option value="UP">UP</option>
          <option value="LEFT">LEFT</option>
        </select>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Children</div>
        <div className="text-ink-400">{group.children.length} child{group.children.length === 1 ? '' : 'ren'}</div>
      </div>
    </div>
  );
}
