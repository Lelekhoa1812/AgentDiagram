# Code Space Agent — Design Spec
**Date:** 2026-05-26  
**Status:** Approved  
**Goal:** Elevate the Code Space agent capability to match production coding agent tools (Cursor, Claude Code, Codex) — fully autonomous agentic loop with inline diff review, multi-provider support, and self-correcting verification.

---

## 1. Overview

Code Space currently has intent classification but no actual LLM execution. This spec defines the complete agent layer: a multi-turn agentic loop built on top of the existing provider infrastructure (`/lib/agent/providers/`), with six tools, inline Monaco diffs, a split Chat + Tool panel UI, and a self-correction verification loop.

**Core user flow:**
1. User opens Code Space, selects a project, selects a provider/model
2. User types a task (e.g. "Add theme-aware variant prop to Button")
3. Agent runs autonomously: reads files → searches codebase → plans → writes changes → lints → tests
4. Each file write surfaces an inline diff in Monaco — user accepts or rejects per file
5. After all diffs accepted, agent runs lint + tests and self-corrects up to 3× if needed
6. Session marked `verified ✓` when lint and tests pass

---

## 2. Architecture

**Approach:** Extend the existing agent pipeline (Approach 1). Reuse `/lib/agent/providers/` for LLM calls, retry logic, exponential backoff, and streaming. Add a new Code Space-specific agent route and tool registry on top.

### 2.1 New Files

```
/app/api/code-space/agent/route.ts       — Multi-turn agent loop, SSE streaming
/lib/code-space/agent/
  loop.ts                                — Core agentic loop controller
  tools.ts                               — Tool registry (6 tools, Zod schemas)
  context.ts                             — Context builder (repo tree, relevant files, stack detection)
  prompt.ts                              — System prompt templates + few-shot examples
  providers.ts                           — callWithTools() wrapper (normalises Anthropic/OpenAI tool formats)
  diff.ts                                — Diff computation (old content → new content → unified diff)
  verification.ts                        — Lint + test runner, error parser, self-correction trigger
```

### 2.2 Modified Files

```
/components/code-space/CodeSpaceWorkspace.tsx   — Add agent panel (split Chat+Tools), SSE listener, diff state
/components/code-space/AgentPanel.tsx           — New: split Chat pane + Tool pane component
/components/code-space/DiffOverlay.tsx          — New: inline Monaco diff + Accept/Reject bar
/components/code-space/BottomPanel.tsx          — Add terminal_chunk streaming support
/lib/code-space/core.ts                         — Extend CodeSpaceAgentSession (tool budget, verified status)
```

### 2.3 Agent Loop (loop.ts)

```
function runAgentLoop(session, tools, context, onEvent):
  messages = [systemPrompt(context), ...session.messages]
  
  while toolCallCount < MAX_TOOL_CALLS:
    response = await callWithTools(messages, tools)   // streaming, emits text_delta events
    
    if response.toolCalls.length === 0:
      emit agent_done
      break
    
    // Execute tool calls (parallel where safe)
    results = await Promise.all(response.toolCalls.map(executeToolCall))
    
    for each result:
      emit tool_result event
      if result.tool === 'write_file':
        emit diff_proposed event  // pauses loop, waits for user accept/reject
        await waitForDiffDecision(result.filePath)
      if result.tool === 'run_terminal':
        stream terminal_chunk events live
    
    messages = [...messages, response, ...results]
    toolCallCount += response.toolCalls.length
  
  // Verification pass
  await runVerification(session, onEvent)
```

**Diff pause mechanism:** When `write_file` is called, the loop emits a `diff_proposed` event and suspends via a `Promise` that resolves only when the UI sends an `accept` or `reject` signal back through a per-session callback registry (a `Map<sessionId, (accepted: boolean) => void>` held in module scope on the server). The UI calls `POST /api/code-space/agent/diff-decision` with `{ sessionId, filePath, accepted }` to resolve the callback. Rejected diffs emit a `tool_result` with `{ accepted: false }` so the agent can try an alternative approach.

---

## 3. Tool Registry

Each tool has a Zod input schema, an executor function, and emits typed SSE events.

### 3.1 read_file
```ts
input:  { path: string, startLine?: number, endLine?: number }
output: { content: string, lineCount: number, language: string, truncated: boolean }
```
- Reads via existing `/api/code-space/files` route (reuse, no duplication)
- Auto-truncates to 8 000 tokens; appends `[truncated — use startLine/endLine to read sections]`
- Returns language from existing extension map in `core.ts`

### 3.2 write_file
```ts
input:  { path: string, content: string, reason: string }
output: { accepted: boolean, path: string }
```
- Does NOT write to disk directly — emits `diff_proposed` and suspends
- UI handles Accept → calls existing `/api/code-space/files` write with hash guard
- Reject → returns `{ accepted: false }` back to agent loop
- Stores changeset in `session.changesets[]` (before/after content, timestamp, accepted flag)

### 3.3 search_code
```ts
input:  { query: string, fileGlob?: string, contextLines?: number }
output: { matches: Array<{ file, line, matchLine, context: string[] }> }
```
- Uses `rg` (ripgrep) if available (`which rg`), falls back to Node `glob + fs.readFile + RegExp`
- `contextLines` default 3 — automatically expands to enclosing function boundary using brace-depth counter
- Results capped at 50 matches, truncated with count

### 3.4 run_terminal
```ts
input:  { command: string, cwd?: string }
output: { exitCode: number, stdout: string, stderr: string, durationMs: number }
```
- Reuses `/api/code-space/terminal` route
- Streams stdout/stderr as `terminal_chunk` SSE events to BottomPanel terminal tab in real time
- Full output also returned in `tool_result` for agent context
- Same command pattern validation (blocks shell metacharacters)

### 3.5 lint_check
```ts
input:  { paths: string[] }
output: { errors: Array<{ file, line, col, severity, message, rule }>, passed: boolean }
```
- Stack-aware: runs `tsc --noEmit --pretty false` if TypeScript project, `eslint --format json <paths>` if eslint configured
- Parses both JSON outputs into unified `LintError[]`
- Emits `lint_error` SSE events → populates Problems tab in BottomPanel
- Called automatically after every accepted `write_file` (agent doesn't need to call it manually — the loop handles this)

### 3.6 list_directory
```ts
input:  { path: string, depth?: number }
output: { tree: DirectoryEntry[] }
```
- Reuses existing `/api/code-space/files` GET route with `recursive: true`
- Depth default 2, max 4
- Filtered by existing `.gitignore` + safe defaults (node_modules, .git, dist, etc.)

---

## 4. Context Builder (context.ts)

Runs once before the first LLM turn. Builds the `[REPO CONTEXT]` block injected into the system prompt.

### 4.1 Stack Detection
Reads `package.json`, `tsconfig.json`, `Gemfile`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml` to detect:
- Language (TypeScript, JavaScript, Python, Go, Ruby, Rust)
- Framework (Next.js, React, Express, Django, FastAPI, etc.)
- Test runner (vitest confirmed for this project; also detects jest, pytest, go test, etc.) — used by verification loop
- Lint tools (eslint, tsc, ruff, golangci-lint, etc.) — used by lint_check

### 4.2 File Relevance Scoring
Reuses the file relevance classifier from `/lib/agent/planning/pipeline.ts`:
- Score each file by keyword overlap with user prompt
- Boost: open editor tabs (+30%), recently edited files (+20%), files imported by open tabs (+15%)
- Fill context window token-by-token (8k chars ≈ 2k tokens per file average)
- Cap total context at 80 000 tokens (leaves headroom for multi-turn tool results)

### 4.3 Context Block Structure
```
<file_tree>        // gitignore-filtered directory tree, max 500 lines
<git_status>       // branch, changed files, last commit message
<key_files>        // package.json, tsconfig.json, README.md, *.config.* (always included)
<relevant_files>   // top N files by relevance score, token-aware
```

### 4.4 Prompt Caching
The entire context block (system prompt + repo context) is marked with Anthropic's `cache_control: { type: "ephemeral" }`. Since the context block doesn't change within a session, all subsequent turns hit the cache — 60–90% token savings on long multi-turn sessions.

---

## 5. System Prompt Engineering (prompt.ts)

The system prompt is the primary lever for coding quality. Key instructions:

1. **Read before write** — always call `read_file` before `write_file` on a file you haven't read this session
2. **Search before invent** — use `search_code` to find existing patterns, utilities, types before writing new ones
3. **Lint after write** — the loop calls `lint_check` automatically; if errors are returned, fix them before proceeding
4. **Incremental commits** — after each logical unit of work, offer to run `git add` + `git commit` (configurable)
5. **Explain reasoning** — write a brief plan in the chat before starting tool calls; keeps user informed

**Extended thinking (Anthropic only):** On the first LLM turn (planning turn), enable `thinking: { type: "enabled", budget_tokens: 8000 }`. Subsequent turns use standard mode to reduce latency.

**Few-shot examples:** Two compact examples of good tool-use sequences are embedded in the system prompt:
```
Example 1: Simple bug fix
  → read_file → search_code (find usages) → write_file → lint passes → done

Example 2: New feature
  → list_directory → read_file (×3) → search_code → write_file (×2) → run_terminal (test) → done
```

---

## 6. UI Components

### 6.1 Layout
Three-panel layout (unchanged from current):
- **Left:** File Explorer (existing)
- **Center:** Monaco Editor + Diff Overlay
- **Right:** Agent Panel (new — replaces current session list)
- **Bottom:** Terminal / Output / Problems / Debug (extended)

### 6.2 AgentPanel.tsx (new)
Split vertically: Chat pane (top 60%) + Tool pane (bottom 40%).

**Chat pane:**
- Streams `text_delta` events as token-by-token text (same as existing diagram streaming)
- User input box at bottom — submits new messages to the active session
- Message history scrollable, persisted in `session.messages[]`
- Provider/model picker dropdown in pane header

**Tool pane:**
- Live list of tool calls: icon + name + status (○ pending / ⟳ running / ✓ done / ✗ failed)
- Each item expandable to show input/output detail
- Progress bar: `toolCallCount / MAX_TOOL_CALLS`
- Token usage counter (updated per turn from provider response headers)

### 6.3 DiffOverlay.tsx (new)
Rendered inside the Monaco editor when a `diff_proposed` event is received.

- Computes unified diff (old content vs new content) using `diff` npm package (new dependency — add `diff` + `@types/diff` to package.json)
- Renders inline decorations: green background `+` lines, red background `-` lines
- Sticky bar at top of editor: `✓ Accept | ✗ Reject | 1 of N files` + `Accept All` button
- On Accept: writes file via `/api/code-space/files`, updates tab content, marks changeset `accepted`
- On Reject: sends rejection back to agent loop via session channel, changeset marked `rejected`
- `Accept All`: accepts all pending diffs sequentially, triggering lint after each

### 6.4 BottomPanel.tsx (extended)
- **Terminal tab:** Add real-time streaming — `terminal_chunk` SSE events appended to terminal output as they arrive (no more waiting for command completion)
- **Problems tab:** Populated by `lint_error` SSE events — file, line, severity, message, clickable to jump to file

---

## 7. Verification Loop (verification.ts)

Runs automatically after all diffs in a session are accepted.

```
1. Run lint_check on all files changed this session
   → If errors: agent gets one self-correction turn (feeds errors as tool_result)
   → Repeat up to 3×; if still failing after 3×: surface errors in Problems tab, mark session 'needs_review'

2. Run test command (auto-detected from package.json scripts)
   → Stream output to terminal tab
   → If failures: agent gets one self-correction turn
   → Repeat up to 3×; if still failing: surface in Problems tab, mark session 'needs_review'

3. If lint + tests pass: mark session 'verified ✓', show green badge in sessions list
```

---

## 8. Session Lifecycle

```
draft → planning → running → waiting_review → verified | needs_review | done
```

- `waiting_review`: agent has proposed diffs, waiting for user accept/reject
- `verified`: lint + tests pass post-acceptance
- `needs_review`: verification failed after max self-correction attempts
- `done`: user dismissed session

**Undo:** "Undo all agent edits" button reverts all `accepted` changesets in reverse-chronological order using the stored `before` content in `session.changesets[]`.

---

## 9. Provider & Model Configuration

- Provider picker in AgentPanel header: reads from existing provider config store (no duplicate credential storage)
- Default model per provider: `claude-sonnet-4-6` (Anthropic), `gpt-4o` (OpenAI), `gemini-2.0-pro` (Gemini), `grok-2` (Grok)
- Per-session model override: user can pin any model (e.g. `claude-opus-4-7` for hard tasks)
- `MAX_TOOL_CALLS` configurable per session (default 50, shown as progress bar in tool pane)

---

## 10. Performance Summary

| Enhancement | Mechanism |
|---|---|
| Fastest model defaults | claude-sonnet-4-6, gpt-4o, gemini-2.0-pro as defaults |
| Deep planning on turn 1 | Extended thinking (8k budget) on Anthropic, first turn only |
| Cheap multi-turn sessions | Prompt caching on system prompt + repo context block |
| Fast file reads | Parallel tool execution (Promise.all for concurrent read_file calls) |
| No redundant reads | Agent instructed to read before write; context pre-loads relevant files |
| Self-correcting output | Auto lint_check after write + 3× correction loops |
| Code-aware search | AST-context expansion in search_code (function boundary extraction) |
| Reuse existing summaries | File relevance classifier from diagram pipeline (no rebuild) |

---

## 11. Out of Scope (this spec)

- GitHub PR creation / code review workflow
- Multi-agent parallelism (one agent per session)
- Voice input
- Remote execution / cloud sandboxing
- Jupyter notebook support
