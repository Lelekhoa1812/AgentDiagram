'use client';

import { useRef, useState } from 'react';
import { useDiagramStore, type MultiLayerOutput } from '@/lib/state/store';
import { ProviderConfig } from '@/components/agent/ProviderConfig';
import { RepoInput } from '@/components/agent/RepoInput';
import { FocusPromptBox } from '@/components/agent/FocusPromptBox';
import { AnalysisAnimation } from '@/components/agent/AnalysisAnimation';

export function MultiLayerPanel() {
  const provider = useDiagramStore((s) => s.provider);
  const focus = useDiagramStore((s) => s.focusPrompt);
  const setMode = useDiagramStore((s) => s.setMode);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const setMultiLayer = useDiagramStore((s) => s.setMultiLayer);
  const setActiveLayer = useDiagramStore((s) => s.setActiveLayer);
  const setAgentStage = useDiagramStore((s) => s.setAgentStage);
  const pushLog = useDiagramStore((s) => s.pushAgentLog);
  const startAgent = useDiagramStore((s) => s.startAgent);
  const stopAgent = useDiagramStore((s) => s.stopAgent);
  const agentRunning = useDiagramStore((s) => s.agentRunning);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);

  const [rootPath, setRootPath] = useState('');
  const [scanInfo, setScanInfo] = useState<{ resolved: string; fileCount: number } | null>(null);
  const [retryNotice, setRetryNotice] = useState<{ stage: string; attempt: number; delayMs: number; reason: string } | null>(null);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const abortRef = useRef<AbortController | null>(null);

  const onStart = async () => {
    if (!rootPath) {
      pushLog({ stage: 'init', level: 'error', message: 'Preview a repo path first' });
      return;
    }
    const sessionId = `ml-${Date.now()}`;
    startAgent(sessionId);
    setCounters({});
    setRetryNotice(null);
    setMultiLayer(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/agent/multilayer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: provider.provider === 'foundry' ? provider.customModel ?? '' : provider.model,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
          rootPath,
          focus,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text();
        pushLog({ stage: 'init', level: 'error', message: txt || `HTTP ${res.status}` });
        stopAgent();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';
        for (const block of lines) {
          if (!block.startsWith('data: ')) continue;
          try {
            handleEvent(JSON.parse(block.slice(6)));
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        pushLog({ stage: 'init', level: 'info', message: 'Cancelled' });
      } else {
        pushLog({ stage: 'init', level: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      stopAgent();
      abortRef.current = null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function handleEvent(ev: any) {
      if (ev.type === 'stage') {
        setAgentStage(ev.stage);
        if (ev.counters) setCounters((c) => ({ ...c, ...ev.counters }));
        if (ev.message) pushLog({ stage: ev.stage, level: 'info', message: `${ev.status}: ${ev.message}` });
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
        pushLog({ stage: ev.stage, level: 'error', message: ev.message });
      } else if (ev.type === 'result-multilayer') {
        const out = ev.output as MultiLayerOutput;
        setMultiLayer(out);
        clearOverrides();
        setActiveLayer('overview');
        setDsl(out.overview.dsl);
        // After receiving the result, switch to editor view so the user
        // immediately sees the rendered overview — the LayerNavigator
        // appears above it.
        setMode('editor');
      } else if (ev.type === 'done') {
        setAgentStage(null);
      }
    }
  };

  const onCancel = () => abortRef.current?.abort();

  return (
    <>
      <div className="grid h-full grid-cols-[1fr] gap-4 overflow-y-auto p-6 lg:grid-cols-2">
        <ProviderConfig />
        <RepoInput onScan={(path, info) => { setRootPath(path); setScanInfo({ resolved: info.resolved, fileCount: info.fileCount }); }} />
        <div className="space-y-2 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-xs">
          <div className="text-[10px] uppercase tracking-widest text-ink-400">Multi-Layer mode</div>
          <p className="text-ink-300">
            The agent decomposes your repo into <strong>3–10 cohesive layers</strong> (clients, edge, services, async,
            data, observability, …) and produces:
          </p>
          <ul className="list-disc pl-5 text-ink-400">
            <li>One <strong>Overview</strong> diagram showing layers + cross-layer flows.</li>
            <li>A dedicated <strong>sub-diagram per layer</strong> showing its internal components and one-hop boundaries.</li>
          </ul>
          <p className="text-ink-400">
            Same provider + retry semantics as Agentic Explorer; switch between the resulting diagrams via the layer
            navigator that appears in Code Editor mode after generation.
          </p>
        </div>
        <FocusPromptBox />

        <div className="col-span-full flex items-center justify-between gap-2 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
          <div className="text-xs text-ink-400">
            {scanInfo ? (
              <>
                Ready · <span className="font-mono text-ink-200">{scanInfo.resolved}</span>{' '}
                ({scanInfo.fileCount} files) · provider {provider.provider}/
                {provider.provider === 'foundry' ? provider.customModel ?? '?' : provider.model}
              </>
            ) : (
              'Configure provider + preview repo to enable multi-layer analysis'
            )}
          </div>
          <button
            disabled={!scanInfo || agentRunning}
            onClick={onStart}
            className="rounded-md border border-accent/50 bg-accent/20 px-4 py-2 text-sm text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {agentRunning ? 'Analyzing…' : 'Generate layered diagrams'}
          </button>
        </div>
      </div>

      {agentRunning && (
        <AnalysisAnimation
          retryNotice={retryNotice}
          counters={counters}
          onCancel={onCancel}
          stages={[
            { id: 'validate', label: 'Validating credentials' },
            { id: 'scan', label: 'Scanning repository' },
            { id: 'classify', label: 'Selecting relevant files' },
            { id: 'context', label: 'Reading docs + import graph' },
            { id: 'summarize', label: 'Summarizing modules' },
            { id: 'layers', label: 'Identifying layers' },
            { id: 'overview', label: 'Compiling overview' },
            { id: 'sub-plans', label: 'Generating layer diagrams' },
          ]}
        />
      )}
    </>
  );
}
