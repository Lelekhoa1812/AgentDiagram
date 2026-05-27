import { promises as fs } from 'node:fs';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCodeSpaceImageContentType, isCodeSpaceImagePath, resolveCodeSpaceChild } from '@/lib/code-space/runtime/filePaths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  rootPath: z.string().min(1),
  path: z.string().min(1),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    rootPath: url.searchParams.get('rootPath') ?? undefined,
    path: url.searchParams.get('path') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  }

  if (!isCodeSpaceImagePath(parsed.data.path)) {
    return NextResponse.json({ error: 'Only image assets can be served here' }, { status: 400 });
  }

  const resolved = resolveCodeSpaceChild(parsed.data.rootPath, parsed.data.path);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const contentType = getCodeSpaceImageContentType(resolved.rel);
  if (!contentType) return NextResponse.json({ error: 'Unsupported image type' }, { status: 415 });

  try {
    const body = await fs.readFile(resolved.child);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
