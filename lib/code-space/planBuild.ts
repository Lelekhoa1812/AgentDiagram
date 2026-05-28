import type { CodeSpaceAgentMode } from './agentModes';

export interface CodeSpacePromptOptions {
  modeOverride?: CodeSpaceAgentMode;
  buildPlanPath?: string;
}

export function appendInstructionToPrompt(prompt: string, instruction?: string | null): string {
  const trimmedInstruction = instruction?.trim();
  if (!trimmedInstruction) return prompt;

  // Motivation vs Logic: Code Space should honor user-specific coding preferences without forcing every caller to duplicate prompt stitching, so we keep the merge rule in one reusable helper.
  return [prompt, '', 'Additional instruction for user customization:', trimmedInstruction].join('\n');
}

export function buildPlanImplementationPrompt(filePath: string): string {
  return [
    `Build from the approved plan at ${filePath}.`,
    '',
    'Read that plan artifact first, treat it as the source of truth, implement its TODOs end-to-end, keep iterating until the requested code changes and validation work are actually finished, and run the validation strategy before summarising the result.',
    'If the plan is outdated or conflicts with the current workspace, explain the conflict and make the smallest safe adjustment instead of generating another plan.',
  ].join('\n');
}

export function extractBuildPlanPath(prompt: string): string | null {
  const match = prompt.match(/\bplan at\s+([^\s.][^\s]*|(?:\.{1,2}\/)?[^\s]+|\.agent\/plans\/[^\s]+)/i);
  const candidate = match?.[1]?.replace(/[),.;:]+$/g, '');
  if (!candidate) return null;
  return candidate.replace(/\\/g, '/').replace(/^\/+/, '');
}
