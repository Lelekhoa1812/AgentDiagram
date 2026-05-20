'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '@/components/shell/TopBar';
import { MonacoPanel } from '@/components/editor/MonacoPanel';
import { ExampleLoader } from '@/components/editor/ExampleLoader';
import { DiagramCanvas, type DiagramCanvasHandle } from '@/components/diagram/DiagramCanvas';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { AgentPanel } from '@/components/agent/AgentPanel';
import { MultiLayerPanel } from '@/components/multilayer/MultiLayerPanel';
import { LayerNavigator } from '@/components/multilayer/LayerNavigator';
import { useDiagramStore } from '@/lib/state/store';
import { downloadPng } from '@/lib/export/png';
import { downloadSvg } from '@/lib/export/svg';
import flowExample from '../examples/flow.txt';

export default function Page() {
  const mode = useDiagramStore((s) => s.mode);
  const theme = useDiagramStore((s) => s.theme);
  const dsl = useDiagramStore((s) => s.dslText);
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clearOverrides = useDiagramStore((s) => s.clearOverrides);
  const canvasRef = useRef<DiagramCanvasHandle>(null);
  const [isEditorVisible, setIsEditorVisible] = useState(true);
  const [isInspectorVisible, setIsInspectorVisible] = useState(true);

  // Seed with the Agentic RFQ example on first load.
  useEffect(() => {
    if (!dsl) setDsl(flowExample as unknown as string);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Motivation vs Logic: side panels are optional workspace tools, so the shell derives grid columns from visibility state instead of leaving collapsed panels mounted with inert width.
  const editorGridColumns = useMemo(
    () =>
      [
        isEditorVisible ? 'minmax(320px, 420px)' : null,
        'minmax(0, 1fr)',
        isInspectorVisible ? 'minmax(280px, 340px)' : null,
      ]
        .filter(Boolean)
        .join(' '),
    [isEditorVisible, isInspectorVisible],
  );

  // Motivation vs Logic: the shell owns product-level theming and fixed workspace regions so editor, canvas, and inspector read as one enterprise workbench while the canvas remains layout-contained.
  return (
    <div data-theme={theme} className="flex h-screen flex-col overflow-hidden bg-ink-950 text-ink-100 surface-transition">
      <TopBar
        onExportPng={onExportPng}
        onExportSvg={onExportSvg}
        onResetLayout={onResetLayout}
        onFitView={onFitView}
        isEditorVisible={isEditorVisible}
        isInspectorVisible={isInspectorVisible}
        onToggleEditor={() => setIsEditorVisible((value) => !value)}
        onToggleInspector={() => setIsInspectorVisible((value) => !value)}
      />

      {mode === 'editor' ? (
        <main className="grid min-h-0 flex-1 bg-ink-950" style={{ gridTemplateColumns: editorGridColumns }}>
          {isEditorVisible && (
            <section className="flex min-w-0 flex-col border-r border-ink-700/80 bg-ink-900">
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
          {isInspectorVisible && (
            <aside className="min-w-0 border-l border-ink-700/80 bg-ink-900">
              <InspectorPanel />
            </aside>
          )}
        </main>
      ) : mode === 'multi-layer' ? (
        // Root Cause vs Logic: Multi Layer was reachable from the toggle but fell through to AgentPanel, so the dedicated pipeline UI never mounted. Keep it as an explicit shell branch while editor remains the rendering destination for generated layers.
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <MultiLayerPanel />
        </main>
      ) : (
        <main className="flex-1 min-h-0 overflow-hidden bg-ink-950">
          <AgentPanel />
        </main>
      )}
    </div>
  );
}
