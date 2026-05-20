/**
 * Single-diagram pipeline (Agentic Explorer mode):
 *   1. Validate provider key
 *   2. Scan repo
 *   3. Classify files (heuristic)
 *   4. Read docs + extract import graph (deep context)
 *   5. Read & chunk relevant files
 *   6. Summarize (parallel, cached by content hash)
 *   7. Identify subsystems (heuristic + import-graph clusters)
 *   8. Plan diagram with all priors
 *   9. Compile plan → DSL
 *  10. Validate + repair
 */

import pLimit from 'p-limit';
import { AGENT_FILE_ALLOWLIST, scanRepo, readRepoFile } from './repoScanner';
import { classifyRelevance, type DiagramKind } from './classifier';
import { summarizeFile } from './summarizer';
import { generatePlan } from './planner';
import { planToDsl } from './dslCompiler';
import { tryRepair } from './repair';
import { compile } from '../dsl/compiler';
import { validateWithRetry, type ProviderSession } from './providers';
import type { SseEvent } from '../util/stream';
import { extractImportGraph, topClusters } from './importGraph';
import { readDocPriors } from './docReader';
import { buildRepoContext } from './repoContext';

export interface PipelineInput {
  rootPath: string;
  session: ProviderSession;
  kind: DiagramKind;
  focus: string;
  topK?: number;
  ignoredFolders?: string[];
  signal?: AbortSignal;
}

export async function runPipeline(
  input: PipelineInput,
  send: (ev: SseEvent) => void,
): Promise<{ dsl: string }> {
  const onRetry = (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => {
    send({ type: 'retry', stage, attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason });
  };

  try {
    // 1. Validate
    send({ type: 'stage', stage: 'validate', status: 'start', message: 'Checking provider credentials…' });
    const v = await validateWithRetry(input.session, {
      signal: input.signal,
      onRetry: onRetry('validate'),
    });
    if (!v.ok) {
      send({ type: 'error', stage: 'validate', message: v.error ?? 'Provider validation failed' });
      send({ type: 'done' });
      return { dsl: '' };
    }
    send({ type: 'stage', stage: 'validate', status: 'done', message: 'Provider ready' });

    // 2. Scan
    send({ type: 'stage', stage: 'scan', status: 'start', message: 'Scanning repository…' });
    const repoMap = await scanRepo(input.rootPath, {
      allowlist: AGENT_FILE_ALLOWLIST,
      ignoredFolders: input.ignoredFolders,
    });
    send({
      type: 'stage',
      stage: 'scan',
      status: 'done',
      message: `Found ${repoMap.fileCount} files (${Math.round(repoMap.totalBytes / 1024)} KB) — stack: ${repoMap.likelyStack.join(', ') || 'unknown'}`,
      counters: { files: repoMap.fileCount, bytes: repoMap.totalBytes },
    });

    // 3. Classify
    send({ type: 'stage', stage: 'classify', status: 'start', message: 'Scoring relevance…' });
    const relevant = classifyRelevance(repoMap, input.kind, input.focus, input.topK ?? 60);
    send({
      type: 'stage',
      stage: 'classify',
      status: 'done',
      message: `Selected ${relevant.length} files for deep analysis`,
      counters: { selected: relevant.length },
    });

    // 4. Deep context: docs + import graph
    send({ type: 'stage', stage: 'context', status: 'start', message: 'Reading docs + import graph…' });
    const [docs, importGraph] = await Promise.all([
      readDocPriors(repoMap),
      extractImportGraph(repoMap.root, repoMap.files.map((f) => f.path), { maxFiles: 700 }),
    ]);
    const clusters = topClusters(importGraph, 12);
    const repoContext = await buildRepoContext(repoMap, importGraph);
    send({
      type: 'stage',
      stage: 'context',
      status: 'done',
      message: `${docs.length} docs · ${importGraph.files.size} files analyzed · ${importGraph.externals.size} unique externals · ${repoContext.folderClusters.length} deep clusters`,
      counters: {
        docs: docs.length,
        importEdges: importGraph.edges.length,
        externals: importGraph.externals.size,
        clusters: repoContext.folderClusters.length,
      },
    });

    // 5 + 6. Summarize relevant files in parallel
    send({ type: 'stage', stage: 'summarize', status: 'start', message: 'Summarizing modules…' });
    const limit = pLimit(4);
    let done = 0;
    const summaries = await Promise.all(
      relevant.map((r) =>
        limit(async () => {
          if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const text = await readRepoFile(repoMap.root, r.file.path, 180_000);
          const summary = await summarizeFile(input.session, r.file.path, text, {
            signal: input.signal,
            onRetry: onRetry('summarize'),
          });
          done++;
          send({
            type: 'stage',
            stage: 'summarize',
            status: 'progress',
            percent: Math.round((done / relevant.length) * 100),
            counters: { done, total: relevant.length },
          });
          return { path: r.file.path, summary };
        }),
      ),
    );
    send({ type: 'stage', stage: 'summarize', status: 'done', message: `Summarized ${summaries.length} files` });

    // 7. Subsystem catalog (heuristic now)
    send({ type: 'stage', stage: 'subsystem', status: 'start', message: 'Discovering subsystems…' });
    const subsystemCount = new Set(summaries.map((s) => s.summary.layer)).size;
    send({
      type: 'stage',
      stage: 'subsystem',
      status: 'done',
      message: `Identified ${subsystemCount} subsystem layers + ${clusters.length} folder clusters`,
      counters: { layers: subsystemCount, clusters: clusters.length },
    });

    // 8. Plan
    send({ type: 'stage', stage: 'plan', status: 'start', message: 'Generating diagram plan…' });
    const plan = await generatePlan(
      input.session,
      { repoMap, summaries, imports: importGraph, docs, repoContext, kind: input.kind, focus: input.focus },
      { signal: input.signal, onRetry: onRetry('plan') },
    );
    send({
      type: 'stage',
      stage: 'plan',
      status: 'done',
      message: `Plan: ${plan.groups.length} groups, ${plan.nodes.length} nodes, ${plan.edges.length} edges`,
    });

    // 9. Compile to DSL
    send({ type: 'stage', stage: 'compile', status: 'start', message: 'Compiling DSL…' });
    let dsl = planToDsl(plan);
    send({ type: 'stage', stage: 'compile', status: 'done', message: 'DSL compiled' });

    // 10. Validate + repair
    send({ type: 'stage', stage: 'validate-dsl', status: 'start', message: 'Validating syntax…' });
    const initial = compile(dsl);
    const initialErrors = initial.diagnostics.filter((d) => d.severity === 'error').length;
    if (initialErrors > 0) {
      send({
        type: 'log',
        stage: 'validate-dsl',
        level: 'warn',
        message: `${initialErrors} syntax errors — attempting repair`,
      });
      const repaired = await tryRepair(input.session, dsl, {
        maxAttempts: 2,
        signal: input.signal,
        onRetry: onRetry('repair'),
      });
      dsl = repaired.dsl;
      send({
        type: 'log',
        stage: 'validate-dsl',
        level: repaired.errors === 0 ? 'info' : 'warn',
        message: repaired.errors === 0 ? 'Repaired successfully' : `${repaired.errors} errors remain after repair`,
      });
    }
    send({ type: 'stage', stage: 'validate-dsl', status: 'done', message: 'Validation complete' });

    send({ type: 'result', dsl });
    send({ type: 'done' });
    return { dsl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', stage: 'pipeline', message });
    send({ type: 'done' });
    return { dsl: '' };
  }
}
