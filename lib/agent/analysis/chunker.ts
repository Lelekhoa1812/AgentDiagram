/**
 * Token-aware file chunker.
 *
 * Uses a rough char→token heuristic (4 chars ≈ 1 token for source code).
 * Aims to produce chunks that fit comfortably inside a single LLM call.
 */

export interface Chunk {
  filePath: string;
  index: number;
  total: number;
  text: string;
  approxTokens: number;
}

const CHARS_PER_TOKEN = 4;

function logicalBoundaryScore(text: string, index: number): number {
  const before = text.slice(Math.max(0, index - 180), index);
  const after = text.slice(index, Math.min(text.length, index + 180));
  if (/\n\s*\n$/.test(before) && /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|def|func|pub\s+fn|impl|mod)\b/m.test(after)) return 100;
  if (/\n\s*}\s*\n\s*\n$/.test(before)) return 95;
  if (/\n\s*(?:end|})\s*\n$/.test(before)) return 90;
  if (/\n\s*\n$/.test(before)) return 70;
  if (/[;)}]\s*\n$/.test(before)) return 45;
  if (/\n$/.test(before)) return 25;
  return 0;
}

function findLogicalBoundary(text: string, target: number, windowChars: number): number {
  const start = Math.max(1, target - windowChars);
  const end = Math.min(text.length - 1, target + windowChars);
  let best = target;
  let bestScore = -1;
  for (let index = start; index <= end; index++) {
    const ch = text[index];
    if (ch !== '\n' && ch !== ';' && ch !== '}') continue;
    const score = logicalBoundaryScore(text, index + 1);
    const distancePenalty = Math.abs(index - target) / Math.max(1, windowChars);
    const adjusted = score - distancePenalty;
    if (adjusted > bestScore) {
      best = index + 1;
      bestScore = adjusted;
    }
  }
  return best;
}

export function chunkFile(filePath: string, text: string, maxTokens = 1800): Chunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return [{ filePath, index: 0, total: 1, text, approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN) }];
  }

  const chunks: Chunk[] = [];
  const boundaryWindowChars = 2500 * CHARS_PER_TOKEN;
  let offset = 0;
  // Motivation vs Logic: large repos fail when raw windows are cut blindly. We still use a cheap
  // token heuristic, but each split searches around the target for a class/function/module boundary
  // so downstream summaries do not receive half of a critical operation.
  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= maxChars) {
      chunks.push({
        filePath,
        index: chunks.length,
        total: 0,
        text: text.slice(offset),
        approxTokens: Math.ceil(remaining / CHARS_PER_TOKEN),
      });
      break;
    }
    const target = offset + maxChars;
    let boundary = findLogicalBoundary(text, target, boundaryWindowChars);
    if (boundary <= offset + Math.floor(maxChars * 0.35) || boundary >= text.length) {
      boundary = target;
    }
    chunks.push({
      filePath,
      index: chunks.length,
      total: 0,
      text: text.slice(offset, boundary),
      approxTokens: Math.ceil((boundary - offset) / CHARS_PER_TOKEN),
    });
    offset = boundary;
  }
  for (const c of chunks) c.total = chunks.length;
  return chunks;
}

export function lineChunkFile(filePath: string, text: string, maxTokens = 1800): Chunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return [{ filePath, index: 0, total: 1, text, approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN) }];
  }
  const chunks: Chunk[] = [];
  // Prefer splitting on blank lines, falling back to char windows.
  const lines = text.split('\n');
  let buf: string[] = [];
  let bufLen = 0;
  for (const line of lines) {
    if (bufLen + line.length + 1 > maxChars && buf.length > 0) {
      chunks.push({
        filePath,
        index: chunks.length,
        total: 0,
        text: buf.join('\n'),
        approxTokens: Math.ceil(bufLen / CHARS_PER_TOKEN),
      });
      buf = [];
      bufLen = 0;
    }
    buf.push(line);
    bufLen += line.length + 1;
  }
  if (buf.length) {
    chunks.push({
      filePath,
      index: chunks.length,
      total: 0,
      text: buf.join('\n'),
      approxTokens: Math.ceil(bufLen / CHARS_PER_TOKEN),
    });
  }
  for (const c of chunks) c.total = chunks.length;
  return chunks;
}

export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
