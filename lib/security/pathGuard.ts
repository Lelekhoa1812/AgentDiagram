import os from 'node:os';
import path from 'node:path';

const FORBIDDEN_PREFIXES = ['/etc', '/var', '/usr', '/bin', '/sbin', '/System', '/Library'];
const FORBIDDEN_NAMES = ['.ssh', '.aws', '.config', '.gnupg'];

export interface PathGuardResult {
  ok: boolean;
  resolved: string;
  reason?: string;
}

export function guardPath(input: string, opts: { allowSensitive?: boolean } = {}): PathGuardResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, resolved: '', reason: 'Path is required' };
  }
  let resolved = input;
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  resolved = path.resolve(resolved);

  if (resolved === '/') {
    return { ok: false, resolved, reason: 'Refusing root directory' };
  }
  if (!opts.allowSensitive) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
        return { ok: false, resolved, reason: `Path inside ${prefix} is blocked by default` };
      }
    }
    const segments = resolved.split(path.sep).filter(Boolean);
    for (const seg of segments) {
      if (FORBIDDEN_NAMES.includes(seg)) {
        return { ok: false, resolved, reason: `Path contains sensitive segment "${seg}"` };
      }
    }
    if (segments.length < 2) {
      return { ok: false, resolved, reason: 'Path is too shallow' };
    }
  }
  return { ok: true, resolved };
}

export function defaultRepoPath(): string {
  if (process.env.AGENTDIAGRAM_DEFAULT_REPO_PATH) {
    return process.env.AGENTDIAGRAM_DEFAULT_REPO_PATH;
  }
  return path.resolve(process.cwd(), '..');
}
