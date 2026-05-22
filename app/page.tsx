'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '@/components/shell/TopBar';
import { MonacoPanel } from '@/components/editor/MonacoPanel';
import { ExampleLoader } from '@/components/editor/ExampleLoader';
import { DiagramCanvas, type DiagramCanvasHandle } from '@/components/diagram/DiagramCanvas';
import { InspectorWorkspacePanel } from '@/components/inspector/InspectorWorkspacePanel';
import { AgentPanel } from '@/components/agent/AgentPanel';
import { CustomPromptPanel } from '@/components/agent/CustomPromptPanel';
import { MultiLayerPanel } from '@/components/multilayer/MultiLayerPanel';
import { LayerNavigator } from '@/components/multilayer/LayerNavigator';
import { useDiagramStore } from '@/lib/state/store';
import { readUiPreferences, writeUiPreference } from '@/lib/state/uiPreferences';
import { downloadPng } from '@/lib/export/png';
import { downloadSvg } from '@/lib/export/svg';
import flowExample from '../examples/flow.txt';

export default function Page() {
  const mode = useDiagramStore((s) => s.mode);
  const theme = useDiagramStore((s) => s.theme);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);
  const hydrateUiPreferences = useDiagramStore((s) => s.hydrateUiPreferences);
  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const [isEditorVisible, setIsEditorVisible] = useState(true);
  const [isInspectorVisible, setIsInspectorVisible] = useState(true);
  const [isCompactShell, setIsCompactShell] = useState(false);
  const [compactFocus, setCompactFocus] = useState<'editor' | 'workspace'>('editor');

  useEffect(() => {
    hydrateUiPreferences();
    const preferences = readUiPreferences();
    if (typeof preferences.isEditorVisible === 'boolean') setIsEditorVisible(preferences.isEditorVisible);
    if (typeof preferences.isInspectorVisible === 'boolean') setIsInspectorVisible(preferences.isInspectorVisible);
  }, [hydrateUiPreferences]);

  // Seed with the flow example only when there is truly no saved content.
  // Reading directly from localStorage avoids the closure-stale-value trap:
  // hydrateUiPreferences() (in the preceding effect) updates the Zustand store
  // but React hasn't re-rendered yet, so we read the persisted preference
  // directly instead of relying on the stale `dsl` value from the first render.
  useEffect(() => {
    if (!readUiPreferences().dslText) setDsl(flowExample as unknown as string);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1535px)');
    const update = () => setIsCompactShell(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const onExportPng = useCallback(async () => {
    const svg = canvasRef.current?.getSvg();
    if (!svg) return;
    await downloadPng(svg, 'diagram.png', { scale: 2, includeBackground: true });
  }, []);

  const onExportSvg = useCallback(() => {
    const svg = canvasRef.current?.getSvg();
    if (!svg) return;
    downloadSvg(svg, 'diagram.svg', { includeBackground: true });
  }, []);

  const onResetLayout = useCallback(() => {
    clearOverrides();
    setTimeout(() => canvasRef.current?.fitView(), 50);
  }, [clearOverrides]);

  const onFitView = useCallback(() => {
    canvasRef.current?.fitView();
  }, []);

  const onToggleEditor = useCallback(() => {
    if (isCompactShell) {
      if (isEditorVisible && isInspectorVisible && compactFocus === 'editor') {
        setIsEditorVisible(false);
        writeUiPreference('isEditorVisible', false);
        return;
      }
      setIsEditorVisible(true);
      writeUiPreference('isEditorVisible', true);
      setCompactFocus('editor');
      return;
    }
    setIsEditorVisible((value) => {
      const next = !value;
      writeUiPreference('isEditorVisible', next);
      return next;
    });
  }, [compactFocus, isCompactShell, isEditorVisible, isInspectorVisible]);

  const onToggleInspector = useCallback(() => {
    if (isCompactShell) {
      if (isEditorVisible && isInspectorVisible && compactFocus === 'workspace') {
        setIsInspectorVisible(false);
        writeUiPreference('isInspectorVisible', false);
        return;
      }
      setIsInspectorVisible(true);
      writeUiPreference('isInspectorVisible', true);
      setCompactFocus('workspace');
      return;
    }
    setIsInspectorVisible((value) => {
      const next = !value;
      writeUiPreference('isInspectorVisible', next);
      return next;
    });
  }, [compactFocus, isCompactShell, isEditorVisible, isInspectorVisible]);

  const showEditorPanel =
    isEditorVisible && (!isCompactShell || !isInspectorVisible || compactFocus === 'editor');
  const showInspectorPanel =
    isInspectorVisible && (!isCompactShell || !isEditorVisible || compactFocus === 'workspace');

  // Motivation vs Logic: once the viewport drops under the shared side-panel breakpoint, the shell keeps only one ancillary pane visible so the canvas stays dominant instead of squeezing three regions into unreadable slivers.
  const editorGridColumns = useMemo(
    () =>
      [
        showEditorPanel ? 'minmax(320px, 420px)' : null,
        'minmax(0, 1fr)',
        showInspectorPanel ? 'minmax(340px, 460px)' : null,
      ]
        .filter(Boolean)
        .join(' '),
    [showEditorPanel, showInspectorPanel],
  );

  // Motivation vs Logic: the shell owns product-level theming and fixed workspace regions so editor, canvas, and inspector read as one enterprise workbench while the canvas remains layout-contained.
  return (
    <div data-theme={theme} className="flex h-screen flex-col overflow-hidden bg-ink-950 text-ink-100 surface-transition">
      <TopBar
        onExportPng={onExportPng}
        onExportSvg={onExportSvg}
        onResetLayout={onResetLayout}
        onFitView={onFitView}
        isEditorVisible={showEditorPanel}
        isInspectorVisible={showInspectorPanel}
        onToggleEditor={onToggleEditor}
        onToggleInspector={onToggleInspector}
      />

      {mode === 'editor' ? (
        <main className="grid min-h-0 flex-1 bg-ink-950" style={{ gridTemplateColumns: editorGridColumns, gridTemplateRows: 'minmax(0, 1fr)' }}>
          {showEditorPanel && (
            <section className="flex min-w-0 min-h-0 overflow-hidden flex-col border-r border-ink-700/80 bg-ink-900">
              <div className="flex min-h-12 items-center justify-between border-b border-ink-700/80 bg-ink-850/80 px-3">
                <ExampleLoader />
              </div>
              <div className="flex-1 min-h-0">
                <MonacoPanel />
              </div>
            </section>
          )}
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <LayerNavigator />
            <div className="relative min-h-0 flex-1">
              <DiagramCanvas ref={canvasRef} />
            </div>
          </section>
          {showInspectorPanel && (
            <aside className="min-w-0 border-l border-ink-700/80 bg-ink-900">
              <InspectorWorkspacePanel diagramRef={canvasRef} />
            </aside>
          )}
        </main>
      ) : mode === 'multi-layer' ? (
        // Root Cause vs Logic: Multi Layer was reachable from the toggle but fell through to AgentPanel, so the dedicated pipeline UI never mounted. Keep it as an explicit shell branch while editor remains the rendering destination for generated layers.
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <MultiLayerPanel />
        </main>
      ) : mode === 'custom-prompt' ? (
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <CustomPromptPanel />
        </main>
      ) : (
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <AgentPanel />
        </main>
      )}
    </div>
  );
}
