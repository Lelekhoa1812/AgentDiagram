import { z } from 'zod';
import { type ProviderSession, type RetryListener } from './providers';
import { chatStructuredWithRetry } from './structuredOutput';
import type { FileSummary } from './summarizer';
import type { RepoMap } from './repoScanner';
import type { DiagramKind } from './classifier';
import type { ImportGraph } from './importGraph';
import type { DocPrior } from './docReader';
import type { RepoContextDigest } from './repoContext';
import type { AnalysisDigest } from './analysisBudget';
import { COLOR_NAMES } from '../ir/types';
import { knownIconNames } from '../icons/registry';

export const DiagramPlanSchema = z.object({
  title: z.string(),
  groups: z.array(
    z.object({
      name: z.string(),
      color: z.string(),
      icon: z.string(),
      children: z.array(z.string()),
      parent: z.string().nullable(),
    }),
  ),
  nodes: z.array(
    z.object({
      name: z.string(),
      color: z.string(),
      icon: z.string(),
      parent: z.string().nullable(),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      kind: z.enum(['fwd', 'bwd', 'bi', 'dashed', 'thick']),
      label: z.string().nullable().optional(),
    }),
  ),
  uncertainties: z.array(z.string()),
  omitted: z.array(z.string()),
});
export type DiagramPlan = z.infer<typeof DiagramPlanSchema>;

const COLORS = [
  'orange', 'green', 'yellow', 'amber', 'coral', 'teal', 'slate',
  'indigo', 'blue', 'purple', 'lime', 'sky', 'red', 'pink', 'gray',
];

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          icon: { type: 'string' },
          children: { type: 'array', items: { type: 'string' } },
          parent: { type: ['string', 'null'] },
        },
        required: ['name', 'color', 'icon', 'children', 'parent'],
        additionalProperties: false,
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          icon: { type: 'string' },
          parent: { type: ['string', 'null'] },
        },
        required: ['name', 'color', 'icon', 'parent'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          kind: { type: 'string', enum: ['fwd', 'bwd', 'bi', 'dashed', 'thick'] },
          label: { type: ['string', 'null'] },
        },
        // Root Cause vs Logic: Strict JSON-schema providers require every declared property in "required"; nullable labels preserve optional semantics while keeping schema validation compatible.
        required: ['source', 'target', 'kind', 'label'],
        additionalProperties: false,
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    omitted: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'groups', 'nodes', 'edges', 'uncertainties', 'omitted'],
  additionalProperties: false,
};

const ICON_GUIDANCE = `Available icons: ${knownIconNames().join(', ')}.`;

const COLOR_GUIDANCE = `Color palette: ${COLOR_NAMES.join(', ')}. Use distinct colors per top-level group so
the rendered diagram is easy to read.`;

export interface PlanInput {
  repoMap: RepoMap;
  summaries: Array<{ path: string; summary: FileSummary }>;
  imports: ImportGraph;
  docs: DocPrior[];
  repoContext?: RepoContextDigest;
  analysisDigest?: AnalysisDigest;
  kind: DiagramKind;
  focus: string;
  /** Optional: restrict planning to a single named layer */
  layerFocus?: string;
  /**
   * Quick Mode flag: summaries will be empty; the planner should rely entirely on
   * the deterministic structural digest (folder clusters, central files, routes,
   * exports, env vars, cross-folder edges) and the import graph.
   */
  quickMode?: boolean;
}

function compactImports(graph: ImportGraph, maxLines = 80): string {
  const lines: string[] = [];
  for (const [from, tos] of graph.files) {
    if (tos.length === 0) continue;
    const slice = tos.slice(0, 8).join(', ');
    lines.push(`${from} → ${slice}${tos.length > 8 ? ` (+${tos.length - 8} more)` : ''}`);
    if (lines.length >= maxLines) break;
  }
  return lines.join('\n');
}

function compactExternals(graph: ImportGraph, topN = 24): string {
  return [...graph.externals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([m, c]) => `${m} (${c}x)`)
    .join(', ');
}

function compactSummaries(summaries: PlanInput['summaries'], maxItems = summaries.length): string {
  const clipped = summaries.slice(0, maxItems);
  const omitted = summaries.length > clipped.length ? `\n- ... ${summaries.length - clipped.length} additional file summaries omitted; use the analysis digest/module rollups above.` : '';
  return clipped
    .map((s) => {
      const ext = s.summary.external_deps.slice(0, 6).join(', ');
      const side = s.summary.side_effects.slice(0, 4).join('; ');
      const surface = s.summary.surface.slice(0, 6).join(', ');
      return `- ${s.path} [${s.summary.layer}/${s.summary.category}] ${s.summary.role}\n    surface: ${surface}\n    externals: ${ext}\n    side-effects: ${side}`;
    })
    .join('\n') + omitted;
}

function compactDocs(docs: DocPrior[]): string {
  return docs
    .map((d) => `\n### ${d.path} (${d.kind})\n${d.excerpt.slice(0, 2500)}`)
    .join('\n');
}

function compactRepoContext(ctx: RepoContextDigest | undefined): string {
  if (!ctx) return '(not available)';
  const clusters = ctx.folderClusters
    .slice(0, 16)
    .map(
      (c) =>
        `- ${c.folder}: ${c.fileCount} files, in ${c.importsIn}, out ${c.importsOut}; reps: ${c.representativeFiles
          .slice(0, 5)
          .join(', ')}; externals: ${c.externalDeps.slice(0, 6).join(', ')}`,
    )
    .join('\n');
  const central = ctx.centralFiles
    .slice(0, 18)
    .map((f) => `- ${f.path}: in ${f.incoming}, out ${f.outgoing}; externals: ${f.externalDeps.join(', ')}`)
    .join('\n');
  const routes = ctx.routes
    .slice(0, 20)
    .map((r) => `- ${r.route}: ${r.path}${r.methods.length ? ` (${r.methods.join(', ')})` : ''}`)
    .join('\n');
  const exports = ctx.exportsByFile
    .slice(0, 24)
    .map((e) => `- ${e.path}: ${e.symbols.slice(0, 10).join(', ')}`)
    .join('\n');
  const envVars = ctx.envVars
    .slice(0, 18)
    .map((e) => `- ${e.name}: ${e.files.slice(0, 5).join(', ')}`)
    .join('\n');
  const boundaries = ctx.crossFolderEdges
    .slice(0, 20)
    .map((e) => `- ${e.sourceFolder} → ${e.targetFolder}: ${e.edgeCount} edges; ${e.examples.map((x) => `${x.from}→${x.to}`).join('; ')}`)
    .join('\n');

  return [
    `Signals: manifests=${ctx.signals.manifests.join(', ') || 'none'}; schemas=${ctx.signals.schemas.join(', ') || 'none'}; infra=${ctx.signals.infra.join(', ') || 'none'}; tests=${ctx.signals.tests}`,
    '',
    'Folder clusters:',
    clusters || '(none)',
    '',
    'Central files:',
    central || '(none)',
    '',
    'Routes:',
    routes || '(none)',
    '',
    'Exports:',
    exports || '(none)',
    '',
    'Environment variables:',
    envVars || '(none)',
    '',
    'Cross-folder dependency edges:',
    boundaries || '(none)',
  ].join('\n');
}

export function compactAnalysisDigest(digest: AnalysisDigest | undefined): string {
  if (!digest) return '(not available)';
  const rollups = digest.moduleRollups
    .slice(0, 36)
    .map(
      (module) =>
        `- ${module.module}: ${module.fileCount} files; deep ${module.deepFiles}, signatures ${module.signatureFiles}; reps: ${module.representativeFiles
          .slice(0, 5)
          .join(', ') || 'none'}; layers: ${module.layers.join(', ') || 'other'}; surface: ${module.surface
          .slice(0, 8)
          .join(', ') || 'none'}; externals: ${module.externalDeps.slice(0, 6).join(', ') || 'none'}`,
    )
    .join('\n');
  return [
    `${digest.label}: relevant=${digest.totalRelevantFiles}, analyzed=${digest.analyzedFiles}, deep=${digest.deepFiles}, signatures=${digest.signatureFiles}, structural=${digest.structuralFiles}, bypassed=${digest.bypassedFiles}`,
    `Notes: ${digest.notes.join(' ')}`,
    '',
    `Global externals: ${digest.global.externals.slice(0, 24).join(', ') || 'none'}`,
    `Central files: ${digest.global.centralFiles.slice(0, 18).join('; ') || 'none'}`,
    `Cross-folder edges: ${digest.global.crossFolderEdges.slice(0, 24).join('; ') || 'none'}`,
    '',
    'Module rollups:',
    rollups || '(none)',
  ].join('\n');
}

function plannerSummaryLimit(input: PlanInput): number {
  if (!input.analysisDigest) return input.summaries.length;
  return input.analysisDigest.tier <= 2 ? Math.min(input.summaries.length, 420) : Math.min(input.summaries.length, 120);
}

export function buildPlanUserMessage(input: PlanInput): string {
  return [
    `Diagram type: ${input.kind}`,
    input.layerFocus ? `Layer focus: ${input.layerFocus} — only include components in this layer plus their immediate boundaries.` : '',
    input.quickMode
      ? `Mode: QUICK — per-file summaries are intentionally unavailable. Ground the diagram in the deterministic repo context, import graph, routes, exports, env vars, and docs below. Prefer folder clusters as group boundaries; use representative files within each cluster as nodes.`
      : '',
    input.analysisDigest
      ? `Analysis tier: ${input.analysisDigest.label}. Prefer the compact analysis digest and module rollups over enumerating individual files when the repo is large.`
      : '',
    `Focus: ${input.focus || '(none — give a general architecture view)'}`,
    `Stack: ${input.repoMap.likelyStack.join(', ') || 'unknown'}`,
    `Top-level files: ${input.repoMap.entrypoints.map((f) => f.path).slice(0, 12).join(', ')}`,
    `Top external dependencies: ${compactExternals(input.imports)}`,
    `Folder count: ${new Set(input.repoMap.files.map((f) => f.path.split('/')[0])).size}`,
    '',
    `## Deterministic repo context`,
    compactRepoContext(input.repoContext),
    '',
    `## Progressive analysis digest`,
    compactAnalysisDigest(input.analysisDigest),
    '',
    `## Documentation priors`,
    input.docs.length ? compactDocs(input.docs) : '(no documentation found)',
    '',
    input.quickMode
      ? `## File summaries\n(skipped — Quick Mode)`
      : `## File summaries (showing ${plannerSummaryLimit(input)} of ${input.summaries.length})\n${compactSummaries(input.summaries, plannerSummaryLimit(input))}`,
    '',
    `## Import graph (sample)`,
    compactImports(input.imports),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generatePlan(
  session: ProviderSession,
  input: PlanInput,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<DiagramPlan> {
  const userMsg = buildPlanUserMessage(input);

  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a senior software architect generating a system diagram plan from a repository scan. ` +
        `Output a DiagramPlan strictly conforming to the JSON schema — no prose outside it. ` +
        `\n\nPLANNING RULES:\n` +
        `1. Group by logical layer first (gateway, services, data, async, observability, etc.); use the supplied per-file 'layer' field as a strong hint.\n` +
        `2. 5-12 top-level groups is ideal. Inside each, list the concrete components (services, tables, queues, third-party integrations).\n` +
        `3. Edges represent real dependencies / data flow / publishes — use the import graph and side-effects to ground them. Mark bidirectional with kind="bi", primary hot paths with "thick", and weak/observability links with "dashed".\n` +
        `4. Include third-party integrations as separate nodes inside an "Integrations" group when relevant.\n` +
        `5. Stable, short, human-readable names — they will be displayed in a diagram.\n` +
        `6. Keep the diagram readable: 40-90 nodes total. If the repo is very large, prefer groups over individual files; list omitted detail under 'omitted'.\n` +
        `7. If the layerFocus field is set, restrict the plan to that layer plus immediate boundary nodes (one hop out).\n\n` +
        `8. Prefer names and boundaries from the deterministic repo context when it conflicts with vague file summaries.\n` +
        (input.quickMode
          ? `9. QUICK MODE: per-file summaries are unavailable. Build the plan from folder clusters (treat each as a candidate group), central files, routes, exports, env vars, cross-folder edges, and the import graph. Keep the diagram skeletal — group-level over file-level when in doubt.\n\n`
          : '\n') +
        ICON_GUIDANCE + '\n\n' + COLOR_GUIDANCE,
    },
    { role: 'user' as const, content: userMsg },
  ];

  return chatStructuredWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: SCHEMA,
    schema: DiagramPlanSchema,
  });
}

// =========================================================================
// Layer identification (for multi-layer mode)
// =========================================================================

export const LayerCatalogSchema = z.object({
  layers: z
    .array(
      z.object({
        name: z.string().describe('Short layer name (Title Case)'),
        description: z.string().describe('1-2 sentence purpose'),
        color: z.string(),
        icon: z.string(),
        member_files: z.array(z.string()).describe('Subset of supplied file paths assigned to this layer'),
        external_deps: z.array(z.string()),
        representative_files: z.array(z.string()).describe('Small set of the most representative files for this layer'),
        boundary_deps: z.array(z.string()).describe('External layers, folders, packages, or services this layer touches'),
      }),
    )
    .min(3)
    .max(10),
  cross_layer_edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      kind: z.enum(['fwd', 'bwd', 'bi', 'dashed', 'thick']),
      label: z.string().nullable().optional(),
    }),
  ),
});
export type LayerCatalog = z.infer<typeof LayerCatalogSchema>;

const LAYER_CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    layers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          icon: { type: 'string' },
          member_files: { type: 'array', items: { type: 'string' } },
          external_deps: { type: 'array', items: { type: 'string' } },
          representative_files: { type: 'array', items: { type: 'string' } },
          boundary_deps: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'color', 'icon', 'member_files', 'external_deps', 'representative_files', 'boundary_deps'],
        additionalProperties: false,
      },
    },
    cross_layer_edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          kind: { type: 'string', enum: ['fwd', 'bwd', 'bi', 'dashed', 'thick'] },
          label: { type: ['string', 'null'] },
        },
        // Root Cause vs Logic: Strict JSON-schema providers reject optional properties that are not required, so layer-edge labels are nullable rather than omitted.
        required: ['source', 'target', 'kind', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['layers', 'cross_layer_edges'],
  additionalProperties: false,
};

export async function identifyLayers(
  session: ProviderSession,
  input: PlanInput,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<LayerCatalog> {
  const layerSummaryLimit = input.analysisDigest?.tier && input.analysisDigest.tier >= 3 ? 160 : input.summaries.length;
  const userMsg = [
    `Stack: ${input.repoMap.likelyStack.join(', ') || 'unknown'}`,
    `Top externals: ${compactExternals(input.imports, 30)}`,
    input.quickMode
      ? `Mode: QUICK — per-file summaries are intentionally unavailable. Derive layers from folder clusters, central files, routes, exports, env vars, and cross-folder dependency edges below. Treat each cohesive folder cluster as a layer candidate.`
      : '',
    '',
    `## Deterministic repo context`,
    compactRepoContext(input.repoContext),
    '',
    `## Progressive analysis digest`,
    compactAnalysisDigest(input.analysisDigest),
    '',
    `## Documentation`,
    input.docs.length ? compactDocs(input.docs) : '(none)',
    '',
    input.quickMode ? `## File summaries\n(skipped — Quick Mode)` : `## File summaries\n${compactSummaries(input.summaries, layerSummaryLimit)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a senior software architect breaking a repository into 3-10 architectural LAYERS for a multi-layer system diagram. ` +
        `Each layer should be cohesive (one concern), distinct from the others, and large enough to deserve its own sub-diagram. ` +
        `Typical layers in a modern web app: Clients, Edge, Gateway, Identity, Services, Async, Data, Analytics, Storage, Observability, Platform, DevX, Integrations, AI. ` +
        `Use the supplied per-file 'layer' field as the strongest signal. Assign every supplied file to exactly one layer (members lists may overlap minimally). ` +
        `For each layer, include representative_files and boundary_deps grounded in the deterministic repo context. ` +
        `Define cross-layer edges: how data and control move BETWEEN layers (not inside). ` +
        `Output JSON strictly matching the schema; no prose outside it.\n` +
        (input.quickMode
          ? `QUICK MODE: per-file summaries are unavailable. Drive layer identification from folder clusters (each cohesive cluster is a strong layer candidate), routes, central files, exports, env vars, and cross-folder dependency edges. Populate member_files / representative_files from those clusters.\n\n`
          : '\n') +
        ICON_GUIDANCE + '\n\n' + COLOR_GUIDANCE,
    },
    { role: 'user' as const, content: userMsg },
  ];

  return chatStructuredWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: LAYER_CATALOG_SCHEMA,
    schema: LayerCatalogSchema,
  });
}
