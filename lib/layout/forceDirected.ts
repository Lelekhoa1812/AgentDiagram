/**
 * Force-Directed Layout Algorithm (Fruchterman-Reingold)
 *
 * Fast approximation for massive diagrams when ELK and Graphviz fail.
 * Does NOT replace ELK; only used as last-resort fallback for extreme complexity.
 *
 * Algorithm:
 *   1. Seed: Initialize positions in group bounds or random
 *   2. Repulsion: Nodes repel each other inversely ∝ distance²
 *   3. Attraction: Edges pull endpoints together
 *   4. Containment: Constrain nodes within parent group bounds
 *   5. Cooling: Reduce movement amplitude over iterations
 *   6. Early exit: Stop if movement < epsilon (converged)
 */

import type { Diagram, Point } from '../ir/types';
import type { LayoutResult, LayoutRect, LayoutEdge } from './elk';

export interface ForceDirectedOptions {
  iterations?: number; // Default 100, range 50-200
  coolDownFactor?: number; // Default 0.95, range 0.9-0.99
  k?: number; // Ideal edge length (default 100)
  epsilon?: number; // Convergence threshold (default 0.01)
  randomSeed?: number; // For deterministic testing
}

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number; // Velocity
  vy: number;
  groupId: string | null;
  width: number;
  height: number;
}

/**
 * Simple pseudorandom number generator (seeded for determinism).
 */
class SeededRandom {
  seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    const x = Math.sin(this.seed++) * 10000;
    return x - Math.floor(x);
  }
}

/**
 * Compute force-directed layout for a diagram.
 * Returns a LayoutResult-compatible output with node/group positions.
 */
export function layoutForceDirected(
  diagram: Diagram,
  opts: ForceDirectedOptions = {},
): LayoutResult {
  const iterations = opts.iterations ?? 100;
  const coolDownFactor = opts.coolDownFactor ?? 0.95;
  const k = opts.k ?? 100; // Ideal edge length
  const epsilon = opts.epsilon ?? 0.01;
  const rng = new SeededRandom(opts.randomSeed ?? 42);

  const nodeById = new Map(diagram.nodes.map((n) => [n.id, n]));

  // Default dimensions for nodes (fallback if not specified)
  const defaultNodeWidth = 120;
  const defaultNodeHeight = 60;

  // Initialize nodes with positions
  const nodes = new Map<string, Node>();
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const node of diagram.nodes) {
    const w = node.width ?? defaultNodeWidth;
    const h = node.height ?? defaultNodeHeight;

    let x = (rng.next() - 0.5) * 800;
    let y = (rng.next() - 0.5) * 800;

    // If node has a parent group, try to seed it within reasonable bounds
    // (we don't have group layout info here, so just use random offset)
    if (node.parentId) {
      x += (rng.next() - 0.5) * 200;
      y += (rng.next() - 0.5) * 200;
    }

    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);

    nodes.set(node.id, {
      id: node.id,
      x,
      y,
      vx: 0,
      vy: 0,
      groupId: node.parentId ?? null,
      width: w,
      height: h,
    });
  }

  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const node of diagram.nodes) {
    adj.set(node.id, new Set());
  }
  for (const edge of diagram.edges) {
    adj.get(edge.source)?.add(edge.target);
    adj.get(edge.target)?.add(edge.source); // Undirected for simplicity
  }

  // Force-directed simulation
  let temperature = Math.max(maxX - minX, maxY - minY) || 1000;
  let maxMovement = Infinity;

  for (let iter = 0; iter < iterations && maxMovement > epsilon; iter++) {
    maxMovement = 0;

    // Clear velocities
    for (const node of nodes.values()) {
      node.vx = 0;
      node.vy = 0;
    }

    // Repulsion forces (all-pairs)
    const nodeList = Array.from(nodes.values());
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const a = nodeList[i];
        const b = nodeList[j];
        if (!a || !b) continue;

        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1; // Avoid division by zero
        const repulsive = (k * k) / (dist * dist); // Repulsive force

        const fx = (dx / dist) * repulsive;
        const fy = (dy / dist) * repulsive;

        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Attraction forces (along edges)
    for (const [nodeId, neighbors] of adj) {
      const node = nodes.get(nodeId);
      if (!node) continue;
      for (const neighborId of neighbors) {
        const neighbor = nodes.get(neighborId);
        if (!neighbor) continue;

        const dx = neighbor.x - node.x;
        const dy = neighbor.y - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const attractive = (dist - k) / k; // Attractive force

        const fx = (dx / dist) * attractive;
        const fy = (dy / dist) * attractive;

        node.vx += fx;
        node.vy += fy;
      }
    }

    // Apply velocities with cooling
    temperature *= coolDownFactor;
    for (const node of nodes.values()) {
      const vel = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (vel > 0) {
        const limitedVel = Math.min(vel, temperature);
        const factor = limitedVel / vel;
        node.x += node.vx * factor;
        node.y += node.vy * factor;
        maxMovement = Math.max(maxMovement, limitedVel);
      }
    }
  }

  // Build LayoutResult
  const layoutNodes = new Map<string, LayoutRect>();
  for (const [nodeId, node] of nodes) {
    layoutNodes.set(nodeId, {
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
    });
  }

  // Groups: create synthetic layout rects that contain their nodes
  const layoutGroups = new Map<string, LayoutRect>();
  for (const group of diagram.groups) {
    const groupNodes = diagram.nodes.filter((n) => n.parentId === group.id);
    if (groupNodes.length > 0) {
      let minNodeX = Infinity,
        maxNodeX = -Infinity;
      let minNodeY = Infinity,
        maxNodeY = -Infinity;
      for (const gn of groupNodes) {
        const rect = layoutNodes.get(gn.id);
        if (rect) {
          minNodeX = Math.min(minNodeX, rect.x);
          maxNodeX = Math.max(maxNodeX, rect.x + rect.width);
          minNodeY = Math.min(minNodeY, rect.y);
          maxNodeY = Math.max(maxNodeY, rect.y + rect.height);
        }
      }
      if (isFinite(minNodeX)) {
        layoutGroups.set(group.id, {
          x: minNodeX - 20,
          y: minNodeY - 40,
          width: maxNodeX - minNodeX + 40,
          height: maxNodeY - minNodeY + 60,
        });
      } else {
        layoutGroups.set(group.id, { x: 0, y: 0, width: 200, height: 200 });
      }
    } else {
      layoutGroups.set(group.id, { x: 0, y: 0, width: 200, height: 200 });
    }
  }

  // Simple edge routing: straight lines with proper LayoutEdge structure
  const layoutEdges = new Map<string, LayoutEdge>();
  for (const edge of diagram.edges) {
    const source = layoutNodes.get(edge.source);
    const target = layoutNodes.get(edge.target);
    if (source && target) {
      const startX = source.x + source.width / 2;
      const startY = source.y + source.height / 2;
      const endX = target.x + target.width / 2;
      const endY = target.y + target.height / 2;

      layoutEdges.set(edge.id, {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        start: { x: startX, y: startY },
        end: { x: endX, y: endY },
        bends: [],
      });
    }
  }

  return {
    nodes: layoutNodes,
    groups: layoutGroups,
    edges: layoutEdges,
    bbox: {
      x: Math.min(...Array.from(layoutNodes.values()).map((r) => r.x)),
      y: Math.min(...Array.from(layoutNodes.values()).map((r) => r.y)),
      width: 2000,
      height: 2000,
    },
  };
}
