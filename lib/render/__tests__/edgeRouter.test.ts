import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IREdge } from '@/lib/ir/types';
import type { LayoutResult } from '@/lib/layout/elk';

interface RouteRequest {
  requestId: number;
  edges: IREdge[];
}

type Listener = (event: MessageEvent<unknown>) => void;

const workers: FakeWorker[] = [];

class FakeWorker {
  listeners = new Map<string, Set<Listener>>();
  terminated = false;
  posts: RouteRequest[] = [];

  constructor() {
    workers.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener]));
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: RouteRequest) {
    this.posts.push(message);
    const delay = message.requestId === 1 ? 20 : 0;
    setTimeout(() => {
      if (this.terminated) return;
      const data = message.edges.map((edge: IREdge) => ({
        requestId: message.requestId,
        edgeId: edge.id,
        path: `M 0 0 L ${message.requestId} ${message.requestId}`,
        points: [
          { x: 0, y: 0 },
          { x: message.requestId, y: message.requestId },
        ],
        labelPoint: { x: message.requestId, y: message.requestId },
      }));
      this.emit('message', { data });
    }, delay);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: string, event: { data?: unknown; message?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as MessageEvent<unknown>);
    }
  }
}

function edge(id: string): IREdge {
  return {
    id,
    source: 'a',
    target: 'b',
    kind: 'fwd',
    label: null,
    color: null,
    style: null,
  };
}

const layout: LayoutResult = {
  nodes: new Map([
    ['a', { x: 0, y: 0, width: 100, height: 40 }],
    ['b', { x: 200, y: 0, width: 100, height: 40 }],
  ]),
  groups: new Map(),
  edges: new Map(),
  bbox: { x: 0, y: 0, width: 300, height: 40 },
};

describe('routeAllEdgesAsync', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    workers.length = 0;
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('matches out-of-order worker responses by request id', async () => {
    const { routeAllEdgesAsync } = await import('../edgeRouter');

    const first = routeAllEdgesAsync([edge('first')], layout, undefined, new Map(), 1_000);
    const second = routeAllEdgesAsync([edge('second')], layout, undefined, new Map(), 1_000);

    await vi.advanceTimersByTimeAsync(25);

    await expect(first).resolves.toEqual(
      new Map([
        [
          'first',
          {
            path: 'M 0 0 L 1 1',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
            labelPoint: { x: 1, y: 1 },
          },
        ],
      ]),
    );
    await expect(second).resolves.toEqual(
      new Map([
        [
          'second',
          {
            path: 'M 0 0 L 2 2',
            points: [
              { x: 0, y: 0 },
              { x: 2, y: 2 },
            ],
            labelPoint: { x: 2, y: 2 },
          },
        ],
      ]),
    );
  });

  it('rejects and restarts the worker when routing times out', async () => {
    class SilentWorker extends FakeWorker {
      override postMessage(message: RouteRequest) {
        this.posts.push(message);
      }
    }
    vi.stubGlobal('Worker', SilentWorker);
    const { routeAllEdgesAsync } = await import('../edgeRouter');

    const routed = routeAllEdgesAsync([edge('slow')], layout, undefined, new Map(), 20);
    const expectation = expect(routed).rejects.toThrow('Edge routing timed out');
    await vi.advanceTimersByTimeAsync(21);

    await expectation;
    expect(workers[0]?.terminated).toBe(true);
  });
});
