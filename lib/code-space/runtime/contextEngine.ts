import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

export interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
  mode: 'full' | 'partial';
}

export interface ContextSearchResult {
  filesConsidered: number;
  files: ContextFile[];
  terms: string[];
}

const DEFAULT_CONTEXT_GLOBS = ['**/*.{ts,tsx,js,jsx,json,md,css,scss,py,go,rs}', '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!.next/**'];

function promptTerms(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/[^a-z0-9_/-]+/)
        .filter((term) => term.length > 2 && !['the', 'and', 'for', 'with', 'this', 'that', 'you'].includes(term)),
    ),
  );
}

export class ContextEngine {
  async collectProjectContext(root: string, prompt: string, openTabs: string[] = [], limit = 8): Promise<ContextSearchResult> {
    const candidates = await fg(DEFAULT_CONTEXT_GLOBS, {
      cwd: root,
      onlyFiles: true,
      dot: false,
      absolute: false,
      unique: true,
    });
    const terms = promptTerms(prompt);
    const selected = candidates
      .map((file) => {
        const lower = file.toLowerCase();
        const score =
          (openTabs.includes(file) ? 8 : 0) +
          terms.reduce((sum, term) => sum + (lower.includes(term) ? 3 : 0), 0) +
          (/readme|package\.json|architecture|agent|code-space/i.test(file) ? 2 : 0);
        return { file, score };
      })
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, limit)
      .map((item) => item.file);

    const files: ContextFile[] = [];
    for (const file of selected) {
      const absolute = path.resolve(root, file);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
      try {
        const content = await fs.readFile(absolute, 'utf8');
        files.push({
          path: file,
          content: content.slice(0, 6_000),
          truncated: content.length > 6_000,
          mode: content.length > 6_000 ? 'partial' : 'full',
        });
      } catch {
        // Unreadable files are omitted but still counted in filesConsidered.
      }
    }

    return { filesConsidered: candidates.length, files, terms };
  }
}

