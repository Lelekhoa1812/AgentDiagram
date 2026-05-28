'use client';

import { Archive, History, Pencil, Trash2 } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import type { CodeSpaceAgentSession } from '@/lib/code-space/core';
import { CollapsibleSection } from './CollapsibleSection';

interface SessionListSectionProps {
  sessions: CodeSpaceAgentSession[];
  activeSessionId: string | null;
  activeProjectName?: string;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (session: CodeSpaceAgentSession) => void;
  onDeleteSession: (session: CodeSpaceAgentSession) => void;
}

function buildSessionSubtitle(session: CodeSpaceAgentSession): string {
  const lastMessage = [...session.messages].reverse().find((message) => message.content.trim());
  if (lastMessage) {
    return lastMessage.content.replace(/\s+/g, ' ').slice(0, 72);
  }
  return session.status;
}

export function SessionListSection({
  sessions,
  activeSessionId,
  activeProjectName,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: SessionListSectionProps) {
  return (
    <CollapsibleSection
      title="Session"
      defaultOpen={false}
      compact
      rightSlot={
        <div className="flex items-center gap-2">
          {activeProjectName ? (
            <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-accent">
              {activeProjectName}
            </span>
          ) : null}
          <span className="text-[9px] text-[#6d6d6d]">{sessions.length}</span>
        </div>
      }
    >
      <div className="max-h-64 overflow-y-auto rounded border border-[#2a2a2a] bg-[#111111] p-1">
        {sessions.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-[#8b8b8b]">No sessions yet.</div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const subtitle = buildSessionSubtitle(session);
            const handleSelect = () => onSelectSession(session.id);
            const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectSession(session.id);
              }
            };

            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={handleSelect}
                onKeyDown={handleKeyDown}
                aria-current={isActive ? 'true' : undefined}
                className={`group mb-1 flex items-start justify-between rounded border px-2 py-2 text-[12px] ${
                  isActive ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-[#2a2a2a] hover:bg-[#1b1b1b]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {session.archived && <Archive size={12} className="text-[#8b8b8b]" />}
                    <div className="truncate font-medium text-[#d4d4d4]">{session.title}</div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#8b8b8b]">
                    <History size={11} />
                    <span>{session.archived ? 'archived' : session.status}</span>
                    <span>·</span>
                    <span>{new Date(session.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 truncate text-[10px] text-[#6d6d6d]">{subtitle}</div>
                </div>
                <div className="ml-3 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRenameSession(session);
                    }}
                    className="rounded border border-transparent px-1.5 text-[#8b8b8b] hover:border-[#3a3a3a] hover:text-[#d4d4d4]"
                    title="Rename session"
                    aria-label="Rename session"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteSession(session);
                    }}
                    className="rounded border border-transparent px-1.5 text-[#8b8b8b] hover:border-[#3a3a3a] hover:text-[#d4d4d4]"
                    title="Delete session"
                    aria-label="Delete session"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </CollapsibleSection>
  );
}
