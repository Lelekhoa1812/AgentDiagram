export const CODE_SPACE_EXECUTION_POLICIES = ['auto', 'manual'] as const;

export type CodeSpaceExecutionPolicy = (typeof CODE_SPACE_EXECUTION_POLICIES)[number];

export interface CodeSpaceExecutionPolicyMeta {
  policy: CodeSpaceExecutionPolicy;
  label: string;
  description: string;
  accentClassName: string;
  buttonClassName: string;
  menuItemClassName: string;
}

// Motivation vs Logic: Code mode is expected to behave like a real coding agent, not just a diff
// generator. The safe mutation boundary already lives in /api/code-space/patches, where every
// proposed file goes through checkpointing and stale-content checks, so the default UX should route
// generated patches through that apply path immediately. Manual review remains available as an
// explicit opt-in gate for users who want to pause before writing files.
export const DEFAULT_CODE_SPACE_EXECUTION_POLICY: CodeSpaceExecutionPolicy = 'auto';

export const CODE_SPACE_EXECUTION_POLICY_META: Record<CodeSpaceExecutionPolicy, CodeSpaceExecutionPolicyMeta> = {
  auto: {
    policy: 'auto',
    label: 'Auto',
    description: 'Apply agent changes through the checkpointed patch pipeline as soon as a diff is proposed.',
    accentClassName: 'text-[#f85149]',
    buttonClassName: 'border-[#be123c66] bg-[#2d1217] text-[#fb7185] hover:bg-[#3b151f]',
    menuItemClassName: 'text-[#fb7185] hover:bg-[#3b151f]',
  },
  manual: {
    policy: 'manual',
    label: 'Confirm',
    description: 'Pause generated diffs for manual review before writing files.',
    accentClassName: 'text-[#3fb950]',
    buttonClassName: 'border-[#23863666] bg-[#0f2a1a] text-[#7ee787] hover:bg-[#12331f]',
    menuItemClassName: 'text-[#7ee787] hover:bg-[#12331f]',
  },
};

export function normalizeCodeSpaceExecutionPolicy(value: unknown): CodeSpaceExecutionPolicy {
  if (value === 'auto' || value === 'manual') return value;
  return DEFAULT_CODE_SPACE_EXECUTION_POLICY;
}

export function isCodeSpaceAutoExecutionPolicy(policy: unknown): boolean {
  return normalizeCodeSpaceExecutionPolicy(policy) === 'auto';
}

// Root Cause vs Logic: previously the default policy held patches in the review queue, so the agent
// could truthfully show a diff while the underlying workspace still had no changed files. Generated
// diffs now auto-apply unless the user explicitly selects Confirm/manual mode.
export function shouldAutoApplyCodeSpaceDiffs(policy: unknown, autoApplied = false): boolean {
  return autoApplied || isCodeSpaceAutoExecutionPolicy(policy);
}

export function getCodeSpaceExecutionPolicyMeta(policy: unknown): CodeSpaceExecutionPolicyMeta {
  return CODE_SPACE_EXECUTION_POLICY_META[normalizeCodeSpaceExecutionPolicy(policy)];
}
