# Code Space Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully autonomous agentic loop for Code Space that matches Cursor/Claude Code in coding capability — multi-turn LLM execution, 6-tool registry, inline Monaco diffs with Accept/Reject, split Chat+Tool panel, and a self-correcting verification loop.

**Architecture:** Extend the existing `/lib/agent/providers/` infrastructure. A new `/app/api/code-space/agent/route.ts` SSE endpoint runs a multi-turn loop: build context → call LLM with tools → execute tool calls (parallel where safe) → emit `diff_proposed` events that pause for user accept/reject → re-enter loop → verify with lint + tests at completion.

**Tech Stack:** Next.js 14, TypeScript, `@anthropic-ai/sdk ^0.30.1`, `openai ^4.67.3`, `@monaco-editor/react ^4.6.0`, `diff` (new dep), `vitest`, existing provider infrastructure in `/lib/agent/providers/`.

---

## File Map

**New files:**
- `lib/code-space/agent/types.ts` — all agent-specific types (SSE events, tool definitions, messages)
- `lib/code-space/agent/registry.ts` — diff callback registry (module-scope Map for pause/resume)
- `lib/code-space/agent/providers.ts` — `callWithTools()` streaming wrapper over existing providers
- `lib/code-space/agent/diff.ts` — diff computation using `diff` package
- `lib/code-space/agent/tools.ts` — 6 tool executors + their JSON schema definitions
- `lib/code-space/agent/context.ts` — stack detection + file relevance scoring + context block builder (new simplified scorer; the existing `/lib/agent/planning/pipeline.ts` classifier is diagram-DSL-specific and not reusable here)
- `lib/code-space/agent/prompt.ts` — system prompt template + few-shot examples
- `lib/code-space/agent/loop.ts` — multi-turn agentic loop controller
- `lib/code-space/agent/verification.ts` — post-edit lint + test runner with self-correction
- `app/api/code-space/agent/route.ts` — POST → SSE stream, runs the loop
- `app/api/code-space/agent/diff-decision/route.ts` — POST to accept/reject a pending diff
- `components/code-space/AgentPanel.tsx` — split Chat pane (top) + Tool pane (bottom)
- `components/code-space/DiffOverlay.tsx` — Monaco DiffEditor with Accept/Reject bar

**Modified files:**
- `package.json` — add `diff` + `@types/diff`
- `lib/code-space/core.ts` — extend `CodeSpaceAgentStatus`, add `toolBudget`/`toolCallCount` to session
- `components/code-space/BottomPanel.tsx` — add `terminalStream` prop + live chunk appending
- `components/code-space/CodeSpaceWorkspace.tsx` — wire up AgentPanel, SSE listener, DiffOverlay, provider picker

**Test files (colocated):**
- `lib/code-space/agent/__tests__/types.test.ts`
- `lib/code-space/agent/__tests__/diff.test.ts`
- `lib/code-space/agent/__tests__/tools.test.ts`
- `lib/code-space/agent/__tests__/context.test.ts`
- `lib/code-space/agent/__tests__/loop.test.ts`

---

## Task 1: Add `diff` dependency + extend core types

**Files:**
- Modify: `package.json`
- Modify: `lib/code-space/core.ts`

- [ ] **Step 1: Install `diff` package**


```bash
cd /path/to/project
npm install diff
npm install --save-dev @types/diff
```

Expected: `package.json` updated, `node_modules/diff/` present.

- [ ] **Step 2: Extend `CodeSpaceAgentStatus` in `lib/code-space/core.ts`**

Find this line in `lib/code-space/core.ts`:
```ts
status: 'idle' | 'planning' | 'applying' | 'reviewing' | 'checking' | 'finalized' | 'blocked';
```
Replace with:
```ts
status: 'idle' | 'planning' | 'applying' | 'reviewing' | 'checking' | 'finalized' | 'blocked'
       | 'running' | 'waiting_review' | 'verified' | 'needs_review';
```

- [ ] **Step 3: Add `toolBudget`, `toolCallCount`, `filesChanged`, and `changesets` to `CodeSpaceAgentSession`**

In `lib/code-space/core.ts`, find the `CodeSpaceAgentSession` interface and add after the existing fields:
```ts
  /** Maximum tool calls allowed this session (default 50) */
  toolBudget: number;
  /** How many tool calls have been made so far */
  toolCallCount: number;
  /** Which files were changed and accepted this session */
  filesChanged: string[];
  /** Full before/after content for every accepted write_file — used for undo */
  agentChangesets: Array<{
    filePath: string;
    beforeContent: string;
    afterContent: string;
    acceptedAt: number; // timestamp ms
  }>;
```

- [ ] **Step 4: Update `createCodeSpaceSession` factory (or wherever sessions are initialised) to include defaults**

Find the function or object literal that creates a new `CodeSpaceAgentSession` and add:
```ts
toolBudget: 50,
toolCallCount: 0,
filesChanged: [],
agentChangesets: [],
```

- [ ] **Step 5: Run typecheck to make sure existing code still compiles**

```bash
npm run typecheck
```
Expected: no errors (new fields are additions, not breaking changes).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/code-space/core.ts
git commit -m "feat(code-space): add diff dep + extend session types for agent loop"
```

---

## Task 2: `lib/code-space/agent/types.ts` — agent-specific types

**Files:**
- Create: `lib/code-space/agent/types.ts`
- Create: `lib/code-space/agent/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/code-space/agent/__tests__/types.test.ts
import { describe, expect, it } from 'vitest';
import type { AgentSSEEvent, AgentMessage, NormalizedToolCall, LintError, DetectedStack } from '../types';

describe('AgentSSEEvent discriminated union', () => {
  it('text_delta has delta string', () => {
    const e: AgentSSEEvent = { type: 'text_delta', delta: 'hello' };
    expect(e.type).toBe('text_delta');
    if (e.type === 'text_delta') expect(e.delta).toBe('hello');
  });

  it('diff_proposed has filePath + old/new content', () => {
    const e: AgentSSEEvent = {
      type: 'diff_proposed',
      diffId: 'sess1:Button.tsx:123',
      filePath: 'src/Button.tsx',
      oldContent: 'old',
      newContent: 'new',
    };
    expect(e.type).toBe('diff_proposed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run lib/code-space/agent/__tests__/types.test.ts
```
Expected: FAIL — `types.ts` does not exist yet.

- [ ] **Step 3: Create `lib/code-space/agent/types.ts`**

```ts
// lib/code-space/agent/types.ts
import type { ProviderId } from '@/lib/agent/providers/types';

// ── SSE events emitted from the agent loop to the browser ──────────────────

export type AgentSSEEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; tool: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; tool: string; output: unknown; durationMs: number; error?: string }
  | { type: 'diff_proposed'; diffId: string; filePath: string; oldContent: string; newContent: string }
  | { type: 'terminal_chunk'; chunk: string }
  | { type: 'lint_errors'; filePath: string; errors: LintError[] }
  | { type: 'agent_done'; summary: string; filesChanged: string[] }
  | { type: 'agent_error'; message: string; recoverable: boolean }
  | { type: 'tool_budget_warning'; used: number; max: number };

// ── Multi-turn message history ──────────────────────────────────────────────

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: NormalizedToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError?: boolean };

// ── Normalised tool call (provider-agnostic) ────────────────────────────────

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

// ── Tool definition (what we pass to the LLM) ──────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
}

// ── Lint error (from tsc / eslint) ─────────────────────────────────────────

export interface LintError {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
  rule?: string;
}

// ── Stack detection ─────────────────────────────────────────────────────────

export interface DetectedStack {
  language: string;           // 'typescript' | 'javascript' | 'python' | ...
  framework: string | null;   // 'nextjs' | 'react' | 'express' | null
  testRunner: string;         // 'vitest' | 'jest' | 'pytest' | 'go test'
  testCommand: string;        // e.g. 'npm run test'
  lintTools: string[];        // ['tsc', 'eslint']
  packageManager: string;     // 'npm' | 'yarn' | 'pnpm' | 'bun'
}

// ── callWithTools request/response ─────────────────────────────────────────

export interface ToolCallRequest {
  messages: AgentMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  model: string;
  providerId: ProviderId;
  apiKey: string;
  endpoint?: string;
  maxTokens?: number;
  enableThinking?: boolean; // Anthropic only — used on first planning turn
  signal?: AbortSignal;
}

export interface ToolCallResponse {
  textContent: string;
  toolCalls: NormalizedToolCall[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run lib/code-space/agent/__tests__/types.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/code-space/agent/types.ts lib/code-space/agent/__tests__/types.test.ts
git commit -m "feat(code-space/agent): add agent-specific types"
```

---

## Task 3: `lib/code-space/agent/registry.ts` — diff callback registry

**Files:**
- Create: `lib/code-space/agent/registry.ts`

- [ ] **Step 1: Create `registry.ts`**

This module holds a module-scope Map so the diff-decision API route can resume a paused `write_file` tool call.

```ts
// lib/code-space/agent/registry.ts

/** Key: diffId (format: `{sessionId}:{filePath}:{timestamp}`) */
const pendingDiffs = new Map<string, (accepted: boolean) => void>();

export function registerDiffCallback(diffId: string, resolve: (accepted: boolean) => void): void {
  pendingDiffs.set(diffId, resolve);
}

export function resolveDiff(diffId: string, accepted: boolean): boolean {
  const cb = pendingDiffs.get(diffId);
  if (!cb) return false;
  pendingDiffs.delete(diffId);
  cb(accepted);
  return true;
}

export function hasPendingDiff(diffId: string): boolean {
  return pendingDiffs.has(diffId);
}

/** Reject all pending diffs for a session (e.g. when user cancels the agent run) */
export function rejectAllForSession(sessionId: string): void {
  for (const [key, cb] of pendingDiffs) {
    if (key.startsWith(`${sessionId}:`)) {
      cb(false);
      pendingDiffs.delete(key);
    }
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/code-space/agent/registry.ts
git commit -m "feat(code-space/agent): add diff callback registry"
```

---

## Task 4: `lib/code-space/agent/providers.ts` — `callWithTools()` streaming wrapper

**Files:**
- Create: `lib/code-space/agent/providers.ts`

- [ ] **Step 1: Create `providers.ts`**

This wraps the raw SDKs directly (not the existing diagram-mode providers which return `Promise<string>` only) to support streaming + tool use.

```ts
// lib/code-space/agent/providers.ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AgentMessage, NormalizedToolCall, ToolCallRequest, ToolCallResponse, AgentSSEEvent } from './types';

export async function callWithTools(
  req: ToolCallRequest,
  onEvent: (e: AgentSSEEvent) => void,
): Promise<ToolCallResponse> {
  if (req.providerId === 'anthropic') return callAnthropic(req, onEvent);
  if (req.providerId === 'openai') return callOpenAI(req, onEvent);
  throw new Error(`Provider ${req.providerId} does not support tool use yet`);
}

// ── Anthropic ───────────────────────────────────────────────────────────────

async function callAnthropic(req: ToolCallRequest, onEvent: (e: AgentSSEEvent) => void): Promise<ToolCallResponse> {
  const client = new Anthropic({ apiKey: req.apiKey, ...(req.endpoint ? { baseURL: req.endpoint } : {}) });

  const anthropicMessages = toAnthropicMessages(req.messages);
  const tools: Anthropic.Tool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8096,
    system: [
      {
        type: 'text',
        text: req.systemPrompt,
        cache_control: { type: 'ephemeral' }, // prompt caching
      },
    ],
    messages: anthropicMessages,
    tools,
  };

  if (req.enableThinking) {
    body.thinking = { type: 'enabled', budget_tokens: 8000 };
  }

  const stream = client.messages.stream(body, { signal: req.signal });

  let textContent = '';
  const toolCalls: NormalizedToolCall[] = [];

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        textContent += event.delta.text;
        onEvent({ type: 'text_delta', delta: event.delta.text });
      }
    }
  }

  const final = await stream.finalMessage();
  for (const block of final.content) {
    if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return {
    textContent,
    toolCalls,
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
    cacheReadTokens: (final.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
  };
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

async function callOpenAI(req: ToolCallRequest, onEvent: (e: AgentSSEEvent) => void): Promise<ToolCallResponse> {
  const client = new OpenAI({ apiKey: req.apiKey, ...(req.endpoint ? { baseURL: req.endpoint } : {}) });

  const messages = toOpenAIMessages(req.systemPrompt, req.messages);
  const tools: OpenAI.ChatCompletionTool[] = req.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const stream = await client.chat.completions.create(
    { model: req.model, messages, tools, stream: true },
    { signal: req.signal },
  );

  let textContent = '';
  // Accumulate streamed tool call deltas
  const toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      textContent += delta.content;
      onEvent({ type: 'text_delta', delta: delta.content });
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCallAccum[tc.index]) {
          toolCallAccum[tc.index] = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
        }
        toolCallAccum[tc.index].args += tc.function?.arguments ?? '';
        if (tc.id) toolCallAccum[tc.index].id = tc.id;
        if (tc.function?.name) toolCallAccum[tc.index].name = tc.function.name;
      }
    }
  }

  const toolCalls: NormalizedToolCall[] = Object.values(toolCallAccum).map((tc) => ({
    id: tc.id,
    name: tc.name,
    input: tc.args ? JSON.parse(tc.args) : {},
  }));

  return { textContent, toolCalls, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

// ── Message format converters ───────────────────────────────────────────────

function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any[] = m.content ? [{ type: 'text', text: m.content }] : [];
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      // Tool results go as user messages in Anthropic
      const last = out[out.length - 1];
      const toolResult = {
        type: 'tool_result' as const,
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(toolResult);
      } else {
        out.push({ role: 'user', content: [toolResult] });
      }
    }
  }
  return out;
}

function toOpenAIMessages(systemPrompt: string, messages: AgentMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/code-space/agent/providers.ts
git commit -m "feat(code-space/agent): add callWithTools streaming wrapper (Anthropic + OpenAI)"
```

---

## Task 5: `lib/code-space/agent/diff.ts` — diff computation

**Files:**
- Create: `lib/code-space/agent/diff.ts`
- Create: `lib/code-space/agent/__tests__/diff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/code-space/agent/__tests__/diff.test.ts
import { describe, expect, it } from 'vitest';
import { computeDiff, diffHasChanges } from '../diff';

describe('computeDiff', () => {
  it('returns empty hunks for identical content', () => {
    const result = computeDiff('src/Button.tsx', 'hello\nworld', 'hello\nworld');
    expect(result.hunks).toHaveLength(0);
    expect(diffHasChanges(result)).toBe(false);
  });

  it('detects added lines', () => {
    const result = computeDiff('src/Button.tsx', 'line1\nline2', 'line1\nline2\nline3');
    expect(diffHasChanges(result)).toBe(true);
    const addedLines = result.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith('+'));
    expect(addedLines).toContain('+line3');
  });

  it('detects removed lines', () => {
    const result = computeDiff('src/Button.tsx', 'line1\nline2\nline3', 'line1\nline3');
    const removedLines = result.hunks.flatMap((h) => h.lines).filter((l) => l.startsWith('-'));
    expect(removedLines).toContain('-line2');
  });

  it('includes filePath in result', () => {
    const result = computeDiff('src/Button.tsx', 'a', 'b');
    expect(result.filePath).toBe('src/Button.tsx');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run lib/code-space/agent/__tests__/diff.test.ts
```
Expected: FAIL — `diff.ts` not found.

- [ ] **Step 3: Create `lib/code-space/agent/diff.ts`**

```ts
// lib/code-space/agent/diff.ts
import { structuredPatch } from 'diff';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // '+added', '-removed', ' context'
}

export interface FileDiff {
  filePath: string;
  oldContent: string;
  newContent: string;
  hunks: DiffHunk[];
}

export function computeDiff(filePath: string, oldContent: string, newContent: string): FileDiff {
  const patch = structuredPatch(filePath, filePath, oldContent, newContent, '', '', { context: 3 });
  return {
    filePath,
    oldContent,
    newContent,
    hunks: patch.hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      lines: h.lines,
    })),
  };
}

export function diffHasChanges(diff: FileDiff): boolean {
  return diff.hunks.length > 0;
}

/** Returns line numbers (1-based) in the NEW file that are added/changed */
export function getAddedLineNumbers(diff: FileDiff): number[] {
  const result: number[] = [];
  for (const hunk of diff.hunks) {
    let lineNum = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) result.push(lineNum++);
      else if (line.startsWith(' ')) lineNum++;
      // '-' lines don't advance new-file line counter
    }
  }
  return result;
}

/** Returns line numbers (1-based) in the OLD file that are removed */
export function getRemovedLineNumbers(diff: FileDiff): number[] {
  const result: number[] = [];
  for (const hunk of diff.hunks) {
    let lineNum = hunk.oldStart;
    for (const line of hunk.lines) {
      if (line.startsWith('-')) result.push(lineNum++);
      else if (line.startsWith(' ')) lineNum++;
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run lib/code-space/agent/__tests__/diff.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/code-space/agent/diff.ts lib/code-space/agent/__tests__/diff.test.ts
git commit -m "feat(code-space/agent): add diff computation utilities"
```

---

## Task 6: `lib/code-space/agent/tools.ts` — tool registry

**Files:**
- Create: `lib/code-space/agent/tools.ts`
- Create: `lib/code-space/agent/__tests__/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/code-space/agent/__tests__/tools.test.ts
import { describe, expect, it, vi } from 'vitest';
import { TOOL_DEFINITIONS, executeReadFile, executeListDirectory } from '../tools';

describe('TOOL_DEFINITIONS', () => {
  it('exports 6 tool definitions', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(6);
  });
  it('all tools have name, description, inputSchema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });
});

describe('executeReadFile', () => {
  it('returns truncated flag when content exceeds token limit', async () => {
    // Mock fetch to return large content
    const longContent = 'x'.repeat(40000); // > 8k tokens
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: longContent, hash: 'abc' }),
    });
    const result = await executeReadFile({ path: 'big.ts' }, 'http://localhost:3000', '/tmp/proj');
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThan(longContent.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run lib/code-space/agent/__tests__/tools.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `lib/code-space/agent/tools.ts`**

```ts
// lib/code-space/agent/tools.ts
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDefinition, LintError, AgentSSEEvent } from './types';
import { registerDiffCallback } from './registry';
import { computeDiff } from './diff';

const execFileAsync = promisify(execFile);
const MAX_READ_CHARS = 32_000; // ~8k tokens

// ── Tool definitions (JSON schemas for the LLM) ─────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Always read a file before writing it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        startLine: { type: 'number', description: 'First line to read (1-based, optional)' },
        endLine: { type: 'number', description: 'Last line to read (1-based, optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write new content to a file. The user will see a diff and must accept before the file is saved.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        content: { type: 'string', description: 'Complete new file content' },
        reason: { type: 'string', description: 'Brief explanation of why this change is needed' },
      },
      required: ['path', 'content', 'reason'],
    },
  },
  {
    name: 'search_code',
    description: 'Search the codebase using ripgrep. Use this before writing code to find existing patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or regex' },
        fileGlob: { type: 'string', description: 'File pattern to restrict search, e.g. "*.tsx"' },
        contextLines: { type: 'number', description: 'Lines of context around each match (default 3)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_terminal',
    description: 'Execute a shell command in the project root. Output streams live to the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'lint_check',
    description: 'Run tsc and/or eslint on the given files and return structured errors.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'File paths to lint' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders at a path. Use when you need to explore an unfamiliar directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to project root' },
        depth: { type: 'number', description: 'Max depth (default 2, max 4)' },
      },
      required: ['path'],
    },
  },
];

// ── Executors ───────────────────────────────────────────────────────────────

export interface ToolContext {
  sessionId: string;
  projectRoot: string;
  baseUrl: string; // e.g. 'http://localhost:3000'
  onEvent: (e: AgentSSEEvent) => void;
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ output: unknown; error?: string }> {
  const inp = input as Record<string, unknown>;
  try {
    switch (name) {
      case 'read_file':    return { output: await executeReadFile(inp, ctx.baseUrl, ctx.projectRoot) };
      case 'write_file':   return { output: await executeWriteFile(inp, ctx) };
      case 'search_code':  return { output: await executeSearchCode(inp, ctx.projectRoot) };
      case 'run_terminal': return { output: await executeRunTerminal(inp, ctx) };
      case 'lint_check':   return { output: await executeLintCheck(inp, ctx.projectRoot, ctx.onEvent) };
      case 'list_directory': return { output: await executeListDirectory(inp, ctx.baseUrl, ctx.projectRoot) };
      default: return { output: null, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { output: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeReadFile(
  inp: Record<string, unknown>,
  baseUrl: string,
  projectRoot: string,
): Promise<{ content: string; lineCount: number; language: string; truncated: boolean }> {
  const filePath = String(inp.path);
  const res = await fetch(`${baseUrl}/api/code-space/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'read', path: path.join(projectRoot, filePath) }),
  });
  if (!res.ok) throw new Error(`read_file failed: ${res.statusText}`);
  const data = await res.json() as { content: string; hash: string };
  let content = data.content;
  const truncated = content.length > MAX_READ_CHARS;
  if (truncated) {
    content = content.slice(0, MAX_READ_CHARS) + '\n[truncated — use startLine/endLine to read sections]';
  }
  if (inp.startLine || inp.endLine) {
    const lines = data.content.split('\n');
    const start = Math.max(0, (Number(inp.startLine) || 1) - 1);
    const end = inp.endLine ? Number(inp.endLine) : lines.length;
    content = lines.slice(start, end).join('\n');
  }
  const lineCount = content.split('\n').length;
  const ext = filePath.split('.').pop() ?? '';
  const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', go: 'go', rs: 'rust', md: 'markdown', json: 'json', css: 'css', html: 'html' };
  return { content, lineCount, language: langMap[ext] ?? 'text', truncated };
}

export async function executeListDirectory(
  inp: Record<string, unknown>,
  baseUrl: string,
  projectRoot: string,
): Promise<{ tree: unknown[] }> {
  const dirPath = String(inp.path || '.');
  const res = await fetch(
    `${baseUrl}/api/code-space/files?path=${encodeURIComponent(path.join(projectRoot, dirPath))}&recursive=true`,
  );
  if (!res.ok) throw new Error(`list_directory failed: ${res.statusText}`);
  const data = await res.json() as { entries: unknown[] };
  return { tree: data.entries ?? [] };
}

async function executeWriteFile(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ accepted: boolean; path: string }> {
  const filePath = String(inp.path);
  const newContent = String(inp.content);

  // Read current content for diff
  let oldContent = '';
  try {
    const r = await executeReadFile({ path: filePath }, ctx.baseUrl, ctx.projectRoot);
    oldContent = r.content;
  } catch {
    // New file — old content is empty
  }

  const diff = computeDiff(filePath, oldContent, newContent);
  const diffId = `${ctx.sessionId}:${filePath}:${Date.now()}`;

  ctx.onEvent({ type: 'diff_proposed', diffId, filePath, oldContent, newContent });

  const accepted = await new Promise<boolean>((resolve) => {
    registerDiffCallback(diffId, resolve);
  });

  if (accepted) {
    await fetch(`${ctx.baseUrl}/api/code-space/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'write',
        path: path.join(ctx.projectRoot, filePath),
        content: newContent,
      }),
    });
  }

  return { accepted, path: filePath };
}

async function executeSearchCode(
  inp: Record<string, unknown>,
  projectRoot: string,
): Promise<{ matches: Array<{ file: string; line: number; text: string; context: string[] }>; truncated: boolean }> {
  const query = String(inp.query);
  const contextLines = Math.min(Number(inp.contextLines ?? 3), 10);
  const glob = inp.fileGlob ? ['--glob', String(inp.fileGlob)] : [];

  try {
    const { stdout } = await execFileAsync(
      'rg',
      ['--json', `--context=${contextLines}`, ...glob, query, projectRoot],
      { maxBuffer: 5 * 1024 * 1024 },
    );
    const matches: Array<{ file: string; line: number; text: string; context: string[] }> = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { type: string; data: { path: { text: string }; line_number: number; lines: { text: string }; submatches: unknown[] } };
        if (obj.type === 'match') {
          const filePath = obj.data.path.text;
          // Expand to enclosing function boundary using brace-depth counter
          const expandedContext = expandToFunctionBoundary(filePath, obj.data.line_number);
          matches.push({
            file: filePath.replace(projectRoot + '/', ''),
            line: obj.data.line_number,
            text: obj.data.lines.text.trimEnd(),
            context: expandedContext,
          });
        }
      } catch { /* skip malformed lines */ }
    }
    const capped = matches.slice(0, 50);
    return { matches: capped, truncated: matches.length > 50 };
  } catch {
    // rg not found or no matches — return empty
    return { matches: [], truncated: false };
  }
}

/**
 * Given a file path and a matched line number, expand context outward to the
 * enclosing function/class boundary using a brace-depth counter.
 * Returns an array of lines (max 40) surrounding the match.
 */
function expandToFunctionBoundary(filePath: string, matchLine: number): string[] {
  try {
    const fs = require('fs') as typeof import('fs');
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const idx = matchLine - 1; // 0-based

    // Walk backward to find function/class start (brace depth returns to 0 or 'function'/'class' keyword)
    let start = idx;
    let depth = 0;
    for (let i = idx; i >= 0 && idx - i < 60; i--) {
      const l = lines[i];
      depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
      if (depth <= 0 && /^\s*(export\s+)?(async\s+)?function|^\s*(export\s+)?class|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(l)) {
        start = i;
        break;
      }
    }

    // Walk forward to find matching closing brace
    let end = idx;
    let openBraces = 0;
    for (let i = start; i < lines.length && i - start < 80; i++) {
      openBraces += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
      end = i;
      if (openBraces <= 0 && i > idx) break;
    }

    return lines.slice(start, Math.min(end + 1, start + 40));
  } catch {
    return [];
  }
}

async function executeRunTerminal(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const command = String(inp.command);

  // Block shell metacharacters that can cause injection (same pattern as /api/code-space/terminal)
  if (!/^[\w@./:\-\s"'=,*?!~^%()[\]{}|&;`$\\]+$/.test(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }

  const start = Date.now();

  const res = await fetch(`${ctx.baseUrl}/api/code-space/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd: ctx.projectRoot }),
  });
  if (!res.ok) throw new Error(`terminal call failed: ${res.statusText}`);
  const data = await res.json() as { stdout: string; stderr: string; exitCode: number };

  // Stream output as chunks to the UI
  if (data.stdout) {
    for (const chunk of data.stdout.split('\n')) {
      ctx.onEvent({ type: 'terminal_chunk', chunk: chunk + '\n' });
    }
  }

  return { exitCode: data.exitCode, stdout: data.stdout, stderr: data.stderr, durationMs: Date.now() - start };
}

export async function executeLintCheck(
  inp: Record<string, unknown>,
  projectRoot: string,
  onEvent: (e: AgentSSEEvent) => void,
): Promise<{ errors: LintError[]; passed: boolean }> {
  const paths = (inp.paths as string[]).map((p) => path.join(projectRoot, p));
  const allErrors: LintError[] = [];

  // TypeScript check
  try {
    await execFileAsync('npx', ['tsc', '--noEmit', '--pretty', 'false'], { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 });
  } catch (err) {
    const output = (err as { stdout?: string; stderr?: string }).stdout ?? '';
    for (const line of output.split('\n')) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/);
      if (m) {
        const e: LintError = { file: m[1].replace(projectRoot + '/', ''), line: Number(m[2]), col: Number(m[3]), severity: m[4] as 'error' | 'warning', message: m[5] };
        allErrors.push(e);
      }
    }
  }

  // ESLint check (if eslint config exists)
  try {
    const { stdout } = await execFileAsync(
      'npx', ['eslint', '--format', 'json', ...paths],
      { cwd: projectRoot, maxBuffer: 2 * 1024 * 1024 },
    );
    const results = JSON.parse(stdout) as Array<{ filePath: string; messages: Array<{ line: number; column: number; severity: number; message: string; ruleId: string | null }> }>;
    for (const r of results) {
      for (const m of r.messages) {
        allErrors.push({
          file: r.filePath.replace(projectRoot + '/', ''),
          line: m.line,
          col: m.column,
          severity: m.severity === 2 ? 'error' : 'warning',
          message: m.message,
          rule: m.ruleId ?? undefined,
        });
      }
    }
  } catch { /* eslint not configured or no errors */ }

  const errors = allErrors.filter((e) => paths.some((p) => p.endsWith(e.file)));
  if (errors.length) {
    const byFile = new Map<string, LintError[]>();
    for (const e of errors) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    for (const [file, errs] of byFile) onEvent({ type: 'lint_errors', filePath: file, errors: errs });
  }

  return { errors, passed: errors.filter((e) => e.severity === 'error').length === 0 };
}
```

- [ ] **Step 4: Run test**

```bash
npx vitest run lib/code-space/agent/__tests__/tools.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/code-space/agent/tools.ts lib/code-space/agent/__tests__/tools.test.ts
git commit -m "feat(code-space/agent): add 6-tool registry with executors"
```

---

## Task 7: `lib/code-space/agent/context.ts` — stack detection + context builder

**Files:**
- Create: `lib/code-space/agent/context.ts`
- Create: `lib/code-space/agent/__tests__/context.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/code-space/agent/__tests__/context.test.ts
import { describe, expect, it } from 'vitest';
import { detectStack, scoreFileRelevance } from '../context';

describe('detectStack', () => {
  it('detects Next.js + TypeScript project', () => {
    const pkg = JSON.stringify({
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      devDependencies: { typescript: '^5.0.0' },
      scripts: { test: 'vitest run' },
    });
    const tsconfig = '{}';
    const result = detectStack({ 'package.json': pkg, 'tsconfig.json': tsconfig });
    expect(result.language).toBe('typescript');
    expect(result.framework).toBe('nextjs');
    expect(result.testRunner).toBe('vitest');
    expect(result.testCommand).toBe('npm run test');
    expect(result.lintTools).toContain('tsc');
  });

  it('detects plain JavaScript project', () => {
    const pkg = JSON.stringify({ dependencies: { express: '^4.0.0' }, scripts: { test: 'jest' } });
    const result = detectStack({ 'package.json': pkg });
    expect(result.language).toBe('javascript');
    expect(result.testRunner).toBe('jest');
  });
});

describe('scoreFileRelevance', () => {
  it('gives higher score to files with prompt keywords', () => {
    const files = ['src/Button.tsx', 'src/theme.ts', 'src/Header.tsx'];
    const scores = scoreFileRelevance(files, 'fix the Button hover state', []);
    expect(scores['src/Button.tsx']).toBeGreaterThan(scores['src/Header.tsx']);
    expect(scores['src/Header.tsx']).toBeGreaterThan(scores['src/theme.ts']);
  });

  it('boosts open tabs', () => {
    const files = ['src/A.tsx', 'src/B.tsx'];
    const scores = scoreFileRelevance(files, 'do something', ['src/B.tsx']);
    expect(scores['src/B.tsx']).toBeGreaterThan(scores['src/A.tsx']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run lib/code-space/agent/__tests__/context.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `lib/code-space/agent/context.ts`**

```ts
// lib/code-space/agent/context.ts
import path from 'path';
import fs from 'fs';
import type { DetectedStack } from './types';

// ── Stack detection ─────────────────────────────────────────────────────────

export function detectStack(fileMap: Record<string, string>): DetectedStack {
  const pkg = fileMap['package.json'] ? JSON.parse(fileMap['package.json']) : null;
  const hasTsConfig = 'tsconfig.json' in fileMap;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  const language = hasTsConfig || 'typescript' in deps ? 'typescript' : 'javascript';

  let framework: string | null = null;
  if ('next' in deps) framework = 'nextjs';
  else if ('react' in deps) framework = 'react';
  else if ('vue' in deps) framework = 'vue';
  else if ('express' in deps || 'fastify' in deps) framework = 'express';

  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const testScript = scripts.test ?? scripts['test:unit'] ?? '';
  let testRunner = 'vitest';
  let testCommand = 'npm run test';
  if ('vitest' in deps || testScript.includes('vitest')) { testRunner = 'vitest'; testCommand = 'npm run test'; }
  else if ('jest' in deps || testScript.includes('jest')) { testRunner = 'jest'; testCommand = 'npm run test'; }

  const lintTools: string[] = [];
  if (language === 'typescript') lintTools.push('tsc');
  if ('eslint' in deps || 'eslint-config-next' in deps) lintTools.push('eslint');

  let packageManager = 'npm';
  try {
    if (fs.existsSync(path.join(process.cwd(), 'yarn.lock'))) packageManager = 'yarn';
    else if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) packageManager = 'pnpm';
    else if (fs.existsSync(path.join(process.cwd(), 'bun.lockb'))) packageManager = 'bun';
  } catch { /* ignore */ }

  return { language, framework, testRunner, testCommand, lintTools, packageManager };
}

export function detectStackFromDisk(projectRoot: string): DetectedStack {
  const fileMap: Record<string, string> = {};
  for (const name of ['package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    try { fileMap[name] = fs.readFileSync(path.join(projectRoot, name), 'utf-8'); } catch { /* ignore */ }
  }
  return detectStack(fileMap);
}

// ── File relevance scoring ──────────────────────────────────────────────────

export function scoreFileRelevance(
  files: string[],
  prompt: string,
  openTabs: string[],
): Record<string, number> {
  const words = prompt.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scores: Record<string, number> = {};

  for (const file of files) {
    const base = path.basename(file, path.extname(file)).toLowerCase();
    const parts = file.toLowerCase().split(/[/\\._-]/);
    let score = 0;

    for (const word of words) {
      if (base.includes(word)) score += 10;
      else if (parts.some((p) => p.includes(word))) score += 5;
    }

    if (openTabs.includes(file)) score += 30;
    scores[file] = score;
  }

  return scores;
}

// ── Context block builder ───────────────────────────────────────────────────

export interface BuiltContext {
  systemContextBlock: string; // injected into system prompt (cache_control block)
  relevantFilePaths: string[]; // top N files to pre-load
}

export async function buildContext(
  projectRoot: string,
  prompt: string,
  openTabs: string[],
  baseUrl: string,
): Promise<BuiltContext> {
  const lines: string[] = [];

  // File tree
  try {
    const res = await fetch(`${baseUrl}/api/code-space/files?path=${encodeURIComponent(projectRoot)}&recursive=true`);
    if (res.ok) {
      const data = await res.json() as { entries: Array<{ path: string; type: string }> };
      const tree = data.entries
        .map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.path.replace(projectRoot + '/', '')}`)
        .slice(0, 500)
        .join('\n');
      lines.push('<file_tree>', tree, '</file_tree>');
    }
  } catch { /* non-fatal */ }

  // Git status
  try {
    const res = await fetch(`${baseUrl}/api/code-space/git-status?root=${encodeURIComponent(projectRoot)}`);
    if (res.ok) {
      const git = await res.json() as { branch?: string; changed?: number; lastCommit?: string };
      lines.push('<git_status>', `Branch: ${git.branch ?? 'unknown'}  Changed files: ${git.changed ?? 0}  Last commit: ${git.lastCommit ?? ''}`, '</git_status>');
    }
  } catch { /* non-fatal */ }

  // Key config files
  const keyFiles = ['package.json', 'tsconfig.json', 'README.md'];
  const keyFileSections: string[] = [];
  for (const f of keyFiles) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, f), 'utf-8').slice(0, 2000);
      keyFileSections.push(`--- ${f} ---\n${content}`);
    } catch { /* skip if missing */ }
  }
  if (keyFileSections.length) lines.push('<key_files>', ...keyFileSections, '</key_files>');

  // Relevant files list (scoring — full content loaded in loop turn 1 via read_file tools)
  let allFiles: string[] = [];
  try {
    const res = await fetch(`${baseUrl}/api/code-space/files?path=${encodeURIComponent(projectRoot)}&recursive=true`);
    if (res.ok) {
      const data = await res.json() as { entries: Array<{ path: string; type: string }> };
      allFiles = data.entries.filter((e) => e.type === 'file').map((e) => e.path.replace(projectRoot + '/', ''));
    }
  } catch { /* non-fatal */ }

  const scores = scoreFileRelevance(allFiles, prompt, openTabs);
  const topFiles = Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([f]) => f);

  lines.push('<relevant_files>', topFiles.join('\n'), '</relevant_files>');

  return {
    systemContextBlock: lines.join('\n'),
    relevantFilePaths: topFiles,
  };
}
```

- [ ] **Step 4: Run test**

```bash
npx vitest run lib/code-space/agent/__tests__/context.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/code-space/agent/context.ts lib/code-space/agent/__tests__/context.test.ts
git commit -m "feat(code-space/agent): add stack detection + file relevance scoring"
```

---

## Task 8: `lib/code-space/agent/prompt.ts` + `loop.ts` + `verification.ts`

**Files:**
- Create: `lib/code-space/agent/prompt.ts`
- Create: `lib/code-space/agent/loop.ts`
- Create: `lib/code-space/agent/verification.ts`
- Create: `lib/code-space/agent/__tests__/loop.test.ts`

- [ ] **Step 1: Create `lib/code-space/agent/prompt.ts`**

```ts
// lib/code-space/agent/prompt.ts
import type { DetectedStack } from './types';

export function buildSystemPrompt(projectName: string, stack: DetectedStack, contextBlock: string): string {
  return `You are an expert ${stack.language} software engineer working in the "${projectName}" codebase.
Tech stack: ${stack.framework ?? stack.language}${stack.framework ? ` (${stack.language})` : ''}, test runner: ${stack.testRunner}.

## Rules
1. Always call read_file before write_file on any file you haven't read this session.
2. Use search_code to find existing patterns before writing new utilities or types.
3. After every write_file, lint_check runs automatically — fix any errors before declaring done.
4. Keep changes minimal and focused on the task.
5. After completing a logical unit of work, offer to run the test suite.

## Examples of good tool sequences

Example 1 — Bug fix:
  read_file → search_code (find usages) → write_file → (lint auto-runs) → run_terminal (test) → done

Example 2 — New feature:
  list_directory → read_file (×2-3) → search_code → write_file (×1-2) → run_terminal (test) → done

## Repo context
${contextBlock}`;
}

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-pro',
  grok: 'grok-2',
  foundry: 'gpt-4o',
};
```

- [ ] **Step 2: Write the failing loop test**

```ts
// lib/code-space/agent/__tests__/loop.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../loop';
import type { AgentMessage, AgentSSEEvent, ToolDefinition } from '../types';

describe('runAgentLoop', () => {
  it('returns done when LLM returns no tool calls', async () => {
    const events: AgentSSEEvent[] = [];
    const mockCallWithTools = vi.fn().mockResolvedValue({
      textContent: 'Task complete.',
      toolCalls: [],
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
    });

    const result = await runAgentLoop({
      sessionId: 'test-session',
      messages: [{ role: 'user', content: 'Hello' }] as AgentMessage[],
      systemPrompt: 'You are a test agent.',
      tools: [] as ToolDefinition[],
      toolBudget: 10,
      projectRoot: '/tmp',
      baseUrl: 'http://localhost:3000',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      apiKey: 'test-key',
      onEvent: (e) => events.push(e),
      _callWithTools: mockCallWithTools, // injected for testing
    });

    expect(result.done).toBe(true);
    expect(result.summary).toBe('Task complete.');
    expect(events.find((e) => e.type === 'agent_done')).toBeTruthy();
  });

  it('emits agent_error and stops when tool budget is exceeded', async () => {
    const events: AgentSSEEvent[] = [];
    const mockCallWithTools = vi.fn().mockResolvedValue({
      textContent: '',
      toolCalls: [{ id: '1', name: 'read_file', input: { path: 'x.ts' } }],
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
    });

    // executeTool also needs mocking in a real test; here we test the budget gate
    await runAgentLoop({
      sessionId: 'test-session',
      messages: [{ role: 'user', content: 'Hello' }] as AgentMessage[],
      systemPrompt: '',
      tools: [],
      toolBudget: 0, // budget already exhausted
      projectRoot: '/tmp',
      baseUrl: 'http://localhost:3000',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      apiKey: 'test-key',
      onEvent: (e) => events.push(e),
      _callWithTools: mockCallWithTools,
    });

    expect(events.find((e) => e.type === 'agent_error')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run lib/code-space/agent/__tests__/loop.test.ts
```
Expected: FAIL.

- [ ] **Step 4: Create `lib/code-space/agent/loop.ts`**

```ts
// lib/code-space/agent/loop.ts
import type { AgentMessage, AgentSSEEvent, NormalizedToolCall, ToolDefinition, ToolCallRequest, ToolCallResponse } from './types';
import type { ProviderId } from '@/lib/agent/providers/types';
import { callWithTools } from './providers';
import { executeTool, executeLintCheck, type ToolContext } from './tools';

export interface LoopInput {
  sessionId: string;
  messages: AgentMessage[];
  systemPrompt: string;
  tools: ToolDefinition[];
  toolBudget: number;
  projectRoot: string;
  baseUrl: string;
  model: string;
  providerId: ProviderId;
  apiKey: string;
  endpoint?: string;
  enableThinking?: boolean;
  signal?: AbortSignal;
  onEvent: (e: AgentSSEEvent) => void;
  /** Injectable for testing */
  _callWithTools?: (req: ToolCallRequest, onEvent: (e: AgentSSEEvent) => void) => Promise<ToolCallResponse>;
}

export interface LoopResult {
  done: boolean;
  summary: string;
  filesChanged: string[];
  toolCallCount: number;
}

export async function runAgentLoop(input: LoopInput): Promise<LoopResult> {
  const {
    sessionId, systemPrompt, tools, toolBudget, projectRoot, baseUrl,
    model, providerId, apiKey, endpoint, signal, onEvent,
    _callWithTools: callFn = callWithTools,
  } = input;

  // Check budget before even starting
  if (toolBudget <= 0) {
    onEvent({ type: 'agent_error', message: 'Tool budget exhausted.', recoverable: false });
    return { done: false, summary: '', filesChanged: [], toolCallCount: 0 };
  }

  const messages: AgentMessage[] = [...input.messages];
  const filesChanged: string[] = [];
  let toolCallCount = 0;
  let lastTextContent = '';
  let isFirstTurn = true;

  const toolCtx: ToolContext = { sessionId, projectRoot, baseUrl, onEvent };

  while (toolCallCount < toolBudget) {
    let response: ToolCallResponse;
    try {
      response = await callFn(
        {
          messages,
          systemPrompt,
          tools,
          model,
          providerId,
          apiKey,
          endpoint,
          maxTokens: 8096,
          enableThinking: isFirstTurn && input.enableThinking,
          signal,
        },
        onEvent,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'agent_error', message: msg, recoverable: false });
      return { done: false, summary: msg, filesChanged, toolCallCount };
    }

    isFirstTurn = false;
    if (response.textContent) lastTextContent = response.textContent;

    // Append assistant message
    messages.push({
      role: 'assistant',
      content: response.textContent,
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    });

    // No tool calls → agent is done
    if (response.toolCalls.length === 0) break;

    // Warn if approaching budget
    const newCount = toolCallCount + response.toolCalls.length;
    if (newCount > toolBudget * 0.8) {
      onEvent({ type: 'tool_budget_warning', used: newCount, max: toolBudget });
    }

    // Execute tool calls (parallel for read-only tools, serial for write/terminal)
    const toolResults = await executeToolCalls(response.toolCalls, toolCtx, filesChanged);
    toolCallCount += response.toolCalls.length;

    // Append tool results as messages
    for (const { call, output, error } of toolResults) {
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(error ? { error } : output),
        isError: !!error,
      });

      onEvent({
        type: 'tool_result',
        toolCallId: call.id,
        tool: call.name,
        output: error ? { error } : output,
        durationMs: 0,
        error,
      });

      // Auto-lint after accepted write_file
      if (call.name === 'write_file' && !error) {
        const writeOutput = output as { accepted: boolean; path: string };
        if (writeOutput.accepted) {
          filesChanged.push(writeOutput.path);
          const lintResult = await executeLintCheck({ paths: [writeOutput.path] }, projectRoot, onEvent);
          if (!lintResult.passed) {
            messages.push({
              role: 'tool',
              toolCallId: `lint-${call.id}`,
              toolName: 'lint_check',
              content: JSON.stringify(lintResult),
            });
          }
        }
      }
    }
  }

  onEvent({ type: 'agent_done', summary: lastTextContent, filesChanged });
  return { done: true, summary: lastTextContent, filesChanged, toolCallCount };
}

async function executeToolCalls(
  calls: NormalizedToolCall[],
  ctx: ToolContext,
  filesChanged: string[],
): Promise<Array<{ call: NormalizedToolCall; output: unknown; error?: string }>> {
  // Read-only tools run in parallel, write/terminal run serially
  const readOnly = new Set(['read_file', 'list_directory', 'search_code']);
  const parallel = calls.filter((c) => readOnly.has(c.name));
  const serial = calls.filter((c) => !readOnly.has(c.name));

  // Emit tool_start for every parallel call before launching them
  for (const call of parallel) {
    ctx.onEvent({ type: 'tool_start', toolCallId: call.id, tool: call.name, input: call.input });
  }

  const parallelResults = await Promise.all(
    parallel.map(async (call) => {
      const { output, error } = await executeTool(call.name, call.input, ctx);
      return { call, output, error };
    }),
  );

  const serialResults: Array<{ call: NormalizedToolCall; output: unknown; error?: string }> = [];
  for (const call of serial) {
    // Emit tool_start individually just before executing each serial call
    ctx.onEvent({ type: 'tool_start', toolCallId: call.id, tool: call.name, input: call.input });
    const { output, error } = await executeTool(call.name, call.input, ctx);
    serialResults.push({ call, output, error });
  }

  return [...parallelResults, ...serialResults];
}
```

- [ ] **Step 5: Create `lib/code-space/agent/verification.ts`**

```ts
// lib/code-space/agent/verification.ts
import type { AgentSSEEvent, AgentMessage, LintError, DetectedStack } from './types';
import { executeLintCheck } from './tools';
import type { ToolDefinition } from './types';
import { runAgentLoop } from './loop';
import type { ProviderId } from '@/lib/agent/providers/types';

export interface VerificationInput {
  sessionId: string;
  filesChanged: string[];
  projectRoot: string;
  baseUrl: string;
  stack: DetectedStack;
  model: string;
  providerId: ProviderId;
  apiKey: string;
  tools: ToolDefinition[];
  systemPrompt: string;
  onEvent: (e: AgentSSEEvent) => void;
  maxAttempts?: number;
}

export type VerificationStatus = 'passed' | 'needs_review';

export async function runVerification(input: VerificationInput): Promise<VerificationStatus> {
  const { filesChanged, projectRoot, stack, baseUrl, onEvent, maxAttempts = 3 } = input;
  if (!filesChanged.length) return 'passed';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Lint check all changed files
    const lintResult = await executeLintCheck({ paths: filesChanged }, projectRoot, onEvent);
    const hasLintErrors = lintResult.errors.some((e: LintError) => e.severity === 'error');

    // Run test suite
    let testPassed = true;
    try {
      const res = await fetch(`${baseUrl}/api/code-space/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: stack.testCommand, cwd: projectRoot }),
      });
      const data = await res.json() as { exitCode: number; stdout: string };
      testPassed = data.exitCode === 0;
      if (data.stdout) onEvent({ type: 'terminal_chunk', chunk: data.stdout });
    } catch { testPassed = false; }

    if (!hasLintErrors && testPassed) return 'passed';

    if (attempt < maxAttempts - 1) {
      // Give agent a self-correction turn
      const fixMessages: AgentMessage[] = [
        {
          role: 'user',
          content: `Verification failed on attempt ${attempt + 1}. Lint errors: ${JSON.stringify(lintResult.errors)}. Please fix the issues.`,
        },
      ];
      await runAgentLoop({
        ...input,
        messages: fixMessages,
        toolBudget: 10,
        enableThinking: false,
      });
    }
  }

  return 'needs_review';
}
```

- [ ] **Step 6: Run loop tests**

```bash
npx vitest run lib/code-space/agent/__tests__/loop.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 7: Run all agent tests**

```bash
npx vitest run lib/code-space/agent
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/code-space/agent/prompt.ts lib/code-space/agent/loop.ts lib/code-space/agent/verification.ts lib/code-space/agent/__tests__/loop.test.ts
git commit -m "feat(code-space/agent): add loop controller, system prompt, and verification"
```

---

## Task 9: API routes — `/api/code-space/agent`

**Files:**
- Create: `app/api/code-space/agent/route.ts`
- Create: `app/api/code-space/agent/diff-decision/route.ts`

- [ ] **Step 1: Create `app/api/code-space/agent/route.ts`**

```ts
// app/api/code-space/agent/route.ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import { buildContext, detectStackFromDisk } from '@/lib/code-space/agent/context';
import { buildSystemPrompt } from '@/lib/code-space/agent/prompt';
import { runAgentLoop } from '@/lib/code-space/agent/loop';
import { runVerification } from '@/lib/code-space/agent/verification';
import { TOOL_DEFINITIONS } from '@/lib/code-space/agent/tools';
import { rejectAllForSession } from '@/lib/code-space/agent/registry';

const BodySchema = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  projectName: z.string(),
  prompt: z.string().min(1),
  model: z.string(),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry']),
  apiKey: z.string(),
  endpoint: z.string().optional(),
  openTabs: z.array(z.string()).default([]),
  toolBudget: z.number().default(50),
  enableThinking: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const {
    sessionId, projectRoot, projectName, prompt, model, providerId,
    apiKey, endpoint, openTabs, toolBudget, enableThinking,
  } = body.data;

  const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function onEvent(e: AgentSSEEvent) {
        const data = `data: ${JSON.stringify(e)}\n\n`;
        try { controller.enqueue(encoder.encode(data)); } catch { /* client disconnected */ }
      }

      try {
        // Build context
        const { systemContextBlock } = await buildContext(projectRoot, prompt, openTabs, baseUrl);
        const stack = detectStackFromDisk(projectRoot);
        const systemPrompt = buildSystemPrompt(projectName, stack, systemContextBlock);

        // Run the agent loop
        const result = await runAgentLoop({
          sessionId, projectRoot, baseUrl, model, providerId, apiKey, endpoint,
          systemPrompt,
          tools: TOOL_DEFINITIONS,
          toolBudget,
          enableThinking,
          messages: [{ role: 'user', content: prompt }],
          onEvent,
          signal: req.signal,
        });

        // Verification pass
        if (result.filesChanged.length > 0) {
          const status = await runVerification({
            sessionId, projectRoot, baseUrl, model, providerId, apiKey,
            tools: TOOL_DEFINITIONS,
            systemPrompt,
            stack,
            filesChanged: result.filesChanged,
            onEvent,
          });
          onEvent({ type: 'agent_done', summary: result.summary + (status === 'needs_review' ? '\n\n⚠️ Verification did not fully pass — check the Problems tab.' : ''), filesChanged: result.filesChanged });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'agent_error', message: msg, recoverable: false });
      } finally {
        controller.close();
      }
    },
    cancel() {
      rejectAllForSession(sessionId);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 2: Create `app/api/code-space/agent/diff-decision/route.ts`**

```ts
// app/api/code-space/agent/diff-decision/route.ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveDiff } from '@/lib/code-space/agent/registry';

const BodySchema = z.object({
  diffId: z.string(),
  accepted: z.boolean(),
});

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const resolved = resolveDiff(body.data.diffId, body.data.accepted);
  if (!resolved) return Response.json({ error: 'No pending diff with that ID' }, { status: 404 });

  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Smoke test the route with curl (dev server must be running)**

```bash
# In a separate terminal: npm run dev
curl -s -X POST http://localhost:3000/api/code-space/agent/diff-decision \
  -H 'Content-Type: application/json' \
  -d '{"diffId":"nonexistent","accepted":true}'
# Expected: {"error":"No pending diff with that ID"}
```

- [ ] **Step 5: Commit**

```bash
git add app/api/code-space/agent/route.ts app/api/code-space/agent/diff-decision/route.ts
git commit -m "feat(code-space/agent): add SSE agent route + diff-decision endpoint"
```

---

## Task 10: `components/code-space/AgentPanel.tsx`

**Files:**
- Create: `components/code-space/AgentPanel.tsx`

- [ ] **Step 1: Create `AgentPanel.tsx`**

```tsx
// components/code-space/AgentPanel.tsx
'use client';
import { useRef, useEffect, useState } from 'react';
import { Bot, Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight, Zap } from 'lucide-react';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

interface ToolCallEntry {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
  output?: unknown;
  error?: string;
  durationMs?: number;
}

interface AgentPanelProps {
  sessionId: string | null;
  events: AgentSSEEvent[];
  isRunning: boolean;
  toolBudget: number;
  toolCallCount: number;
  model: string;
  availableModels: Array<{ id: string; label: string; providerId: string }>;
  onModelChange: (modelId: string, providerId: string) => void;
  onSubmitPrompt: (prompt: string) => void;
  onCancelRun: () => void;
}

export function AgentPanel({
  sessionId, events, isRunning, toolBudget, toolCallCount,
  model, availableModels, onModelChange, onSubmitPrompt, onCancelRun,
}: AgentPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Derive state from events
  const chatMessages: Array<{ type: 'user' | 'agent'; text: string }> = [];
  const toolCalls: ToolCallEntry[] = [];

  for (const e of events) {
    if (e.type === 'text_delta') {
      const last = chatMessages[chatMessages.length - 1];
      if (last?.type === 'agent') last.text += e.delta;
      else chatMessages.push({ type: 'agent', text: e.delta });
    } else if (e.type === 'tool_start') {
      toolCalls.push({ id: e.toolCallId, name: e.tool, input: e.input, status: 'running' });
    } else if (e.type === 'tool_result') {
      const tc = toolCalls.find((t) => t.id === e.toolCallId);
      if (tc) { tc.status = e.error ? 'error' : 'done'; tc.output = e.output; tc.error = e.error; tc.durationMs = e.durationMs; }
    } else if (e.type === 'agent_done') {
      chatMessages.push({ type: 'agent', text: `✓ ${e.summary}` });
    } else if (e.type === 'agent_error') {
      chatMessages.push({ type: 'agent', text: `⚠ ${e.message}` });
    }
  }

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [events]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isRunning) return;
    onSubmitPrompt(prompt.trim());
    setPrompt('');
  };

  const budgetPct = toolBudget > 0 ? Math.min((toolCallCount / toolBudget) * 100, 100) : 0;

  return (
    <div className="flex flex-col h-full bg-[#0d1117] text-[#e6edf3] text-xs font-mono border-l border-[#30363d]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#30363d] flex-shrink-0">
        <Bot size={14} className="text-[#58a6ff]" />
        <span className="text-[#8b949e] uppercase tracking-wider text-[10px]">Agent</span>
        <select
          value={model}
          onChange={(e) => {
            const m = availableModels.find((x) => x.id === e.target.value);
            if (m) onModelChange(m.id, m.providerId);
          }}
          className="ml-auto bg-[#161b22] border border-[#30363d] rounded px-1 py-0.5 text-[10px] text-[#8b949e] focus:outline-none"
        >
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Chat pane — top 60% */}
      <div className="flex-[3] overflow-y-auto p-2 space-y-2 min-h-0">
        {chatMessages.length === 0 && (
          <p className="text-[#6e7681] text-center mt-8">Describe a task to get started</p>
        )}
        {chatMessages.map((m, i) => (
          <div key={i} className={`rounded px-2 py-1 ${m.type === 'user' ? 'bg-[#1f6feb33] text-[#e6edf3]' : 'text-[#e6edf3]'}`}>
            {m.type === 'agent' && <span className="text-[#58a6ff] mr-1">🤖</span>}
            <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
          </div>
        ))}
        {isRunning && <Loader2 size={12} className="animate-spin text-[#8b949e] ml-1" />}
        <div ref={chatEndRef} />
      </div>

      {/* Divider */}
      <div className="border-t border-[#30363d] flex-shrink-0" />

      {/* Tool pane — bottom 40% */}
      <div className="flex-[2] overflow-y-auto p-2 min-h-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[#8b949e] uppercase tracking-wider text-[10px]">Tools</span>
          <span className="text-[#6e7681] text-[10px]">{toolCallCount}/{toolBudget}</span>
        </div>
        {/* Budget bar */}
        <div className="bg-[#21262d] rounded h-[3px] mb-2">
          <div className="bg-[#1f6feb] h-[3px] rounded transition-all" style={{ width: `${budgetPct}%` }} />
        </div>
        {toolCalls.length === 0 && <p className="text-[#6e7681] text-[10px]">No tool calls yet</p>}
        {toolCalls.map((tc) => (
          <div key={tc.id} className="mb-1">
            <button
              className="flex items-center gap-1 w-full text-left hover:bg-[#161b22] px-1 rounded"
              onClick={() => setExpandedTools((prev) => {
                const next = new Set(prev);
                next.has(tc.id) ? next.delete(tc.id) : next.add(tc.id);
                return next;
              })}
            >
              {tc.status === 'running' ? <Loader2 size={10} className="animate-spin text-[#f0883e]" /> :
               tc.status === 'done' ? <CheckCircle2 size={10} className="text-[#3fb950]" /> :
               <XCircle size={10} className="text-[#f85149]" />}
              <span className={tc.status === 'done' ? 'text-[#8b949e]' : tc.status === 'error' ? 'text-[#f85149]' : 'text-[#e6edf3]'}>
                {tc.name}
              </span>
              {tc.durationMs && <span className="text-[#6e7681] ml-auto">{tc.durationMs}ms</span>}
              {expandedTools.has(tc.id) ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
            </button>
            {expandedTools.has(tc.id) && (
              <div className="ml-4 mt-1 bg-[#161b22] rounded p-1 text-[#8b949e] text-[9px] overflow-x-auto">
                <div>Input: {JSON.stringify(tc.input, null, 1).slice(0, 200)}</div>
                {tc.output && <div>Output: {JSON.stringify(tc.output, null, 1).slice(0, 200)}</div>}
                {tc.error && <div className="text-[#f85149]">Error: {tc.error}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input bar */}
      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-[#30363d] p-2 flex gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe a task..."
          className="flex-1 bg-[#161b22] border border-[#30363d] rounded px-2 py-1 text-[11px] text-[#e6edf3] focus:outline-none focus:border-[#58a6ff] placeholder:text-[#6e7681]"
          disabled={isRunning}
        />
        {isRunning ? (
          <button type="button" onClick={onCancelRun} className="px-2 py-1 bg-[#b91c1c] text-white rounded text-[10px]">Stop</button>
        ) : (
          <button type="submit" disabled={!prompt.trim()} className="px-2 py-1 bg-[#1f6feb] text-white rounded text-[10px] disabled:opacity-40">
            <Zap size={10} />
          </button>
        )}
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/code-space/AgentPanel.tsx
git commit -m "feat(code-space): add AgentPanel component (split Chat + Tool pane)"
```

---

## Task 11: `components/code-space/DiffOverlay.tsx`

**Files:**
- Create: `components/code-space/DiffOverlay.tsx`

- [ ] **Step 1: Create `DiffOverlay.tsx`**

```tsx
// components/code-space/DiffOverlay.tsx
'use client';
import { DiffEditor } from '@monaco-editor/react';

interface PendingDiff {
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
}

interface DiffOverlayProps {
  diffs: PendingDiff[];      // queue of pending diffs
  currentIndex: number;      // which diff is active
  onAccept: (diffId: string) => void;
  onReject: (diffId: string) => void;
  onAcceptAll: () => void;
  language: string;
  theme: 'vs-dark' | 'light';
}

export function DiffOverlay({ diffs, currentIndex, onAccept, onReject, onAcceptAll, language, theme }: DiffOverlayProps) {
  const current = diffs[currentIndex];
  if (!current) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Accept/Reject bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] text-xs flex-shrink-0">
        <span className="text-[#f0883e] font-mono">{current.filePath}</span>
        <span className="text-[#6e7681] ml-1 mr-auto">{currentIndex + 1} of {diffs.length} file{diffs.length > 1 ? 's' : ''}</span>
        <button
          onClick={() => onReject(current.diffId)}
          className="px-3 py-0.5 bg-[#b91c1c] text-white rounded text-[10px] font-semibold hover:bg-red-700"
        >
          ✗ Reject
        </button>
        <button
          onClick={() => onAccept(current.diffId)}
          className="px-3 py-0.5 bg-[#1a7f37] text-white rounded text-[10px] font-semibold hover:bg-green-700"
        >
          ✓ Accept
        </button>
        {diffs.length > 1 && (
          <button
            onClick={onAcceptAll}
            className="px-3 py-0.5 bg-[#21262d] text-[#e6edf3] rounded text-[10px] hover:bg-[#30363d]"
          >
            Accept All ({diffs.length})
          </button>
        )}
      </div>

      {/* Monaco DiffEditor (inline mode) */}
      <div className="flex-1 min-h-0">
        <DiffEditor
          original={current.oldContent}
          modified={current.newContent}
          language={language}
          theme={theme}
          options={{
            renderSideBySide: false,
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            folding: false,
          }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/code-space/DiffOverlay.tsx
git commit -m "feat(code-space): add DiffOverlay component with Monaco inline diff"
```

---

## Task 12: Update `BottomPanel.tsx` for streaming terminal

**Files:**
- Modify: `components/code-space/BottomPanel.tsx`
- Modify: `lib/code-space/core.ts`

- [ ] **Step 1: Add `terminalStream` to `CodeSpaceBottomTab` type and BottomPanel props**

In `lib/code-space/core.ts`, find the `CodeSpaceBottomTab` type and verify it already covers `'terminal'`. If `BottomPanelProps` doesn't include `terminalStream`, add it.

In `components/code-space/BottomPanel.tsx`, add to the `BottomPanelProps` interface:
```ts
  /** Live chunks from the agent's run_terminal tool — appended in real time */
  terminalStream: string;
```

- [ ] **Step 2: In BottomPanel, combine static terminal history with the live stream**

Find where the terminal tab renders terminal history and append the stream. Locate the JSX that renders `TerminalEntry` items and after the last entry add:

```tsx
{terminalStream && (
  <pre className="text-[#3fb950] text-[11px] font-mono whitespace-pre-wrap mt-1">
    {terminalStream}
  </pre>
)}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/code-space/BottomPanel.tsx lib/code-space/core.ts
git commit -m "feat(code-space): add terminalStream prop to BottomPanel for live agent output"
```

---

## Task 13: Wire up `CodeSpaceWorkspace.tsx`

**Files:**
- Modify: `components/code-space/CodeSpaceWorkspace.tsx`

This is the integration task — it adds the SSE listener, agent panel, diff overlay, and provider state to the existing workspace component.

- [ ] **Step 1: Add new state variables**

At the top of the `CodeSpaceWorkspace` component function, add:

```ts
// Agent state
const [agentEvents, setAgentEvents] = useState<AgentSSEEvent[]>([]);
const [agentRunning, setAgentRunning] = useState(false);
const [pendingDiffs, setPendingDiffs] = useState<PendingDiff[]>([]);
const [currentDiffIndex, setCurrentDiffIndex] = useState(0);
const [terminalStream, setTerminalStream] = useState('');
const [toolCallCount, setToolCallCount] = useState(0);
const agentAbortRef = useRef<AbortController | null>(null);
const [agentChangesets, setAgentChangesets] = useState<Array<{
  filePath: string; beforeContent: string; afterContent: string; acceptedAt: number;
}>>([]);

// Provider/model picker state  
const [agentModel, setAgentModel] = useState('claude-sonnet-4-6');
const [agentProviderId, setAgentProviderId] = useState<'anthropic'|'openai'|'gemini'|'grok'|'foundry'>('anthropic');
```

- [ ] **Step 2: Add imports at top of file**

```ts
import { AgentPanel } from '@/components/code-space/AgentPanel';
import { DiffOverlay } from '@/components/code-space/DiffOverlay';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

interface PendingDiff {
  diffId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
}
```

- [ ] **Step 3: Add `handleRunAgent` function**

```ts
const handleRunAgent = useCallback(async (userPrompt: string) => {
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project || !project.rootPath) return;

  const abortCtrl = new AbortController();
  agentAbortRef.current = abortCtrl;
  setAgentRunning(true);
  setAgentEvents([{ type: 'text_delta', delta: '' }]); // reset
  setTerminalStream('');
  setToolCallCount(0);

  const openTabs = tabs.map((t) => t.path ?? '').filter(Boolean);

  const response = await fetch('/api/code-space/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: activeSessionId ?? `sess-${Date.now()}`,
      projectRoot: project.rootPath,
      projectName: project.name,
      prompt: userPrompt,
      model: agentModel,
      providerId: agentProviderId,
      apiKey: getApiKey(agentProviderId), // reads from existing provider config store
      openTabs,
      toolBudget: 50,
      enableThinking: agentProviderId === 'anthropic',
    }),
    signal: abortCtrl.signal,
  });

  if (!response.body) { setAgentRunning(false); return; }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event: AgentSSEEvent = JSON.parse(line.slice(6));
        setAgentEvents((prev) => [...prev, event]);
        if (event.type === 'diff_proposed') {
          setPendingDiffs((prev) => [...prev, {
            diffId: event.diffId,
            filePath: event.filePath,
            oldContent: event.oldContent,
            newContent: event.newContent,
          }]);
        }
        if (event.type === 'terminal_chunk') {
          setTerminalStream((prev) => prev + event.chunk);
        }
        if (event.type === 'tool_start') {
          setToolCallCount((prev) => prev + 1);
        }
      } catch { /* skip malformed */ }
    }
  }

  setAgentRunning(false);
  agentAbortRef.current = null;
}, [activeProjectId, activeSessionId, agentModel, agentProviderId, projects, tabs]);
```

- [ ] **Step 4: Add diff accept/reject handlers + undo**

```ts
const handleAcceptDiff = useCallback(async (diffId: string) => {
  const diff = pendingDiffs.find((d) => d.diffId === diffId);
  await fetch('/api/code-space/agent/diff-decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diffId, accepted: true }),
  });
  if (diff) {
    // Record changeset for undo
    setAgentChangesets((prev) => [...prev, {
      filePath: diff.filePath,
      beforeContent: diff.oldContent,
      afterContent: diff.newContent,
      acceptedAt: Date.now(),
    }]);
    reloadFileInEditor(diff.filePath);
  }
  setPendingDiffs((prev) => {
    const remaining = prev.filter((d) => d.diffId !== diffId);
    setCurrentDiffIndex(0);
    return remaining;
  });
}, [pendingDiffs]);

/** Revert all accepted agent edits for the current session in reverse order */
const handleUndoAllAgentEdits = useCallback(async () => {
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project?.rootPath) return;
  for (const cs of [...agentChangesets].reverse()) {
    await fetch('/api/code-space/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'write',
        path: `${project.rootPath}/${cs.filePath}`,
        content: cs.beforeContent,
      }),
    });
    reloadFileInEditor(cs.filePath);
  }
  setAgentChangesets([]);
}, [agentChangesets, activeProjectId, projects]);

const handleRejectDiff = useCallback(async (diffId: string) => {
  await fetch('/api/code-space/agent/diff-decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diffId, accepted: false }),
  });
  setPendingDiffs((prev) => {
    const remaining = prev.filter((d) => d.diffId !== diffId);
    setCurrentDiffIndex(0);
    return remaining;
  });
}, []);

const handleAcceptAllDiffs = useCallback(async () => {
  for (const diff of pendingDiffs) {
    await handleAcceptDiff(diff.diffId);
  }
}, [pendingDiffs, handleAcceptDiff]);

const handleCancelRun = useCallback(() => {
  agentAbortRef.current?.abort();
  setAgentRunning(false);
}, []);
```

- [ ] **Step 5: Add `getApiKey` helper**

```ts
// Add near top of component, after existing provider config reading
function getApiKey(providerId: string): string {
  // Read from the existing provider config store (same store used by diagram mode)
  try {
    const stored = localStorage.getItem(`provider_config_${providerId}`);
    if (stored) return (JSON.parse(stored) as { apiKey?: string }).apiKey ?? '';
  } catch { /* ignore */ }
  return '';
}
```

- [ ] **Step 6: In the JSX, replace the existing right sidebar (sessions list) with AgentPanel**

Find the right sidebar section in the JSX (look for where `activeSession` or sessions are listed in the sidebar). Replace or extend it with:

```tsx
{/* Right: Agent Panel */}
<div className="w-[220px] flex-shrink-0 h-full overflow-hidden">
  <AgentPanel
    sessionId={activeSessionId}
    events={agentEvents}
    isRunning={agentRunning}
    toolBudget={50}
    toolCallCount={toolCallCount}
    model={agentModel}
    availableModels={[
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', providerId: 'anthropic' },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', providerId: 'anthropic' },
      { id: 'gpt-4o', label: 'GPT-4o', providerId: 'openai' },
      { id: 'gemini-2.0-pro', label: 'Gemini 2.0 Pro', providerId: 'gemini' },
    ]}
    onModelChange={(id, pid) => { setAgentModel(id); setAgentProviderId(pid as typeof agentProviderId); }}
    onSubmitPrompt={handleRunAgent}
    onCancelRun={handleCancelRun}
  />
  {agentChangesets.length > 0 && !agentRunning && (
    <button
      onClick={handleUndoAllAgentEdits}
      className="w-full text-[10px] text-[#8b949e] hover:text-[#f85149] border-t border-[#30363d] px-3 py-1.5 text-left"
    >
      ↩ Undo all agent edits ({agentChangesets.length} file{agentChangesets.length > 1 ? 's' : ''})
    </button>
  )}
</div>
```

- [ ] **Step 7: In the Monaco editor section, show DiffOverlay when pendingDiffs is non-empty**

Find the Monaco `<Editor>` render section and wrap it:

```tsx
{pendingDiffs.length > 0 ? (
  <DiffOverlay
    diffs={pendingDiffs}
    currentIndex={currentDiffIndex}
    onAccept={handleAcceptDiff}
    onReject={handleRejectDiff}
    onAcceptAll={handleAcceptAllDiffs}
    language={activeTab?.language ?? 'typescript'}
    theme="vs-dark"
  />
) : (
  <Editor {/* existing editor props */} />
)}
```

- [ ] **Step 8: Pass `terminalStream` to BottomPanel**

Find the `<BottomPanel` usage and add:
```tsx
terminalStream={terminalStream}
```

- [ ] **Step 9: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors. Fix any type mismatches (e.g. if existing session types don't match new ones).

- [ ] **Step 10: Run all tests**

```bash
npm run test
```
Expected: all existing tests pass, new agent tests pass.

- [ ] **Step 11: Commit**

```bash
git add components/code-space/CodeSpaceWorkspace.tsx
git commit -m "feat(code-space): wire up agent panel, SSE listener, and diff overlay in workspace"
```

---

## Task 14: End-to-end smoke test

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```
Expected: server starts on http://localhost:3000.

- [ ] **Step 2: Open Code Space and verify agent panel renders**

Navigate to http://localhost:3000, switch to Code Space mode. Verify:
- Right sidebar shows the Agent panel with Chat + Tool panes
- Model picker dropdown is visible
- "Describe a task..." input is present

- [ ] **Step 3: Submit a simple prompt with a real project open**

With a local project loaded:
1. Type: `What files are in this project?`
2. Hit Enter / click the run button
3. Verify: SSE stream starts, `list_directory` or `read_file` tool call appears in the Tool pane, agent text streams into the Chat pane

- [ ] **Step 4: Test diff flow**

Type: `Add a comment to the first file in the project`

Verify:
- Agent calls `read_file` (visible in Tool pane) 
- Agent calls `write_file` → DiffOverlay appears in the editor
- Accept/Reject bar is visible with file name
- Clicking Accept removes the overlay and reloads the file

- [ ] **Step 5: Run typecheck + tests one final time**

```bash
npm run typecheck && npm run test
```
Expected: all pass.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(code-space): complete agent loop implementation — autonomous coding agent with diff review"
```
