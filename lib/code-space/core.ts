import { isHiddenByDefault } from '@/lib/agent/repo/ignoreDefaults';
import type { RepoSourceConfig, RepoSourceType } from '@/lib/agent/repo/repoTypes';

export type CodeSpaceProjectSourceType = RepoSourceType | 'browser-folder' | 'zip';
export type CodeSpaceAgentIntent =
  | 'answer/question'
  | 'code_edit'
  | 'feature_build'
  | 'bug_fix'
  | 'refactor'
  | 'test_generation'
  | 'documentation'
  | 'dependency/setup'
  | 'styling/ui_change'
  | 'git_operation'
  | 'system_diagram'
  | 'fresh_build_from_plan'
  | 'debugging/log_analysis'
  | 'preview_request'
  | 'repository_explanation'
  | 'validation';

export interface CodeSpaceGitMetadata {
  branch?: string;
  changedFiles?: number;
  stagedFiles?: number;
  untrackedFiles?: number;
  ahead?: number;
  behind?: number;
  latestCommit?: string;
}

export interface CodeSpaceProject {
  id: string;
  name: string;
  sourceType: CodeSpaceProjectSourceType;
  rootPath?: string;
  repoRef?: string;
  branch?: string;
  provider?: 'github' | 'local' | 'browser' | 'zip';
  createdAt: number;
  updatedAt: number;
  treeState: Record<string, boolean>;
  active: boolean;
  permissions: {
    canRead: boolean;
    canWrite: boolean;
    browserHandleGranted?: boolean;
  };
  git?: CodeSpaceGitMetadata;
  cachedFileMetadata?: Record<string, CodeSpaceFileMetadata>;
  source?: RepoSourceConfig;
}

export interface CodeSpaceFileMetadata {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  modifiedAt?: number;
  hidden?: boolean;
  dirty?: boolean;
  generated?: boolean;
}

export interface CodeSpaceTreeNode extends CodeSpaceFileMetadata {
  name: string;
  children?: CodeSpaceTreeNode[];
  loading?: boolean;
}

export interface CodeSpaceEditorTab {
  id: string;
  projectId: string;
  path: string;
  language: string;
  contentHash: string;
  dirty: boolean;
  pinned: boolean;
  preview: boolean;
  scrollPosition?: { top: number; left: number };
  cursorPosition?: { lineNumber: number; column: number };
  lastOpenedAt: number;
}

export interface CodeSpaceToolCall {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'success' | 'error';
  summary: string;
  input?: unknown;
  output?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface CodeSpaceMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: number;
}

export interface CodeSpaceChangesetFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CodeSpaceChangeset {
  id: string;
  sessionId: string;
  projectId: string;
  files: CodeSpaceChangesetFile[];
  hunks: Array<{ filePath: string; header: string; patch: string; accepted?: boolean }>;
  status: 'draft' | 'partially-applied' | 'applied' | 'rejected' | 'reverted';
  appliedAt?: number;
  revertedAt?: number;
  validationSummary?: string;
}

export interface CodeSpaceAgentSession {
  id: string;
  projectId: string | null;
  title: string;
  status: 'idle' | 'planning' | 'applying' | 'reviewing' | 'checking' | 'finalized' | 'blocked';
  mode: 'chat' | 'agent' | 'fresh-start';
  messages: CodeSpaceMessage[];
  toolCalls: CodeSpaceToolCall[];
  plan: string[];
  todos: Array<{ id: string; text: string; done: boolean }>;
  changesets: CodeSpaceChangeset[];
  verificationResults: Array<{ id: string; command: string; status: 'passed' | 'failed' | 'skipped'; output: string }>;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  localCacheVersion: number;
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.php': 'php',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.dsl': 'agentdiagram',
};

const CODE_OR_DSL_EXTENSIONS = new Set([
  ...Object.keys(EXTENSION_LANGUAGE_MAP),
  '.vue',
  '.svelte',
  '.astro',
  '.prisma',
  '.graphql',
  '.gql',
]);

export function detectCodeSpaceLanguage(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath;
  if (basename === 'Dockerfile' || basename.endsWith('.Dockerfile')) return 'dockerfile';
  if (basename === 'Makefile') return 'makefile';
  const ext = basename.includes('.') ? `.${basename.split('.').pop()}`.toLowerCase() : '';
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'plaintext';
}

export function isCodeSpaceHiddenPath(filePath: string): boolean {
  const parts = filePath.split('/').filter(Boolean);
  return parts.some((part) => isHiddenByDefault(part, true));
}

export function classifyCodeSpaceIntent(prompt: string): CodeSpaceAgentIntent[] {
  const text = prompt.toLowerCase();
  const intents = new Set<CodeSpaceAgentIntent>();

  if (/\b(system diagram|architecture diagram|multi[- ]?layer|diagram)\b/.test(text)) intents.add('system_diagram');
  if (/\b(fresh start|from plan|planning zip|build from zip|scaffold)\b/.test(text)) intents.add('fresh_build_from_plan');
  if (/\b(fix|bug|broken|failing|error|exception|stack trace|crash)\b/.test(text)) intents.add('bug_fix');
  if (/\b(debug|logs?|trace|why.*fail|failing|error|exception|crash)\b/.test(text)) intents.add('debugging/log_analysis');
  if (/\b(add|build|implement|create feature|feature)\b/.test(text)) intents.add('feature_build');
  if (/\b(refactor|clean up|simplify|modularize)\b/.test(text)) intents.add('refactor');
  if (/\b(test|spec|coverage|vitest|jest|playwright|pytest)\b/.test(text)) intents.add('test_generation');
  if (/\b(typecheck|lint|build|verify|run checks|checks)\b/.test(text)) intents.add('validation');
  if (/\b(readme|docs?|document|comment)\b/.test(text)) intents.add('documentation');
  if (/\b(package|dependency|install|setup|configure)\b/.test(text)) intents.add('dependency/setup');
  if (/\b(style|ui|css|layout|responsive|design)\b/.test(text)) intents.add('styling/ui_change');
  if (/\b(git|branch|commit|diff|status|stage|push)\b/.test(text)) intents.add('git_operation');
  if (/\b(preview|dev server|localhost|open app)\b/.test(text)) intents.add('preview_request');
  if (/\b(explain|summarize|what is|how does|walk me through)\b/.test(text)) intents.add('repository_explanation');

  if (intents.size === 0) intents.add('answer/question');
  if (intents.has('system_diagram')) return ['system_diagram'];
  if (intents.has('repository_explanation') && intents.size === 1) return ['repository_explanation'];
  return Array.from(intents);
}

export function validateFreshStartManifest(filePaths: readonly string[]): {
  ok: boolean;
  planningFiles: string[];
  dslOrCodeFiles: string[];
  missing: string[];
} {
  const normalized = filePaths
    .map((filePath) => filePath.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((filePath) => filePath && !isCodeSpaceHiddenPath(filePath));

  const planningFiles = normalized.filter((filePath) => {
    const lower = filePath.toLowerCase();
    return lower.endsWith('.md') && /(plan|planning|instruction|instructions|spec|requirements|brief)/.test(lower);
  });

  const planningSet = new Set(planningFiles);
  const dslOrCodeFiles = normalized.filter((filePath) => {
    if (planningSet.has(filePath)) return false;
    const basename = filePath.split('/').pop() ?? filePath;
    if (basename === 'Dockerfile' || basename === 'Makefile') return true;
    const ext = basename.includes('.') ? `.${basename.split('.').pop()}`.toLowerCase() : '';
    return CODE_OR_DSL_EXTENSIONS.has(ext);
  });

  const missing: string[] = [];
  if (planningFiles.length === 0) missing.push('planning/instruction markdown');
  if (dslOrCodeFiles.length === 0) missing.push('DSL or code files');

  return {
    ok: missing.length === 0,
    planningFiles,
    dslOrCodeFiles,
    missing,
  };
}

export function createCodeSpaceProject(input: {
  name: string;
  sourceType: CodeSpaceProjectSourceType;
  rootPath?: string;
  repoRef?: string;
  source?: RepoSourceConfig;
}): CodeSpaceProject {
  const now = Date.now();
  const stableKey = input.rootPath ?? input.repoRef ?? input.name;
  return {
    id: `project:${stableKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || now}`,
    name: input.name,
    sourceType: input.sourceType,
    rootPath: input.rootPath,
    repoRef: input.repoRef,
    provider:
      input.sourceType === 'github'
        ? 'github'
        : input.sourceType === 'browser-folder'
          ? 'browser'
          : input.sourceType === 'zip'
            ? 'zip'
            : 'local',
    createdAt: now,
    updatedAt: now,
    treeState: { '.': true },
    active: false,
    permissions: {
      canRead: true,
      canWrite: input.sourceType !== 'github' || Boolean(input.rootPath),
      browserHandleGranted: input.sourceType === 'browser-folder',
    },
    source: input.source,
  };
}
