import path from 'node:path';
import { extractBuildPlanPath } from '@/lib/code-space/planBuild';
import { traceDependencyEdges, type DependencyEdge } from './dependencyTrace';
import { listRepositoryFiles, normalizeContextPath, safeReadTextFile } from './repoMap';
import { extractSymbols } from './symbolScanner';

export type ContextReason =
  | 'explicit_file'
  | 'explicit_folder'
  | 'open_tab'
  | 'current_editor'
  | 'recent_file'
  | 'plan_artifact'
  | 'project_rule'
  | 'package_config'
  | 'direct_import_dependency'
  | 'reverse_importer'
  | 'test_surface'
  | 'symbol_match'
  | 'content_match'
  | 'route_runtime_surface'
  | 'ui_surface'
  | 'documentation_spec';

export interface ContextAttachment {
  kind: 'file' | 'folder';
  relativePath: string;
  displayName?: string;
}

export interface ContextGraphOptions {
  mode?: 'ask' | 'plan' | 'code';
  openTabs?: string[];
  currentEditorFile?: string;
  recentFiles?: string[];
  attachments?: ContextAttachment[];
  buildPlanPath?: string | null;
  limitHint?: number;
}

export interface ContextGraphFile {
  path: string;
  content: string;
  truncated: boolean;
  mode: 'full' | 'partial';
  lineCount: number;
  score: number;
  reasons: ContextReason[];
  reasonDetails: string[];
  summary: string;
  symbols: string[];
}

export interface ContextGraphResult {
  filesConsidered: number;
  files: ContextGraphFile[];
  selectedFiles: string[];
  omittedRelevantCandidates: string[];
  terms: string[];
  dependencyEdges: DependencyEdge[];
  testCandidates: string[];
  validationCandidates: string[];
  missingContextWarnings: string[];
  confidence: 'low' | 'medium' | 'high';
  evidencePackArtifactId?: string;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'can', 'into', 'from', 'mode', 'code', 'make', 'please', 'need', 'deeply', 'review', 'comprehensively', 'improve', 'plan']);

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term)))).slice(0, 48);
}

function normalizeReason(reason: string): ContextReason {
  if (reason === 'explicit_file') return 'explicit_file';
  if (reason === 'explicit_folder') return 'explicit_folder';
  if (reason === 'open_tab') return 'open_tab';
  if (reason === 'current_editor') return 'current_editor';
  if (reason === 'recent_file') return 'recent_file';
  return 'content_match';
}

function addScore(
  scores: Map<string, { score: number; reasons: Set<ContextReason>; details: Set<string> }>,
  file: string,
  amount: number,
  reason: ContextReason,
  detail: string = reason,
) {
  const normalized = normalizeContextPath(file);
  if (!normalized || amount <= 0) return;
  const current = scores.get(normalized) ?? { score: 0, reasons: new Set<ContextReason>(), details: new Set<string>() };
  current.score += amount;
  current.reasons.add(reason);
  current.details.add(detail);
  scores.set(normalized, current);
}

function summarizeContextFile(filePath: string, content: string, symbols: string[]): string {
  const lowerPath = filePath.toLowerCase();
  const lower = content.toLowerCase();
  const symbolHint = symbols.length ? ` Key surfaces: ${symbols.slice(0, 4).join(', ')}.` : '';
  if (/readme|docs?\//i.test(filePath)) return `Project documentation, setup notes, or architecture constraints.${symbolHint}`;
  if (/agents\.md|claude\.md|\.cursorrules/i.test(filePath)) return `Project rules and coding instructions that should shape runtime behavior.${symbolHint}`;
  if (/package\.json|tsconfig|next\.config|vitest|playwright/i.test(lowerPath)) return `Package, framework, or validation configuration.${symbolHint}`;
  if (/route\.ts|app\/api|controller/i.test(lowerPath)) return `API route/runtime entrypoint selected for request handling evidence.${symbolHint}`;
  if (/agent|orchestrator|runtime|runner|manager/i.test(lowerPath)) return `Agent runtime, orchestration, state, or execution surface.${symbolHint}`;
  if (/patch|checkpoint|diff/i.test(lowerPath)) return `Patch, diff, checkpoint, or mutation lifecycle surface.${symbolHint}`;
  if (/validation|terminal|test/i.test(lowerPath)) return `Validation, terminal, test, or repair-loop surface.${symbolHint}`;
  if (/components\/code-space|panel|workspace|selector/i.test(lowerPath)) return `Code Space UI/session state surface.${symbolHint}`;
  if (/test|spec/i.test(lowerPath)) return `Executable test surface or behavior example.${symbolHint}`;
  if (/pubmed|clinical|guideline|mesh/.test(lower)) return `Domain-specific evidence or query behavior surface.${symbolHint}`;
  return `Implementation surface selected by repository context scoring.${symbolHint}`;
}

function isPackageOrConfig(file: string): boolean {
  return /package\.json|tsconfig|next\.config|vitest|playwright|tailwind|postcss|eslint|\.cursorrules/i.test(file);
}

export class ContextGraphEngine {
  async collectProjectContext(root: string, prompt: string, options: ContextGraphOptions = {}): Promise<ContextGraphResult> {
    const candidates = await listRepositoryFiles(root);
    const candidateSet = new Set(candidates);
    const terms = promptTerms(prompt);
    const scores = new Map<string, { score: number; reasons: Set<ContextReason>; details: Set<string> }>();
    const buildPlanPath = normalizeContextPath(options.buildPlanPath ?? extractBuildPlanPath(prompt) ?? '');

    for (const file of candidates) {
      const lower = file.toLowerCase();
      if (isPackageOrConfig(file)) addScore(scores, file, 18, 'package_config');
      if (/^app\/api\/code-space|lib\/code-space\/runtime|app\/api\/code-space\/agent/.test(file)) addScore(scores, file, 22, 'route_runtime_surface');
      if (/^components\/code-space/.test(file)) addScore(scores, file, 18, 'ui_surface');
      if (/(__tests__|\.test\.|\.spec\.|tests?\/)/i.test(file)) addScore(scores, file, 10, 'test_surface');
      if (/^(docs|README\.md)/i.test(file)) addScore(scores, file, 8, 'documentation_spec');
      if (/AGENTS\.md|CLAUDE\.md|\.cursorrules/i.test(file)) addScore(scores, file, 24, 'project_rule');
      if (/^\.agent\/plans/.test(file)) addScore(scores, file, 8, 'plan_artifact');
      const pathHits = terms.reduce((sum, term) => sum + (lower.includes(term) ? 7 : 0), 0);
      if (pathHits) addScore(scores, file, pathHits, 'content_match', 'prompt/path overlap');
    }

    if (buildPlanPath) addScore(scores, buildPlanPath, candidateSet.has(buildPlanPath) ? 500 : 0, 'plan_artifact', 'approved plan artifact');

    for (const tab of options.openTabs ?? []) {
      addScore(scores, tab, 70, 'open_tab');
    }
    if (options.currentEditorFile) {
      addScore(scores, options.currentEditorFile, 80, 'current_editor');
    }
    for (const recent of options.recentFiles ?? []) {
      addScore(scores, recent, 20, 'recent_file');
    }
    for (const attachment of options.attachments ?? []) {
      const normalized = normalizeContextPath(attachment.relativePath);
      if (attachment.kind === 'file') {
        addScore(scores, normalized, 180, 'explicit_file', `@File ${attachment.displayName ?? normalized}`);
        continue;
      }
      for (const file of candidates) {
        if (file === normalized || file.startsWith(`${normalized}/`)) {
          addScore(scores, file, 130 - Math.min(file.split('/').length, 20), 'explicit_folder', `@Folder ${attachment.displayName ?? normalized}`);
        }
      }
    }

    const promptMentions = Array.from(prompt.matchAll(/@([\w./-]+)/g)).map((match) => normalizeContextPath(match[1] ?? ''));
    for (const mention of promptMentions) {
      if (candidateSet.has(mention)) addScore(scores, mention, 170, 'explicit_file');
      for (const file of candidates) {
        if (file.startsWith(`${mention.replace(/\/$/, '')}/`)) addScore(scores, file, 115, 'explicit_folder');
      }
    }

    const baseBudget = options.mode === 'ask' ? 15 : options.mode === 'plan' ? 35 : 50;
    const budget = Math.max(8, Math.min(50, options.limitHint ?? baseBudget));
    const ranked = Array.from(scores.entries())
      .filter(([file, scored]) => candidateSet.has(file) && scored.score > 0)
      .map(([file, scored]) => ({ file, ...scored }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    const initialSelected = ranked.slice(0, budget).map((item) => item.file);
    const trace = await traceDependencyEdges({ root, candidates, selected: initialSelected });

    for (const edge of trace.edges) {
      addScore(scores, edge.to, 26, edge.reason === 'direct_import' ? 'direct_import_dependency' : 'reverse_importer', `${edge.reason} ${edge.from} -> ${edge.to}`);
      addScore(scores, edge.from, 22, edge.reason === 'direct_import' ? 'direct_import_dependency' : 'reverse_importer', `${edge.reason} ${edge.from} -> ${edge.to}`);
    }

    const finalRanked = Array.from(trace.files)
      .map((file) => {
        const scored = scores.get(file) ?? { score: 0, reasons: new Set<ContextReason>(), details: new Set<string>() };
        return { file, ...scored };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, budget);

    const files: ContextGraphFile[] = [];
    for (const item of finalRanked) {
      const content = await safeReadTextFile(root, item.file);
      if (content == null) continue;
      const symbols = extractSymbols(content);
      const contentHits = terms.filter((term) => content.toLowerCase().includes(term)).slice(0, 6);
      const reasons = new Set(item.reasons);
      if (contentHits.length) reasons.add('content_match');
      if (symbols.some((symbol) => terms.includes(symbol.toLowerCase()))) reasons.add('symbol_match');
      files.push({
        path: item.file,
        content: content.slice(0, 22_000),
        truncated: content.length > 22_000,
        mode: content.length > 22_000 ? 'partial' : 'full',
        lineCount: content.split('\n').length,
        score: item.score + contentHits.length * 3,
        reasons: Array.from(reasons),
        reasonDetails: Array.from(item.details),
        summary: summarizeContextFile(item.file, content, symbols),
        symbols: symbols.slice(0, 12),
      });
    }

    const selectedFiles = files.map((file) => file.path);
    const omittedRelevantCandidates = ranked
      .filter((item) => !selectedFiles.includes(item.file) && item.score >= 18)
      .slice(0, 15)
      .map((item) => item.file);
    const missingContextWarnings: string[] = [];
    for (const attachment of options.attachments ?? []) {
      const normalized = normalizeContextPath(attachment.relativePath);
      if (attachment.kind === 'file' && !selectedFiles.includes(normalized)) missingContextWarnings.push(`Mentioned file was not readable: ${normalized}`);
    }
    if (buildPlanPath && !selectedFiles.includes(buildPlanPath)) missingContextWarnings.push(`Referenced plan artifact was not readable: ${buildPlanPath}`);
    if (!files.length) missingContextWarnings.push('No high-signal project files were readable.');

    const confidence: ContextGraphResult['confidence'] = files.length >= 24 ? 'high' : files.length >= 8 ? 'medium' : 'low';
    return {
      filesConsidered: candidates.length,
      files,
      selectedFiles,
      omittedRelevantCandidates,
      terms,
      dependencyEdges: trace.edges,
      testCandidates: selectedFiles.filter((file) => /(__tests__|\.test\.|\.spec\.|tests?\/)/i.test(file)),
      validationCandidates: selectedFiles.filter((file) => isPackageOrConfig(file) || /pytest|go\.mod|Cargo\.toml/i.test(path.basename(file))),
      missingContextWarnings,
      confidence,
    };
  }
}

export function legacyReasonLabel(reason: ContextReason): string {
  return normalizeReason(reason);
}
