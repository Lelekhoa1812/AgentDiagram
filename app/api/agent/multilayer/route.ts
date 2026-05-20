import { z } from 'zod';
import { runMultiLayerPipeline } from '@/lib/agent/multilayer';
import { makeSseStream } from '@/lib/util/stream';
import { methodNotAllowedResponse } from '@/lib/util/http';
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
  focus: z.string().default(''),
  topK: z.number().int().min(10).max(200).optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
  quickMode: z.boolean().optional().default(false),
});

const multilayerMethodNotAllowed = () =>
  methodNotAllowedResponse(
    'POST with provider creds, repo path, and pipeline knobs is required to generate a multilayer overview.',
    ['POST'],
  );

// Motivation vs Logic: avoid the generic 404 page by clearly stating that this SSE endpoint is POST-only.
export function GET() {
  return multilayerMethodNotAllowed();
}

export function HEAD() {
  return multilayerMethodNotAllowed();
}

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
        error: `No API key for ${cfg.provider}. Set ${PROVIDER_ENV[cfg.provider]} or enter one in the UI.`,
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

  runMultiLayerPipeline(
    {
      rootPath: guard.resolved,
      session: { id: cfg.provider, model: cfg.model, apiKey, endpoint },
      focus: cfg.focus,
      topK: cfg.topK,
      ignoredFolders: cfg.ignoredFolders,
      quickMode: cfg.quickMode,
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
