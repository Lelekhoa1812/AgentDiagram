import fg from 'fast-glob';
import ignore from 'ignore';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_IGNORE = [
  'node_modules/**',
  '.next/**',
  '.turbo/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.git/**',
  '**/*.min.js',
  '**/*.map',
  '**/*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.ico',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.pem',
  '**/*.key',
  '**/*.crt',
  '**/.env',
  '**/.env.*',
  '.agentdiagram-cache/**',
  'vendor/**',
];

const MAX_FILE_BYTES = 1024 * 1024; // 1MB

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

export async function scanRepo(root: string): Promise<RepoMap> {
  const ig = await readGitignore(root);

  const entries = await fg('**/*', {
    cwd: root,
    dot: false,
    onlyFiles: true,
    ignore: DEFAULT_IGNORE,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  const filtered = entries.filter((p) => !ig.ignores(p));

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
    ignoredFolders: DEFAULT_IGNORE,
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
