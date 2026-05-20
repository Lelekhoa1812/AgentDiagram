/**
 * Fix-mode pipeline.
 *
 * Step 1 (`runFixClarify`)  : validate provider → ask LLM for clarifying MCQs
 *                             about how to apply the requested diagram change.
 * Step 2 (`runFix`)         : validate → generate updated plan → compile DSL →
 *                             repair → return DSL.
 *
 * Both stream SSE events compatible with AnalysisAnimation.
 */

import { validateWithRetry, type ProviderSession } from './providers';
import { generateFixClarifyingQuestions, generateFixedPlan } from './fixPrompt';
import { planToDsl } from './dslCompiler';
import { tryRepair } from './repair';
import { compile } from '../dsl/compiler';
import type { ClarifyingQuestions, CustomAnswer } from './customPrompt';
import type { SseEvent } from '../util/stream';

export interface FixClarifyInput {
  session: ProviderSession;
  dsl: string;
  changeDescription: string;
  signal?: AbortSignal;
}

export const FIX_CLARIFY_STAGES = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'clarify', label: 'Drafting clarifying questions' },
];

export const FIX_APPLY_STAGES = [
  { id: 'validate', label: 'Validating credentials' },
  { id: 'fix', label: 'Applying changes to diagram' },
  { id: 'compile', label: 'Compiling DSL' },
  { id: 'validate-dsl', label: 'Validating syntax' },
];

export async function runFixClarify(
  input: FixClarifyInput,
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
    const result = await generateFixClarifyingQuestions(
      input.session,
      input.dsl,
      input.changeDescription,
      { signal: input.signal, onRetry: onRetry('clarify') },
    );
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

export interface FixApplyInput {
  session: ProviderSession;
  dsl: string;
  changeDescription: string;
  intentSummary?: string;
  answers: CustomAnswer[];
  signal?: AbortSignal;
}

export async function runFix(
  input: FixApplyInput,
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

    send({ type: 'stage', stage: 'fix', status: 'start', message: 'Applying changes to diagram…' });
    const plan = await generateFixedPlan(
      input.session,
      input.dsl,
      input.changeDescription,
      input.answers,
      { signal: input.signal, onRetry: onRetry('fix') },
    );
    send({
      type: 'stage',
      stage: 'fix',
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

    send({ type: 'result', dsl });
    send({ type: 'done' });
    return { dsl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: 'error', stage: 'pipeline', message });
    send({ type: 'done' });
    return { dsl: '' };
  }
}
