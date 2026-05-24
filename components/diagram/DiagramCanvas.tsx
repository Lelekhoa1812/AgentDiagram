'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDiagramStore } from '@/lib/state/store';
import { compile } from '@/lib/dsl/compiler';
import { runLayout } from '@/lib/layout/strategies';
import { buildScene, type SceneResult } from '@/lib/render/svgScene';
import type { LayoutResult } from '@/lib/layout/elk';
import type { Point } from '@/lib/ir/types';
import { edgeLaneOffsets, routeEdgePath } from '@/lib/render/edgePath';
import { RenderErrorBanner } from './RenderErrorBanner';

const LAYOUT_TIMEOUT_MS = 5_000;

// ELK's network-simplex algorithm throws "Invalid array length" when the edge
// count inside a compound graph exceeds its internal matrix capacity. The limit
// below is conservative so that we bail out gracefully before the worker dies.
const ELK_EDGE_LIMIT = 80;

// ELK's network-simplex crashes on compound graphs with many cross-group edges
// even when the raw edge count is below ELK_EDGE_LIMIT. The product of group
// count × edge count is a proxy for cross-hierarchy edge density; empirically
// diagrams with 7 groups × 37 edges (= 259) reliably crash the worker.
const ELK_COMPLEXITY_LIMIT = 200;

export interface DiagramCanvasHandle {
  getSvg: () => SVGSVGElement | null;
  fitView: () => void;
}

interface DragState {
  kind: 'pan' | 'node' | 'group' | 'edge-segment';
  id?: string;
  start: { x: number; y: number };
  origin: { x: number; y: number; scale: number };
  startRect?: { x: number; y: number; width: number; height: number };
  descendantStarts?: Record<string, { x: number; y: number }>;
  edgeSegmentIndex?: number;
  edgeSegmentAxis?: 'horizontal' | 'vertical';
  edgeRouteStart?: Point[];
}

const PAD = 32;

export const DiagramCanvas = forwardRef<DiagramCanvasHandle>(function DiagramCanvas(_, ref) {
  const dsl = useDiagramStore((s) => s.dslText);
  const overrides = useDiagramStore((s) => s.overrides);
  const setOverride = useDiagramStore((s) => s.setOverride);
  const selection = useDiagramStore((s) => s.selection);
  const setSelection = useDiagramStore((s) => s.setSelection);
  const setDiagram = useDiagramStore((s) => s.setDiagram);
  const setLayoutResult = useDiagramStore((s) => s.setLayoutResult);
  const strategy = useDiagramStore((s) => s.layoutStrategy);
  const theme = useDiagramStore((s) => s.theme);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<DragState | null>(null);
  const [isLayingOut, setIsLayingOut] = useState(false);

  const diagram = useMemo(() => {
    try {
      return compile(dsl, dsl);
    } catch (err) {
      // Compile threw unexpectedly — surface as a single error diagnostic so the
      // error banner appears instead of crashing the component tree.
      const msg = err instanceof Error ? err.message : String(err);
      return compile(`// render-error: ${msg}`, `// render-error: ${msg}`);
    }
  }, [dsl]);
  useEffect(() => setDiagram(diagram), [diagram, setDiagram]);

  const layoutRef = useRef<LayoutResult | null>(null);
  const [scene, setScene] = useState<SceneResult | null>(null);
  const [renderErrors, setRenderErrors] = useState<string[]>([]);
  const [renderErrorsDismissed, setRenderErrorsDismissed] = useState(false);

  // Reset dismissed state whenever the DSL changes so fresh errors surface again.
  useEffect(() => {
    setRenderErrorsDismissed(false);
  }, [diagram]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Bail out early if the compiler already found hard errors — running ELK
      // on a structurally broken diagram can hang the main thread indefinitely.
      const compileErrors = diagram.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `Line ${d.line}:${d.column} — ${d.message}`);

      if (compileErrors.length > 0) {
        if (!cancelled) {
          setScene(null);
          setLayoutResult(null);
          setRenderErrors(compileErrors);
          setIsLayingOut(false);
        }
        return;
      }

      // Guard against the "Invalid array length" RangeError that ELK's
      // network-simplex algorithm throws on graphs with too many edges.
      // Bail out before the worker even starts so the page stays responsive.
      if (diagram.edges.length > ELK_EDGE_LIMIT) {
        if (!cancelled) {
          setScene(null);
          setLayoutResult(null);
          setRenderErrors([
            `Diagram has ${diagram.edges.length} edges — ELK layout cannot safely process more than ${ELK_EDGE_LIMIT}. ` +
              `Remove redundant or cross-group edges, split the diagram into smaller sub-diagrams, or use AI Fix to simplify.`,
          ]);
          setIsLayingOut(false);
        }
        return;
      }

      // Guard against cross-group edge density that crashes ELK's network-simplex
      // even when raw edge count looks acceptable. The product of group count ×
      // edge count is a reliable proxy: 7 groups × 37 edges = 259 > 200 → crash.
      const elkComplexity = diagram.groups.length * diagram.edges.length;
      if (elkComplexity > ELK_COMPLEXITY_LIMIT) {
        if (!cancelled) {
          setScene(null);
          setLayoutResult(null);
          setRenderErrors([
            `Diagram complexity too high (${diagram.groups.length} groups × ${diagram.edges.length} edges = ${elkComplexity}) — ` +
              `ELK layout cannot safely process this. Remove redundant cross-group edges or use AI Fix to simplify.`,
          ]);
          setIsLayingOut(false);
        }
        return;
      }

      try {
        if (!cancelled) setIsLayingOut(true);
        // ELK now runs in a real Web Worker (see lib/layout/elk.ts) so it never
        // blocks the main thread. The timeout promise will actually fire if the
        // worker takes too long, because the main thread remains free.
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Layout timed out after ${LAYOUT_TIMEOUT_MS / 1000}s — the diagram may be too large or complex to render automatically. Try splitting it into smaller diagrams or use AI Fix to simplify.`,
                ),
              ),
            LAYOUT_TIMEOUT_MS,
          ),
        );
        const result = await Promise.race([runLayout(diagram, strategy), timeoutPromise]);
        if (cancelled) return;
        layoutRef.current = result;
        setLayoutResult(result);
        // Clear the loading spinner BEFORE the synchronous buildScene call so
        // that the browser can paint and process any queued user events (e.g.
        // nav-tab clicks) in between. Without this yield, buildScene holds the
        // main thread for the full routing pass, keeping the UI frozen even
        // after ELK finishes.
        if (!cancelled) setIsLayingOut(false);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (cancelled) return;
        setScene(buildScene(diagram, result, { selectedId: selection.id, overrides, theme }));
        setRenderErrors([]);
      } catch (err) {
        if (!cancelled) {
          setScene(null);
          setLayoutResult(null);
          let errMsg = err instanceof Error ? err.message : String(err);
          // ELK's network-simplex algorithm throws "Invalid array length" when
          // the compound graph is too complex (too many nodes/cross-group edges).
          if (errMsg.includes('Invalid array length')) {
            errMsg =
              `ELK layout failed: diagram is too complex (too many nodes or cross-group edges). ` +
              `Try removing redundant edges, splitting into smaller sub-diagrams, or use AI Fix to simplify.`;
          }
          setRenderErrors([errMsg]);
          // eslint-disable-next-line no-console
          console.warn('Layout failed:', err);
        }
      } finally {
        if (!cancelled) setIsLayingOut(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram, strategy, theme]);

  useEffect(() => {
    if (!layoutRef.current) return;
    setScene(
      buildScene(diagram, layoutRef.current, { selectedId: selection.id, overrides, theme }),
    );
  }, [overrides, selection, diagram, theme]);

  const fitView = useCallback(() => {
    if (!scene || !wrapperRef.current) return;
    const w = wrapperRef.current.clientWidth;
    const h = wrapperRef.current.clientHeight;
    if (w === 0 || h === 0) return;
    const bw = scene.bbox.width + PAD * 2;
    const bh = scene.bbox.height + PAD * 2;
    const scale = Math.max(0.08, Math.min(w / bw, h / bh) * 0.92);
    const cx = scene.bbox.x + scene.bbox.width / 2;
    const cy = scene.bbox.y + scene.bbox.height / 2;
    setViewport({ x: w / 2 - cx * scale, y: h / 2 - cy * scale, scale });
  }, [scene]);

  useEffect(() => {
    if (scene && wrapperRef.current) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.bbox.width, scene?.bbox.height]);

  useImperativeHandle(
    ref,
    (): DiagramCanvasHandle => ({
      getSvg: () => svgRef.current,
      fitView,
    }),
    [fitView],
  );

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    setViewport((v) => {
      const nextScale = Math.max(0.1, Math.min(5, v.scale * factor));
      const k = nextScale / v.scale;
      return { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, scale: nextScale };
    });
  };

  function findRectFor(id: string, kind: 'node' | 'group') {
    const result = layoutRef.current;
    if (!result) return null;
    const ov = kind === 'node' ? overrides.nodes[id] : overrides.groups[id];
    const base = kind === 'node' ? result.nodes.get(id) : result.groups.get(id);
    if (!base) return null;
    return {
      x: ov?.x ?? base.x,
      y: ov?.y ?? base.y,
      width: ov?.width ?? base.width,
      height: ov?.height ?? base.height,
    };
  }

  function descendants(groupId: string): { nodes: string[]; groups: string[] } {
    const out = { nodes: [] as string[], groups: [] as string[] };
    const g = diagram.groups.find((gg) => gg.id === groupId);
    if (!g) return out;
    for (const child of g.children) {
      if (diagram.groups.some((gg) => gg.id === child)) {
        out.groups.push(child);
        const sub = descendants(child);
        out.nodes.push(...sub.nodes);
        out.groups.push(...sub.groups);
      } else {
        out.nodes.push(child);
      }
    }
    return out;
  }

  function currentEdgeRoute(edgeId: string): Point[] | null {
    const result = layoutRef.current;
    if (!result) return null;
    const edge = diagram.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return null;
    const edgeOffsets = edgeLaneOffsets(diagram.edges);
    return routeEdgePath(edge, result, overrides, edgeOffsets.get(edge.id) ?? 0)?.points ?? null;
  }

  function compactManualBends(points: Point[]): Point[] {
    const out: Point[] = [];
    for (const point of points) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last.x - point.x) > 0.001 || Math.abs(last.y - point.y) > 0.001) {
        out.push(point);
      }
    }
    if (out.length <= 2) return [];

    const bends: Point[] = [];
    for (let i = 1; i < out.length - 1; i++) {
      const prev = bends[bends.length - 1] ?? out[i - 1]!;
      const curr = out[i]!;
      const next = out[i + 1]!;
      const sameVertical = Math.abs(prev.x - curr.x) < 0.001 && Math.abs(curr.x - next.x) < 0.001;
      const sameHorizontal = Math.abs(prev.y - curr.y) < 0.001 && Math.abs(curr.y - next.y) < 0.001;
      if (!sameVertical && !sameHorizontal) bends.push(curr);
    }
    return bends;
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!wrapperRef.current) return;
    // Do NOT capture the pointer while layout is running. Capturing here would
    // redirect all subsequent pointer events (including clicks on nav links
    // outside the canvas) to this element, making the rest of the UI unclickable
    // until the user releases the mouse.
    if (isLayingOut) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = e.target as Element;
    const edgeHandle = target.closest('[data-edge-segment]') as Element | null;
    if (edgeHandle) {
      const edgeId = edgeHandle.getAttribute('data-id');
      const segmentIndex = Number(edgeHandle.getAttribute('data-edge-segment'));
      const segmentAxis = edgeHandle.getAttribute('data-edge-axis') as
        | 'horizontal'
        | 'vertical'
        | null;
      const route = edgeId ? currentEdgeRoute(edgeId) : null;
      if (edgeId && route && segmentAxis && Number.isFinite(segmentIndex)) {
        setSelection({ id: edgeId, kind: 'edge' });
        // Motivation vs Logic: selected edge handles drag the existing orthogonal segment rather than re-routing immediately, giving users precise control over the cut while the default renderer remains obstacle-avoiding.
        drag.current = {
          kind: 'edge-segment',
          id: edgeId,
          start: { x: e.clientX, y: e.clientY },
          origin: viewport,
          edgeSegmentIndex: segmentIndex,
          edgeSegmentAxis: segmentAxis,
          edgeRouteStart: route,
        };
        return;
      }
    }

    const hit = target.closest('[data-id]') as Element | null;
    const id = hit?.getAttribute('data-id') ?? null;
    const kind = hit?.getAttribute('data-kind') as 'node' | 'group' | 'edge' | null;

    if (id && kind) setSelection({ id, kind });
    else setSelection({ id: null, kind: null });

    if (id && (kind === 'node' || kind === 'group')) {
      const rect = findRectFor(id, kind);
      if (!rect) return;
      const descendantStarts: Record<string, { x: number; y: number }> = {};
      if (kind === 'group') {
        const d = descendants(id);
        for (const nid of d.nodes) {
          const r = findRectFor(nid, 'node');
          if (r) descendantStarts[`n:${nid}`] = { x: r.x, y: r.y };
        }
        for (const gid of d.groups) {
          const r = findRectFor(gid, 'group');
          if (r) descendantStarts[`g:${gid}`] = { x: r.x, y: r.y };
        }
      }
      drag.current = {
        kind,
        id,
        start: { x: e.clientX, y: e.clientY },
        origin: viewport,
        startRect: rect,
        descendantStarts,
      };
    } else {
      drag.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origin: viewport };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (d.kind === 'pan') {
      setViewport({ x: d.origin.x + dx, y: d.origin.y + dy, scale: d.origin.scale });
      return;
    }
    const dxScene = dx / viewport.scale;
    const dyScene = dy / viewport.scale;
    if (d.kind === 'edge-segment') {
      if (!d.id || !d.edgeRouteStart || d.edgeSegmentIndex === undefined || !d.edgeSegmentAxis)
        return;
      const next = d.edgeRouteStart.map((point) => ({ ...point }));
      const index = d.edgeSegmentIndex;
      const afterIndex = index + 1;
      if (index <= 0 || afterIndex >= next.length - 1) return;
      if (d.edgeSegmentAxis === 'vertical') {
        next[index]!.x += dxScene;
        next[afterIndex]!.x += dxScene;
      } else {
        next[index]!.y += dyScene;
        next[afterIndex]!.y += dyScene;
      }
      setOverride('edges', d.id, { bends: compactManualBends(next) });
      return;
    }
    if (!d.startRect || !d.id) return;
    if (d.kind === 'node') {
      setOverride('nodes', d.id, { x: d.startRect.x + dxScene, y: d.startRect.y + dyScene });
    } else if (d.kind === 'group') {
      setOverride('groups', d.id, { x: d.startRect.x + dxScene, y: d.startRect.y + dyScene });
      if (d.descendantStarts) {
        for (const [key, start] of Object.entries(d.descendantStarts)) {
          const [scope, ...idParts] = key.split(':');
          const idStr = idParts.join(':');
          const move = { x: start.x + dxScene, y: start.y + dyScene };
          if (scope === 'n') setOverride('nodes', idStr, move);
          else setOverride('groups', idStr, move);
        }
      }
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={wrapperRef}
      className={`diagram-canvas relative h-full w-full overflow-hidden border-x border-ink-700/70 ${drag.current ? 'dragging' : ''}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {renderErrors.length > 0 && !renderErrorsDismissed && (
        <RenderErrorBanner
          errors={renderErrors}
          onDismiss={() => setRenderErrorsDismissed(true)}
        />
      )}
      {isLayingOut && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-900/80 px-3 py-2 text-[11px] text-ink-400 backdrop-blur-sm">
            <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-accent" />
            Computing layout…
          </div>
        </div>
      )}
      {scene ? (
        /* Root Cause vs Logic: the SVG used to contribute its full intrinsic width to the CSS grid, so fitView centered against a thousands-pixel wrapper and pushed the diagram out of view. Keeping it absolutely positioned makes the viewport size authoritative while preserving the full viewBox for export. */
        <svg
          ref={svgRef}
          xmlns="http://www.w3.org/2000/svg"
          data-diagram-theme={theme}
          className="absolute left-0 top-0 max-w-none overflow-visible"
          width={scene.bbox.width + PAD * 2}
          height={scene.bbox.height + PAD * 2}
          viewBox={`${scene.bbox.x - PAD} ${scene.bbox.y - PAD} ${scene.bbox.width + PAD * 2} ${scene.bbox.height + PAD * 2}`}
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            transformOrigin: '0 0',
          }}
        >
          <defs dangerouslySetInnerHTML={{ __html: scene.defsHtml }} />
          {scene.layers}
        </svg>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-ink-400">
          No diagram
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-ink-900/80 px-2 py-1 text-[10px] uppercase tracking-wider text-ink-400">
        {Math.round(viewport.scale * 100)}%
      </div>
    </div>
  );
});
