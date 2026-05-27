import type { CodeSpaceAgentMode } from './agentModes';

export interface CodeSpacePromptOptions {
  modeOverride?: CodeSpaceAgentMode;
}

export function buildPlanImplementationPrompt(filePath: string): string {
  return [
    `Build from the approved plan at ${filePath}.`,
    '',
    'Read that plan artifact first, treat it as the source of truth, implement its TODOs end-to-end, and run the validation strategy before summarising the result.',
    'If the plan is outdated or conflicts with the current workspace, explain the conflict and make the smallest safe adjustment instead of generating another plan.',
  ].join('\n');
}

export function extractBuildPlanPath(prompt: string): string | null {
  const match = prompt.match(/\bplan at\s+([^\s.][^\s]*|(?:\.{1,2}\/)?[^\s]+|\.agent\/plans\/[^\s]+)/i);
  const candidate = match?.[1]?.replace(/[),.;:]+$/g, '');
  if (!candidate) return null;
  return candidate.replace(/\\/g, '/').replace(/^\/+/, '');
}
