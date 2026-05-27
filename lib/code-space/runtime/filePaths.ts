import path from 'node:path';
import { normalizeIgnoredFolders } from '@/lib/agent/repo/repoScanner';
import { defaultRepoPath, guardPath } from '@/lib/security/pathGuard';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);

export function resolveCodeSpaceChild(
  rootPath: string,
  relativePath = '',
): { ok: true; root: string; child: string; rel: string } | { ok: false; error: string } {
  const rootGuard = guardPath(rootPath || defaultRepoPath());
  if (!rootGuard.ok) return { ok: false, error: rootGuard.reason ?? 'Invalid root path' };
  const [normalized = ''] = normalizeIgnoredFolders([relativePath]);
  if (relativePath && !normalized) return { ok: false, error: 'Invalid file path' };
  const child = path.resolve(rootGuard.resolved, normalized || '.');
  if (child !== rootGuard.resolved && !child.startsWith(`${rootGuard.resolved}${path.sep}`)) {
    return { ok: false, error: 'File path escapes project root' };
  }
  return { ok: true, root: rootGuard.resolved, child, rel: normalized };
}

export function isCodeSpaceImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export function getCodeSpaceImageContentType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    case '.avif':
      return 'image/avif';
    case '.ico':
      return 'image/x-icon';
    default:
      return null;
  }
}
