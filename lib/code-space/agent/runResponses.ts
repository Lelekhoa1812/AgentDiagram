import { PLAN_ARTIFACT_SECTION_TITLES } from './planTemplate';

export interface RunValidationCommand {
  command: string;
  reason: string;
}

export interface RunValidationResult {
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  output: string;
}

export interface PlanResponseInput {
  planPath: string;
  projectName: string;
  planContent?: string;
  inspectedFiles: Array<{ path: string; summary?: string }>;
  validationCommands: RunValidationCommand[];
}

export interface CodeResponseInput {
  projectName: string;
  files: Array<{ path: string; explanation: string }>;
  validationRuns: RunValidationResult[];
  summary?: string;
  checkpointRef?: string;
}

export function buildPlanCompletionResponse(input: PlanResponseInput): string {
  const summaryHighlight = extractSectionLead(input.planContent ?? '', 'Summary');
  const planHighlights = [
    summaryHighlight,
    ...PLAN_ARTIFACT_SECTION_TITLES.slice(1).flatMap((title) => extractSectionBullets(input.planContent ?? '', title)),
  ]
    .filter((item): item is string => Boolean(item))
    .slice(0, 2);
  const fileHighlights = input.inspectedFiles.slice(0, 3).map((file) => `\`${file.path}\``);
  const validationHighlights = summarizeValidationCommands(input.validationCommands, 2);

  const lines: string[] = [`Saved ${input.planPath} for ${input.projectName}.`];
  if (planHighlights.length) {
    lines.push(`Plan focus: ${planHighlights.join('; ')}.`);
  } else if (fileHighlights.length) {
    lines.push(`Scoped the plan around ${formatList(fileHighlights)}.`);
  }
  if (validationHighlights.length) {
    lines.push(`Validation: ${validationHighlights.join('; ')}.`);
  }
  return lines.join(' ');
}

export function buildCodeCompletionResponse(input: CodeResponseInput): string {
  const lines: string[] = [];
  const cleanSummary = input.files.length ? normalizeSummary(input.summary, true) : null;
  if (cleanSummary) lines.push(cleanSummary);

  if (input.files.length) {
    const fileList = input.files.slice(0, 3).map((file) => `\`${file.path}\``);
    const suffix = input.files.length > fileList.length ? `, and ${input.files.length - fileList.length} more` : '';
    lines.push(
      `Proposed ${input.files.length} reviewable patch${input.files.length === 1 ? '' : 'es'} for ${input.projectName}: ${formatList(fileList)}${suffix}. No project file is written until the patch is visible in Code changes and accepted or auto-apply succeeds.`,
    );
  } else {
    // Root Cause vs Logic: an empty patch result is a blocked run, not a useful completion. Never echo
    // the model's own "I cannot / insufficient evidence" wording here; that message makes the agent
    // look passive even when the runtime already attempted context recall. Keep the UX deterministic,
    // actionable, and tied to the tool trace the user can inspect.
    lines.push(
      `Needs review for ${input.projectName}: Code mode exhausted autonomous context recall and did not receive a valid reviewable file patch. No workspace files were changed; inspect the context_graph and patch_planner tool output for the missing target surface or model/provider response issue, then rerun with the named files attached if needed.`,
    );
  }

  const failed = input.validationRuns.filter((run) => run.status === 'failed');
  const passed = input.validationRuns.filter((run) => run.status === 'passed');
  const skipped = input.validationRuns.filter((run) => run.status === 'skipped');
  if (failed.length) {
    lines.push(`Validation still needs attention: ${failed.map((run) => `\`${run.command}\``).join(', ')}.`);
  } else if (passed.length || skipped.length) {
    const validationBits = [
      passed.length ? `${passed.length} passed` : null,
      skipped.length ? `${skipped.length} skipped` : null,
    ].filter(Boolean);
    lines.push(`Validation: ${validationBits.join(', ')}.`);
  }

  if (input.checkpointRef) {
    lines.push('Checkpoint created before the edit.');
  }

  return lines.join(' ');
}

function normalizeSummary(summary?: string, proposedOnly = false): string | null {
  const trimmed = summary?.trim();
  if (!trimmed) return null;
  if (/^done\b/i.test(trimmed)) return null;
  if (/^plan ready\b/i.test(trimmed)) return null;
  if (/\b(unable to produce|cannot produce|could not produce|insufficient evidence|not enough evidence|no reviewable code patch was produced)\b/i.test(trimmed)) return null;
  let normalized = trimmed.replace(/\s+/g, ' ').slice(0, 240);
  if (proposedOnly) {
    normalized = normalized
      .replace(/^fixed\b/i, 'Proposed a fix for')
      .replace(/^updated\b/i, 'Proposed an update to')
      .replace(/^changed\b/i, 'Proposed changes to')
      .replace(/^implemented\b/i, 'Proposed an implementation for');
  }
  return normalized;
}

function summarizeValidationCommands(commands: RunValidationCommand[], limit: number): string[] {
  return commands.slice(0, limit).map((command) => `\`${command.command}\``);
}

function extractSectionBullets(content: string, heading: string): string[] {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\b`, 'i').test(line.trim()));
  if (startIndex < 0) return [];

  const bullets: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^##\s+/.test(line)) break;
    const bullet = line.match(/^[-*]\s+(.*)$/)?.[1] ?? line.match(/^\d+\.\s+(.*)$/)?.[1];
    if (!bullet) continue;
    const normalized = bullet.replace(/\s+/g, ' ').trim();
    if (normalized && !bullets.includes(normalized)) bullets.push(normalized);
    if (bullets.length >= 2) break;
  }
  return bullets;
}

function extractSectionLead(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\b`, 'i').test(line.trim()));
  if (startIndex < 0) return null;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) continue;
    if (/^##\s+/.test(line)) break;
    return line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').replace(/\s+/g, ' ').trim() || null;
  }

  return null;
}

function formatList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
