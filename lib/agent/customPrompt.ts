/**
 * Custom-Prompt mode.
 *
 * Two LLM calls:
 *   1. `generateClarifyingQuestions(prompt)` — returns 4-6 MCQs the user
 *      should answer so the agent can disambiguate scope, audience, level
 *      of detail, etc. Each option is a short, distinct choice; the UI
 *      always appends an "Other (free text)" sentinel so the user can
 *      answer customisably even when none of the canned options fit.
 *
 *   2. `generatePlanFromPrompt(prompt, answers)` — produces the same
 *      `DiagramPlan` shape used by the repo-scanner flows, so the
 *      existing `planToDsl` → DSL compiler → renderer pipeline applies
 *      unchanged. The diagram does NOT have to be a software/architecture
 *      diagram; the system prompt tells the model to honor whatever
 *      domain the user described (org chart, workflow, mind map, recipe
 *      flow, biology cycle, …).
 */

import { z } from 'zod';
import type { ProviderSession, RetryListener } from './providers';
import { chatWithRetry } from './providers';
import { chatStructuredWithRetry } from './structuredOutput';
import { DiagramPlanSchema, type DiagramPlan } from './planner';
import { COLOR_NAMES } from '../ir/types';
import { knownIconNames } from '../icons/registry';

// =========================================================================
// Clarifying questions
// =========================================================================

export const ClarifyingQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  rationale: z.string().describe('Why this matters for the diagram'),
  options: z
    .array(
      z.object({
        label: z.string().describe('Short option label (1-6 words)'),
        description: z.string().describe('1 sentence on what selecting this means'),
      }),
    )
    .min(2)
    .max(5),
  allow_multiple: z.boolean().describe('True if the user may select multiple options'),
});

export const ClarifyingQuestionsSchema = z.object({
  intent_summary: z.string().describe("1-2 sentence paraphrase of what the user seems to want"),
  questions: z.array(ClarifyingQuestionSchema).min(3).max(6),
});

export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;
export type ClarifyingQuestions = z.infer<typeof ClarifyingQuestionsSchema>;

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

export async function generateClarifyingQuestions(
  session: ProviderSession,
  prompt: string,
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<ClarifyingQuestions> {
  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a diagram-planning assistant. The user has described something they want to visualise as a diagram. ` +
        `Before producing the diagram, you need to ask short clarifying questions, similar to how a plan-mode agent confirms scope. ` +
        `\n\nThe diagram domain is open-ended — it MIGHT be software architecture, but it could equally be an org chart, a business workflow, a recipe, a biology cycle, a mind map, a decision tree, a journey, a process, etc. Do NOT assume code. ` +
        `\n\nWrite 4-6 MCQ questions that genuinely reduce ambiguity. Each question must have 2-5 short distinct options ` +
        `(the UI will automatically append an "Other (free text)" option, so do not duplicate that). ` +
        `Cover at least: (a) what kind of diagram / structure best fits, (b) the intended audience or use-case, ` +
        `(c) level of detail / size, (d) what to emphasise vs omit, and any domain-specific axes you detect in the prompt. ` +
        `Use 'allow_multiple: true' when the user could reasonably pick more than one option (e.g. emphasis). ` +
        `Avoid yes/no questions — prefer comparative options. ` +
        `Keep labels short and concrete (e.g. "Flowchart", "Org tree", "Lifecycle states") and descriptions to one sentence. ` +
        `Output JSON strictly matching the schema — no prose outside it.`,
    },
    {
      role: 'user' as const,
      content: `User's description:\n"""\n${prompt.trim()}\n"""\n\nProduce the clarifying-questions JSON now.`,
    },
  ];

  return chatStructuredWithRetry(session, messages, {
    signal: opts.signal,
    onRetry: opts.onRetry,
    jsonSchema: CLARIFY_JSON_SCHEMA,
    schema: ClarifyingQuestionsSchema,
  });
}

// =========================================================================
// Diagram plan from prompt + answers
// =========================================================================

export interface CustomAnswer {
  question_id: string;
  question: string;
  selected_options: string[];
  custom_text?: string;
}

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
const COLOR_GUIDANCE = `Color palette: ${COLOR_NAMES.join(', ')}. Use distinct colors per top-level group so the rendered diagram is easy to read.`;

export function formatAnswers(answers: CustomAnswer[]): string {
  if (!answers.length) return '(no answers provided — infer reasonable defaults from the prompt)';
  return answers
    .map((a, i) => {
      const selected = a.selected_options.length ? a.selected_options.join('; ') : '(none chosen)';
      const custom = a.custom_text?.trim() ? `\n   Free-text addition: ${a.custom_text.trim()}` : '';
      return `Q${i + 1}. ${a.question}\n   → ${selected}${custom}`;
    })
    .join('\n\n');
}

export async function generatePlanFromPrompt(
  session: ProviderSession,
  input: {
    prompt: string;
    intentSummary?: string;
    answers: CustomAnswer[];
  },
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<DiagramPlan> {
  const userMsg = [
    `## User's original description`,
    input.prompt.trim(),
    '',
    input.intentSummary ? `## Restated intent\n${input.intentSummary}` : '',
    '',
    `## Clarifying answers`,
    formatAnswers(input.answers),
    '',
    `Produce the DiagramPlan now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a diagram designer producing a structured diagram plan. ` +
        `The user described something in free text and answered a few MCQs to refine scope. ` +
        `\n\nThe diagram does NOT have to be software architecture — it could be a workflow, lifecycle, org chart, mind map, business process, recipe, biology cycle, decision tree, narrative arc, etc. Pick whatever structure is faithful to what the user described and confirmed in the answers. ` +
        `\n\nOutput a DiagramPlan strictly conforming to the JSON schema — no prose outside it.` +
        `\n\nPLANNING RULES:\n` +
        `1. Treat groups as logical containers (phases, stages, departments, modules, layers, categories — whatever fits).\n` +
        `2. 3-10 top-level groups is ideal. Inside each, list the concrete entities or steps.\n` +
        `3. Edges represent the relationship the user described: data flow, dependency, sequence, hierarchy, communication. Use 'fwd' (>) by default, 'bi' for bidirectional, 'thick' for primary paths, 'dashed' for optional / weak / observational links.\n` +
        `4. Stable, short, human-readable names — they will be displayed in the diagram.\n` +
        `5. Honor the user's answers: if they asked for a small overview, keep it small (15-30 nodes). If they asked for deep detail, scale up but stay readable (≤90 nodes).\n` +
        `6. Use 'uncertainties' to record assumptions you made and 'omitted' for things deliberately left out per the user's answers.\n\n` +
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

// Motivation vs Logic: Instruction Mode is an additive mentor layer, so the diagram planner remains structured JSON while this dedicated raw-Markdown call receives the instructional system prompt verbatim and can produce rich prose.
export const INSTRUCTION_MODE_SYSTEM_PROMPT = `You are an expert technical mentor and system architect. Your objective is to provide a comprehensive, step-by-step guide tailored to the user's request. First, evaluate whether the user's prompt is a codebase problem or a general conceptual practice.

If it is a codebase problem, provide a sequential implementation guide. Include precise code snippets, explain where the code belongs within the architecture, and detail the logic behind each step so the user understands the implementation.

If it is a conceptual or non-coding problem, provide a highly structured set of best practices, architectural steps, or design instructions to guide the user toward their goal.

Always structure your entire response in well-formatted Markdown. Use clear headings for distinct sections, numbered lists for sequential steps, and properly tagged code blocks. Your tone must be authoritative, highly instructional, and strictly focused on helping the user successfully complete their exact task.`;

export async function generateInstructionGuide(
  session: ProviderSession,
  input: {
    prompt: string;
    intentSummary?: string;
    answers: CustomAnswer[];
    diagramStyle: 'single' | 'multi-layer';
  },
  opts: { signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<string> {
  const userMsg = [
    `## User's original request`,
    input.prompt.trim(),
    '',
    input.intentSummary ? `## Restated intent\n${input.intentSummary}` : '',
    '',
    `## Clarifying answers`,
    formatAnswers(input.answers),
    '',
    `## Diagram output context`,
    `The user selected ${input.diagramStyle === 'multi-layer' ? 'a multi-layer diagram' : 'a single diagram'}.`,
    '',
    `Produce the Instruction Mode Markdown guide now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chatWithRetry(
    session,
    [
      { role: 'system', content: INSTRUCTION_MODE_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `${userMsg}\n\nReturn Markdown only. Do not wrap the whole response in a code fence unless the entire requested deliverable is code.`,
      },
    ],
    { signal: opts.signal, onRetry: opts.onRetry },
  );

  return raw.trim();
}
