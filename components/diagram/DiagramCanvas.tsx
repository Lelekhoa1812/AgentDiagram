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
import { flushDraftSave, useDiagramStore } from '@/lib/state/store';
import { compile } from '@/lib/dsl/compiler';
import { runLayout } from '@/lib/layout/strategies';
import { buildScene, type SceneResult } from '@/lib/render/svgScene';
import type { LayoutResult } from '@/lib/layout/elk';
import type { Point } from '@/lib/ir/types';
import { edgeLaneOffsets, hasNodeGroupOverrides, routeEdgePath } from '@/lib/render/edgePath';
import { routeEdgesProgressively, type RoutedEdgePath } from '@/lib/render/edgeRouter';
import { getCachedLayout, cacheLayoutResult } from '@/lib/cache/indexdbCache';
import { diagramHash } from '@/lib/layout/layoutCache';
import { validateCompletedRoutes } from '@/lib/render/routeValidation';
import { RenderErrorBanner } from './RenderErrorBanner';
import { getEffectiveThresholds, getDetectedDevice } from '@/lib/layout/constants';

export interface DiagramCanvasHandle {
  getSvg: () => SVGSVGElement | null;
  fitView: () => void;
}

interface MultiDragItem {
  id: string;
  kind: 'node' | 'group';
  startRect: { x: number; y: number; width: number; height: number };
  /** Keyed `n:<id>` or `g:<id>` — only populated for group items. */
  descendantStarts: Record<string, { x: number; y: number }>;
}

interface DragState {
  kind: 'pan' | 'node' | 'group' | 'edge-segment' | 'multi';
  id?: string;
  start: { x: number; y: number };
  origin: { x: number; y: number; scale: number };
  startRect?: { x: number; y: number; width: number; height: number };
  descendantStarts?: Record<string, { x: number; y: number }>;
  edgeSegmentIndex?: number;
  edgeSegmentAxis?: 'horizontal' | 'vertical';
  edgeRouteStart?: Point[];
  /** Populated only for kind === 'multi'. */
  multiItems?: MultiDragItem[];
}

const PAD = 32;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

export const DiagramCanvas = forwardRef<DiagramCanvasHandle>(function DiagramCanvas(_, ref) {
  const dsl = useDiagramStore((s) => s.dslText);
  const overrides = useDiagramStore((s) => s.overrides);
  const setOverride = useDiagramStore((s) => s.setOverride);
  const selection = useDiagramStore((s) => s.selection);
  const setSelection = useDiagramStore((s) => s.setSelection);
  const multiSelection = useDiagramStore((s) => s.multiSelection);
  const toggleMultiSelectItem = useDiagramStore((s) => s.toggleMultiSelectItem);
  const clearMultiSelection = useDiagramStore((s) => s.clearMultiSelection);
  const setDiagram = useDiagramStore((s) => s.setDiagram);
  const setLayoutResult = useDiagramStore((s) => s.setLayoutResult);
  const strategy = useDiagramStore((s) => s.layoutStrategy);
  const theme = useDiagramStore((s) => s.theme);

  // All IDs that should be highlighted with a selection ring — primary plus
  // every item in the multi-selection.  Passed to buildScene as a Set so
  // the scene builder can check membership in O(1) per element.
  const multiSelectedIds = useMemo(() => {
    const ids = new Set<string>();
    if (selection.id) ids.add(selection.id);
    for (const item of multiSelection) ids.add(item.id);
    return ids;
  }, [selection, multiSelection]);
  // Ref so the layout effect can read the current set without being a dep.
  const multiSelectedIdsRef = useRef(multiSelectedIds);
  useEffect(() => { multiSelectedIdsRef.current = multiSelectedIds; }, [multiSelectedIds]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  // Always-current viewport ref — read inside buildScene calls without adding
  // viewport to effect deps (which would rebuild the scene on every pan/zoom frame).
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  const drag = useRef<DragState | null>(null);
  const [isLayingOut, setIsLayingOut] = useState(false);
  // Elapsed-time counter shown in the "Computing layout…" spinner.
  // Increments every 500 ms while layout is running so the user knows progress.
  const [layoutElapsedMs, setLayoutElapsedMs] = useState(0);
  // Routed edges from the worker/cache. During progressive rendering this may be
  // a partial map, with missing edges intentionally skipped by buildScene.
  const [preRoutedEdges, setPreRoutedEdges] = useState<Map<string, RoutedEdgePath> | null>(null);
  const [isRoutingComplete, setIsRoutingComplete] = useState(false);
  const renderRunIdRef = useRef(0);
  useEffect(() => {
    if (!isLayingOut) {
      setLayoutElapsedMs(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setLayoutElapsedMs(Date.now() - start), 500);
    return () => clearInterval(id);
  }, [isLayingOut]);

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
    const runId = ++renderRunIdRef.current;
    const controller = new AbortController();
    let scheduledFrame: number | null = null;
    const isCurrent = () => !controller.signal.aborted && renderRunIdRef.current === runId;

    const scheduleSceneCommit = (
      result: LayoutResult,
      routed: Map<string, RoutedEdgePath>,
      missingPreRoutedEdge: 'skip' | 'sync',
    ) => {
      if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        if (!isCurrent()) return;
        setScene(
          buildScene(diagram, result, {
            selectedId: selection.id,
            multiSelectedIds: multiSelectedIdsRef.current,
            overrides,
            theme,
            viewport: wrapperRef.current
              ? {
                  ...viewportRef.current,
                  containerW: wrapperRef.current.clientWidth,
                  containerH: wrapperRef.current.clientHeight,
                }
              : undefined,
            preRoutedEdges: routed,
            missingPreRoutedEdge,
          }),
        );
      });
    };

    (async () => {
      if (isCurrent()) {
        setIsLayingOut(true);
        setLayoutResult(null);
        setPreRoutedEdges(null);
        setIsRoutingComplete(false);
        layoutRef.current = null;
      }

      // Bail out early if the compiler already found hard errors — running ELK
      // on a structurally broken diagram can hang the main thread indefinitely.
      const compileErrors = diagram.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `Line ${d.line}:${d.column} — ${d.message}`);

      if (compileErrors.length > 0) {
        if (isCurrent()) {
          setScene(null);
          setLayoutResult(null);
          setRenderErrors(compileErrors);
          setIsLayingOut(false);
        }
        return;
      }

      // Get adaptive thresholds based on device capacity
      const effectiveThresholds = getEffectiveThresholds();
      const device = getDetectedDevice();
      const deviceLabel = device.isLowEnd ? 'low-end' : device.isHighEnd ? 'high-end' : 'mid-range';
      const elementCount = diagram.nodes.length + diagram.groups.length + diagram.edges.length;

      if (elementCount > effectiveThresholds.renderElementLimit) {
        if (isCurrent()) {
          setRenderErrors([
            `Diagram too complex to render safely (${elementCount} elements) on this ${deviceLabel} device. ` +
              `Hard limit is ${effectiveThresholds.renderElementLimit} elements to prevent the page from becoming unresponsive. ` +
              `Use AI Fix to simplify or Split Layer to divide it into smaller diagrams.`,
          ]);
          setIsLayingOut(false);
        }
        return;
      }

      try {
        const renderTimeoutMs = effectiveThresholds.renderTimeoutMs;
        const deadlineMs = Date.now() + renderTimeoutMs;
        const edgeIds = diagram.edges.map((edge) => edge.id);
        const cacheKey = diagramHash(diagram, { direction: 'DOWN' });
        const cached = await getCachedLayout(cacheKey, edgeIds);
        if (!isCurrent()) return;

        let result: LayoutResult;
        let routed: Map<string, RoutedEdgePath>;

        if (cached) {
          console.debug('[Cache] Completed layout cache hit for diagram');
          result = cached.layoutResult;
          routed = new Map(cached.routedEdges.map((route) => [route.edgeId, route]));
        } else {
          result = await runLayout(diagram, strategy, undefined, {
            deadlineMs,
            signal: controller.signal,
          });
          if (!isCurrent()) return;

          const renderPixels = result.bbox.width * result.bbox.height;
          if (renderPixels > effectiveThresholds.renderPixelLimit) {
            throw new Error(
              `Diagram too complex to render safely (${Math.round(renderPixels / 1_000_000)}M layout pixels) on this ${deviceLabel} device. ` +
                `Use AI Fix to simplify or Split Layer to divide it into smaller diagrams.`,
            );
          }

          const partialRoutes = new Map<string, RoutedEdgePath>();
          layoutRef.current = result;
          setLayoutResult(result);
          setPreRoutedEdges(partialRoutes);
          setRenderErrors([]);

          // Motivation vs Logic: complex diagrams should become inspectable as
          // soon as layout exists, so the canvas paints nodes/groups first and
          // then lets worker-routed edges stream in under the same 60s budget.
          scheduleSceneCommit(result, partialRoutes, 'skip');

          const edgeOffsets = edgeLaneOffsets(diagram.edges);
          routed = await routeEdgesProgressively(diagram.edges, result, overrides, edgeOffsets, {
            timeoutMs: Math.max(1, remainingMs(deadlineMs)),
            batchSize: 16,
            signal: controller.signal,
            onBatch: ({ routed: progressiveRoutes }) => {
              if (!isCurrent()) return;
              setPreRoutedEdges(progressiveRoutes);
              scheduleSceneCommit(result, progressiveRoutes, 'skip');
            },
          });
        }

        if (!isCurrent()) return;

        const renderPixels = result.bbox.width * result.bbox.height;
        if (renderPixels > effectiveThresholds.renderPixelLimit) {
          throw new Error(
            `Diagram too complex to render safely (${Math.round(renderPixels / 1_000_000)}M layout pixels) on this ${deviceLabel} device. ` +
              `Use AI Fix to simplify or Split Layer to divide it into smaller diagrams.`,
          );
        }

        const routeErrors = validateCompletedRoutes(diagram.edges, result, routed);
        if (routeErrors.length > 0) throw new Error(routeErrors.join('\n'));

        layoutRef.current = result;
        setLayoutResult(result);
        setPreRoutedEdges(routed);
        setIsRoutingComplete(true);
        setRenderErrors([]);
        scheduleSceneCommit(result, routed, 'sync');

        if (!cached) {
          const routedArray = Array.from(routed.entries()).map(([edgeId, path]) => ({
            edgeId,
            ...path,
          }));
          cacheLayoutResult(
            cacheKey,
            result,
            routedArray,
            'default-project',
            'default-layer',
            dsl,
            edgeIds,
          ).catch((err) =>
            console.warn('[Cache] Failed to save completed render to IndexDB:', err),
          );
        }
      } catch (err) {
        if (isAbortError(err) || !isCurrent()) return;
        let errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('Invalid array length') || errMsg.includes('worker crashed')) {
          errMsg =
            `Layout worker failed on this complex diagram. ` +
            `The partial render was kept visible when available; use AI Fix or Split Layer if the diagram does not finish.`;
        }
        if (isCurrent()) {
          setRenderErrors([errMsg]);
          if (!layoutRef.current) {
            setScene(null);
            setLayoutResult(null);
          }
        }
        console.warn('Layout failed:', err);
      } finally {
        if (isCurrent()) setIsLayingOut(false);
      }
    })();
    return () => {
      controller.abort();
      if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram, strategy, theme]);

  useEffect(() => {
    if (!layoutRef.current || !preRoutedEdges) return;
    setScene(
      buildScene(diagram, layoutRef.current, {
        selectedId: selection.id,
        multiSelectedIds,
        overrides,
        theme,
        viewport: wrapperRef.current
          ? {
              ...viewportRef.current,
              containerW: wrapperRef.current.clientWidth,
              containerH: wrapperRef.current.clientHeight,
            }
          : undefined,
        preRoutedEdges: preRoutedEdges ?? undefined,
        missingPreRoutedEdge: isRoutingComplete ? 'sync' : 'skip',
      }),
    );
  }, [overrides, selection, multiSelectedIds, diagram, theme, preRoutedEdges, isRoutingComplete]);

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
    // Mirror the prerouted-skip logic from renderEdge in svgScene.tsx so that
    // the segmentIndex stored in drag state always matches the rendered handles.
    // Without this, handles are positioned on the prerouted path while drag
    // operates on the re-computed routeEdgePath — they use different point arrays
    // and the segment index becomes invalid, causing the edge to jump on first drag.
    // Root Cause vs Logic: worker-routed paths were being reused after unrelated
    // component moves, so edge handles could anchor to a stale route that still
    // cut through the current layout. Once any node or group override exists, we
    // recompute the live route from the current geometry before starting a drag.
    const hasConnectedOverride =
      !!(overrides.nodes[edge.source] || overrides.nodes[edge.target] ||
         overrides.groups[edge.source] || overrides.groups[edge.target]);
    const hasEdgeBendOverride = !!(overrides.edges[edgeId]?.bends?.length);
    if (
      !hasNodeGroupOverrides(overrides) &&
      !hasConnectedOverride &&
      !hasEdgeBendOverride &&
      preRoutedEdges
    ) {
      const prerouted = preRoutedEdges.get(edgeId);
      if (prerouted) return prerouted.points;
    }
    const edgeOffsets = edgeLaneOffsets(diagram.edges);
    return routeEdgePath(edge, result, overrides, edgeOffsets.get(edge.id) ?? 0)?.points ?? null;
  }

  function compactManualBends(points: Point[]): Point[] {
    // 1. Deduplicate exact-duplicate consecutive points.
    const deduped: Point[] = [];
    for (const point of points) {
      const last = deduped[deduped.length - 1];
      if (!last || Math.abs(last.x - point.x) > 0.001 || Math.abs(last.y - point.y) > 0.001) {
        deduped.push(point);
      }
    }
    if (deduped.length <= 2) return [];

    // 2. Remove near-collinear interior points whose perpendicular deviation
    //    from the line through their two neighbours is ≤ 4 px.  This collapses
    //    the tiny Z-shaped stubs that accumulate after node moves (e.g. two long
    //    horizontal runs separated by a 2 px vertical connector) so the bend
    //    handle and the visual "break" disappear automatically on drag end.
    const NEAR_PX = 4;
    let current = deduped;
    let changed = true;
    while (changed && current.length > 2) {
      changed = false;
      const simplified: Point[] = [current[0]!];
      for (let i = 1; i < current.length - 1; i++) {
        const prev = simplified[simplified.length - 1]!;
        const curr = current[i]!;
        const next = current[i + 1]!;
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 0.000001) { simplified.push(curr); continue; }
        const cross = (curr.x - prev.x) * dy - (curr.y - prev.y) * dx;
        if (Math.abs(cross) / Math.sqrt(len2) <= NEAR_PX) { changed = true; continue; }
        simplified.push(curr);
      }
      simplified.push(current[current.length - 1]!);
      current = simplified;
    }
    if (current.length <= 2) return [];

    // 3. Remove exactly-collinear interior points (same axis as both neighbours).
    const bends: Point[] = [];
    for (let i = 1; i < current.length - 1; i++) {
      const prev = bends[bends.length - 1] ?? current[i - 1]!;
      const curr = current[i]!;
      const next = current[i + 1]!;
      const sameVertical = Math.abs(prev.x - curr.x) < 0.001 && Math.abs(curr.x - next.x) < 0.001;
      const sameHorizontal = Math.abs(prev.y - curr.y) < 0.001 && Math.abs(curr.y - next.y) < 0.001;
      if (!sameVertical && !sameHorizontal) bends.push(curr);
    }
    return bends;
  }

  /**
   * Build the list of drag items for a multi-select drag.
   *
   * Rules:
   *   • Skips any item that is a descendant of another selected group (it
   *     will already be moved by its ancestor's descendantStarts).
   *   • Populates descendantStarts for every group item so children follow.
   */
  function buildMultiDragItems(
    items: { id: string; kind: 'node' | 'group' }[],
  ): MultiDragItem[] {
    // Collect every node/group that is a descendant of a selected group.
    const coveredIds = new Set<string>();
    for (const item of items) {
      if (item.kind === 'group') {
        const d = descendants(item.id);
        d.nodes.forEach((nid) => coveredIds.add(nid));
        d.groups.forEach((gid) => coveredIds.add(gid));
      }
    }

    const result: MultiDragItem[] = [];
    for (const item of items) {
      if (coveredIds.has(item.id)) continue; // moved by an ancestor group

      const rect = findRectFor(item.id, item.kind);
      if (!rect) continue;

      const descendantStarts: Record<string, { x: number; y: number }> = {};
      if (item.kind === 'group') {
        const d = descendants(item.id);
        for (const nid of d.nodes) {
          const r = findRectFor(nid, 'node');
          if (r) descendantStarts[`n:${nid}`] = { x: r.x, y: r.y };
        }
        for (const gid of d.groups) {
          const r = findRectFor(gid, 'group');
          if (r) descendantStarts[`g:${gid}`] = { x: r.x, y: r.y };
        }
      }
      result.push({ id: item.id, kind: item.kind, startRect: rect, descendantStarts });
    }
    return result;
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!wrapperRef.current) return;
    // Do NOT capture the pointer while layout is running. Capturing here would
    // redirect all subsequent pointer events (including clicks on nav links
    // outside the canvas) to this element, making the rest of the UI unclickable
    // until the user releases the mouse.
    if (isLayingOut) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    const isMultiKey = e.metaKey || e.ctrlKey;
    const target = e.target as Element;

    // ── Edge-segment handle (bend-point drag) ────────────────────────────────
    // Must be checked first because handles live inside the edge <g> and would
    // otherwise be caught by the generic [data-id] hit test below.
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
        if (!isMultiKey) clearMultiSelection();
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
        // Override the CSS grab cursor with the correct resize cursor for the
        // duration of this drag.  Pointer capture routes all pointer events to
        // the wrapper, so its cursor takes precedence over the handle element's
        // Tailwind class — set it inline so it wins over .diagram-canvas.dragging.
        if (wrapperRef.current) {
          wrapperRef.current.style.cursor = segmentAxis === 'vertical' ? 'ew-resize' : 'ns-resize';
        }
        return;
      }
    }

    const hit = target.closest('[data-id]') as Element | null;
    const id = hit?.getAttribute('data-id') ?? null;
    const kind = hit?.getAttribute('data-kind') as 'node' | 'group' | 'edge' | null;

    // ── Cmd/Ctrl + click → multi-select toggle ───────────────────────────────
    if (isMultiKey && id && kind && kind !== 'edge-label' as string) {
      toggleMultiSelectItem({ id, kind: kind as 'node' | 'group' | 'edge' });
      // Don't start any drag — the user is building a selection set.
      drag.current = null;
      return;
    }

    // ── Plain click: update primary selection ────────────────────────────────
    if (id && kind) {
      setSelection({ id, kind });
      clearMultiSelection();
    } else {
      setSelection({ id: null, kind: null });
      clearMultiSelection();
    }

    // ── Edge click: focus the edge without starting a pan drag ───────────────
    // Requirement: an edge must be selected (focused) before its handles can be
    // dragged. Clicking the edge body ONLY selects it; dragging immediately
    // after pans the canvas (same as clicking empty space), which prevents
    // the common confusion of accidentally moving the viewport while trying to
    // adjust an arrow.
    if (kind === 'edge') {
      // No drag initiated — next pointer-down on an edge *handle* (above) will
      // fire the edge-segment drag path.
      drag.current = null;
      return;
    }

    // ── Node / Group drag ────────────────────────────────────────────────────
    if (id && (kind === 'node' || kind === 'group')) {
      // If other items are already multi-selected, drag all of them together.
      const hasMulti = multiSelection.length > 0;
      if (hasMulti) {
        // Build the combined set: primary item + all multi-selection items
        // (filtering to node/group only — edges cannot be dragged as a group).
        const allItems: { id: string; kind: 'node' | 'group' }[] = [
          { id, kind },
          ...multiSelection
            .filter((i): i is { id: string; kind: 'node' | 'group' } => i.kind !== 'edge')
            // Don't duplicate the primary item if it's already in multiSelection.
            .filter((i) => i.id !== id),
        ];
        const multiItems = buildMultiDragItems(allItems);
        drag.current = {
          kind: 'multi',
          start: { x: e.clientX, y: e.clientY },
          origin: viewport,
          multiItems,
        };
        return;
      }

      // Single-item drag (existing behaviour).
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
      return;
    }

    // ── Canvas pan (empty space click) ───────────────────────────────────────
    drag.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origin: viewport };
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
    // ── Multi-item drag ───────────────────────────────────────────────────────
    if (d.kind === 'multi') {
      if (!d.multiItems) return;
      for (const item of d.multiItems) {
        setOverride(item.kind === 'node' ? 'nodes' : 'groups', item.id, {
          x: item.startRect.x + dxScene,
          y: item.startRect.y + dyScene,
        });
        for (const [key, start] of Object.entries(item.descendantStarts)) {
          const [scope, ...idParts] = key.split(':');
          const idStr = idParts.join(':');
          const move = { x: start.x + dxScene, y: start.y + dyScene };
          if (scope === 'n') setOverride('nodes', idStr, move);
          else setOverride('groups', idStr, move);
        }
      }
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
    if (drag.current) {
      // Root Cause vs Logic: drag movement streams a burst of override updates,
      // so we flush on pointer-up to make sure the final geometry lands in the
      // same persisted snapshot the user sees on screen.
      void flushDraftSave();
    }
    drag.current = null;
    // Restore the default CSS cursor after any drag type (edge-segment drag
    // sets an inline cursor to override .diagram-canvas.dragging).
    if (wrapperRef.current) wrapperRef.current.style.cursor = '';
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
        <RenderErrorBanner errors={renderErrors} onDismiss={() => setRenderErrorsDismissed(true)} />
      )}
      {isLayingOut && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-ink-700/60 bg-ink-900/80 px-3 py-2 text-[11px] text-ink-400 backdrop-blur-sm">
            <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-accent" />
            {layoutElapsedMs >= 1_000
              ? `Computing layout… (${Math.round(layoutElapsedMs / 1_000)}s)`
              : 'Computing layout…'}
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
