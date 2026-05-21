import { z } from 'zod';
import { runMultiLayerPipeline } from '@/lib/agent/multilayer';
import { makeSseStream } from '@/lib/util/stream';
import { methodNotAllowedResponse } from '@/lib/util/http';
import { defaultRepoPath } from '@/lib/security/pathGuard';
import { PROVIDER_ENV } from '@/lib/agent/providers';
import { RepoSourceError, resolveRepoSource } from '@/lib/agent/repoSource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
  rootPath: z.string().optional(),
  allowSensitive: z.boolean().optional(),
  focus: z.string().default(''),
  topK: z.number().int().min(10).max(200).optional(),
  ignoredFolders: z.array(z.string()).max(100).optional(),
  quickMode: z.boolean().optional().default(false),
  source: z
    .object({
      sourceType: z.enum(['local', 'github']).optional(),
      repoPath: z.string().optional(),
      repoUrl: z.string().url().optional(),
      authMode: z.enum(['none', 'pat']).optional(),
      pat: z.string().optional(),
    })
    .partial()
    .optional(),
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

  let rootPath: string;
  try {
    const resolved = await resolveRepoSource({
      path: cfg.rootPath ?? defaultRepoPath(),
      allowSensitive: cfg.allowSensitive,
      source: cfg.source
        ? {
            sourceType: cfg.source.sourceType,
            repoPath: cfg.source.repoPath,
            repoUrl: cfg.source.repoUrl,
            authMode: cfg.source.authMode,
            pat: cfg.source.pat,
          }
        : undefined,
    });
    rootPath = resolved.rootPath;
  } catch (err) {
    if (err instanceof RepoSourceError && err.code === 'PAT_REQUIRED') {
      return new Response(JSON.stringify({ error: err.message, code: err.code }), { status: 401 });
    }
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 400 });
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
      rootPath,
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
