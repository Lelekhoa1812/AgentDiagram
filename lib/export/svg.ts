/**
 * SVG export. Serializes the *current* on-screen SVG, inlines styles, and
 * returns a standalone SVG string usable for downstream PNG rasterization
 * or direct download.
 */

import { themeFor, type RenderThemeMode } from '../render/theme';

interface SerializeOptions {
  includeBackground?: boolean;
  /** Inline font face (data: URL or external) */
  inlineFontCss?: string;
}

const INTER_FONT_CSS = `
@font-face {
  font-family: 'Inter';
  src: local('Inter'), local('Inter-Regular'), url('https://rsms.me/inter/font-files/Inter-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: local('Inter'), local('Inter-Medium'), url('https://rsms.me/inter/font-files/Inter-Medium.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: local('Inter'), local('Inter-SemiBold'), url('https://rsms.me/inter/font-files/Inter-SemiBold.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
`;

export function serializeSvg(source: SVGSVGElement, opts: SerializeOptions = {}): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.style.transform = '';
  clone.style.transformOrigin = '';
  clone.removeAttribute('style');

  // Inject background
  if (opts.includeBackground) {
    const viewBox = clone.getAttribute('viewBox')?.split(' ').map(Number);
    if (viewBox && viewBox.length === 4) {
      const [x, y, w, h] = viewBox as [number, number, number, number];
      const mode: RenderThemeMode = source.dataset.diagramTheme === 'light' ? 'light' : 'dark';
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', String(x));
      bg.setAttribute('y', String(y));
      bg.setAttribute('width', String(w));
      bg.setAttribute('height', String(h));
      bg.setAttribute('fill', themeFor(mode).background);
      clone.insertBefore(bg, clone.firstChild);
    }
  }

  // Inline font CSS
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = opts.inlineFontCss ?? INTER_FONT_CSS;
  clone.insertBefore(style, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

export function downloadSvg(source: SVGSVGElement, filename = 'diagram.svg', opts?: SerializeOptions): void {
  const svgString = serializeSvg(source, opts);
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
