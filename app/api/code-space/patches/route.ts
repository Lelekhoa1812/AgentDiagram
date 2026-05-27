import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createFileCheckpoint } from '@/lib/code-space/runtime';
import { applyGroupedEditBlocks, createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { guardPath } from '@/lib/security/pathGuard';

export const runtime = 'nodejs';

const PatchFile = z.object({
  path: z.string().min(1),
  beforeContent: z.string(),
  afterContent: z.string(),
  deleted: z.boolean().optional(),
});

const EditBlock = z.object({
  path: z.string().min(1),
  search: z.string(),
  replace: z.string(),
  reason: z.string().default('Surgical edit'),
});

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('preview-edit-blocks'),
    rootPath: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().optional(),
    patchId: z.string().optional(),
    edits: z.array(EditBlock).min(1),
  }),
  z.object({
    action: z.literal('apply'),
    rootPath: z.string().min(1),
    projectId: z.string().min(1),
    runId: z.string().optional(),
    patchId: z.string().min(1),
    files: z.array(PatchFile).min(1),
  }),
]);

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }
  return target;
}

async function readCurrentFiles(root: string, filePaths: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const filePath of filePaths) {
    const target = resolveInside(root, filePath);
    try {
      files[filePath] = await fs.readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files[filePath] = '';
    }
  }
  return files;
}

function firstDifference(a: string, b: string): { index: number; line: number; column: number } | null {
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) continue;
    const prefix = a.slice(0, index);
    const lines = prefix.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    return { index, line: lines.length, column: lastLine.length + 1 };
  }
  return null;
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', details: parsed.error.issues }, { status: 400 });
  }

  const guarded = guardPath(parsed.data.rootPath);
  if (!guarded.ok) {
    return NextResponse.json({ error: guarded.reason ?? 'Invalid project root' }, { status: 400 });
  }

  try {
    if (parsed.data.action === 'preview-edit-blocks') {
      const filePaths = Array.from(new Set(parsed.data.edits.map((edit) => edit.path.replace(/\\/g, '/').replace(/^\/+/, ''))));
      const currentFiles = await readCurrentFiles(guarded.resolved, filePaths);
      const result = applyGroupedEditBlocks(currentFiles, parsed.data.edits);
      if (!result.ok) {
        return NextResponse.json({ error: 'Edit block validation failed', code: 'EDIT_BLOCK_INVALID', diagnostics: result.diagnostics }, { status: 409 });
      }

      const syntaxDiagnostics = result.previews.flatMap((preview) => validateSyntaxLightweight(preview.path, preview.afterContent));
      if (syntaxDiagnostics.length) {
        return NextResponse.json({ error: 'Syntax pre-validation failed', code: 'AST_PREVALIDATION_FAILED', diagnostics: syntaxDiagnostics }, { status: 422 });
      }

      return NextResponse.json({
        patchId: parsed.data.patchId ?? `patch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        status: 'previewed',
        files: result.previews,
        unifiedDiff: result.previews.map((preview) => preview.unifiedDiff).join('\n'),
        createdAt: Date.now(),
      });
    }

    const alreadyApplied: string[] = [];
    const conflicts: Array<{ path: string; line: number; column: number; currentPreview: string; expectedPreview: string }> = [];

    for (const file of parsed.data.files) {
      const target = resolveInside(guarded.resolved, file.path);
      let current = '';
      let fileExists = true;
      try {
        current = await fs.readFile(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        fileExists = false;
      }

      if (file.deleted) {
        if (!fileExists) {
          alreadyApplied.push(file.path);
          continue;
        }
      } else if (current === file.afterContent) {
        alreadyApplied.push(file.path);
        continue;
      }

      if (!file.deleted && current !== file.beforeContent) {
        const diff = firstDifference(current, file.beforeContent) ?? { index: 0, line: 1, column: 1 };
        conflicts.push({
          path: file.path,
          line: diff.line,
          column: diff.column,
          currentPreview: current.slice(Math.max(0, diff.index - 160), diff.index + 160),
          expectedPreview: file.beforeContent.slice(Math.max(0, diff.index - 160), diff.index + 160),
        });
      }
    }

    if (conflicts.length) {
      return NextResponse.json(
        {
          error: 'Patch conflict. The file changed since the proposal was created. Refresh the diff or regenerate the patch from the latest file content.',
          code: 'PATCH_CONFLICT',
          conflicts,
          alreadyApplied,
        },
        { status: 409 },
      );
    }

    if (alreadyApplied.length === parsed.data.files.length) {
      return NextResponse.json({
        patchId: parsed.data.patchId,
        status: 'already_applied',
        filesChanged: [],
        alreadyApplied,
        appliedAt: Date.now(),
      });
    }

    const filesToWrite = parsed.data.files.filter((file) => !alreadyApplied.includes(file.path));
    const checkpoint = await createFileCheckpoint({
      projectId: parsed.data.projectId,
      projectRoot: guarded.resolved,
      runId: parsed.data.runId,
      reason: `before applying ${parsed.data.patchId}`,
      files: filesToWrite.map((file) => file.path),
    });

    for (const file of filesToWrite) {
      const diagnostics = validateSyntaxLightweight(file.path, file.afterContent);
      if (diagnostics.length) {
        return NextResponse.json({ error: `Patch failed syntax pre-validation in ${file.path}.`, code: 'AST_PREVALIDATION_FAILED', diagnostics, checkpoint }, { status: 422 });
      }
    }

    for (const file of filesToWrite) {
      const target = resolveInside(guarded.resolved, file.path);
      // Root Cause vs Logic: deletion requests previously wrote an empty string, which preserved the file; use a real filesystem removal when the patch is marked deleted.
      if (file.deleted) {
        await fs.rm(target, { force: false, recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.afterContent, 'utf8');
      }
    }

    return NextResponse.json({
      patchId: parsed.data.patchId,
      status: 'applied',
      filesChanged: filesToWrite.map((file) => file.path),
      alreadyApplied,
      unifiedDiff: filesToWrite.map((file) => createUnifiedDiff(file.path, file.beforeContent, file.afterContent)).join('\n'),
      checkpoint,
      appliedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
