import type { SseEvent } from '@/lib/util/stream';

export type AgentStreamEvent = SseEvent;

export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushBlocks = (input: string, keepRemainder: boolean) => {
    const blocks = input.split('\n\n');
    buffer = keepRemainder ? blocks.pop() ?? '' : '';

    for (const block of blocks) {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));
      if (!dataLines.length) continue;

      try {
        onEvent(JSON.parse(dataLines.join('\n')) as AgentStreamEvent);
      } catch {
        /* Ignore malformed SSE blocks so one bad progress event does not kill the run UI. */
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushBlocks(buffer, true);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    flushBlocks(buffer.endsWith('\n\n') ? buffer : `${buffer}\n\n`, false);
  }
}

export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `HTTP ${res.status}`;

  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : null;
    return message ?? text;
  } catch {
    return text;
  }
}
