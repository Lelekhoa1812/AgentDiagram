/**
 * Render `examples/flow.txt` to a PNG using the same DSL → layout → renderer
 * pipeline as the on-screen app. Output: `examples/flow.png`.
 *
 * This is intentionally a Node-side render (no headless browser) so the
 * generated PNG is reproducible from CI and doesn't require the dev server.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { compile } from '../lib/dsl/compiler';
import { runLayout } from '../lib/layout/strategies';
import { renderSvg } from '../lib/render/svgString';

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const input = path.join(ROOT, 'examples', 'flow.txt');
  const outputSvg = path.join(ROOT, 'examples', 'flow.svg');
  const outputPng = path.join(ROOT, 'examples', 'flow.png');

  const dsl = await readFile(input, 'utf8');
  const diagram = compile(dsl);
  const errors = diagram.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) {
    console.error('Compile errors:');
    for (const e of errors) {
      console.error(`  line ${e.line}:${e.column} — ${e.message}`);
    }
    process.exit(1);
  }
  console.log(
    `Compiled: ${diagram.groups.length} groups · ${diagram.nodes.length} nodes · ${diagram.edges.length} edges`,
  );

  const layout = await runLayout(diagram, 'auto');
  console.log(`Layout: ${Math.round(layout.bbox.width)}x${Math.round(layout.bbox.height)}`);

  const svg = renderSvg(diagram, layout, { withBackground: true, padding: 32 });
  await writeFile(outputSvg, svg, 'utf8');
  console.log(`Wrote ${path.relative(ROOT, outputSvg)} (${(svg.length / 1024).toFixed(1)} KB)`);

  const resvg = new Resvg(svg, {
    background: '#07090c',
    fitTo: { mode: 'width', value: Math.ceil((layout.bbox.width + 64) * 2) },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  });
  const png = resvg.render().asPng();
  await writeFile(outputPng, png);
  console.log(`Wrote ${path.relative(ROOT, outputPng)} (${(png.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
