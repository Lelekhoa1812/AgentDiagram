function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeMarkdownPath(filePath: string): string {
  return safeDecodeURIComponent(filePath)
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function dirnameMarkdownPath(filePath: string): string {
  const normalized = normalizeMarkdownPath(filePath);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
}

export function resolveMarkdownPath(currentFilePath: string, targetPath: string): string {
  const normalizedTarget = safeDecodeURIComponent(targetPath).replace(/\\/g, '/').trim();
  if (!normalizedTarget) return '';

  const [pathPart = ''] = normalizedTarget.split('#', 2);
  const baseSegments = normalizedTarget.startsWith('/')
    ? []
    : dirnameMarkdownPath(currentFilePath).split('/').filter(Boolean);
  const targetSegments = pathPart
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);

  const resolved: string[] = [...baseSegments];
  for (const segment of targetSegments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join('/');
}

const EXTERNAL_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export type MarkdownLinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; hash: string }
  | { kind: 'file'; path: string; hash?: string };

export function resolveMarkdownLinkTarget(currentFilePath: string, href: string): MarkdownLinkTarget | null {
  const normalizedHref = safeDecodeURIComponent(href).trim();
  if (!normalizedHref) return null;
  if (normalizedHref.startsWith('#')) {
    return { kind: 'anchor', hash: normalizedHref.slice(1) };
  }
  if (normalizedHref.startsWith('//') || EXTERNAL_URL_PATTERN.test(normalizedHref) || normalizedHref.startsWith('data:')) {
    return { kind: 'external', href: normalizedHref };
  }

  const [pathPart = '', hashPart = ''] = normalizedHref.split('#', 2);
  const resolvedPath = resolveMarkdownPath(currentFilePath, pathPart);
  if (!resolvedPath) {
    return hashPart ? { kind: 'anchor', hash: hashPart } : null;
  }

  return { kind: 'file', path: resolvedPath, hash: hashPart || undefined };
}

export function buildMarkdownAssetUrl(rootPath: string, currentFilePath: string, src: string): string | null {
  const resolved = resolveMarkdownLinkTarget(currentFilePath, src);
  if (!resolved || resolved.kind === 'anchor') return null;
  if (resolved.kind === 'external') return resolved.href;
  if (resolved.kind !== 'file') return null;

  const params = new URLSearchParams({
    rootPath,
    path: resolved.path,
  });
  return `/api/code-space/assets?${params.toString()}`;
}

export function slugifyMarkdownHeading(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}
