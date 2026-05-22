'use client';

import { zipSync } from 'fflate';
import { downloadBlob, downloadTextFile } from './download';

export type ExportContent = string | Blob | Uint8Array;

export interface ExportFile {
  name: string;
  content: ExportContent;
  mimeType?: string;
}

async function contentToBytes(content: ExportContent): Promise<Uint8Array> {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  return new Uint8Array(await content.arrayBuffer());
}

export async function downloadExportFiles(files: ExportFile[], zipFilename = 'export.zip'): Promise<void> {
  if (files.length === 0) return;

  if (files.length === 1) {
    const file = files[0]!;
    if (typeof file.content === 'string') {
      downloadTextFile(file.content, file.name, file.mimeType ?? 'text/plain;charset=utf-8');
    } else if (file.content instanceof Blob) {
      downloadBlob(file.content, file.name);
    } else {
      const buffer = file.content.buffer.slice(
        file.content.byteOffset,
        file.content.byteOffset + file.content.byteLength,
      ) as ArrayBuffer;
      downloadBlob(new Blob([buffer], { type: file.mimeType ?? 'application/octet-stream' }), file.name);
    }
    return;
  }

  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.name] = await contentToBytes(file.content);
  }
  const zipped = zipSync(entries, { level: 6 });
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), zipFilename);
}
