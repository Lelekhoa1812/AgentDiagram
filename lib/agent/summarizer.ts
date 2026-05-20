import { z } from 'zod';
import { chatWithRetry, type ProviderSession, type RetryListener } from './providers';
import { readCache, writeCache } from './cache';
import { sha1 } from '../util/hash';

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
  exports: z.array(z.string()).max(20),
  imports: z.array(z.string()).max(30),
  surface: z.array(z.string()).max(25).describe('Public surface: function / class / route / table names'),
  external_deps: z.array(z.string()).max(20).describe('External packages / services used (e.g. stripe, redis, openai)'),
  side_effects: z.array(z.string()).max(15).describe('Notable side effects (db writes, HTTP calls, queue publishes, env reads)'),
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
    exports: { type: 'array', items: { type: 'string' } },
    imports: { type: 'array', items: { type: 'string' } },
    surface: { type: 'array', items: { type: 'string' } },
    external_deps: { type: 'array', items: { type: 'string' } },
    side_effects: { type: 'array', items: { type: 'string' } },
    notes: { type: ['string', 'null'] },
  },
  // Root Cause vs Logic: OpenAI strict JSON schema rejects optional object properties unless every property is listed as required, so nullable fields carry "not supplied" intent without breaking structured output validation.
  required: ['role', 'category', 'layer', 'exports', 'imports', 'surface', 'external_deps', 'side_effects', 'notes'],
  additionalProperties: false,
};

export async function summarizeFile(
  session: ProviderSession,
  filePath: string,
  content: string,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<FileSummary> {
  const key = `summary-${sha1(`${session.id}|${session.model}|v3|${filePath}|${content}`)}`;
  const cached = await readCache<FileSummary>(key);
  if (cached) return cached;

  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a senior software architect summarizing a single source file for downstream diagram planning. ' +
        'Identify the logical layer (client/edge/gateway/identity/service/async/data/analytics/storage/observability/platform/devx/integration/ai/billing/other). ' +
        'Capture the public surface (exported names, route paths, table names) and external dependencies (npm packages, AWS services, third-party APIs). ' +
        'Note notable side effects (db writes, HTTP calls, queue publishes, env-var reads). ' +
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

  const parsed = FileSummarySchema.parse(JSON.parse(raw));
  await writeCache(key, parsed);
  return parsed;
}
