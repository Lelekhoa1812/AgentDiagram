import { inflateRawSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import { validateFreshStartManifest } from '@/lib/code-space/core';

export const runtime = 'nodejs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 300;

interface ZipEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('Invalid zip: central directory not found');

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const end = centralDirectoryOffset + centralDirectorySize;
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  while (offset < end && entries.length < MAX_FILES) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const entryPath = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength).replace(/\\/g, '/');

    if (!entryPath.endsWith('/')) {
      entries.push({
        path: entryPath.replace(/^\/+/, ''),
        compressedSize,
        uncompressedSize,
        compressionMethod,
        localHeaderOffset,
      });
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntryContent(buffer: Buffer, entry: ZipEntry): string | null {
  if (entry.uncompressedSize > MAX_FILE_BYTES) return null;
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) return null;
  const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  const content =
    entry.compressionMethod === 0
      ? compressed
      : entry.compressionMethod === 8
        ? inflateRawSync(compressed)
        : null;
  if (!content || content.includes(0)) return null;
  return content.toString('utf8');
}

export async function POST(req: Request) {
  const formData = await req.formData().catch(() => null);
  const file = formData?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Upload a planning zip file.' }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const entries = readZipEntries(buffer);
    const safeFiles = entries
      .map((entry) => entry.path)
      .filter((entryPath) => entryPath && !entryPath.includes('../'))
      .slice(0, MAX_FILES);
    const validation = validateFreshStartManifest(safeFiles);

    if (!validation.ok) {
      return NextResponse.json(
        {
          error: `Planning zip is missing ${validation.missing.join(' and ')}.`,
          files: safeFiles,
          ...validation,
        },
        { status: 422 },
      );
    }

    const contextFiles = [];
    for (const entry of entries) {
      const normalized = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!safeFiles.includes(normalized)) continue;
      if (![...validation.planningFiles, ...validation.dslOrCodeFiles].includes(normalized)) continue;
      const content = readZipEntryContent(buffer, entry);
      if (!content) continue;
      contextFiles.push({ path: normalized, content });
    }

    return NextResponse.json({
      ok: true,
      fileName: file.name,
      files: safeFiles,
      planningFiles: validation.planningFiles,
      dslOrCodeFiles: validation.dslOrCodeFiles,
      contextFiles,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
