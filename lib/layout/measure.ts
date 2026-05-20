/**
 * SSR-safe text measurement.
 *
 * We avoid relying on a DOM canvas for layout so that ELK runs the same
 * on server and client. Uses a character-width approximation calibrated
 * against Inter at the relevant pixel sizes.
 */

const INTER_AVG_WIDTH = 0.55; // ratio of px width to font-size for average Inter glyphs

export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split('\n');
  const width = lines.reduce((max, line) => Math.max(max, approxLineWidth(line, fontSize)), 0);
  const height = lines.length * fontSize * 1.25;
  return { width, height };
}

function approxLineWidth(line: string, fontSize: number): number {
  let total = 0;
  for (const ch of line) {
    total += charWidth(ch, fontSize);
  }
  return total;
}

function charWidth(ch: string, fontSize: number): number {
  const code = ch.charCodeAt(0);
  // Narrow chars
  if ('ilftIjI|.,:;\''.includes(ch)) return fontSize * 0.32;
  // Wide chars
  if ('mwWMQ@%'.includes(ch)) return fontSize * 0.85;
  // Digits
  if (code >= 48 && code <= 57) return fontSize * 0.6;
  // Spaces
  if (ch === ' ') return fontSize * 0.3;
  // Default
  return fontSize * INTER_AVG_WIDTH;
}

export function nodeSize(label: string): { width: number; height: number } {
  const text = measureText(label, 11);
  const horizontalPadding = 28; // icon + padding
  const verticalPadding = 22;
  return {
    width: Math.max(110, Math.ceil(text.width + horizontalPadding)),
    height: Math.max(44, Math.ceil(text.height + verticalPadding)),
  };
}

export function groupTitleSize(title: string): { width: number; height: number } {
  const text = measureText(title.toUpperCase(), 10);
  return {
    width: Math.ceil(text.width + 36),
    height: 22,
  };
}

export function edgeLabelSize(label: string): { width: number; height: number } {
  const text = measureText(label, 9.5);
  return {
    width: Math.ceil(text.width + 18),
    height: Math.ceil(text.height + 8),
  };
}
