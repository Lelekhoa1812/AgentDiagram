'use client';

import { useEffect, useState } from 'react';
import { useDiagramStore } from '@/lib/state/store';

const DEFAULT_STAGES: Array<{ id: string; label: string }> = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'scan', label: 'Scanning repository' },
  { id: 'classify', label: 'Selecting relevant files' },
  { id: 'context', label: 'Reading docs + import graph' },
  { id: 'summarize', label: 'Summarizing modules' },
  { id: 'subsystem', label: 'Discovering subsystems' },
  { id: 'plan', label: 'Generating diagram plan' },
  { id: 'compile', label: 'Compiling DSL' },
  { id: 'validate-dsl', label: 'Validating syntax' },
];

interface Props {
  retryNotice?: { stage: string; attempt: number; delayMs: number; reason: string } | null;
  counters?: Record<string, number>;
  onCancel?: () => void;
  stages?: Array<{ id: string; label: string }>;
}

export function AnalysisAnimation({ retryNotice, counters, onCancel, stages = DEFAULT_STAGES }: Props) {
  const stage = useDiagramStore((s) => s.agentStage);
  const log = useDiagramStore((s) => s.agentLog);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(t);
  }, []);

  const activeIdx = stages.findIndex((s) => s.id === stage);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 backdrop-blur-sm">
      <div className="w-[700px] max-w-[92vw] rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-ink-100">Analyzing repository</div>
            <div className="text-[11px] text-ink-400">Streaming live progress · cancel any time</div>
          </div>
          <button
            onClick={onCancel}
            className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs hover:bg-ink-700"
          >
            Cancel
          </button>
        </div>

        <div className="space-y-2">
          {stages.map((s, i) => {
            const done = i < activeIdx;
            const active = i === activeIdx;
            return (
              <div
                key={s.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                  active
                    ? 'stage-active border-accent/60 bg-accent/10'
                    : done
                      ? 'border-ink-700 bg-ink-800/40 text-ink-300'
                      : 'border-ink-800 bg-ink-900 text-ink-500'
                }`}
              >
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                    done
                      ? 'border-green-400/60 bg-green-400/20 text-green-300'
                      : active
                        ? 'border-accent bg-accent/30 text-accent'
                        : 'border-ink-700 bg-ink-800'
                  }`}
                >
                  {done ? '✓' : active ? <span className="h-2 w-2 rounded-full bg-accent animate-pulse" /> : i + 1}
                </div>
                <div className="flex-1 text-sm">{s.label}</div>
                {active && retryNotice?.stage === s.id && (
                  <span className="text-[11px] text-yellow-300">
                    Retrying in {Math.round(retryNotice.delayMs / 1000)}s (attempt {retryNotice.attempt})
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-400">
          <div>⏱ {elapsed}s</div>
          {counters?.files !== undefined && <div>📁 {counters.files} files</div>}
          {counters?.selected !== undefined && <div>★ {counters.selected} selected</div>}
          {counters?.docs !== undefined && <div>📄 {counters.docs} docs</div>}
          {counters?.externals !== undefined && <div>🔗 {counters.externals} externals</div>}
          {counters?.layers !== undefined && <div>🧱 {counters.layers} layers</div>}
          {counters?.done !== undefined && counters?.total !== undefined && (
            <div>✓ {counters.done}/{counters.total} summarized</div>
          )}
        </div>

        <details className="mt-3 rounded-lg border border-ink-700 bg-ink-950/40 p-2 text-[11px]">
          <summary className="cursor-pointer text-ink-400">Log</summary>
          <div className="mt-2 max-h-32 overflow-y-auto font-mono text-[11px]">
            {log.length === 0 ? (
              <div className="text-ink-500">No log entries yet.</div>
            ) : (
              log.slice(-60).map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === 'error'
                      ? 'text-red-300'
                      : l.level === 'warn'
                        ? 'text-yellow-300'
                        : 'text-ink-300'
                  }
                >
                  [{l.stage}] {l.message}
                </div>
              ))
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
