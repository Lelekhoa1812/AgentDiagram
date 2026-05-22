import type { ImportGraph } from './importGraph';
import type { RepoContextDigest } from './repoContext';
import type { ScannedFile } from './repoScanner';
import { normalizeFileSummary, type FileSummary } from './summarizer';

const EXPORT_PATTERNS: Array<RegExp> = [
  /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s*\{([^}]+)\}/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
  /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/gm,
  /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:func|type)\s+([A-Za-z_]\w*)/gm,
];

const CALL_PATTERNS: Array<RegExp> = [
  /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /^\s*func\s+([A-Za-z_]\w*)/gm,
];

function uniqLimit(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1];
      if (!value) continue;
      if (value.includes(',')) {
        for (const part of value.split(',')) {
          const symbol = part.trim().split(/\s+as\s+/i)[0]?.trim();
          if (symbol) symbols.push(symbol);
        }
      } else {
        symbols.push(value);
      }
    }
  }
  for (const pattern of CALL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) symbols.push(match[1]);
    }
  }
  return uniqLimit(symbols, 25);
}

function inferCategory(path: string): FileSummary['category'] {
  const lower = path.toLowerCase();
  if (/\/api\/|\/routes?\//.test(lower)) return 'api';
  if (/\.(tsx|jsx|vue|svelte)$/.test(lower) || /(^|\/)components?\//.test(lower)) return 'component';
  if (/(^|\/)(services?|domain|controllers?|handlers?)\//.test(lower)) return 'service';
  if (/(schema|models?|prisma|migrations|\.sql$)/.test(lower)) return 'schema';
  if (/(^|\/)(utils?|helpers?|shared|common)\//.test(lower)) return 'util';
  if (/(test|spec)\./.test(lower) || /__tests__\//.test(lower)) return 'test';
  if (/(worker|queue|job)\b/.test(lower)) return 'worker';
  if (/(client|sdk)\b/.test(lower)) return 'client';
  if (/(ai|agent|llm|prompt)\b/.test(lower)) return 'ai';
  if (/(config|settings|env)\b/.test(lower)) return 'config';
  return 'other';
}

function inferLayer(path: string): FileSummary['layer'] {
  const lower = path.toLowerCase();
  if (/components?|pages?|app\/(?!api)/.test(lower)) return 'client';
  if (/app\/api|pages\/api|gateway|routes?|controllers?/.test(lower)) return 'gateway';
  if (/services?|domain|handlers?/.test(lower)) return 'service';
  if (/auth|identity|session|user/.test(lower)) return 'identity';
  if (/worker|queue|job|async/.test(lower)) return 'async';
  if (/models?|schema|prisma|db|database|repository/.test(lower)) return 'data';
  if (/analytics|metrics|events/.test(lower)) return 'analytics';
  if (/storage|blob|s3|bucket|file/.test(lower)) return 'storage';
  if (/log|trace|observability|monitor/.test(lower)) return 'observability';
  if (/infra|deploy|docker|terraform|kubernetes|helm/.test(lower)) return 'platform';
  if (/test|spec|dev|scripts?/.test(lower)) return 'devx';
  if (/stripe|billing|payment/.test(lower)) return 'billing';
  if (/ai|agent|llm|prompt|openai|anthropic|gemini/.test(lower)) return 'ai';
  return 'other';
}

function inferSideEffects(content: string): string[] {
  const effects: string[] = [];
  if (/\bprocess\.env\.|import\.meta\.env|Deno\.env|os\.environ|getenv\(/.test(content)) effects.push('env-var reads');
  if (/\bfetch\(|axios\.|http\.|request\(/.test(content)) effects.push('HTTP calls');
  if (/\b(prisma|db|database|repository)\.[A-Za-z_]\w*\.(create|update|delete|upsert|insert|save|find|query)\b/i.test(content)) effects.push('database access');
  if (/\b(queue|publish|send|emit|enqueue|topic)\b/i.test(content)) effects.push('queue/event activity');
  if (/\b(writeFile|appendFile|mkdir|rm|unlink|createWriteStream)\b/.test(content)) effects.push('filesystem writes');
  return effects;
}

function externalDeps(filePath: string, importGraph: ImportGraph): string[] {
  return uniqLimit(
    importGraph.edges
      .filter((edge) => edge.from === filePath && edge.external)
      .map((edge) => edge.to),
    20,
  );
}

function localImports(filePath: string, importGraph: ImportGraph): string[] {
  return uniqLimit(importGraph.files.get(filePath) ?? [], 30);
}

function clusterNote(filePath: string, repoContext?: RepoContextDigest): string | null {
  const cluster = repoContext?.folderClusters.find((item) => filePath === item.folder || filePath.startsWith(`${item.folder}/`));
  if (!cluster) return null;
  return `Signature profile in ${cluster.folder}: ${cluster.fileCount} files, ${cluster.importsIn} inbound, ${cluster.importsOut} outbound.`;
}

export function createSignatureSummary(
  file: ScannedFile,
  content: string,
  importGraph: ImportGraph,
  repoContext?: RepoContextDigest,
): FileSummary {
  // Motivation vs Logic: higher analysis tiers intentionally bypass implementation bodies, but
  // the planner still needs stable names and dependency hints. This deterministic profile captures
  // the public surface and side effects without spending LLM tokens on helper internals.
  const surface = extractSymbols(content);
  return normalizeFileSummary({
    role: `Signature-level profile for ${file.path}`,
    category: inferCategory(file.path),
    layer: inferLayer(file.path),
    exports: surface.slice(0, 20),
    imports: localImports(file.path, importGraph),
    surface,
    external_deps: externalDeps(file.path, importGraph),
    side_effects: inferSideEffects(content),
    notes: clusterNote(file.path, repoContext),
  });
}
