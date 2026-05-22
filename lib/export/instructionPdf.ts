'use client';

import { downloadBlob } from './download';

type ThemeMode = 'dark' | 'light';

export async function instructionPdfBlob(
  source: HTMLElement,
  theme: ThemeMode = 'dark',
): Promise<Blob> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
  const canvas = await html2canvas(source, {
    backgroundColor: theme === 'light' ? '#ffffff' : '#0b0e13',
    scale: 2,
    useCORS: true,
  });

  const pdf = new jsPDF('p', 'pt', 'a4');
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 36;
  const imageWidth = pageWidth - margin * 2;
  const imageHeight = (canvas.height * imageWidth) / canvas.width;
  const imageData = canvas.toDataURL('image/png');
  let y = margin;
  let remainingHeight = imageHeight;

  pdf.addImage(imageData, 'PNG', margin, y, imageWidth, imageHeight);
  remainingHeight -= pageHeight - margin * 2;

  while (remainingHeight > 0) {
    pdf.addPage();
    y -= pageHeight - margin * 2;
    pdf.addImage(imageData, 'PNG', margin, y, imageWidth, imageHeight);
    remainingHeight -= pageHeight - margin * 2;
  }

  return pdf.output('blob');
}

export async function downloadInstructionPdf(
  source: HTMLElement,
  filename = 'instruction-guide.pdf',
  theme: ThemeMode = 'dark',
): Promise<void> {
  const blob = await instructionPdfBlob(source, theme);
  downloadBlob(blob, filename);
}
