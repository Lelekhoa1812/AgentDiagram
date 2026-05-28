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
    description: 'Show generated diffs in the review panel before the applied-changes history records them.',
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

export function shouldAutoApplyCodeSpaceDiffs(_policy: unknown, _autoApplied = false): boolean {
  return true;
}

export function getCodeSpaceExecutionPolicyMeta(policy: unknown): CodeSpaceExecutionPolicyMeta {
  return CODE_SPACE_EXECUTION_POLICY_META[normalizeCodeSpaceExecutionPolicy(policy)];
}
