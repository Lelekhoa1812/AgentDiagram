/**
 * SSE helpers — encodes objects as server-sent event lines and lets the
 * agent pipeline push progress notices to the browser.
 */
export interface MultiLayerStreamOutput {
  overview: { name: string; description: string; dsl: string };
  layers: Array<{ name: string; description: string; dsl: string }>;
  generatedAt: number;
}

export interface ClarifyStreamOutput {
  intent_summary: string;
  questions: Array<{
    id: string;
    question: string;
    rationale: string;
    options: Array<{ label: string; description: string }>;
    allow_multiple: boolean;
  }>;
}

export type SseEvent =
  | { type: 'stage'; stage: string; status: 'start' | 'progress' | 'done' | 'error'; percent?: number; message?: string; counters?: Record<string, number> }
  | { type: 'retry'; stage: string; attempt: number; delayMs: number; reason: string }
  | { type: 'log'; stage: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; dsl: string; instructionMarkdown?: string }
  | { type: 'result-multilayer'; output: MultiLayerStreamOutput; instructionMarkdown?: string }
  | { type: 'result-clarify'; output: ClarifyStreamOutput }
  | { type: 'error'; stage: string; message: string }
  | { type: 'done' };

export function sseEncode(ev: SseEvent): Uint8Array {
  const lines = `data: ${JSON.stringify(ev)}\n\n`;
  return new TextEncoder().encode(lines);
}

export function makeSseStream(): {
  stream: ReadableStream<Uint8Array>;
  send: (ev: SseEvent) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
    },
  });
  return {
    stream,
    send: (ev) => {
      if (!controller) return;
      try {
        controller.enqueue(sseEncode(ev));
      } catch {
        /* ignore */
      }
    },
    close: () => {
      if (!controller) return;
      try {
        controller.close();
      } catch {
        /* ignore */
      }
      controller = null;
    },
  };
}
