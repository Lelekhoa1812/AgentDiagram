import fg from 'fast-glob';
import ignore from 'ignore';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultScannerIgnorePatterns } from './ignoreDefaults';

// Motivation vs Logic: the canonical "skip" list lives in `ignoreDefaults.ts` so the folder
// browser and the scanner stay in lock-step. We keep a few scanner-specific extras here for
// security-sensitive patterns (credentials, source-maps, minified assets) that have no reason to
// surface in either view.
const DEFAULT_IGNORE = [
  ...defaultScannerIgnorePatterns(),
  '**/*.min.js',
  '**/*.min.css',
  '**/*.lock',
  '**/*.pem',
  '**/*.key',
  '**/*.crt',
  '**/diagram.png',
  '**/diagram.svg',
];

const MAX_FILE_BYTES = 1024 * 1024; // 1MB

export const AGENT_ALLOWED_EXTENSIONS = [
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'cxx',
  'go',
  'graphql',
  'gql',
  'h',
  'hpp',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'mjs',
  'php',
  'prisma',
  'py',
  'rb',
  'rs',
  'scala',
  'scss',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
] as const;

// Motivation vs Logic: `Dockerfile`, `docker-compose.*` and `requirements.txt` used to live
// here so the scanner could read them as manifests. The product decision is to bypass them
// entirely (they're hidden from the folder browser too); `pyproject.toml` still covers Python
// stack detection and `package.json` / `Cargo.toml` / `go.mod` cover everything else.
export const AGENT_ALLOWED_FILES = [
  'Cargo.toml',
  'Gemfile',
  'build.gradle',
  'composer.json',
  'go.mod',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'package.json',
  'pom.xml',
  'pyproject.toml',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'webpack.config.js',
  'webpack.config.ts',
] as const;

export interface RepoScanAllowlist {
  extensions: readonly string[];
  fileNames: readonly string[];
}

export const AGENT_FILE_ALLOWLIST: RepoScanAllowlist = {
  extensions: AGENT_ALLOWED_EXTENSIONS,
  fileNames: AGENT_ALLOWED_FILES,
};

export interface RepoScanOptions {
  allowlist?: RepoScanAllowlist;
  ignoredFolders?: readonly string[];
}

export interface ScannedFile {
  /** Relative POSIX-style path */
  path: string;
  bytes: number;
  ext: string;
}

export interface RepoMap {
  root: string;
  fileCount: number;
  totalBytes: number;
  byExt: Record<string, number>;
  files: ScannedFile[];
  manifests: ScannedFile[];
  entrypoints: ScannedFile[];
  apiRoutes: ScannedFile[];
  components: ScannedFile[];
  schemas: ScannedFile[];
  configs: ScannedFile[];
  infra: ScannedFile[];
  tests: ScannedFile[];
  docs: ScannedFile[];
  depHints: string[];
  ignoredFolders: string[];
  likelyStack: string[];
}

const MANIFESTS = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
]);

function classify(file: ScannedFile, map: RepoMap): void {
  const p = file.path.toLowerCase();
  const name = path.basename(p);

  if (MANIFESTS.has(name)) map.manifests.push(file);
  if (/(^|\/)(index|main|app|server)\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/.test(p))
    map.entrypoints.push(file);
  if (/(^|\/)(api|routes|handlers)\//.test(p) && /\.(ts|tsx|js|jsx|py|go)$/.test(p))
    map.apiRoutes.push(file);
  if (/components\/.*\.(tsx|jsx|vue|svelte)$/.test(p)) map.components.push(file);
  if (/(schema|migrations|prisma|models)\//.test(p) || /\.(prisma|sql)$/.test(p))
    map.schemas.push(file);
  if (/(^|\/)(?:tsconfig|vite|webpack|next|tailwind|babel|eslint|prettier|vitest|jest|playwright)/.test(p))
    map.configs.push(file);
  if (
    /(^|\/)(dockerfile|docker-compose|terraform|cloudformation|helm|kustomization|kubernetes)\b/i.test(
      file.path,
    )
  )
    map.infra.push(file);
  if (/(test|spec)\.(ts|tsx|js|jsx|py|go|rb|java)$/.test(p) || /__tests__\//.test(p))
    map.tests.push(file);
  if (/(^|\/)(readme|docs|adr)/.test(p) || /\.(md|mdx)$/.test(p)) map.docs.push(file);
}

function detectStack(map: RepoMap): string[] {
  const stack: string[] = [];
  if (map.manifests.some((f) => path.basename(f.path) === 'package.json')) stack.push('Node.js');
  if (map.files.some((f) => f.path.includes('next.config'))) stack.push('Next.js');
  if (map.files.some((f) => f.ext === 'tsx' || f.ext === 'jsx')) stack.push('React');
  if (map.manifests.some((f) => path.basename(f.path) === 'pyproject.toml' || path.basename(f.path) === 'requirements.txt'))
    stack.push('Python');
  if (map.manifests.some((f) => path.basename(f.path) === 'Cargo.toml')) stack.push('Rust');
  if (map.manifests.some((f) => path.basename(f.path) === 'go.mod')) stack.push('Go');
  if (map.files.some((f) => f.path.includes('Dockerfile'))) stack.push('Docker');
  if (map.files.some((f) => f.path.includes('prisma'))) stack.push('Prisma');
  return stack;
}

async function readGitignore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  try {
    const txt = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    ig.add(txt);
  } catch {
    /* no .gitignore */
  }
  return ig;
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

export function normalizeIgnoredFolders(folders: readonly string[] = []): string[] {
  const normalized = new Set<string>();
  for (const folder of folders) {
    const cleaned = folder
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .trim();
    if (!cleaned || cleaned === '.' || cleaned.startsWith('../') || cleaned.includes('/../')) continue;
    normalized.add(cleaned);
  }
  return [...normalized].sort((a, b) => a.localeCompare(b));
}

// Motivation vs Logic: users can now ignore individual files in addition to folders, but the
// store still keeps a flat string[] for backwards compatibility. We emit both a literal pattern
// (matches a single file or the folder name itself) and a `/**` pattern (matches folder contents)
// so fast-glob filters both cases without us tracking whether the entry was a file or directory.
function ignoredFolderPatterns(folders: readonly string[]): string[] {
  const patterns: string[] = [];
  for (const folder of normalizeIgnoredFolders(folders)) {
    patterns.push(folder);
    patterns.push(`${folder}/**`);
  }
  return patterns;
}

function isAllowedByAllowlist(rel: string, allowlist: RepoScanAllowlist): boolean {
  // Motivation vs Logic: repo previews and agent runs should only ever admit code-like inputs. Keeping the allowlist here means later stages cannot accidentally read docs, screenshots, cached summaries, or test fixtures just because they share a folder with source.
  const normalizedRel = rel.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalizedRel);
  const allowedFiles = new Set(allowlist.fileNames.map((name) => name.replace(/\\/g, '/').toLowerCase()));
  if (allowedFiles.has(normalizedRel) || allowedFiles.has(basename)) return true;

  const ext = normalizeExt(path.extname(rel).slice(1));
  if (!ext) return false;
  return new Set(allowlist.extensions.map(normalizeExt)).has(ext);
}

export async function scanRepo(root: string, opts: RepoScanOptions = {}): Promise<RepoMap> {
  const ig = await readGitignore(root);
  const allowlist = opts.allowlist ?? AGENT_FILE_ALLOWLIST;
  const ignorePatterns = [...DEFAULT_IGNORE, ...ignoredFolderPatterns(opts.ignoredFolders ?? [])];

  const entries = await fg('**/*', {
    cwd: root,
    dot: false,
    onlyFiles: true,
    ignore: ignorePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  const filtered = entries.filter((p) => !ig.ignores(p) && isAllowedByAllowlist(p, allowlist));

  const map: RepoMap = {
    root,
    fileCount: 0,
    totalBytes: 0,
    byExt: {},
    files: [],
    manifests: [],
    entrypoints: [],
    apiRoutes: [],
    components: [],
    schemas: [],
    configs: [],
    infra: [],
    tests: [],
    docs: [],
    depHints: [],
    ignoredFolders: ignorePatterns,
    likelyStack: [],
  };

  for (const rel of filtered) {
    const abs = path.join(root, rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const ext = path.extname(rel).slice(1).toLowerCase();
      const file: ScannedFile = { path: rel.replace(/\\/g, '/'), bytes: stat.size, ext };
      map.files.push(file);
      map.fileCount++;
      map.totalBytes += stat.size;
      map.byExt[ext] = (map.byExt[ext] ?? 0) + 1;
      classify(file, map);
    } catch {
      /* unreadable */
    }
  }

  // Pull dependency hints from package.json
  const pkg = map.manifests.find((f) => path.basename(f.path) === 'package.json');
  if (pkg) {
    try {
      const txt = await fs.readFile(path.join(root, pkg.path), 'utf8');
      const json = JSON.parse(txt) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      map.depHints = [
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
      ].slice(0, 40);
    } catch {
      /* malformed */
    }
  }

  map.likelyStack = detectStack(map);
  return map;
}

/** Read a file from a scanned repo, truncated to maxBytes if needed. */
export async function readRepoFile(root: string, rel: string, maxBytes = 64_000): Promise<string> {
  const buf = await fs.readFile(path.join(root, rel));
  if (buf.length <= maxBytes) return buf.toString('utf8');
  return buf.subarray(0, maxBytes).toString('utf8') + `\n\n// …truncated (${buf.length - maxBytes} bytes)`;
}
