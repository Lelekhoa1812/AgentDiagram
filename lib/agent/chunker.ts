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

export function chunkFile(filePath: string, text: string, maxTokens = 1800): Chunk[] {
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
