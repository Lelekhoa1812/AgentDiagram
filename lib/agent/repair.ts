import { compile } from '../dsl/compiler';
import { chatWithRetry, type ProviderSession, type RetryListener } from './providers';

const REPAIR_SYSTEM = `You are a DSL repairer. Given an invalid AgentDiagram DSL with diagnostics, return ONLY a corrected DSL — no fences, no prose. Preserve the original structure and intent. Do not add or remove nodes/groups except as needed to fix syntax errors.

FORBIDDEN in names and labels:
- Never use "/" (slash) or "," (comma) — replace path separators (e.g. "api/v1/users") with spaces or hyphens ("api v1 users").
- Never use "{" or "}" inside a name — they are group-block delimiters.
- "--" is the dashed-edge operator, NOT a comment or annotation. Use "// text" for all comments; never "--" for descriptions.
- Attribute blocks [color: X, icon: Y] must follow the name with exactly one space, never appended after a "{...}" group block.`;

export async function tryRepair(
  session: ProviderSession,
  dsl: string,
  opts: { maxAttempts?: number; signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<{ dsl: string; attempts: number; errors: number }> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let current = dsl;
  for (let i = 0; i < maxAttempts; i++) {
    const diagram = compile(current);
    const errors = diagram.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length === 0) return { dsl: current, attempts: i, errors: 0 };
    const messages = [
      { role: 'system' as const, content: REPAIR_SYSTEM },
      {
        role: 'user' as const,
        content: `Diagnostics:\n${errors
          .map((e) => `- line ${e.line}:${e.column}: ${e.message}`)
          .join('\n')}\n\nDSL:\n${current}`,
      },
    ];
    current = await chatWithRetry(session, messages, {
      signal: opts.signal,
      onRetry: opts.onRetry,
    });
    current = stripFences(current);
  }
  const final = compile(current);
  return {
    dsl: current,
    attempts: maxAttempts,
    errors: final.diagnostics.filter((d) => d.severity === 'error').length,
  };
}

function stripFences(s: string): string {
  return s.replace(/^```[a-zA-Z]*\n/m, '').replace(/```\s*$/m, '').trim();
}
