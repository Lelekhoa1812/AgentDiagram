// Motivation vs Logic: keep one canonical list of "things the agent never needs to read" so the
// folder browser and the repo scanner stay perfectly in sync. Before this module each side had
// its own ad-hoc allow/deny rules and the browser would show entries the scanner already skipped
// (and vice versa), which was confusing. Here we model the policy in three small lists:
//
//  - HIDDEN_NAMES         exact folder OR file names hidden anywhere in the tree
//  - HIDDEN_EXTENSIONS    file extensions hidden anywhere (binary/media, markdown, logs, …)
//  - HIDDEN_PREFIXES      filename prefixes hidden anywhere (README*, LICENSE*, …)
//
// Plus a single rule: any name starting with "." is hidden. That single rule covers the long tail
// of dot-files users asked us to filter (.claude, .rtk, .gitignore, .dockerignore, .hintrc,
// .eslintrc*, .prettierrc*, .editorconfig, .env*, .npmrc, …) without us having to enumerate them.

const HIDDEN_FOLDER_NAMES = [
  // JS/TS build & cache outputs
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'coverage',
  'playwright-report',
  '.agentdiagram-cache',
  'vendor',

  // Motivation vs Logic: the user asked to hide scaffolding/config directories and caches so the browser skips them entirely.
  'sample',
  'samples',
  'example',
  'examples',
  'config',
  'configs',
  'setup',
  'scripts',
  'docker',
  'env',
  'cache',
  '.cache',
  'tmp',
  'temp',

  // Explicitly blacklist dot-ish configs the user referenced (redundant with the dot rule but good for clarity).
  'cursor',
  'claude',
  'vscode',
  'rtk',

  // Python toolchains and virtualenvs
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  'env',
  'site-packages',

  // Test directories (per user request: "tests/test folder")
  'tests',
  'test',
  '__tests__',
  '__mocks__',
  'e2e',
  'spec',
  'specs',

  // Log directories (per user request: "logs/log folder")
  'logs',
  'log',

  // Documentation directories
  'docs',
  'doc',
  'documentation',
] as const;

const HIDDEN_FILE_NAMES = [
  // Lockfiles
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Cargo.lock',

  // Manifests the user explicitly asked to bypass
  'requirements.txt',
  'Pipfile',

  // Docker (per user request)
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',

  // Misc OS / IDE noise
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'Dockerfile.azure',
  'docker-compose.azure.yml',
  'tsconfig.tsbuildinfo',
] as const;

export const HIDDEN_NAMES: readonly string[] = [...HIDDEN_FOLDER_NAMES, ...HIDDEN_FILE_NAMES];

// File extensions (with leading dot, lower-case) to hide anywhere in the tree.
export const HIDDEN_EXTENSIONS: readonly string[] = [
// Markdown/docs + config metadata files (per user request to hide txt/json/yaml/toml/etc). 
// Motivation vs Logic: these extensions are mostly configs, docs, or auxiliary artifacts we never need to parse.
  '.md',
  '.mdx',
  '.rst',
  '.adoc',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',

  // Data/office/external assets + security artifacts (per request to ignore non-code).
  '.csv',
  '.tsv',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.doc',
  '.docx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.pem',
  '.crt',
  '.key',

  // Media / design / font files that are never source code.
  '.psd',
  '.ai',
  '.eps',
  '.swf',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',

  // Archives / intermediate files / temp artifacts
  '.bak',
  '.tmp',
  '.swp',
  '.db',
  '.sqlite',
  '.sqlite3',

  // Logs
  '.log',

  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.tiff',
  '.heic',

  // Documents / archives / media
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.xz',
  '.bz2',
  '.iso',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.mkv',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',

  // Binaries / installers
  '.bin',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.o',
  '.jar',
  '.war',
  '.ear',
  '.pyc',
  '.class',
  '.pdb',
  '.apk',
  '.msi',
  '.dmg',
  '.pkg',

  // Source maps & minified assets
  '.map',
];

// Case-insensitive filename prefixes that should be hidden (covers README, README.md, README.txt…)
export const HIDDEN_PREFIXES: readonly string[] = [
  'README',
  'CHANGELOG',
  'CHANGES',
  'HISTORY',
  'NEWS',
  'LICENSE',
  'LICENCE',
  'COPYING',
  'NOTICE',
  'CONTRIBUTING',
  'CODE_OF_CONDUCT',
  'CODEOWNERS',
  'GOVERNANCE',
  'SECURITY',
  'SUPPORT',
  'MAINTAINERS',
  'AUTHORS',
  'AGENTS',
  'CLAUDE',
  'CURSOR',
  'GEMINI',
  'COPILOT',
  'RTK',
  'VSCODE',
];

const HIDDEN_NAME_SET = new Set(HIDDEN_NAMES);
const HIDDEN_EXT_SET = new Set(HIDDEN_EXTENSIONS.map((ext) => ext.toLowerCase()));
const HIDDEN_PREFIX_SET = HIDDEN_PREFIXES.map((prefix) => prefix.toLowerCase());

/**
 * Returns true when an entry should never appear in the user-facing folder browser AND should
 * never be considered by the agent scanner. The check is intentionally name-based (does not walk
 * the full path) because the browser inspects a single directory at a time.
 */
export function isHiddenByDefault(name: string, isDirectory: boolean): boolean {
  if (!name) return false;
  // Dotfiles / dot-folders (broad sweep — covers .claude, .rtk, .gitignore, .dockerignore,
  // .hintrc, .eslintrc, .prettierrc, .env, .env.local, .npmrc, .python-version, .tool-versions,
  // .editorconfig, .nvmrc, .yarnrc, .babelrc, IDE configs like .vscode/.idea, etc.).
  if (name.startsWith('.')) return true;

  if (HIDDEN_NAME_SET.has(name)) return true;

  if (!isDirectory) {
    const lower = name.toLowerCase();

    // Extension match (handles multi-dot files via lastIndexOf).
    const dot = lower.lastIndexOf('.');
    if (dot >= 0 && HIDDEN_EXT_SET.has(lower.slice(dot))) return true;

    // Prefix match (README, LICENSE, CLAUDE.md, AGENTS.md, …).
    for (const prefix of HIDDEN_PREFIX_SET) {
      if (lower.startsWith(prefix)) return true;
    }

    // Dockerfile variants (Dockerfile.dev, Dockerfile.prod, …).
    if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return true;
  }

  return false;
}

/**
 * Glob patterns for fast-glob's `ignore` option. We translate the name/extension/prefix lists
 * into globs so the scanner skips the same things the browser hides. Returned patterns are safe
 * to concat with user-supplied ones.
 */
export function defaultScannerIgnorePatterns(): string[] {
  const patterns: string[] = [];

  // Every dot-segment anywhere (covers `.claude/**`, `.git/**`, `.env`, `.env.local`, …).
  // fast-glob already excludes dotfiles when `dot: false` is set, but include explicit globs so
  // callers that flip `dot: true` still get the same policy.
  patterns.push('**/.*', '**/.*/**');

  for (const name of HIDDEN_NAMES) {
    patterns.push(`**/${name}`);
    patterns.push(`**/${name}/**`);
  }

  for (const ext of HIDDEN_EXTENSIONS) {
    patterns.push(`**/*${ext}`);
  }

  for (const prefix of HIDDEN_PREFIXES) {
    patterns.push(`**/${prefix}*`);
  }

  patterns.push('**/Dockerfile.*');

  // Test-file naming conventions across stacks.
  patterns.push('**/*.test.*', '**/*.spec.*');

  return patterns;
}
