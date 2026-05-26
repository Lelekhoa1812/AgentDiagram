'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Loader2,
  MessageCircle,
  TerminalSquare,
} from 'lucide-react';
import type { CodeSpaceAgentSession, CodeSpaceBottomTab } from '@/lib/code-space/core';

interface BottomPanelProps {
  activeSession: CodeSpaceAgentSession | null;
  bottomActiveTab: CodeSpaceBottomTab;
  error: string | null;
  minimapEnabled: boolean;
  onToggleMinimap: () => void;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
  onTabChange: (tab: CodeSpaceBottomTab) => void;
  onHide: () => void;
  projectName: string;
  projectRoot?: string;
}

interface ProblemEntry {
  id: string;
  source: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  timestamp?: number;
}

interface TerminalEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  status: 'success' | 'error';
  timestamp: number;
}

const TAB_META: Record<CodeSpaceBottomTab, { label: string; icon: typeof AlertCircle }> = {
  problems: { label: 'Problems', icon: AlertTriangle },
  output: { label: 'Output', icon: TerminalSquare },
  debug: { label: 'Debug Console', icon: MessageCircle },
  terminal: { label: 'Terminal', icon: TerminalSquare },
};

const severityOrder: Record<ProblemEntry['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

const EMPTY_PLACEHOLDER = 'No events yet — run a prompt, tool, or command to fill this area.';

function splitCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === '\\' && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function randomId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

// Motivation vs Logic: Align the bottom console with Cursor's Problems/Output/Debug/Terminal workflow so
// each tab surface real diagnostics, logs, and terminal output instead of a single catch-all stream.
export function BottomPanel({
  activeSession,
  bottomActiveTab,
  error,
  minimapEnabled,
  onToggleMinimap,
  wordWrap,
  onToggleWordWrap,
  onTabChange,
  onHide,
  projectName,
  projectRoot,
}: BottomPanelProps) {
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [commandInput, setCommandInput] = useState('');

  const toolCalls = activeSession?.toolCalls ?? [];
  const verificationResults = activeSession?.verificationResults ?? [];
  const plan = activeSession?.plan ?? [];
  const todos = activeSession?.todos ?? [];
  const debugMessages = activeSession?.messages ?? [];

  const problems = useMemo<ProblemEntry[]>(() => {
    const entries: ProblemEntry[] = [];
    if (error) {
      entries.push({
        id: 'workspace-error',
        source: 'Workspace',
        severity: 'error',
        message: error,
        timestamp: Date.now(),
      });
    }
    toolCalls
      .filter((call) => call.status === 'error')
      .forEach((call) => {
        entries.push({
          id: call.id,
          source: call.name,
          severity: 'error',
          message: call.summary,
          timestamp: call.updatedAt,
        });
      });
    verificationResults.forEach((result) => {
      entries.push({
        id: result.id,
        source: result.command,
        severity: result.status === 'failed' ? 'error' : 'info',
        message: result.output,
        timestamp: Date.now(),
      });
    });
    todos
      .filter((todo) => !todo.done)
      .forEach((todo) => {
        entries.push({
          id: todo.id,
          source: 'Plan',
          severity: 'warning',
          message: `Pending: ${todo.text}`,
          timestamp: Date.now(),
        });
      });
    entries.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    return entries;
  }, [error, toolCalls, verificationResults, todos]);

  const problemsCount = problems.length;
  const outputCount = toolCalls.length;
  const debugCount = debugMessages.length;
  const terminalCount = terminalHistory.length;

  const handleTerminalSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectRoot) {
      setTerminalError('Open a project to run terminal commands.');
      return;
    }
    const trimmed = commandInput.trim();
    if (!trimmed || terminalBusy) return;
    const tokens = splitCommandLine(trimmed);
    if (!tokens.length) return;
    const [command, ...args] = tokens;
    setTerminalBusy(true);
    setTerminalError(null);
    try {
      const start = Date.now();
      const response = await fetch('/api/code-space/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: projectRoot, command, args }),
      });
      const payload = await response.json();
      const entry: TerminalEntry = {
        id: randomId(),
        command: trimmed,
        stdout: payload.stdout ?? '',
        stderr: payload.stderr ?? '',
        exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 1,
        status: response.ok ? 'success' : 'error',
        timestamp: Date.now(),
      };
      setTerminalHistory((current) => [...current, entry]);
      if (!response.ok) {
        setTerminalError(payload.error ?? 'Command failed');
      }
      setCommandInput('');
    } catch (err) {
      setTerminalHistory((current) => [
        ...current,
        {
          id: randomId(),
          command: trimmed,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
          status: 'error',
          timestamp: Date.now(),
        },
      ]);
      setTerminalError(err instanceof Error ? err.message : String(err));
    } finally {
      setTerminalBusy(false);
    }
  };

  const renderTabContent = () => {
    if (bottomActiveTab === 'problems') {
      return problems.length ? (
        <div className="space-y-2 text-sm">
          {problems.map((problem) => (
            <div
              key={problem.id}
              className="flex items-center justify-between rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2"
            >
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-[#9ea9b8]">
                  {problem.severity === 'error' ? (
                    <AlertCircle size={12} className="text-[#ff6565]" />
                  ) : (
                    <CheckCircle2 size={12} className="text-[#43b581]" />
                  )}
                  <span>{problem.source}</span>
                </div>
                <p className="text-[12px] text-[#d4d4d4]">{problem.message}</p>
              </div>
              <span className="text-[10px] text-[#7d7d7d]">
                {problem.timestamp ? new Date(problem.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-[#8b8b8b]">{EMPTY_PLACEHOLDER}</div>
      );
    }
    if (bottomActiveTab === 'output') {
      return toolCalls.length ? (
        <div className="space-y-2 text-[12px]">
          {toolCalls.map((call) => (
            <div key={call.id} className="rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-2 font-semibold uppercase tracking-wider text-[#8ca0c2]">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${call.status === 'error' ? 'bg-[#5c1616] text-[#ffadad]' : 'bg-[#1a4c28] text-[#6ee69c]'}`}>
                    {call.status.toUpperCase()}
                  </span>
                  <span>{call.name}</span>
                </div>
                <span className="text-[10px] text-[#6d6d6d]">
                  {new Date(call.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-[#d4d4d4]">{call.summary}</p>
              {(call.input || call.output) && (
                <div className="mt-2 space-y-1 text-[10px] text-[#8b8b8b]">
                  {call.input && (
                    <details className="rounded border border-[#2a2a2a] bg-[#151515] p-2">
                      <summary className="cursor-pointer">Input</summary>
                      <pre className="whitespace-pre-wrap text-[11px] text-[#c6d0e1]">
                        {JSON.stringify(call.input, null, 2)}
                      </pre>
                    </details>
                  )}
                  {call.output && (
                    <details className="rounded border border-[#2a2a2a] bg-[#151515] p-2">
                      <summary className="cursor-pointer">Output</summary>
                      <pre className="whitespace-pre-wrap text-[11px] text-[#c6d0e1]">
                        {JSON.stringify(call.output, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-[#8b8b8b]">No output yet. {EMPTY_PLACEHOLDER}</div>
      );
    }
    if (bottomActiveTab === 'debug') {
      return (
        <div className="space-y-3 text-[11px]">
          <section>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
              <span>Plan</span>
              <span>{plan.length} step{plan.length === 1 ? '' : 's'}</span>
            </div>
            {plan.length ? (
              <ol className="mt-1 space-y-1 pl-4 text-[#d4d4d4]">
                {plan.map((step, index) => (
                  <li key={`${step}:${index}`} className="marker:text-[#6d6d6d]">
                    {step}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-1 text-[#8b8b8b]">Add a prompt to start building a plan.</p>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
              <span>Todos</span>
              <span>{todos.filter((todo) => !todo.done).length} active</span>
            </div>
            {todos.length ? (
              <div className="mt-1 space-y-1 text-[#d4d4d4]">
                {todos.map((todo) => (
                  <div key={todo.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`h-3 w-3 rounded-full border ${todo.done ? 'border-[#3b8b3b] bg-[#3b8b3b]' : 'border-[#4a4a4a]'}`} />
                    <span className={todo.done ? 'text-[#6d6d6d]' : 'text-[#d4d4d4]'}>{todo.text}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[#8b8b8b]">Lifecycle tasks appear once you submit a prompt.</p>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
              <span>Messages</span>
              <span>{debugMessages.length}</span>
            </div>
            {debugMessages.length ? (
              <div className="mt-1 space-y-2 max-h-[120px] overflow-y-auto">
                {debugMessages.map((message) => (
                  <div key={message.id} className="rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2">
                    <div className="flex items-center justify-between text-[10px] text-[#6d6d6d]">
                      <div className="flex items-center gap-2">
                        {message.role === 'assistant' ? (
                          <Bot size={12} className="text-[#9ec3ff]" />
                        ) : (
                          <MessageCircle size={12} className="text-[#f3a3ff]" />
                        )}
                        <span className="uppercase tracking-widest">{message.role}</span>
                      </div>
                      <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-[#d4d4d4]">{message.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[#8b8b8b]">{EMPTY_PLACEHOLDER}</p>
            )}
          </section>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <form onSubmit={handleTerminalSubmit} className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-[#6d6d6d]">
            <span>Running under</span>
            <span className="text-[10px] text-[#8b8b8b]">{projectName}</span>
          </div>
          <input
            value={commandInput}
            onChange={(event) => setCommandInput(event.target.value)}
            disabled={terminalBusy || !projectRoot}
            placeholder={projectRoot ? 'e.g. git status' : 'Open a project to use the terminal'}
            className="rounded border border-[#2a2a2a] bg-[#151515] px-3 py-2 text-[12px] outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={terminalBusy || !commandInput.trim() || !projectRoot}
              className="flex items-center gap-1 rounded bg-accent/20 px-3 py-1 text-[12px] font-semibold text-accent disabled:opacity-40"
            >
              {terminalBusy ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin text-accent" />
                  Running…
                </>
              ) : (
                'Run'
              )}
            </button>
            <button
              type="button"
              onClick={() => setTerminalHistory([])}
              disabled={!terminalHistory.length}
              className="rounded border border-[#2a2a2a] px-3 py-1 text-[12px] text-[#8b8b8b] disabled:opacity-40"
            >
              Clear
            </button>
          </div>
          {terminalError && <p className="text-[11px] text-[#ff7b72]">{terminalError}</p>}
        </form>
        <div className="space-y-2">
          {terminalHistory.length ? (
            terminalHistory.map((entry) => (
              <div key={entry.id} className="rounded border border-[#2a2a2a] bg-[#0f0f0f] p-2 text-[11px]">
                <div className="flex items-center justify-between text-[10px] text-[#6d6d6d]">
                  <span className="font-mono text-[11px] text-[#d4d4d4]">{entry.command}</span>
                  <span className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${entry.status === 'success' ? 'bg-[#1a4c28] text-[#76f59e]' : 'bg-[#5c1616] text-[#ffb3b3]'}`}>
                      {entry.status === 'success' ? `exit ${entry.exitCode}` : 'error'}
                    </span>
                    <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                </div>
                {entry.stdout && (
                  <pre className="mt-2 whitespace-pre-wrap text-[11px] text-[#c6d0e1]">{entry.stdout}</pre>
                )}
                {entry.stderr && (
                  <pre className="mt-1 whitespace-pre-wrap text-[11px] text-[#ffb3b3]">{entry.stderr}</pre>
                )}
              </div>
            ))
          ) : (
            <p className="text-[12px] text-[#8b8b8b]">Run a command to bootstrap the terminal history.</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-52 border-t border-[#2a2a2a] bg-[#121212]">
      <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] px-3">
        <div className="flex items-center gap-2">
          {Object.entries(TAB_META).map(([id, { label, icon: Icon }]) => {
            const tabId = id as CodeSpaceBottomTab;
            const count =
              tabId === 'problems'
                ? problemsCount
                : tabId === 'output'
                ? outputCount
                : tabId === 'debug'
                ? debugCount
                : terminalCount;
            return (
              <button
                key={tabId}
                type="button"
                onClick={() => onTabChange(tabId)}
                aria-pressed={bottomActiveTab === tabId}
                className={`flex items-center gap-1 rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition ${
                  bottomActiveTab === tabId
                    ? 'bg-[#171717] text-white'
                    : 'text-[#8c8c8c] hover:text-white'
                }`}
              >
                {/* Root Cause vs Logic: lucide icons are React components, not plain functions, so render via JSX. */}
                <Icon
                  size={14}
                  className={bottomActiveTab === tabId ? 'text-white' : 'text-[#8c8c8c]'}
                />
                <span>
                  {label}
                  <span className="ml-1 text-[10px] text-[#6d6d6d]">({count})</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-[#8c8c8c]">
          <span className="rounded-full border border-[#2a2a2a] px-2 py-0.5 text-[10px] uppercase">{activeSession?.status ?? 'idle'}</span>
          <button type="button" onClick={onToggleMinimap} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#8c8c8c] hover:text-white">
            Minimap {minimapEnabled ? 'On' : 'Off'}
          </button>
          <button type="button" onClick={onToggleWordWrap} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#8c8c8c] hover:text-white">
            Wrap {wordWrap ? 'On' : 'Off'}
          </button>
          <button type="button" onClick={onHide} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#8c8c8c] hover:text-white">
            Hide
          </button>
        </div>
      </div>
      <div className="h-[calc(100%-2.25rem)] overflow-auto p-3 text-[12px] text-[#d4d4d4]">{renderTabContent()}</div>
    </div>
  );
}
