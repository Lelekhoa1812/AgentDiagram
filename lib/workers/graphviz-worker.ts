import type { Diagram } from '../ir/types';
import type { LayoutOptions } from '../layout/elk';
import { layoutWithGraphvizDirect, serializeLayoutResult } from '../layout/graphviz';

interface GraphvizWorkerRequest {
  requestId: number;
  diagram: Diagram;
  opts: LayoutOptions;
  kind: 'layout' | 'prewarm';
}

self.onmessage = async (event: MessageEvent<GraphvizWorkerRequest>) => {
  const { requestId, diagram, opts, kind } = event.data;

  try {
    if (kind === 'prewarm') {
      await layoutWithGraphvizDirect(diagram, opts);
      self.postMessage({ requestId });
      return;
    }

    const result = await layoutWithGraphvizDirect(diagram, opts);
    self.postMessage({ requestId, result: serializeLayoutResult(result) });
  } catch (err) {
    self.postMessage({
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
