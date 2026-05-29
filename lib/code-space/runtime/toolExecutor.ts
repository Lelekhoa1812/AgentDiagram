import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AutonomyLevel } from '@/lib/code-space/domain';
import type { ToolCall, ToolSpec } from '@/lib/agent/providers';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import {
  applyGroupedEditBlocks,
  createUnifiedDiff,
  type EditBlock,
} from '@/lib/code-space/agent/editBlocks';
import { writeAgentArtifact, readArtifactRange, grepArtifact, type AgentArtifact } from '@/lib/code-space/agent/artifacts';
import type { AgentEventType } from './events';
import { applyPatchFiles, PatchApplyError } from './patchApply';
import {
  createCheckpointFromSnapshots,
  loadFileCheckpoint,
  restoreFileCheckpoint,
  type FileCheckpoint,
} from './checkpointManager';
import { PermissionManager } from './permissionManager';
import { createDefaultToolRegistry, ToolRegistry } from './toolRegistry';
import { TerminalRunner } from './terminalRunner';
import { isRiskyTerminalCommand, type TerminalCommand } from './terminalPolicy';
import { traceDependencyEdges } from './dependencyTrace';
import { listRepositoryFiles, normalizeContextPath, safeReadTextFile } from './repoMap';
import { hashContent } from './patchReview';

export interface LedgerEntry {
  beforeContent: string;
  afterContent: string;
  deleted: boolean;
  existedBefore: boolean;
}

export interface ToolExecutionResult {
  content: string;
  isError?: boolean;
}

/** Persisted checkpoint plus a hook so the runtime can record it to the store. */
export type CheckpointSink = (checkpoint: FileCheckpoint) => void | Promise<void>;

export interface CodeAgentContext {
  root: string;
  runId: string;
  projectId: string;
  sessionId: string;
  autonomy: AutonomyLevel;
  emit: (event: AgentSSEEvent) => void | Promise<void>;
  emitRuntime: (type: AgentEventType, payload: unknown) => Promise<void>;
  /** Original → latest content per touched path; powers the final cumulative diff. */
  ledger: Map<string, LedgerEntry>;
  /** Files the model has read this run. */
  readFiles: Set<string>;
  /** Artifacts produced during the run, keyed by artifactId. */
  artifacts: Map<string, AgentArtifact>;
  /** Checkpoints captured during the run (per edit_file apply). */
  checkpoints: FileCheckpoint[];
  registry: ToolRegistry;
  permission: PermissionManager;
  terminal: TerminalRunner;
  onCheckpoint?: CheckpointSink;
  signal?: AbortSignal;
}

const MAX_TOOL_OUTPUT = 6000;
const MAX_SEARCH_FILE_BYTES = 200_000;
const MAX_SEARCH_MATCHES = 80;

/** Tool specs advertised to the model for Code mode. */
export const CODE_MODE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Optionally pass startLine/endLine (1-based) to read a slice. Always read a file before editing it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files and folders under a workspace directory (default: repo root). Set recursive=true to list the full subtree.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
  },
  {
    name: 'search_text',
    description: 'Search the workspace for a substring or regex, returning matching files with line numbers and nearby context. Use before refactors to find references.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' }, contextLines: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'repo_map',
    description: 'Summarize the repository: file count, top-level directories, detected languages, package manager, and available validation commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dependency_trace',
    description: 'Trace direct imports and reverse importers around the given paths. Use after a rename/move to find every file that must be updated.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] },
  },
  {
    name: 'git_status',
    description: 'Show the current git branch and changed-file state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Show the current uncommitted workspace diff, optionally scoped to a path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'read_artifact',
    description: 'Read a line range from a stored artifact (e.g. full command output) by artifactId instead of pulling the whole thing into context.',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['artifactId', 'startLine', 'endLine'] },
  },
  {
    name: 'grep_artifact',
    description: 'Search inside a stored artifact by artifactId without loading it fully into context.',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' }, pattern: { type: 'string' }, contextLines: { type: 'number' } }, required: ['artifactId', 'pattern'] },
  },
  {
    name: 'edit_file',
    description: 'Apply exact SEARCH/REPLACE edit blocks to files on disk. Each edit\'s "search" must match the current file content exactly and uniquely. The server checkpoints, conflict-checks, syntax-validates, and writes. Returns diffs or actionable diagnostics to fix and retry. Use empty search with a new path to create a file.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, reason: { type: 'string' } },
            required: ['path', 'search', 'replace', 'reason'],
          },
        },
      },
      required: ['edits'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a workspace command (tests, typecheck, build, lint, grep, ls, etc.) and capture output. Destructive or network-mutating commands are gated and require approval.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, reason: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command', 'reason'] },
  },
  {
    name: 'restore_checkpoint',
    description: 'Revert all files captured by a previously created checkpoint (checkpointRef is the checkpoint id returned by an earlier edit_file).',
    inputSchema: { type: 'object', properties: { checkpointRef: { type: 'string' }, reason: { type: 'string' } }, required: ['checkpointRef'] },
  },
  {
    name: 'attempt_completion',
    description: 'Signal that the task is finished. Set success=false if you could not complete it; never fabricate a result. Provide a concise summary of what changed (or why it could not be done).',
    inputSchema: { type: 'object', properties: { success: { type: 'boolean' }, summary: { type: 'string' } }, required: ['success', 'summary'] },
  },
];

function clip(output: string): string {
  return output.length > MAX_TOOL_OUTPUT ? `${output.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; ${output.length - MAX_TOOL_OUTPUT} more chars]` : output;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class ToolExecutor {
  constructor(
    registry: ToolRegistry = createDefaultToolRegistry(),
    private readonly permission = new PermissionManager(),
  ) {
    this.registry = registry;
  }
  private readonly registry: ToolRegistry;

  /** Execute one tool call against the workspace. Never throws for tool-level failures. */
  async execute(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    try {
      switch (call.name) {
        case 'read_file':
          return await this.readFile(call, ctx);
        case 'list_files':
          return await this.listFiles(call, ctx);
        case 'search_text':
          return await this.searchText(call, ctx);
        case 'repo_map':
          return await this.repoMap(ctx);
        case 'dependency_trace':
          return await this.dependencyTrace(call, ctx);
        case 'git_status':
          return await this.git(['status', '--short', '--branch'], ctx);
        case 'git_diff':
          return await this.git(['diff', ...(str(call.input.path) ? ['--', str(call.input.path)] : [])], ctx);
        case 'read_artifact':
          return await this.readArtifact(call, ctx);
        case 'grep_artifact':
          return await this.grepArtifactTool(call, ctx);
        case 'edit_file':
          return await this.editFile(call, ctx);
        case 'run_command':
          return await this.runCommand(call, ctx);
        case 'restore_checkpoint':
          return await this.restoreCheckpoint(call, ctx);
        default:
          return { content: `Unknown tool "${call.name}". Use one of the provided tools.`, isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Tool ${call.name} failed: ${message}`, isError: true };
    }
  }

  private async readFile(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const target = str(call.input.path);
    if (!target) return { content: 'read_file requires "path".', isError: true };
    const content = await safeReadTextFile(ctx.root, target);
    if (content == null) return { content: `File not found or unreadable: ${target}`, isError: true };
    ctx.readFiles.add(normalizeContextPath(target));
    await ctx.emitRuntime('file.read', { path: target });
    const lines = content.split('\n');
    const start = typeof call.input.startLine === 'number' ? Math.max(1, Math.floor(call.input.startLine)) : 1;
    const end = typeof call.input.endLine === 'number' ? Math.min(lines.length, Math.floor(call.input.endLine)) : lines.length;
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, index) => `${start + index}\t${line}`).join('\n');
    return { content: clip(`${target} (lines ${start}-${end} of ${lines.length}):\n${numbered}`) };
  }

  private async listFiles(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const rel = normalizeContextPath(str(call.input.path) || '.');
    const recursive = call.input.recursive === true;
    if (recursive) {
      const all = await listRepositoryFiles(ctx.root);
      const prefix = rel === '.' || rel === '' ? '' : `${rel}/`;
      const matches = all.filter((file) => !prefix || file.startsWith(prefix)).slice(0, 500);
      return { content: clip(matches.join('\n') || '(no files)') };
    }
    const dir = path.resolve(ctx.root, rel === '.' ? '' : rel);
    if (dir !== ctx.root && !dir.startsWith(`${ctx.root}${path.sep}`)) return { content: 'Path escapes workspace root.', isError: true };
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return { content: `Directory not found: ${rel}`, isError: true };
    const listing = entries
      .filter((entry) => !['node_modules', '.git', '.next', 'dist', 'build'].includes(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    return { content: clip(listing.join('\n') || '(empty)') };
  }

  private async searchText(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const query = str(call.input.query);
    if (!query) return { content: 'search_text requires "query".', isError: true };
    const glob = str(call.input.glob);
    const contextLines = typeof call.input.contextLines === 'number' ? Math.max(0, Math.min(6, Math.floor(call.input.contextLines))) : 1;
    let rx: RegExp;
    try {
      rx = new RegExp(query, 'i');
    } catch {
      rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const files = await listRepositoryFiles(ctx.root);
    const candidates = glob ? files.filter((file) => matchesGlob(file, glob)) : files;
    const blocks: string[] = [];
    let matchCount = 0;
    for (const file of candidates) {
      if (matchCount >= MAX_SEARCH_MATCHES) break;
      const content = await safeReadTextFile(ctx.root, file);
      if (content == null || content.length > MAX_SEARCH_FILE_BYTES) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && matchCount < MAX_SEARCH_MATCHES; index += 1) {
        if (!rx.test(lines[index] ?? '')) continue;
        matchCount += 1;
        const from = Math.max(0, index - contextLines);
        const to = Math.min(lines.length, index + contextLines + 1);
        const snippet = lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${line}`).join('\n');
        blocks.push(`${file}:\n${snippet}`);
      }
    }
    await ctx.emitRuntime('tool.completed', { tool: 'search_text', matches: matchCount });
    return { content: clip(blocks.length ? `${matchCount} match(es):\n\n${blocks.join('\n\n')}` : `No matches for "${query}".`) };
  }

  private async repoMap(ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const files = await listRepositoryFiles(ctx.root);
    const topDirs = new Map<string, number>();
    const extensions = new Map<string, number>();
    for (const file of files) {
      const top = file.includes('/') ? `${file.split('/')[0]}/` : '(root)';
      topDirs.set(top, (topDirs.get(top) ?? 0) + 1);
      const ext = file.split('.').pop() ?? '';
      if (ext) extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    }
    const fmt = (map: Map<string, number>) =>
      Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([key, count]) => `${key} (${count})`)
        .join(', ');
    let pkgInfo = 'none';
    const pkgRaw = await safeReadTextFile(ctx.root, 'package.json');
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; packageManager?: string };
        pkgInfo = `scripts: ${Object.keys(pkg.scripts ?? {}).join(', ') || '(none)'}; packageManager: ${pkg.packageManager ?? 'unknown'}`;
      } catch {
        pkgInfo = 'package.json present but unparseable';
      }
    }
    return {
      content: clip(
        [
          `Files: ${files.length}`,
          `Top directories: ${fmt(topDirs)}`,
          `Languages by extension: ${fmt(extensions)}`,
          `package.json: ${pkgInfo}`,
        ].join('\n'),
      ),
    };
  }

  private async dependencyTrace(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const paths = Array.isArray(call.input.paths) ? call.input.paths.filter((p): p is string => typeof p === 'string') : [];
    if (!paths.length) return { content: 'dependency_trace requires "paths".', isError: true };
    const candidates = await listRepositoryFiles(ctx.root);
    const trace = await traceDependencyEdges({ root: ctx.root, candidates, selected: paths });
    const edges = trace.edges.slice(0, 100).map((edge) => `${edge.reason}: ${edge.from} -> ${edge.to}`);
    return { content: clip(edges.length ? `Related files: ${Array.from(trace.files).join(', ')}\n\nEdges:\n${edges.join('\n')}` : 'No local dependency edges found for those paths.') };
  }

  private async git(args: string[], ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const command: TerminalCommand = { kind: 'explore', command: 'git', args, cwd: ctx.root, reason: 'Read git state for the agent.', timeoutMs: 30_000 };
    const result = await ctx.terminal.run(command, ctx.root, ctx.signal);
    return { content: clip(result.output || '(no output)'), isError: result.status === 'failed' };
  }

  private async readArtifact(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const artifact = ctx.artifacts.get(str(call.input.artifactId));
    if (!artifact) return { content: `Unknown artifactId: ${str(call.input.artifactId)}`, isError: true };
    const range = await readArtifactRange(artifact.path, Number(call.input.startLine) || 1, Number(call.input.endLine) || 80);
    return { content: clip(`${artifact.artifactId} (lines ${range.startLine}-${range.endLine} of ${range.lineCount}):\n${range.content}`) };
  }

  private async grepArtifactTool(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const artifact = ctx.artifacts.get(str(call.input.artifactId));
    if (!artifact) return { content: `Unknown artifactId: ${str(call.input.artifactId)}`, isError: true };
    const pattern = str(call.input.pattern);
    if (!pattern) return { content: 'grep_artifact requires "pattern".', isError: true };
    const result = await grepArtifact(artifact.path, pattern, typeof call.input.contextLines === 'number' ? call.input.contextLines : 3);
    const rendered = result.matches.map((match) => `L${match.line}: ${match.text}`).join('\n');
    return { content: clip(rendered || `No matches for "${pattern}" in ${artifact.artifactId}.`) };
  }

  private async editFile(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const rawEdits = Array.isArray(call.input.edits) ? call.input.edits : [];
    const edits: EditBlock[] = rawEdits
      .filter((edit): edit is Record<string, unknown> => Boolean(edit) && typeof edit === 'object')
      .map((edit) => ({
        path: str(edit.path),
        search: str(edit.search),
        replace: str(edit.replace),
        reason: str(edit.reason) || 'Code edit',
      }))
      .filter((edit) => edit.path);
    if (!edits.length) return { content: 'edit_file requires a non-empty "edits" array of {path, search, replace, reason}.', isError: true };

    // Build current content per file from disk (fresh source of truth).
    const uniquePaths = Array.from(new Set(edits.map((edit) => normalizeContextPath(edit.path))));
    const currentFiles: Record<string, string> = {};
    const existedBefore: Record<string, boolean> = {};
    for (const filePath of uniquePaths) {
      const disk = await safeReadTextFile(ctx.root, filePath);
      currentFiles[filePath] = disk ?? '';
      existedBefore[filePath] = disk != null;
    }

    const grouped = applyGroupedEditBlocks(currentFiles, edits);
    if (!grouped.ok) {
      const detail = grouped.diagnostics
        .map((diagnostic) => `- ${diagnostic.path} [${diagnostic.code}]${diagnostic.line ? ` line ${diagnostic.line}` : ''}: ${diagnostic.message}`)
        .join('\n');
      return { content: `edit_file could not apply cleanly. Fix and retry:\n${detail}`, isError: true };
    }

    const decision = this.decide('propose_edit_blocks', ctx.autonomy);
    const applyToDisk = decision.permission === 'auto';

    const applied: string[] = [];
    for (const preview of grouped.previews) {
      const normalized = normalizeContextPath(preview.path);
      if (!applyToDisk) {
        // suggest_only / approval_required → propose, do not write.
        await ctx.emit({
          type: 'diff_proposed',
          diffId: `patch:${ctx.runId}:${normalized}:${Date.now()}`,
          filePath: normalized,
          oldContent: preview.beforeContent,
          newContent: preview.afterContent,
          explanation: preview.explanation,
          unifiedDiff: preview.unifiedDiff,
          autoApplied: false,
        });
        if (decision.approvalRequired) await ctx.emitRuntime('tool.approval.required', { tool: 'edit_file', path: normalized, reason: decision.reason });
        continue;
      }

      try {
        const result = await applyPatchFiles({
          root: ctx.root,
          projectId: ctx.projectId,
          runId: ctx.runId,
          patchId: `patch:${ctx.runId}:${normalized}`,
          files: [{ path: normalized, beforeContent: preview.beforeContent, afterContent: preview.afterContent }],
        });
        if (result.checkpoint) {
          ctx.checkpoints.push(result.checkpoint);
          await ctx.onCheckpoint?.(result.checkpoint);
          await ctx.emitRuntime('checkpoint.created', { checkpointId: result.checkpoint.id, files: result.checkpoint.files.map((file) => file.path) });
        }
      } catch (error) {
        if (error instanceof PatchApplyError) {
          return { content: `edit_file write rejected for ${normalized} [${error.code}]: ${error.message}. Re-read the file and regenerate the edit.`, isError: true };
        }
        throw error;
      }

      const existing = ctx.ledger.get(normalized);
      const original = existing ? existing.beforeContent : preview.beforeContent;
      ctx.ledger.set(normalized, { beforeContent: original, afterContent: preview.afterContent, deleted: false, existedBefore: existing ? existing.existedBefore : existedBefore[normalized] ?? false });
      applied.push(normalized);
      await ctx.emit({ type: 'file_applied', filePath: normalized, beforeContent: original, afterContent: preview.afterContent, explanation: preview.explanation, unifiedDiff: preview.unifiedDiff, hash: hashContent(preview.afterContent) });
      await ctx.emitRuntime(existedBefore[normalized] ? 'file.updated' : 'file.created', { path: normalized });
    }

    if (!applyToDisk) {
      return { content: `Proposed ${grouped.previews.length} edit(s) for review (autonomy "${ctx.autonomy}" does not auto-apply). Not written to disk.` };
    }
    const diffSummary = grouped.previews.map((preview) => preview.unifiedDiff).join('\n');
    return { content: clip(`Applied edits to: ${applied.join(', ')}\n\n${diffSummary}`) };
  }

  private async runCommand(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const commandName = str(call.input.command);
    if (!commandName) return { content: 'run_command requires "command".', isError: true };
    const args = Array.isArray(call.input.args) ? call.input.args.filter((a): a is string => typeof a === 'string') : [];
    const command: TerminalCommand = {
      kind: 'shell',
      command: commandName,
      args,
      cwd: str(call.input.cwd) ? path.resolve(ctx.root, str(call.input.cwd)) : ctx.root,
      reason: str(call.input.reason) || 'Agent-requested command.',
      timeoutMs: typeof call.input.timeoutMs === 'number' ? call.input.timeoutMs : 120_000,
    };

    const decision = this.decide('run_command', ctx.autonomy);
    if (decision.permission !== 'auto') {
      await ctx.emitRuntime('tool.approval.required', { tool: 'run_command', command: `${commandName} ${args.join(' ')}`, reason: decision.reason });
      return { content: `Command not run: autonomy "${ctx.autonomy}" requires approval for "${commandName}". ${decision.reason}`, isError: true };
    }
    if (isRiskyTerminalCommand(command)) {
      return { content: `Command "${commandName} ${args.join(' ')}" is gated by terminal policy and requires explicit approval. It was not run.`, isError: true };
    }

    const result = await ctx.terminal.run(command, ctx.root, ctx.signal);
    const artifact = await writeAgentArtifact({ projectRoot: ctx.root, runId: ctx.runId, kind: 'terminal_log', content: result.output, summary: `${result.command}: ${result.status}` });
    ctx.artifacts.set(artifact.artifactId, artifact);
    const preview = result.output.length > MAX_TOOL_OUTPUT ? `${result.output.slice(0, MAX_TOOL_OUTPUT)}\n…[truncated; read full output via read_artifact id=${artifact.artifactId}]` : result.output;
    return { content: `[${result.status}] ${result.command}\nartifactId: ${artifact.artifactId}\n\n${preview || '(no output)'}`, isError: result.status === 'failed' };
  }

  private async restoreCheckpoint(call: ToolCall, ctx: CodeAgentContext): Promise<ToolExecutionResult> {
    const ref = str(call.input.checkpointRef);
    const checkpoint = ctx.checkpoints.find((entry) => entry.id === ref);
    if (!checkpoint) return { content: `Unknown checkpointRef: ${ref}`, isError: true };
    const decision = this.decide('restore_checkpoint', ctx.autonomy);
    if (decision.permission !== 'auto') {
      await ctx.emitRuntime('tool.approval.required', { tool: 'restore_checkpoint', checkpointRef: ref, reason: decision.reason });
      return { content: `Checkpoint restore requires approval under autonomy "${ctx.autonomy}".`, isError: true };
    }
    const loaded = await loadFileCheckpoint(checkpoint.snapshotRef);
    const files = await restoreFileCheckpoint(ctx.root, loaded);
    for (const file of files) {
      const normalized = normalizeContextPath(file);
      const snapshot = loaded.files.find((entry) => normalizeContextPath(entry.path) === normalized);
      const existing = ctx.ledger.get(normalized);
      if (existing) {
        // Roll the ledger's "latest" back to this checkpoint's snapshot content.
        ctx.ledger.set(normalized, { ...existing, afterContent: snapshot?.content ?? existing.beforeContent, deleted: snapshot ? !snapshot.existed : existing.deleted });
      }
      await ctx.emit({ type: 'file_applied', filePath: normalized, beforeContent: existing?.beforeContent ?? '', afterContent: snapshot?.content ?? '', explanation: `Restored from checkpoint ${ref}`, unifiedDiff: '', hash: hashContent(snapshot?.content ?? '') });
    }
    await ctx.emitRuntime('checkpoint.restored', { checkpointId: ref, files });
    return { content: `Restored ${files.length} file(s) from ${ref}: ${files.join(', ')}` };
  }

  private decide(registryToolName: string, autonomy: AutonomyLevel) {
    const tool = this.registry.get(registryToolName);
    if (!tool) return { permission: 'auto' as const, approvalRequired: false, reason: 'Unregistered tool defaults to auto.' };
    return this.permission.decide(tool, autonomy);
  }
}

/** Build a run-level checkpoint capturing every touched file's original content. */
export async function createRunRevertCheckpoint(ctx: CodeAgentContext): Promise<FileCheckpoint | null> {
  if (!ctx.ledger.size) return null;
  const snapshots = Array.from(ctx.ledger.entries()).map(([filePath, entry]) => ({
    path: filePath,
    content: entry.existedBefore ? entry.beforeContent : null,
    existed: entry.existedBefore,
  }));
  return createCheckpointFromSnapshots({
    projectId: ctx.projectId,
    projectRoot: ctx.root,
    runId: ctx.runId,
    reason: `Revert all Code-mode changes for ${ctx.runId}`,
    snapshots,
  });
}

function matchesGlob(file: string, glob: string): boolean {
  // Minimal glob: supports **, *, and literal segments. Anchored to full path.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(file) || new RegExp(escaped).test(file);
  } catch {
    return file.includes(glob.replace(/\*/g, ''));
  }
}
