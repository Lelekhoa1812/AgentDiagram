import { z } from 'zod';
import { runPipeline } from '@/lib/agent/pipeline';
import { makeSseStream } from '@/lib/util/stream';
import { guardPath, defaultRepoPath } from '@/lib/security/pathGuard';
import { PROVIDER_ENV } from '@/lib/agent/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  rootPath: z.string().optional(),
  kind: z.enum(['architecture', 'sequence', 'class', 'data-flow', 'deployment']).default('architecture'),
  focus: z.string().default(''),
  topK: z.number().int().min(5).max(120).optional(),
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

  const rootPath = cfg.rootPath || defaultRepoPath();
  const guard = guardPath(rootPath);
  if (!guard.ok) {
    return new Response(JSON.stringify({ error: guard.reason }), { status: 400 });
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

  runPipeline(
    {
      rootPath: guard.resolved,
      session: { id: cfg.provider, model: cfg.model, apiKey, endpoint },
      kind: cfg.kind,
      focus: cfg.focus,
      topK: cfg.topK,
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
