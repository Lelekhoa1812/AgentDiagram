'use client';

import { serializeSvg } from './svg';

export interface PrintDiagramOptions {
  title?: string;
  includeBackground?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildPrintHtml(svgMarkup: string, title: string): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      @page {
        margin: 12mm;
        size: auto;
      }

      html,
      body {
        margin: 0;
        padding: 0;
        background: #fff;
      }

      body {
        min-height: 100vh;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .page {
        box-sizing: border-box;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12mm;
      }

      svg {
        display: block;
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
      }
    </style>
  </head>
  <body>
    <div class="page">
      ${svgMarkup}
    </div>
  </body>
</html>`;
}

export async function printSvgDiagram(
  source: SVGSVGElement,
  opts: PrintDiagramOptions = {},
): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '1024px';
  iframe.style.height = '768px';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  const cleanup = () => {
    iframe.onload = null;
    iframe.remove();
  };

  const printWindow = iframe.contentWindow;
  const printDocument = iframe.contentDocument;
  if (!printWindow || !printDocument) {
    cleanup();
    return;
  }

  const svgMarkup = serializeSvg(source, { includeBackground: opts.includeBackground ?? true });
  printDocument.open();
  printDocument.write(buildPrintHtml(svgMarkup, opts.title ?? 'Diagram'));
  printDocument.close();

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve();
    };

    const timeout = window.setTimeout(finish, 30_000);
    const handleAfterPrint = () => {
      window.clearTimeout(timeout);
      finish();
    };

    printWindow.addEventListener('afterprint', handleAfterPrint, { once: true });
    queueMicrotask(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        window.clearTimeout(timeout);
        finish();
      }
    });
  });
}
