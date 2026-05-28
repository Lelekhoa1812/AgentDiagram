import { createHash } from 'node:crypto';
import { createUnifiedDiff, validateSyntaxLightweight } from '@/lib/code-space/agent/editBlocks';
import { createPatchProposal } from './patchManager';
import { PatchStore, type PendingPatchRecord } from './patchStore';
import { resolvePatchTarget, type PatchApplyFile } from './patchApply';

export interface PatchPrevalidationInput {
  root: string;
  runId: string;
  projectId: string;
  patchId: string;
  explanation: string;
  files: PatchApplyFile[];
  readFiles: Set<string>;
  risk?: 'low' | 'medium' | 'high';
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class PatchReview {
  constructor(private readonly store = new PatchStore()) {}

  async prevalidateAndPersist(input: PatchPrevalidationInput): Promise<PendingPatchRecord> {
    for (const file of input.files) {
      resolvePatchTarget(input.root, file.path);
      // Runtime recall may load a target after the initial context graph. The proposal still carries
      // the exact previous content, and the later apply step checks for stale content before writing.
      if (!input.readFiles.has(file.path) && file.beforeContent === '') {
        throw new Error(`Patch target ${file.path} has no read baseline and is not a new file.`);
      }
      if (!file.deleted) {
        const diagnostics = validateSyntaxLightweight(file.path, file.afterContent);
        if (diagnostics.length) {
          throw new Error(`Patch failed syntax pre-validation in ${file.path}: ${diagnostics[0]?.message ?? 'syntax diagnostic'}`);
        }
      }
    }

    const proposal = createPatchProposal({
      id: input.patchId,
      runId: input.runId,
      projectId: input.projectId,
      explanation: input.explanation,
      files: input.files,
    });

    const patch: PendingPatchRecord = {
      id: proposal.id,
      runId: proposal.runId,
      projectId: proposal.projectId,
      status: 'proposed',
      filesChanged: proposal.filesChanged,
      diff: proposal.diff || input.files.map((file) => createUnifiedDiff(file.path, file.beforeContent, file.deleted ? '' : file.afterContent)).join('\n'),
      explanation: proposal.explanation,
      createdAt: proposal.createdAt,
      files: input.files,
      beforeHashes: Object.fromEntries(input.files.map((file) => [file.path, hashContent(file.beforeContent)])),
      risk: input.risk ?? 'medium',
    };

    return this.store.persistPendingPatch(patch);
  }
}
