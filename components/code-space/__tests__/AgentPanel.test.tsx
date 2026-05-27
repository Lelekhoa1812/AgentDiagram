import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPanel } from '../AgentPanel';
import type { CodeSpaceAgentSession } from '@/lib/code-space/core';
import type { CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import type { CodeSpaceExecutionPolicy } from '@/lib/code-space/executionPolicy';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function createSession(): CodeSpaceAgentSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Plan session',
    status: 'planning',
    mode: 'plan',
    messages: [],
    toolCalls: [],
    plan: [],
    clarifyingQuestions: [],
    planMarkdown: {
      filePath: '.agent/plans/session-1.md',
      content: '# Plan',
      createdAt: Date.now(),
    },
    todos: [],
    changesets: [],
    verificationResults: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    localCacheVersion: 0,
    toolBudget: 50,
    toolCallCount: 0,
    filesChanged: [],
    agentChangesets: [],
  };
}

function renderPanel(onOpenPlanFile = vi.fn()) {
  const session = createSession();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root?.render(
      <AgentPanel
        session={session}
        sessions={[session]}
        isRunning={false}
        toolBudget={50}
        pendingDiffs={[]}
        providerSummary="foundry/gpt-5-mini"
        agentMode={'plan' as CodeSpaceAgentMode}
        executionPolicy={'manual' as CodeSpaceExecutionPolicy}
        onOpenModelConfig={vi.fn()}
        onGenerateDiagram={vi.fn()}
        onOpenAppPlanner={vi.fn()}
        onAgentModeChange={vi.fn()}
        onExecutionPolicyChange={vi.fn()}
        canGenerateDiagram={false}
        onSelectSession={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onSubmitPrompt={vi.fn()}
        onCancelRun={vi.fn()}
        onAcceptDiff={vi.fn()}
        onRejectDiff={vi.fn()}
        onOpenPlanFile={onOpenPlanFile}
      />,
    );
  });

  return { container, onOpenPlanFile };
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('AgentPanel', () => {
  it('forwards View plan clicks to the open-plan handler', () => {
    const { container, onOpenPlanFile } = renderPanel();
    const viewPlanButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('View plan...'),
    );

    act(() => {
      viewPlanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenPlanFile).toHaveBeenCalledWith('.agent/plans/session-1.md');
  });
});
