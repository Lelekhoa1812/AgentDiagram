'use client';

import { useState } from 'react';
import { flushSync } from 'react-dom';
import { AlertTriangle, RotateCw, Wand2, X } from 'lucide-react';
import { useDiagramStore } from '@/lib/state/store';
import { DSL_GRAMMAR_SUMMARY } from '@/lib/agent/promptBuilder';
import { compile } from '@/lib/dsl/compiler';
import { readAgentStream, readErrorMessage } from '../agent/streamEvents';

const MAX_FIX_ATTEMPTS = 3;

interface Props {
  errors: string[];
  onDismiss: () => void;
}

// NOTE: All colours here are hardcoded Tailwind slate/red values (not ink-*).
// ink-* remaps in light theme — ink-950 becomes near-white — making the banner
// invisible. Using slate-* guarantees contrast in both dark and light themes.

export function RenderErrorBanner({ errors, onDismiss }: Props) {
  const provider = useDiagramStore((s) => s.provider);
  const dsl = useDiagramStore((s) => s.dslText);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const [fixing, setFixing] = useState(false);
  const [fixStage, setFixStage] = useState('');
  const [fixAttempt, setFixAttempt] = useState(0);
  const [fixError, setFixError] = useState<string | null>(null);

  const currentModel =
    provider.provider === 'foundry' ? (provider.customModel ?? provider.model) : provider.model;

  const buildChangeDescription = (currentErrors: string[]) =>
    [
      'Fix DSL syntax and format errors so the diagram renders correctly.',
      'Do NOT add or remove nodes, groups, or edges — only correct syntax/format issues.',
      '',
      'DSL syntax reference:',
      DSL_GRAMMAR_SUMMARY.trim(),
      '',
      'Errors to fix:',
      ...currentErrors.map((e, i) => `${i + 1}. ${e}`),
    ].join('\n');

  const onAiFix = async () => {
    if (!dsl.trim() || fixing) return;

    // flushSync forces React to paint the loading state before any async work.
    // Without this, React 18 automatic batching merges setFixing(true) and
    // setFixing(false) into a single paint so the animation never appears.
    flushSync(() => {
      setFixing(true);
      setFixError(null);
      setFixStage('Initialising…');
      setFixAttempt(1);
    });

    let currentDsl = dsl;
    let currentErrors = [...errors];

    try {
      for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        flushSync(() => {
          setFixAttempt(attempt);
          setFixStage('Connecting to AI…');
        });

        const res = await fetch('/api/agent/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: provider.provider,
            model: currentModel,
            apiKey: provider.apiKey || undefined,
            endpoint: provider.endpoint || undefined,
            dsl: currentDsl,
            changeDescription: buildChangeDescription(currentErrors),
            answers: [],
          }),
        });

        if (!res.ok || !res.body) {
          const msg = await readErrorMessage(res);
          flushSync(() => setFixError(msg));
          return;
        }

        let resultDsl: string | null = null;
        let streamErr: string | null = null;

        await readAgentStream(res.body, (ev) => {
          if (ev.type === 'stage' && ev.status === 'start') {
            setFixStage(ev.message ?? ev.stage);
          } else if (ev.type === 'result') {
            resultDsl = ev.dsl;
          } else if (ev.type === 'error') {
            streamErr = ev.message;
          }
        });

        if (streamErr) {
          flushSync(() => setFixError(streamErr!));
          return;
        }
        if (!resultDsl) {
          flushSync(() => setFixError('AI did not return a fixed diagram.'));
          return;
        }

        // Compile the result to check whether errors remain.
        const diagram = compile(resultDsl);
        const remainingErrors = diagram.diagnostics
          .filter((d) => d.severity === 'error')
          .map((d) => `Line ${d.line}:${d.column} — ${d.message}`);

        if (remainingErrors.length === 0) {
          setDsl(resultDsl);
          return;
        }

        currentDsl = resultDsl;
        currentErrors = remainingErrors;

        if (attempt < MAX_FIX_ATTEMPTS) {
          flushSync(() =>
            setFixStage(
              `${remainingErrors.length} error(s) remain — retrying (${attempt + 1}/${MAX_FIX_ATTEMPTS})…`,
            ),
          );
          await new Promise<void>((r) => setTimeout(r, 800));
        }
      }

      // All attempts exhausted — apply best result and surface remaining count.
      setDsl(currentDsl);
      flushSync(() =>
        setFixError(
          `${currentErrors.length} error(s) persist after ${MAX_FIX_ATTEMPTS} fix attempt(s).`,
        ),
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const msg = err instanceof Error ? err.message : String(err);
        flushSync(() => setFixError(msg));
      }
    } finally {
      setFixing(false);
      setFixStage('');
    }
  };

  return (
    // slate-950 / slate-900 are hardcoded — ink-* flips to near-white in light theme
    <div className="absolute inset-x-3 top-3 z-20 rounded-xl border border-red-500/50 bg-slate-950/95 shadow-xl backdrop-blur-sm">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-red-400" />

        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-red-400">
            Diagram rendering error — DSL syntax/format issue detected
          </div>

          {/* Full error messages — no truncation */}
          <div className="mt-1 space-y-0.5">
            {errors.map((e, i) => (
              <div key={i} className="break-all font-mono text-[10px] text-slate-400">
                {e}
              </div>
            ))}
          </div>

          {/* Live fix progress — always dark regardless of app theme */}
          {fixing && (
            <div className="mt-2 rounded-md border border-slate-700/60 bg-slate-900/80 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  <span
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400"
                    style={{ animationDelay: '150ms' }}
                  />
                  <span
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-400"
                    style={{ animationDelay: '300ms' }}
                  />
                </div>
                <div className="flex-1 truncate text-[10px] text-slate-300">
                  {fixStage || 'Working…'}
                </div>
                {fixAttempt > 1 && (
                  <div className="flex-shrink-0 text-[9px] text-slate-500">
                    Attempt {fixAttempt}/{MAX_FIX_ATTEMPTS}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Error feedback box */}
          {fixError && !fixing && (
            <div className="mt-2 rounded-md border border-red-500/40 bg-red-950/60 px-2.5 py-1.5 text-[11px] text-red-300">
              {fixError}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onAiFix}
            disabled={fixing || !dsl.trim()}
            className="flex items-center gap-1.5 rounded-md border border-blue-500/50 bg-blue-500/20 px-2.5 py-1.5 text-[11px] text-blue-300 transition-colors hover:bg-blue-500/30 disabled:opacity-50"
          >
            {fixing ? (
              <>
                <RotateCw size={11} className="animate-spin" />
                Fixing…
              </>
            ) : (
              <>
                <Wand2 size={11} />
                AI Fix
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={fixing}
            className="rounded-md border border-slate-700 bg-slate-800 p-1.5 text-slate-400 transition-colors hover:bg-slate-700 disabled:opacity-40"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
