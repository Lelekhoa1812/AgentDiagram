import { COLOR_NAMES } from '@/lib/ir/types';
import { knownIconNames } from '@/lib/icons/registry';

export const COLORS = COLOR_NAMES;
export const ICONS = knownIconNames();

/**
 * Find the source-text span of a declaration's property list and rewrite a
 * single key. Used by inspector → DSL writes. If the property doesn't exist
 * yet, append it.
 */
export function rewriteDeclProp(dsl: string, name: string, key: string, value: string): string {
  // Find the line whose first token matches `name` (allowing for nested indent).
  const lines = dsl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimStart();
    if (line.startsWith('//')) continue;
    if (!line.startsWith(name)) continue;
    const after = line.slice(name.length);
    if (!/^\s*(\[|\{|$)/.test(after)) continue;

    // Edit the props block
    const bracket = raw.indexOf('[');
    if (bracket === -1) {
      // No props yet — insert one.
      const closingBrace = raw.indexOf('{');
      const insertAt = closingBrace === -1 ? raw.length : closingBrace;
      const prefix = raw.slice(0, insertAt).trimEnd();
      const suffix = raw.slice(insertAt);
      lines[i] = `${prefix} [${key}: ${value}]${suffix ? ' ' + suffix.trim() : ''}`;
      return lines.join('\n');
    }
    const close = raw.indexOf(']', bracket);
    if (close === -1) return dsl;
    const inner = raw.slice(bracket + 1, close);
    const parts = inner.split(',').map((p) => p.trim()).filter(Boolean);
    let replaced = false;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j]!.startsWith(`${key}:`)) {
        parts[j] = `${key}: ${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) parts.push(`${key}: ${value}`);
    lines[i] = `${raw.slice(0, bracket)}[${parts.join(', ')}]${raw.slice(close + 1)}`;
    return lines.join('\n');
  }
  return dsl;
}
