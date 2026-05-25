import { z } from 'zod';

function blankStringToUndefined(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

// Root Cause vs Logic: local-path mode still reuses the same request payload shape as GitHub mode,
// but an empty `repoUrl` should be treated like "not provided" instead of failing URL validation.
export const optionalUrl = z.preprocess(blankStringToUndefined, z.string().url().optional());
