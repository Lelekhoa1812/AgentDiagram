import { serializeSvg } from './svg';

export interface PngExportOptions {
  scale?: 1 | 2 | 4;
  includeBackground?: boolean;
}

export async function svgToPngBlob(source: SVGSVGElement, opts: PngExportOptions = {}): Promise<Blob> {
  const scale = opts.scale ?? 2;
  const svgString = serializeSvg(source, { includeBackground: opts.includeBackground ?? true });
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();

    const viewBoxAttr = source.getAttribute('viewBox') ?? '';
    const parts = viewBoxAttr.split(' ').map(Number);
    const vbWidth = parts[2] ?? source.clientWidth;
    const vbHeight = parts[3] ?? source.clientHeight;

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vbWidth * scale);
    canvas.height = Math.ceil(vbHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D canvas context');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const pngBlob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    if (!pngBlob) throw new Error('canvas.toBlob returned null');
    return pngBlob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadPng(source: SVGSVGElement, filename = 'diagram.png', opts?: PngExportOptions): Promise<void> {
  const blob = await svgToPngBlob(source, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyPngToClipboard(source: SVGSVGElement, opts?: PngExportOptions): Promise<void> {
  const blob = await svgToPngBlob(source, opts);
  const item = new ClipboardItem({ 'image/png': blob });
  await navigator.clipboard.write([item]);
}
