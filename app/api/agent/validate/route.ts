import { NextResponse } from 'next/server';
import { z } from 'zod';
import { makeProvider, PROVIDER_ENV } from '@/lib/agent/providers';

export const runtime = 'nodejs';

const Body = z.object({
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry']),
  model: z.string(),
  apiKey: z.string().optional(),
  endpoint: z.string().optional(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }
  const cfg = parsed.data;
  const apiKey = cfg.apiKey?.trim() || process.env[PROVIDER_ENV[cfg.provider]] || '';
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: `No API key. Set ${PROVIDER_ENV[cfg.provider]} or enter one in the UI.`,
    });
  }
  try {
    const provider = makeProvider(cfg.provider, {
      apiKey,
      endpoint: cfg.endpoint || process.env.FOUNDRY_ENDPOINT,
    });
    const result = await provider.validate(cfg.model);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg });
  }
}
