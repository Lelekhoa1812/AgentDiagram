'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bot, CheckCircle2, Loader2, XCircle, Zap } from 'lucide-react';
import type { CodeSpaceAgentSession, CodeSpaceMessage } from '@/lib/code-space/core';
import type { CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { AgentModeSelector } from './AgentModeSelector';
import { CollapsibleSection } from './CollapsibleSection';
import { SessionListSection } from './SessionListSection';
import { FileMentionInput } from './FileMentionInput';

interface AgentPanelProps {
  session: CodeSpaceAgentSession | null;
  sessions: CodeSpaceAgentSession[];
  isRunning: boolean;
  toolBudget: number;
  pendingDiffs: Array<{
    diffId: string;
    filePath: string;
    oldContent: string;
    newContent: string;
    explanation?: string;
    unifiedDiff?: string;
  }>;
  providerSummary: string;
  agentMode: CodeSpaceAgentMode;
  onOpenModelConfig: () => void;
  onGenerateDiagram: () => void;
  onOpenAppPlanner: () => void;
  onAgentModeChange: (mode: CodeSpaceAgentMode) => void;
  canGenerateDiagram: boolean;
  onSelectSession: (sessionId: string | null) => void;
  onRenameSession: (session: CodeSpaceAgentSession) => void;
  onDeleteSession: (session: CodeSpaceAgentSession) => void;
  onSubmitPrompt: (prompt: string) => void;
  onCancelRun: () => void;
  onAcceptDiff: (diffId: string) => void;
  onRejectDiff: (diffId: string) => void;
  filePaths?: string[];
}

function renderMessageText(message: CodeSpaceMessage) {
  return message.content.trim() || ' ';
}

function formatToolPreview(value: unknown) {
  try {
    const serialized = JSON.stringify(value, null, 1);
    return serialized ? (serialized.length > 240 ? `${serialized.slice(0, 240)}…` : serialized) : 'undefined';
  } catch {
    return String(value);
  }
}

export function AgentPanel({
  session,
  sessions,
  isRunning,
  toolBudget,
  pendingDiffs,
  providerSummary,
  agentMode,
  onOpenModelConfig,
  onGenerateDiagram,
  onOpenAppPlanner,
  onAgentModeChange,
  canGenerateDiagram,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSubmitPrompt,
  onCancelRun,
  onAcceptDiff,
  onRejectDiff,
  filePaths = [],
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);

  const toolCalls = session?.toolCalls ?? [];
  const toolCallCount = session?.toolCallCount ?? 0;

  const budgetPct = toolBudget > 0 ? Math.min((toolCallCount / toolBudget) * 100, 100) : 0;

  const chatEntries = useMemo(() => {
    return (session?.messages ?? []).map((message, index) => ({
      key: message.id ?? `${message.role}:${index}`,
      message,
    }));
  }, [session?.messages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, isRunning]);

  useEffect(() => {
    setExpandedTools(new Set());
  }, [session?.id]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || isRunning) return;
    onSubmitPrompt(value);
    setPrompt('');
  };

  return (
    <div className="flex h-full flex-col border-l border-[#30363d] bg-[#0d1117] text-xs font-mono text-[#e6edf3]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] px-3 py-2">
        <Bot size={14} className="text-[#58a6ff]" />
        <span className="text-[10px] uppercase tracking-wider text-[#8b949e]">Agent</span>
        <span className="ml-auto truncate text-[10px] text-[#6e7681]">{providerSummary}</span>
        <button
          type="button"
          onClick={onOpenModelConfig}
          className="text-[10px] text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]"
        >
          Model Configuration
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <SessionListSection
          sessions={sessions}
          activeSessionId={session?.id ?? null}
          onSelectSession={onSelectSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
        />

        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-[#2a2a2a] bg-[#111111] p-2">
          {chatEntries.length === 0 ? (
            <p className="mt-6 text-center text-[#6e7681]">Describe a task to get started</p>
          ) : (
            <div className="space-y-2">
              {chatEntries.map(({ key, message }) => (
                <div
                  key={key}
                  className={`rounded border px-2 py-1.5 ${
                    message.role === 'user'
                      ? 'border-[#1f6feb55] bg-[#1f6feb1f] text-[#e6edf3]'
                      : message.role === 'assistant'
                        ? 'border-[#30363d] bg-[#161b22] text-[#e6edf3]'
                        : message.role === 'tool'
                          ? 'border-[#30363d] bg-[#0f1720] text-[#9fb7cf]'
                          : 'border-[#30363d] bg-[#151515] text-[#8b949e]'
                  }`}
                >
                  <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-widest text-[#6e7681]">
                    {message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : message.role}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[11px] leading-5">
                    {renderMessageText(message)}
                  </div>
                </div>
              ))}
              {isRunning && (
                <div className="flex items-center gap-2 text-[10px] text-[#8b949e]">
                  <Loader2 size={12} className="animate-spin" />
                  <span>Running in {session?.title ?? 'new session'}…</span>
                </div>
              )}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <CollapsibleSection
          title="Plan"
          rightSlot={<span className="text-[10px] text-[#6d6d6d]">{session?.plan.length ?? 0}</span>}
        >
          <div className="space-y-1 rounded border border-[#2a2a2a] bg-[#111111] p-2">
            {session?.plan.length ? (
              session.plan.map((item, index) => (
                <div key={`${item}:${index}`} className="flex gap-2 text-[10px] leading-4 text-[#c9d1d9]">
                  <span className="text-[#6e7681]">{index + 1}.</span>
                  <span>{item}</span>
                </div>
              ))
            ) : (
              <p className="text-[10px] text-[#6e7681]">No visible plan yet</p>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="TODO"
          rightSlot={<span className="text-[10px] text-[#6d6d6d]">{session?.todos.filter((todo) => todo.done).length ?? 0}/{session?.todos.length ?? 0}</span>}
        >
          <div className="space-y-1 rounded border border-[#2a2a2a] bg-[#111111] p-2">
            {session?.todos.length ? (
              session.todos.map((todo) => (
                <div key={todo.id} className="flex items-start gap-2 text-[10px] leading-4">
                  <span className={todo.done ? 'text-[#3fb950]' : 'text-[#8b949e]'}>{todo.done ? '✓' : '○'}</span>
                  <span className={todo.done ? 'text-[#8b949e] line-through' : 'text-[#c9d1d9]'}>{todo.text}</span>
                </div>
              ))
            ) : (
              <p className="text-[10px] text-[#6e7681]">TODOs appear after planning starts</p>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Review"
          rightSlot={<span className="text-[10px] text-[#6d6d6d]">{pendingDiffs.length}</span>}
        >
          <div className="space-y-2 rounded border border-[#2a2a2a] bg-[#111111] p-2">
            {pendingDiffs.length ? (
              pendingDiffs.map((diff) => (
                <div key={diff.diffId} className="rounded border border-[#30363d] bg-[#0f1114]">
                  <div className="flex items-center gap-2 border-b border-[#1f1f1f] px-2 py-1">
                    <span className="truncate text-[10px] text-[#e6edf3]">{diff.filePath}</span>
                    <span className="ml-auto text-[9px] uppercase tracking-wider text-[#f0883e]">approval required</span>
                  </div>
                  {diff.explanation && <p className="px-2 pt-2 text-[10px] leading-4 text-[#8b949e]">{diff.explanation}</p>}
                  <pre className="max-h-48 overflow-auto px-2 py-2 text-[9px] leading-4 text-[#c9d1d9]">
                    {diff.unifiedDiff ?? `${diff.oldContent}\n---\n${diff.newContent}`}
                  </pre>
                  <div className="flex justify-end gap-2 border-t border-[#1f1f1f] px-2 py-1.5">
                    <button type="button" onClick={() => onRejectDiff(diff.diffId)} className="rounded border border-[#30363d] px-2 py-1 text-[10px] text-[#f85149] hover:bg-[#2d1517]">
                      Reject
                    </button>
                    <button type="button" onClick={() => onAcceptDiff(diff.diffId)} className="rounded bg-[#238636] px-2 py-1 text-[10px] text-white hover:bg-[#2ea043]">
                      Apply
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-[10px] text-[#6e7681]">Patch proposals will require approval here</p>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Validation"
          rightSlot={<span className="text-[10px] text-[#6d6d6d]">{session?.verificationResults.length ?? 0}</span>}
        >
          <div className="space-y-1 rounded border border-[#2a2a2a] bg-[#111111] p-2">
            {session?.verificationResults.length ? (
              session.verificationResults.map((result) => (
                <div key={result.id} className="rounded border border-[#1f1f1f] bg-[#0f1114] px-2 py-1">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className={result.status === 'passed' ? 'text-[#3fb950]' : result.status === 'failed' ? 'text-[#f85149]' : 'text-[#f0883e]'}>
                      {result.status}
                    </span>
                    <span className="truncate text-[#c9d1d9]">{result.command}</span>
                  </div>
                  {result.output && <pre className="mt-1 max-h-24 overflow-auto text-[9px] leading-4 text-[#8b949e]">{result.output}</pre>}
                </div>
              ))
            ) : (
              <p className="text-[10px] text-[#6e7681]">Validation output will stream here</p>
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="Tool"
          rightSlot={<span className="text-[10px] text-[#6d6d6d]">{toolCallCount}/{toolBudget}</span>}
        >
          <div className="rounded border border-[#2a2a2a] bg-[#111111] p-2">
            <div className="mb-2 rounded bg-[#21262d]">
              <div
                className="h-[3px] rounded bg-[#1f6feb] transition-all"
                style={{ width: `${budgetPct}%` }}
              />
            </div>
            {toolCalls.length === 0 ? (
              <p className="text-[10px] text-[#6e7681]">No tool calls yet</p>
            ) : (
              <div className="space-y-1">
                {toolCalls.map((toolCall) => (
                  <div key={toolCall.id} className="rounded border border-[#1f1f1f] bg-[#0f1114]">
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-[#161b22]"
                      onClick={() =>
                        setExpandedTools((prev) => {
                          const next = new Set(prev);
                          if (next.has(toolCall.id)) {
                            next.delete(toolCall.id);
                          } else {
                            next.add(toolCall.id);
                          }
                          return next;
                        })
                      }
                    >
                      {toolCall.status === 'running' ? (
                        <Loader2 size={10} className="animate-spin text-[#f0883e]" />
                      ) : toolCall.status === 'success' ? (
                        <CheckCircle2 size={10} className="text-[#3fb950]" />
                      ) : (
                        <XCircle size={10} className="text-[#f85149]" />
                      )}
                      <span
                        className={
                          toolCall.status === 'success'
                            ? 'text-[#8b949e]'
                            : toolCall.status === 'error'
                              ? 'text-[#f85149]'
                              : 'text-[#e6edf3]'
                        }
                      >
                        {toolCall.name}
                      </span>
                      {toolCall.durationMs !== undefined && (
                        <span className="ml-auto text-[#6e7681]">{toolCall.durationMs}ms</span>
                      )}
                    </button>
                    {expandedTools.has(toolCall.id) && (
                      <div className="space-y-1 border-t border-[#1f1f1f] px-2 py-2 text-[9px] text-[#8b949e]">
                        <div className="overflow-x-auto">
                          <span className="text-[#6e7681]">Input:</span> {formatToolPreview(toolCall.input)}
                        </div>
                        {toolCall.output !== undefined && (
                          <div className="overflow-x-auto">
                            <span className="text-[#6e7681]">Output:</span> {formatToolPreview(toolCall.output)}
                          </div>
                        )}
                        {toolCall.error && <div className="text-[#f85149]">Error: {toolCall.error}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>

      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-[#30363d] p-2">
        <div className="flex items-end gap-2">
          <FileMentionInput
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => {
              const value = prompt.trim();
              if (!value || isRunning) return;
              onSubmitPrompt(value);
              setPrompt('');
            }}
            filePaths={filePaths}
            disabled={isRunning}
            placeholder="Describe a task..."
          />
          {isRunning ? (
            <button
              type="button"
              onClick={onCancelRun}
              className="rounded bg-[#b91c1c] px-2 py-1 text-[10px] text-white"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!prompt.trim()}
              className="rounded bg-[#1f6feb] px-2 py-1 text-[10px] text-white disabled:opacity-40"
            >
              <Zap size={10} />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 px-1 text-[10px]">
          <button
            type="button"
            onClick={onGenerateDiagram}
            disabled={!canGenerateDiagram || isRunning}
            title={canGenerateDiagram ? 'Open the current project in Multi Layer mode' : 'Open a project first'}
            className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff] disabled:cursor-not-allowed disabled:text-[#6e7681] disabled:no-underline"
          >
            Generate Diagram
          </button>
          <button
            type="button"
            onClick={onOpenAppPlanner}
            className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]"
          >
            App Planner
          </button>
          <div>
            <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
          </div>
        </div>
      </form>
    </div>
  );
}
