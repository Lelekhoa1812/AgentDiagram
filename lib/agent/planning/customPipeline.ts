/**
 * Custom-Prompt pipeline.
 *
 * Step 1 (`runClarify`)   : validate provider → ask LLM for clarifying MCQs.
 * Step 2 (`runCustomPlan`): validate → generate plan from prompt+answers →
 *                            compile to DSL → repair → return DSL.
 *
 * Both stream SSE events compatible with the existing AnalysisAnimation.
 */

import { validateWithRetry, type ProviderSession } from '../providers';
import { generateClarifyingQuestions, generateInstructionGuide, generatePlanFromPrompt, type ClarifyingQuestions, type CustomAnswer } from './customPrompt';
import { planToDsl } from './dslCompiler';
import { tryRepair } from './repair';
import { compile } from '../../dsl/compiler';
import type { SseEvent } from '../../util/stream';

export interface ClarifyInput {
  session: ProviderSession;
  prompt: string;
  signal?: AbortSignal;
}

export async function runClarify(
  input: ClarifyInput,
  send: (ev: SseEvent) => void,
): Promise<ClarifyingQuestions | null> {
  const onRetry = (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => {
    send({ type: 'retry', stage, attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason });
  };

  try {
    send({ type: 'stage', stage: 'validate', status: 'start', message: 'Checking provider credentials…' });
    const v = await validateWithRetry(input.session, { signal: input.signal, onRetry: onRetry('validate') });
    if (!v.ok) {
      send({ type: 'error', stage: 'validate', message: v.error ?? 'Provider validation failed' });
      send({ type: 'done' });
      return null;
    }
    send({ type: 'stage', stage: 'validate', status: 'done', message: 'Provider ready' });

    send({ type: 'stage', stage: 'clarify', status: 'start', message: 'Drafting clarifying questions…' });
    const result = await generateClarifyingQuestions(input.session, input.prompt, {
      signal: input.signal,
      onRetry: onRetry('clarify'),
    });
    send({
      type: 'stage',
      stage: 'clarify',
      status: 'done',
      message: `${result.questions.length} questions ready`,
      counters: { questions: result.questions.length },
    });
    send({ type: 'result-clarify', output: result });
    send({ type: 'done' });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', stage: 'pipeline', message });
    send({ type: 'done' });
    return null;
  }
}

export interface CustomPlanInput {
  session: ProviderSession;
  prompt: string;
  intentSummary?: string;
  answers: CustomAnswer[];
  instructionMode?: boolean;
  signal?: AbortSignal;
}

export async function runCustomPlan(
  input: CustomPlanInput,
  send: (ev: SseEvent) => void,
): Promise<{ dsl: string }> {
  const onRetry = (stage: string) => (notice: { attempt: number; delayMs: number; reason: string }) => {
    send({ type: 'retry', stage, attempt: notice.attempt, delayMs: notice.delayMs, reason: notice.reason });
  };

  try {
    send({ type: 'stage', stage: 'validate', status: 'start', message: 'Checking provider credentials…' });
    const v = await validateWithRetry(input.session, { signal: input.signal, onRetry: onRetry('validate') });
    if (!v.ok) {
      send({ type: 'error', stage: 'validate', message: v.error ?? 'Provider validation failed' });
      send({ type: 'done' });
      return { dsl: '' };
    }
    send({ type: 'stage', stage: 'validate', status: 'done', message: 'Provider ready' });

    send({
      type: 'stage',
      stage: 'plan',
      status: 'start',
      message: 'Designing diagram from prompt + answers…',
    });
    const plan = await generatePlanFromPrompt(
      input.session,
      { prompt: input.prompt, intentSummary: input.intentSummary, answers: input.answers },
      { signal: input.signal, onRetry: onRetry('plan') },
    );
    send({
      type: 'stage',
      stage: 'plan',
      status: 'done',
      message: `Plan: ${plan.groups.length} groups, ${plan.nodes.length} nodes, ${plan.edges.length} edges`,
    });

    send({ type: 'stage', stage: 'compile', status: 'start', message: 'Compiling DSL…' });
    let dsl = planToDsl(plan);
    send({ type: 'stage', stage: 'compile', status: 'done', message: 'DSL compiled' });

    send({ type: 'stage', stage: 'validate-dsl', status: 'start', message: 'Validating syntax…' });
    const initial = compile(dsl);
    const initialErrors = initial.diagnostics.filter((d) => d.severity === 'error').length;
    if (initialErrors > 0) {
      send({ type: 'log', stage: 'validate-dsl', level: 'warn', message: `${initialErrors} syntax errors — attempting repair` });
      const repaired = await tryRepair(input.session, dsl, {
        maxAttempts: 2,
        signal: input.signal,
        onRetry: onRetry('repair'),
      });
      dsl = repaired.dsl;
      send({
        type: 'log',
        stage: 'validate-dsl',
        level: repaired.errors === 0 ? 'info' : 'warn',
        message: repaired.errors === 0 ? 'Repaired successfully' : `${repaired.errors} errors remain after repair`,
      });
    }
    send({ type: 'stage', stage: 'validate-dsl', status: 'done', message: 'Validation complete' });

    let instructionMarkdown: string | undefined;
    if (input.instructionMode) {
      send({ type: 'stage', stage: 'instruction', status: 'start', message: 'Writing Instruction Mode guide…' });
      instructionMarkdown = await generateInstructionGuide(
        input.session,
        {
          prompt: input.prompt,
          intentSummary: input.intentSummary,
          answers: input.answers,
          diagramStyle: 'single',
        },
        { signal: input.signal, onRetry: onRetry('instruction') },
      );
      send({ type: 'stage', stage: 'instruction', status: 'done', message: 'Instruction guide ready' });
    }

    send({ type: 'result', dsl, instructionMarkdown });
    send({ type: 'done' });
    return { dsl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', stage: 'pipeline', message });
    send({ type: 'done' });
    return { dsl: '' };
  }
}
