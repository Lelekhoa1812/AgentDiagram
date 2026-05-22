import { describe, expect, it } from 'vitest';
import { approxTokenCount, chunkFile } from '../chunker';

describe('chunkFile', () => {
  it('splits near logical class/function boundaries and stays near the target size', () => {
    const sections = Array.from(
      { length: 30 },
      (_, index) => `
export class Service${index} {
  async run${index}() {
    const values = [${Array.from({ length: 80 }, (_v, i) => i).join(', ')}];
    return values.map((value) => value + ${index});
  }
}
`,
    );
    const chunks = chunkFile('lib/service.ts', sections.join('\n'), 450);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(approxTokenCount(chunk.text)).toBeLessThanOrEqual(450 + 2600);
      expect(chunk.text.trimEnd()).toMatch(/}\s*$/);
    }
    expect(chunks.every((chunk) => chunk.total === chunks.length)).toBe(true);
  });
});

