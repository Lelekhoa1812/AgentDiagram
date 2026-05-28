import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

export type ContextReason =
  | 'explicit_file'
  | 'explicit_folder'
  | 'open_tab'
  | 'current_editor'
  | 'package_or_config'
  | 'content_match'
  | 'route_runtime_surface'
  | 'ui_surface'
  | 'test_surface'
  | 'plan_artifact';

export interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
  mode: 'full' | 'partial';
  score: number;
  reasons: ContextReason[];
}

export interface ContextSearchResult {
  filesConsidered: number;
  files: ContextFile[];
  terms: string[];
  omittedRelevantCandidates: string[];
  missingContextWarnings: string[];
  confidence: 'low' | 'medium' | 'high';
}

const DEFAULT_CONTEXT_GLOBS = ['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**'];

function promptTerms(prompt: string): string[] {
  return Array.from(new Set(prompt.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length > 2)));
}

export class ContextEngine {
  async collectProjectContext(root: string, prompt: string, openTabs: string[] = [], limitHint = 20): Promise<ContextSearchResult> {
    const candidates = await fg(DEFAULT_CONTEXT_GLOBS, { cwd: root, onlyFiles: true, absolute: false, unique: true, dot: true });
    const terms = promptTerms(prompt);
    const mentions = extractMentions(prompt);
    const budget = Math.max(8, Math.min(50, limitHint));

    const ranked = candidates
      .map((file) => {
        const lower = file.toLowerCase();
        const reasons: ContextReason[] = [];
        let score = 0;
        if (openTabs.includes(file)) {
          score += 16;
          reasons.push('open_tab');
        }
        if (mentions.files.has(file)) {
          score += 30;
          reasons.push('explicit_file');
        }
        if ([...mentions.folders].some((folder) => lower.startsWith(folder))) {
          score += 22;
          reasons.push('explicit_folder');
        }
        if (/package\.json|tsconfig|next\.config|vitest|playwright|\.cursorrules|claude\.md|agents\.md|readme/i.test(file)) {
          score += 8;
          reasons.push('package_or_config');
        }
        if (/app\/api\/code-space|lib\/code-space\/runtime/.test(file)) {
          score += 8;
          reasons.push('route_runtime_surface');
        }
        if (/components\/code-space/.test(file)) {
          score += 5;
          reasons.push('ui_surface');
        }
        if (/\.test\.|\.spec\.|__tests__/.test(file)) {
          score += 6;
          reasons.push('test_surface');
        }
        const contentHits = terms.reduce((sum, term) => sum + (lower.includes(term) ? 2 : 0), 0);
        if (contentHits > 0) reasons.push('content_match');
        score += contentHits;
        if (/\.agent\/plans/.test(file)) {
          score += 8;
          reasons.push('plan_artifact');
        }
        return { file, score, reasons };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

    const selected = ranked.filter((item) => item.score > 0).slice(0, budget);
    const files: ContextFile[] = [];
    for (const item of selected) {
      const absolute = path.resolve(root, item.file);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
      try {
        const content = await fs.readFile(absolute, 'utf8');
        files.push({ path: item.file, content: content.slice(0, 10000), truncated: content.length > 10000, mode: content.length > 10000 ? 'partial' : 'full', score: item.score, reasons: item.reasons });
      } catch {}
    }

    const omittedRelevantCandidates = ranked.slice(budget, budget + 15).filter((x) => x.score >= 8).map((x) => x.file);
    const missingContextWarnings: string[] = [];
    if (!files.length) missingContextWarnings.push('No high-signal files were selected from repository search.');
    if (mentions.files.size > 0 && !files.some((file) => mentions.files.has(file.path))) missingContextWarnings.push('Prompt mentioned specific files that were not found/read.');

    const confidence: ContextSearchResult['confidence'] = files.length >= 18 ? 'high' : files.length >= 8 ? 'medium' : 'low';
    return { filesConsidered: candidates.length, files, terms, omittedRelevantCandidates, missingContextWarnings, confidence };
  }
}

function extractMentions(prompt: string): { files: Set<string>; folders: Set<string> } {
  const fileMatches = prompt.match(/@([\w./-]+\.[\w]+)/g) ?? [];
  const folderMatches = prompt.match(/@([\w./-]+\/?)(?!\.)/g) ?? [];
  const files = new Set(fileMatches.map((m) => m.slice(1)));
  const folders = new Set(folderMatches.map((m) => m.slice(1).replace(/\/$/, '')).filter((m) => m.includes('/')));
  return { files, folders };
}
