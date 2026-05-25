/**
 * Fix-mode LLM calls.
 *
 * Two calls:
 *   1. `generateFixClarifyingQuestions` — given the current diagram DSL and a
 *      change description, returns MCQs to narrow down exactly how to apply it.
 *
 *   2. `generateFixedPlan` — given DSL + change description + (optional) MCQ
 *      answers, produces a new DiagramPlan that applies the requested changes
 *      while preserving everything the user did not ask to change.
 */

import type { ProviderSession, RetryListener } from './providers';
import { chatStructuredWithRetry } from './structuredOutput';
import { DiagramPlanSchema, type DiagramPlan } from './planner';
import { COLOR_NAMES } from '../ir/types';
import { knownIconNames } from '../icons/registry';
import { ClarifyingQuestionsSchema, type ClarifyingQuestions, type CustomAnswer } from './customPrompt';

// Shared JSON schema for clarifying questions (same shape as custom-prompt clarify)
const CLARIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent_summary: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          rationale: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
          allow_multiple: { type: 'boolean' },
        },
        required: ['id', 'question', 'rationale', 'options', 'allow_multiple'],
        additionalProperties: false,
      },
    },
  },
  required: ['intent_summary', 'questions'],
  additionalProperties: false,
};

const COLORS = [
  'orange', 'green', 'yellow', 'amber', 'coral', 'teal', 'slate',
  'indigo', 'blue', 'purple', 'lime', 'sky', 'red', 'pink', 'gray',
];

const PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          icon: { type: 'string' },
          children: { type: 'array', items: { type: 'string' } },
          parent: { type: ['string', 'null'] },
        },
        required: ['name', 'color', 'icon', 'children', 'parent'],
        additionalProperties: false,
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          icon: { type: 'string' },
          parent: { type: ['string', 'null'] },
        },
        required: ['name', 'color', 'icon', 'parent'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          kind: { type: 'string', enum: ['fwd', 'bwd', 'bi', 'dashed', 'thick'] },
          label: { type: ['string', 'null'] },
        },
        required: ['source', 'target', 'kind', 'label'],
        additionalProperties: false,
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
    omitted: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'groups', 'nodes', 'edges', 'uncertainties', 'omitted'],
  additionalProperties: false,
};

const ICON_GUIDANCE = `Available icons: ${knownIconNames().join(', ')}.`;
const COLOR_GUIDANCE = `Color palette: ${COLOR_NAMES.join(', ')}. Preserve existing colors for unchanged elements; use distinct colors for newly added groups.`;

function truncateDsl(dsl: string, maxChars = 6000): string {
  if (dsl.length <= maxChars) return dsl;
  return dsl.slice(0, maxChars) + '\n… (truncated)';
}

function formatAnswers(answers: CustomAnswer[]): string {
  if (!answers.length) return '';
  return answers
    .map((a, i) => {
      const selected = a.selected_options.length ? a.selected_options.join('; ') : '(none chosen)';
      const custom = a.custom_text?.trim() ? `\n   Free-text addition: ${a.custom_text.trim()}` : '';
      return `Q${i + 1}. ${a.question}\n   → ${selected}${custom}`;
    })
    .join('\n\n');
}

export async function generateFixClarifyingQuestions(
  session: ProviderSession,
  currentDsl: string,
  changeDescription: string,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<ClarifyingQuestions> {
  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a diagram-editing assistant. The user wants to modify an existing diagram and has described what they want to change. ` +
        `Before applying the change, ask 3-5 clarifying questions to make sure the change is applied correctly and completely. ` +
        `Focus on: what exactly to add/remove/modify, how to handle naming, colors, or grouping for new elements, ` +
        `whether related parts of the diagram should also be updated, and any edge cases specific to the described change. ` +
        `Each question must have 2-5 short distinct options (the UI appends an "Other (free text)" option automatically — do not add one). ` +
        `Use 'allow_multiple: true' only when multiple options genuinely apply simultaneously. ` +
        `Output JSON strictly matching the schema — no prose outside it.`,
    },
    {
      role: 'user' as const,
      content: [
        `## Current diagram DSL`,
        '```',
        truncateDsl(currentDsl),
        '```',
        '',
        `## Requested change`,
        changeDescription.trim(),
        '',
        `Produce the clarifying-questions JSON now.`,
      ].join('\n'),
    },
  ];

  return chatStructuredWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: CLARIFY_JSON_SCHEMA,
    schema: ClarifyingQuestionsSchema,
  });
}

export async function generateFixedPlan(
  session: ProviderSession,
  currentDsl: string,
  changeDescription: string,
  answers: CustomAnswer[],
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<DiagramPlan> {
  const answersSection = formatAnswers(answers);

  const userMsg = [
    `## Current diagram DSL`,
    '```',
    truncateDsl(currentDsl),
    '```',
    '',
    `## Requested change`,
    changeDescription.trim(),
    '',
    answersSection ? `## Clarifying answers\n${answersSection}` : '',
    '',
    `Produce the updated DiagramPlan now.`,
  ]
    .filter((s) => s !== '')
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a diagram-editing assistant. You will receive the current DSL of a diagram (the complete source of truth for all nodes, groups, and edges) and a description of what the user wants changed. ` +
        `Output a DiagramPlan for the UPDATED diagram that faithfully applies the change. ` +
        `\n\nRULES:\n` +
        `1. Preserve all existing nodes, groups, edges, colors, and icons that the user did NOT ask to change.\n` +
        `2. Apply only the requested change — do not rename, recolor, or restructure anything else.\n` +
        `3. "Add X" → add it in the appropriate parent group or as a new top-level element with a fitting color and icon.\n` +
        `4. "Remove X" → omit it entirely from the plan along with any edges that only connect to it.\n` +
        `5. "Rename X to Y" → use Y everywhere in the plan.\n` +
        `6. "Move X into Y" → update X's parent to Y.\n` +
        `7. Keep stable, short, human-readable names (they appear as diagram labels).\n` +
        `8. Use 'uncertainties' to document assumptions and 'omitted' for deliberate exclusions per the user's answers.\n` +
        `CRITICAL — EDGE LIMIT: Total edges in the output plan MUST stay below 60. Exceeding this causes ELK layout to crash with "Invalid array length". ` +
        `If adding new edges would push the total over 60, remove lower-priority existing edges (observability links, redundant dashed lines) to make room.\n\n` +
        ICON_GUIDANCE + '\n\n' + COLOR_GUIDANCE,
    },
    { role: 'user' as const, content: userMsg },
  ];

  return chatStructuredWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: PLAN_JSON_SCHEMA,
    schema: DiagramPlanSchema,
  });
}
