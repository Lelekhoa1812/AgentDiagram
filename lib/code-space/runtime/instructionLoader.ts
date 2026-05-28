import { safeReadTextFile } from './repoMap';

export interface LoadedInstruction {
  path: string;
  precedence: number;
  summary: string;
  content: string;
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'README.md'];

export class InstructionLoader {
  async loadProjectInstructions(root: string, explicitPlanPath?: string | null): Promise<LoadedInstruction[]> {
    const loaded: LoadedInstruction[] = [];
    if (explicitPlanPath) {
      const content = await safeReadTextFile(root, explicitPlanPath);
      if (content) loaded.push(toInstruction(explicitPlanPath, 2, content));
    }
    for (const [index, file] of INSTRUCTION_FILES.entries()) {
      const content = await safeReadTextFile(root, file);
      if (content) loaded.push(toInstruction(file, 3 + index, content));
    }
    return loaded;
  }
}

function toInstruction(path: string, precedence: number, content: string): LoadedInstruction {
  return {
    path,
    precedence,
    content: redactSecrets(content.slice(0, 20_000)),
    summary: content.split(/\r?\n/).find((line) => line.trim())?.slice(0, 220) ?? 'Project instruction file',
  };
}

function redactSecrets(content: string): string {
  return content
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)=\S+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi, '[REDACTED]');
}
