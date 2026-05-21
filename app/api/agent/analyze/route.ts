import { z } from 'zod';
import { runPipeline } from '@/lib/agent/pipeline';
import { makeSseStream } from '@/lib/util/stream';
import { methodNotAllowedResponse } from '@/lib/util/http';
import { PROVIDER_ENV } from '@/lib/agent/providers';
import { resolveRepoSource } from '@/lib/agent/repoSourceResolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  sourceType: z.enum(['local', 'github']).optional(),
  rootPath: z.string().optional(),
  githubUrl: z.string().optional(),
  githubPat: z.string().optional(),
  kind: z.enum(['architecture', 'sequence', 'class', 'data-flow', 'deployment']).default('architecture'),
  focus: z.string().default(''),
  topK: z.number().int().min(5).max(120).optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
  quickMode: z.boolean().optional().default(false),
});

const analyzeMethodNotAllowed = () =>
  methodNotAllowedResponse(
    'POST with repo info, provider creds, and analysis settings is required to run the pipeline.',
    ['POST'],
  );

export function GET() {
  return analyzeMethodNotAllowed();
}

export function HEAD() {
  return analyzeMethodNotAllowed();
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
        error: `No API key found for ${cfg.provider}. Set ${PROVIDER_ENV[cfg.provider]} in .env.local or enter a key in the UI.`,
      }),
      { status: 400 },
    );
  }

  const source =
    cfg.sourceType === 'github'
      ? await resolveRepoSource({ sourceType: 'github', githubUrl: cfg.githubUrl ?? '', githubPat: cfg.githubPat })
      : await resolveRepoSource({ sourceType: 'local', rootPath: cfg.rootPath });
  if (!source.ok) {
    return new Response(JSON.stringify({ error: source.message, code: source.code, details: source.details }), { status: 400 });
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
      rootPath: source.resolvedRootPath,
      session: { id: cfg.provider, model: cfg.model, apiKey, endpoint },
      kind: cfg.kind,
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
