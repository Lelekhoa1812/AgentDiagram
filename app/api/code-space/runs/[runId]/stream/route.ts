import { getEventStore } from '@/lib/code-space/runtime';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { runId: string } }) {
  return new Response(getEventStore().stream(params.runId, req.signal), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

