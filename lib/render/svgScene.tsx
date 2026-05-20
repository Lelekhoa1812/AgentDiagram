/**
 * Pure SVG scene builder.
 *
 * Builds the content of an SVG (a `<g>` tree of groups, nodes, edges) and
 * the surrounding `<defs>` (markers). Consumers wrap this in their own
 * `<svg>` element to control the viewBox / interaction model.
 *
 * Used by:
 *   - <DiagramCanvas/> for on-screen rendering (wraps in interactive <svg>)
 *   - lib/export/svg.ts for export (wraps in plain <svg> at full bbox)
 *
 * Same builder → PNG-equals-screen by construction.
 */

import React from 'react';
import type { Diagram, IRGroup, IRNode, IREdge, Point } from '../ir/types';
import type { LayoutResult, LayoutRect } from '../layout/elk';
import { paletteFor, themeFor, type RenderThemeMode } from './theme';
import { getIcon } from '../icons/registry';
import { ARROW_FWD_ID, ARROW_BWD_ID, ARROW_THICK_ID, MARKER_DEFS } from './markers';
import { edgeLabelSize, groupTitleSize } from '../layout/measure';
import { edgeLaneOffsets, routeEdgePath } from './edgePath';

export interface SceneOptions {
  selectedId?: string | null;
  onSelect?: (id: string | null, kind: 'node' | 'group' | 'edge') => void;
  overrides?: {
    nodes?: Record<string, Partial<LayoutRect>>;
    groups?: Record<string, Partial<LayoutRect>>;
    edges?: Record<string, { bends: Point[] }>;
  };
  theme?: RenderThemeMode;
}

export interface SceneResult {
  /** <defs> contents string (for dangerouslySetInnerHTML) */
  defsHtml: string;
  /** Array of <g> elements ordered: groups, nodes, edges */
  layers: React.ReactElement[];
  /** Bounding box of the content (no padding) */
  bbox: { x: number; y: number; width: number; height: number };
}

const ICON_SIZE = 14;

export function buildScene(
  diagram: Diagram,
  layout: LayoutResult,
  opts: SceneOptions = {},
): SceneResult {
  const theme = themeFor(opts.theme);
  const groupsById = new Map(diagram.groups.map((g) => [g.id, g]));
  const edgeOffsets = edgeLaneOffsets(diagram.edges);

  function rectFor(id: string): LayoutRect | undefined {
    const ov = opts.overrides?.nodes?.[id] ?? opts.overrides?.groups?.[id];
    const base = layout.nodes.get(id) ?? layout.groups.get(id);
    if (!base) return undefined;
    return {
      x: ov?.x ?? base.x,
      y: ov?.y ?? base.y,
      width: ov?.width ?? base.width,
      height: ov?.height ?? base.height,
    };
  }

  function effectiveColor(item: IRNode | IRGroup): IRGroup['color'] {
    if (item.color) return item.color;
    let parentId = item.parentId;
    while (parentId) {
      const g = groupsById.get(parentId);
      if (!g) break;
      if (g.color) return g.color;
      parentId = g.parentId;
    }
    return null;
  }

  function renderGroup(g: IRGroup): React.ReactElement | null {
    const rect = rectFor(g.id);
    if (!rect) return null;
    const color = effectiveColor(g);
    const pal = paletteFor(color, opts.theme);
    const title = (g.label ?? g.name).toUpperCase();
    const titleSize = groupTitleSize(title);
    const icon = getIcon(g.icon);
    const radius = 14;
    const isSelected = opts.selectedId === g.id;

    return (
      <g key={`g-${g.id}`} data-id={g.id} data-kind="group">
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={radius}
          ry={radius}
          fill={pal.groupFill}
          stroke={isSelected ? theme.selectionRing : pal.groupBorder}
          strokeWidth={isSelected ? 2 : 1}
          style={{ filter: `drop-shadow(0 0 12px ${pal.groupGlow})` }}
        />
        <g transform={`translate(${rect.x + 10}, ${rect.y + 8})`}>
          <rect
            x={0}
            y={0}
            width={titleSize.width}
            height={titleSize.height}
            rx={titleSize.height / 2}
            ry={titleSize.height / 2}
            fill={pal.groupTitleBg}
            stroke={pal.groupBorder}
            strokeWidth={0.5}
          />
          <g transform={`translate(6, ${(titleSize.height - ICON_SIZE) / 2})`}>
            <svg
              width={ICON_SIZE}
              height={ICON_SIZE}
              viewBox={icon.viewBox}
              fill="none"
              stroke={pal.groupTitleText}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: icon.paths.join('') }}
            />
          </g>
          <text
            x={6 + ICON_SIZE + 6}
            y={titleSize.height / 2}
            dominantBaseline="middle"
            fill={pal.groupTitleText}
            fontSize={10}
            fontFamily="Inter, sans-serif"
            fontWeight={600}
            letterSpacing={0.5}
          >
            {title}
          </text>
        </g>
      </g>
    );
  }

  function renderNode(n: IRNode): React.ReactElement | null {
    const rect = rectFor(n.id);
    if (!rect) return null;
    const color = effectiveColor(n);
    const pal = paletteFor(color, opts.theme);
    const icon = getIcon(n.icon);
    const label = n.label ?? n.name;
    const isSelected = opts.selectedId === n.id;

    return (
      <g key={`n-${n.id}`} data-id={n.id} data-kind="node">
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={8}
          ry={8}
          fill={pal.nodeFill}
          stroke={isSelected ? theme.selectionRing : pal.nodeBorder}
          strokeWidth={isSelected ? 2 : 1}
        />
        <g transform={`translate(${rect.x + 8}, ${rect.y + (rect.height - ICON_SIZE) / 2})`}>
          <svg
            width={ICON_SIZE}
            height={ICON_SIZE}
            viewBox={icon.viewBox}
            fill="none"
            stroke={pal.nodeIcon}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dangerouslySetInnerHTML={{ __html: icon.paths.join('') }}
          />
        </g>
        <text
          x={rect.x + 8 + ICON_SIZE + 6}
          y={rect.y + rect.height / 2}
          dominantBaseline="middle"
          fill={pal.nodeLabel}
          fontSize={11}
          fontFamily="Inter, sans-serif"
          fontWeight={500}
        >
          {label}
        </text>
      </g>
    );
  }

  function renderEdge(edge: IREdge): React.ReactElement | null {
    const routed = routeEdgePath(edge, layout, opts.overrides, edgeOffsets.get(edge.id) ?? 0);
    if (!routed?.path) return null;
    const isSelected = opts.selectedId === edge.id;
    const fwdMarker = edge.kind === 'thick' ? ARROW_THICK_ID : ARROW_FWD_ID;
    const markerEnd = edge.kind === 'bwd' ? undefined : `url(#${fwdMarker})`;
    const markerStart =
      edge.kind === 'bwd' || edge.kind === 'bi' ? `url(#${ARROW_BWD_ID})` : undefined;
    const dash = edge.kind === 'dashed' ? '4 4' : undefined;
    const strokeWidth = edge.kind === 'thick' ? 2 : 1.1;

    return (
      <g key={`e-${edge.id}`} data-id={edge.id} data-kind="edge">
        <path
          d={routed.path}
          fill="none"
          stroke="transparent"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="cursor-pointer"
        />
        <path
          d={routed.path}
          fill="none"
          stroke={isSelected ? theme.edgeHover : theme.edgeStroke}
          strokeWidth={isSelected ? strokeWidth + 0.6 : strokeWidth}
          strokeDasharray={dash}
          strokeLinejoin="round"
          strokeLinecap="round"
          markerEnd={markerEnd}
          markerStart={markerStart}
        />
        {isSelected &&
          routed.points.slice(0, -1).map((point, index) => {
            const next = routed.points[index + 1]!;
            const isVertical = Math.abs(point.x - next.x) < 0.001;
            const isHorizontal = Math.abs(point.y - next.y) < 0.001;
            const isTerminalSegment = index === 0 || index + 1 === routed.points.length - 1;
            const length = Math.hypot(next.x - point.x, next.y - point.y);
            if ((!isVertical && !isHorizontal) || isTerminalSegment || length < 18) return null;
            const mid = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
            const axis = isVertical ? 'vertical' : 'horizontal';

            return (
              <g
                key={`edge-handle-${edge.id}-${index}`}
                data-id={edge.id}
                data-kind="edge"
                data-edge-segment={index}
                data-edge-axis={axis}
                className={isVertical ? 'cursor-ew-resize' : 'cursor-ns-resize'}
              >
                <line
                  x1={point.x}
                  y1={point.y}
                  x2={next.x}
                  y2={next.y}
                  stroke="transparent"
                  strokeWidth={16}
                  strokeLinecap="round"
                />
                <circle
                  cx={mid.x}
                  cy={mid.y}
                  r={4.5}
                  fill={theme.background}
                  stroke={theme.selectionRing}
                  strokeWidth={1.4}
                />
                {isVertical ? (
                  <line
                    x1={mid.x - 7}
                    y1={mid.y}
                    x2={mid.x + 7}
                    y2={mid.y}
                    stroke={theme.selectionRing}
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                ) : (
                  <line
                    x1={mid.x}
                    y1={mid.y - 7}
                    x2={mid.x}
                    y2={mid.y + 7}
                    stroke={theme.selectionRing}
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                )}
              </g>
            );
          })}
        {edge.label &&
          (() => {
            const labelSize = edgeLabelSize(edge.label);
            const selfRect = edge.source === edge.target ? rectFor(edge.source) : null;
            const labelPoint = selfRect
              ? {
                  x: selfRect.x + selfRect.width + labelSize.width / 2 + 14,
                  y: selfRect.y + selfRect.height / 2,
                }
              : routed.labelPoint;
            return (
              <g
                data-kind="edge-label"
                transform={`translate(${labelPoint.x}, ${labelPoint.y - 4})`}
              >
                <rect
                  x={-labelSize.width / 2}
                  y={-labelSize.height / 2}
                  width={labelSize.width}
                  height={labelSize.height}
                  rx={5}
                  ry={5}
                  fill={theme.background}
                  fillOpacity={0.86}
                  stroke={isSelected ? theme.edgeHover : theme.edgeStroke}
                  strokeOpacity={0.35}
                  strokeWidth={0.8}
                />
                <text
                  x={0}
                  y={0}
                  fill={theme.labelFill}
                  fontSize={9.5}
                  fontFamily="Inter, sans-serif"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {edge.label}
                </text>
              </g>
            );
          })()}
      </g>
    );
  }

  function groupDepth(g: IRGroup): number {
    let d = 0;
    let p: string | null = g.parentId;
    while (p) {
      const parent = groupsById.get(p);
      if (!parent) break;
      d++;
      p = parent.parentId;
    }
    return d;
  }

  void opts.onSelect; // selection handled at canvas via event delegation

  const sortedGroups = [...diagram.groups].sort((a, b) => groupDepth(a) - groupDepth(b));

  const layers: React.ReactElement[] = [
    <g key="edges">{diagram.edges.map((e) => renderEdge(e)).filter(Boolean)}</g>,
    <g key="groups">{sortedGroups.map((g) => renderGroup(g)).filter(Boolean)}</g>,
    <g key="nodes">{diagram.nodes.map((n) => renderNode(n)).filter(Boolean)}</g>,
  ];

  return {
    defsHtml: MARKER_DEFS,
    layers,
    bbox: {
      x: layout.bbox.x,
      y: layout.bbox.y,
      width: layout.bbox.width,
      height: layout.bbox.height,
    },
  };
}
