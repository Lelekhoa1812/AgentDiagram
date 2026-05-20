'use client';

import { useRef, useState } from 'react';
import { useDiagramStore } from '@/lib/state/store';
import { ProviderConfig } from './ProviderConfig';
import { RepoInput } from './RepoInput';
import { DiagramTypePicker } from './DiagramTypePicker';
import { FocusPromptBox } from './FocusPromptBox';
import { AnalysisAnimation } from './AnalysisAnimation';
import { readAgentStream, readErrorMessage, type AgentStreamEvent } from './streamEvents';

interface ScanResult {
  resolved: string;
  fileCount: number;
}

export function AgentPanel() {
  const provider = useDiagramStore((s) => s.provider);
  const kind = useDiagramStore((s) => s.diagramType);
  const focus = useDiagramStore((s) => s.focusPrompt);
  const setMode = useDiagramStore((s) => s.setMode);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const setAgentStage = useDiagramStore((s) => s.setAgentStage);
  const pushLog = useDiagramStore((s) => s.pushAgentLog);
  const startAgent = useDiagramStore((s) => s.startAgent);
  const stopAgent = useDiagramStore((s) => s.stopAgent);
  const agentRunning = useDiagramStore((s) => s.agentRunning);

  const [rootPath, setRootPath] = useState<string>('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [retryNotice, setRetryNotice] = useState<{ stage: string; attempt: number; delayMs: number; reason: string } | null>(null);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [terminalState, setTerminalState] = useState<{ status: 'failed' | 'cancelled'; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onStart = async () => {
    if (!rootPath) {
      pushLog({ stage: 'init', level: 'error', message: 'Choose a repo path first' });
      return;
    }
    const sessionId = `s-${Date.now()}`;
    startAgent(sessionId);
    setCounters({});
    setRetryNotice(null);
    setTerminalState(null);
    let sawResult = false;
    let sawFailure = false;

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: provider.provider === 'foundry' ? provider.customModel ?? '' : provider.model,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
          rootPath,
          kind,
          focus,
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const message = await readErrorMessage(res);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
        return;
      }

      await readAgentStream(res.body, handleEvent);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        sawFailure = true;
        setTerminalState({ status: 'cancelled', message: 'Cancelled' });
        pushLog({ stage: 'init', level: 'info', message: 'Cancelled' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        sawFailure = true;
        setTerminalState({ status: 'failed', message });
        pushLog({ stage: 'init', level: 'error', message });
      }
    } finally {
      if (!sawResult && !sawFailure && !ac.signal.aborted) {
        setTerminalState({ status: 'failed', message: 'Analysis ended before a diagram was produced.' });
      }
      stopAgent();
      abortRef.current = null;
    }

    function handleEvent(ev: AgentStreamEvent) {
      if (ev.type === 'stage') {
        setAgentStage(ev.stage);
        if (ev.counters) setCounters((c) => ({ ...c, ...ev.counters }));
        if (ev.message)
          pushLog({ stage: ev.stage, level: 'info', message: `${ev.status}: ${ev.message}` });
      } else if (ev.type === 'retry') {
        setRetryNotice({ stage: ev.stage, attempt: ev.attempt, delayMs: ev.delayMs, reason: ev.reason });
        pushLog({
          stage: ev.stage,
          level: 'warn',
          message: `retry #${ev.attempt} in ${Math.round(ev.delayMs / 1000)}s — ${ev.reason}`,
        });
      } else if (ev.type === 'log') {
        pushLog({ stage: ev.stage, level: ev.level, message: ev.message });
      } else if (ev.type === 'error') {
        sawFailure = true;
        setTerminalState({ status: 'failed', message: ev.message });
        pushLog({ stage: ev.stage, level: 'error', message: ev.message });
      } else if (ev.type === 'result') {
        sawResult = true;
        setDsl(ev.dsl);
        setMode('editor');
      } else if (ev.type === 'done') {
        setAgentStage(null);
      }
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <>
      <div className="grid h-full grid-cols-[1fr] gap-4 overflow-y-auto p-6 lg:grid-cols-2">
        <ProviderConfig />
        <RepoInput onScan={(path, result) => { setRootPath(path); setScan({ resolved: result.resolved, fileCount: result.fileCount }); }} />
        <DiagramTypePicker />
        <FocusPromptBox />

        <div className="col-span-full flex items-center justify-between gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
          <div className="text-xs text-ink-400">
            {scan ? (
              <>
                Ready to analyze <span className="font-mono text-ink-200">{scan.resolved}</span> ({scan.fileCount} files)
                {' · '}
                <span className="capitalize">{kind}</span>
                {' · '}
                <span>
                  {provider.provider}/{provider.provider === 'foundry' ? provider.customModel ?? '?' : provider.model}
                </span>
              </>
            ) : (
              'Configure provider + preview repo to enable analysis'
            )}
          </div>
          <button
            disabled={!scan || agentRunning}
            onClick={onStart}
            className="rounded-md border border-accent/50 bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {agentRunning ? 'Analyzing…' : 'Generate diagram'}
          </button>
        </div>
      </div>

      {(agentRunning || terminalState) && (
        <AnalysisAnimation
          retryNotice={retryNotice}
          counters={counters}
          onCancel={onCancel}
          onDismiss={() => setTerminalState(null)}
          terminalState={terminalState}
        />
      )}
    </>
  );
}
