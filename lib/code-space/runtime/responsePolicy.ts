import {
  buildCodeCompletionResponse,
  buildPlanCompletionResponse,
  type CodeResponseInput,
  type PlanResponseInput,
  type RunValidationResult,
} from '@/lib/code-space/agent/runResponses';

export function buildAskFinalResponse(input: {
  projectName: string;
  prompt: string;
  evidence: Array<{ path: string; summary: string; content?: string }>;
  missingContextWarnings?: string[];
}): string {
  if (!input.evidence.length) {
    return `I could not find enough readable repository evidence in ${input.projectName} to answer that confidently.`;
  }
  const critical = input.evidence.slice(0, 4).map((file) => `\`${file.path}\``);
  const warnings = input.missingContextWarnings?.length ? ` Missing evidence: ${input.missingContextWarnings.join('; ')}.` : '';
  return `Based on the repository evidence, the relevant surface is ${critical.join(', ')}. ${input.evidence[0]?.summary ?? 'The selected files contain the key implementation path.'}${warnings}`;
}

export function buildPlanFinalResponse(input: PlanResponseInput): string {
  return buildPlanCompletionResponse(input);
}

export function buildCodeFinalResponse(input: CodeResponseInput): string {
  return buildCodeCompletionResponse(input);
}

export function validationStatus(results: RunValidationResult[]): 'passed' | 'failed' | 'skipped' {
  if (!results.length) return 'skipped';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'skipped')) return 'skipped';
  return 'passed';
}
