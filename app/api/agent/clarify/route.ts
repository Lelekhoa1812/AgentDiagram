import { z } from 'zod';
import { runClarify } from '@/lib/agent/customPipeline';
import { makeSseStream } from '@/lib/util/stream';
import { PROVIDER_ENV } from '@/lib/agent/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  prompt: z.string().min(4),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.message }), { status: 400 });
  }

  const cfg = parsed.data;
  const apiKey = cfg.apiKey?.trim() || process.env[PROVIDER_ENV[cfg.provider]] || '';
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        error: `No API key found for ${cfg.provider}. Set ${PROVIDER_ENV[cfg.provider]} in .env.local or enter a key in the UI.`,
      }),
      { status: 400 },
    );
  }

  const endpoint =
    cfg.endpoint?.trim() ||
    (cfg.provider === 'foundry'
      ? process.env.FOUNDRY_ENDPOINT
      : cfg.provider === 'grok'
      ? process.env.GROK_API_BASE
      : undefined);

  const { stream, send, close } = makeSseStream();
  const ac = new AbortController();
  req.signal.addEventListener('abort', () => ac.abort());

  runClarify(
    {
      session: { id: cfg.provider, model: cfg.model, apiKey, endpoint },
      prompt: cfg.prompt,
      signal: ac.signal,
    },
    send,
  )
    .catch((err) => {
      send({ type: 'error', stage: 'pipeline', message: err instanceof Error ? err.message : String(err) });
      send({ type: 'done' });
    })
    .finally(() => close());

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
