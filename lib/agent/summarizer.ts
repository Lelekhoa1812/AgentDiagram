import { z } from 'zod';
import { chatWithRetry, type ProviderSession, type RetryListener } from './providers';
import { readCache, writeCache } from './cache';
import { chunkFile } from './chunker';
import { sha1 } from '../util/hash';

const LIMITS = {
  exports: 20,
  imports: 30,
  surface: 25,
  external_deps: 20,
  side_effects: 15,
} as const;

export const FileSummarySchema = z.object({
  role: z.string().describe('1-sentence role of this file in the system'),
  category: z.enum([
    'api',
    'component',
    'service',
    'config',
    'schema',
    'util',
    'test',
    'doc',
    'infra',
    'worker',
    'client',
    'ai',
    'other',
  ]),
  layer: z.enum([
    'client',
    'edge',
    'gateway',
    'identity',
    'service',
    'async',
    'data',
    'analytics',
    'storage',
    'observability',
    'platform',
    'devx',
    'integration',
    'ai',
    'billing',
    'other',
  ]).describe('Logical layer this file belongs to in a multi-layer architecture'),
  exports: z.array(z.string()).max(LIMITS.exports),
  imports: z.array(z.string()).max(LIMITS.imports),
  surface: z.array(z.string()).max(LIMITS.surface).describe('Public surface: function / class / route / table names'),
  external_deps: z.array(z.string()).max(LIMITS.external_deps).describe('External packages / services used (e.g. stripe, redis, openai)'),
  side_effects: z.array(z.string()).max(LIMITS.side_effects).describe('Notable side effects (db writes, HTTP calls, queue publishes, env reads)'),
  notes: z.string().nullable().describe('Short notes on subsystem position / quirks').optional(),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

const SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    category: {
      type: 'string',
      enum: ['api', 'component', 'service', 'config', 'schema', 'util', 'test', 'doc', 'infra', 'worker', 'client', 'ai', 'other'],
    },
    layer: {
      type: 'string',
      enum: [
        'client', 'edge', 'gateway', 'identity', 'service', 'async', 'data', 'analytics',
        'storage', 'observability', 'platform', 'devx', 'integration', 'ai', 'billing', 'other',
      ],
    },
    exports: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.exports },
    imports: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.imports },
    surface: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.surface },
    external_deps: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.external_deps },
    side_effects: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.side_effects },
    notes: { type: ['string', 'null'] },
  },
  // Root Cause vs Logic: OpenAI strict JSON schema rejects optional object properties unless every property is listed as required, so nullable fields carry "not supplied" intent without breaking structured output validation.
  required: ['role', 'category', 'layer', 'exports', 'imports', 'surface', 'external_deps', 'side_effects', 'notes'],
  additionalProperties: false,
};

const LooseFileSummarySchema = FileSummarySchema.extend({
  exports: z.array(z.string()).default([]),
  imports: z.array(z.string()).default([]),
  surface: z.array(z.string()).default([]),
  external_deps: z.array(z.string()).default([]),
  side_effects: z.array(z.string()).default([]),
});

function uniqLimit(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeFileSummary(raw: unknown): FileSummary {
  const loose = LooseFileSummarySchema.parse(raw);
  // Root Cause vs Logic: providers can still overfill arrays despite schema hints; clamp and de-dupe before strict validation so one verbose file summary does not abort diagram generation.
  return FileSummarySchema.parse({
    ...loose,
    exports: uniqLimit(loose.exports, LIMITS.exports),
    imports: uniqLimit(loose.imports, LIMITS.imports),
    surface: uniqLimit(loose.surface, LIMITS.surface),
    external_deps: uniqLimit(loose.external_deps, LIMITS.external_deps),
    side_effects: uniqLimit(loose.side_effects, LIMITS.side_effects),
  });
}

function mostCommon<T extends string>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}

function mergeChunkSummaries(filePath: string, summaries: FileSummary[]): FileSummary {
  const roles = summaries.map((s) => s.role).filter(Boolean);
  const notes = summaries.map((s) => s.notes).filter((note): note is string => Boolean(note));

  return normalizeFileSummary({
    role: roles.length
      ? `${filePath} spans ${summaries.length} chunks: ${roles.slice(0, 4).join(' ')}`
      : `Summarized ${filePath} across ${summaries.length} chunks`,
    category: mostCommon(summaries.map((s) => s.category), 'other'),
    layer: mostCommon(summaries.map((s) => s.layer), 'other'),
    exports: summaries.flatMap((s) => s.exports),
    imports: summaries.flatMap((s) => s.imports),
    surface: summaries.flatMap((s) => s.surface),
    external_deps: summaries.flatMap((s) => s.external_deps),
    side_effects: summaries.flatMap((s) => s.side_effects),
    notes: notes.length ? notes.slice(0, 3).join(' | ') : null,
  });
}

export async function summarizeFile(
  session: ProviderSession,
  filePath: string,
  content: string,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<FileSummary> {
  const key = `summary-${sha1(`${session.id}|${session.model}|v4|${filePath}|${content}`)}`;
  const cached = await readCache<FileSummary>(key);
  if (cached) return cached;

  const chunks = chunkFile(filePath, content, 2200);
  const summary =
    chunks.length === 1
      ? await summarizeText(session, filePath, content, opts)
      : mergeChunkSummaries(filePath, await summarizeChunks(session, filePath, chunks, opts));

  await writeCache(key, summary);
  return summary;
}

async function summarizeChunks(
  session: ProviderSession,
  filePath: string,
  chunks: ReturnType<typeof chunkFile>,
  opts: { signal?: AbortSignal; onRetry?: RetryListener },
): Promise<FileSummary[]> {
  const summaries: FileSummary[] = [];
  for (const chunk of chunks) {
    summaries.push(
      await summarizeText(
        session,
        filePath,
        `Chunk ${chunk.index + 1} of ${chunk.total} for ${filePath} (${chunk.approxTokens} approx tokens).\n\n${chunk.text}`,
        opts,
      ),
    );
  }
  return summaries;
}

async function summarizeText(
  session: ProviderSession,
  filePath: string,
  content: string,
  opts: { signal?: AbortSignal; onRetry?: RetryListener },
): Promise<FileSummary> {
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a senior software architect summarizing a single source file for downstream diagram planning. ' +
        'Identify the logical layer (client/edge/gateway/identity/service/async/data/analytics/storage/observability/platform/devx/integration/ai/billing/other). ' +
        'Capture the public surface (exported names, route paths, table names) and external dependencies (npm packages, AWS services, third-party APIs). ' +
        'Note notable side effects (db writes, HTTP calls, queue publishes, env-var reads). ' +
        `Respect these hard caps: exports <= ${LIMITS.exports}, imports <= ${LIMITS.imports}, surface <= ${LIMITS.surface}, external_deps <= ${LIMITS.external_deps}, side_effects <= ${LIMITS.side_effects}. ` +
        'If there are more items, keep only the highest-signal architectural items. ' +
        'Output strictly conforms to the JSON schema. No prose, no markdown fences.',
    },
    {
      role: 'user' as const,
      content: `File path: ${filePath}\n\n----- BEGIN FILE -----\n${content}\n----- END FILE -----`,
    },
  ];

  const raw = await chatWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: SCHEMA,
  });

  return normalizeFileSummary(JSON.parse(raw));
}
