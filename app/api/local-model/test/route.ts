import { NextRequest } from 'next/server';
import { z } from 'zod';

const BodySchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional().default(''),
});

export async function POST(req: NextRequest) {
  const result = BodySchema.safeParse(await req.json());
  if (!result.success) {
    return Response.json({ ok: false, error: result.error.message }, { status: 400 });
  }

  const { baseUrl, apiKey } = result.data;
  const url = `${baseUrl.replace(/\/$/, '')}/models`;

  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    if (!res.ok) {
      return Response.json({ ok: false, error: `Server returned HTTP ${res.status}` });
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const models = json.data?.map((m) => m.id) ?? [];
    return Response.json({ ok: true, models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed';
    return Response.json({ ok: false, error: msg });
  }
}
