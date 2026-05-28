import type { JsonCodeSpaceStore } from './serverStore';
import { getCodeSpaceStore } from './serverStore';
import type { PatchRecord } from '@/lib/code-space/domain';
import type { PatchApplyFile } from './patchApply';

export interface PendingPatchRecord extends PatchRecord {
  status: 'proposed' | 'validated' | 'applied' | 'rejected' | 'failed' | 'reverted';
  files?: PatchApplyFile[];
  beforeHashes?: Record<string, string>;
  risk?: 'low' | 'medium' | 'high';
}

export class PatchStore {
  constructor(private readonly store: JsonCodeSpaceStore = getCodeSpaceStore()) {}

  async persistPendingPatch(patch: PendingPatchRecord): Promise<PendingPatchRecord> {
    await this.store.upsert('patches', patch);
    return patch;
  }

  async getPatch(patchId: string): Promise<PendingPatchRecord | null> {
    const data = await this.store.read();
    return (data.patches.find((patch) => patch.id === patchId) as PendingPatchRecord | undefined) ?? null;
  }

  async markApplied(patchId: string): Promise<PendingPatchRecord | null> {
    const patch = await this.getPatch(patchId);
    if (!patch) return null;
    const updated = { ...patch, status: 'applied' as const, appliedAt: Date.now() };
    await this.store.upsert('patches', updated);
    return updated;
  }
}
