# Code Space UX Improvements — Design Spec

**Date:** 2026-05-27  
**Branch:** codex/agent-mode-dropdown  
**Status:** Approved — ready for implementation

---

## Overview

Three independent UX improvements to the Code Space (and related pages):

1. **Session auto-naming** — when a user submits their first message, automatically generate a meaningful 2–4 word session title in the background using the active LLM provider, falling back to rule-based extraction.
2. **Dropdown relocation** — move the Code/Ask/Plan agent mode selector from its current flat position in the nav row to the right side of the bottom bar, directly below the submit button.
3. **Local Model provider** — add a "Local Model" option to the AI provider selector on all four pages (Code Space, Single Layer/App Planner, Multi Layer), with a full OpenAI-compatible config form that auto-saves to browser storage.

---

## Feature 1 — Session Auto-Naming

### Goal
Sessions currently default to "New coding session". After the user's first submit, the title should update to a meaningful 2–4 word summary (e.g. "Frontend Chatbox Design", "Fix Auth Bug").

### Trigger condition
Only fires when **all** of the following are true:
- `session.messages.length === 0` (first submit)
- `session.title === 'New coding session'` (title has not been manually set)

This ensures the rename never fires on subsequent messages and never overwrites a user-set title.

### New endpoint: `POST /api/code-space/name-session`

**Request body:**
```ts
{
  query: string        // first 100 chars of the user's message
  providerId: string   // active provider id
  model: string
  apiKey?: string
  endpoint?: string    // for foundry / local providers
  mode: 'code-space' | 'app-planner'  // controls word limit
}
```

**Response:**
```ts
{ name: string }  // 2–4 words for code-space, 1–2 words for app-planner
```

**LLM prompt (tight, low-cost):**
```
You are a session title generator.
Given a task description, return ONLY a title of up to {maxWords} words.
No punctuation. No quotes. Title case.
Examples: "Frontend Chatbox Design", "Fix Auth Bug", "API Rate Limiter"

Task: {query}
```

Where `maxWords` is `4` for `code-space` mode and `2` for `app-planner` mode.

### Timing
The naming call fires **in parallel** with the main agent run (fire-and-forget). No `await` — the agent run starts immediately. When the naming call resolves (~1 s), the client calls `updateSession(id, { title: name })` and the sidebar title updates live.

### Fallback
If the LLM call fails (network error, missing API key, timeout), the client falls back to `extractFallbackName(query)`: a local utility that strips stop words and returns the first 2–4 meaningful words. The session title still updates silently — the user never sees an error.

### Integration points

**`CodeSpaceWorkspace.tsx` — `handleSubmit()`:**
```ts
const isFirstMessage = session.messages.length === 0
if (isFirstMessage && session.title === 'New coding session') {
  nameSessionAsync(session.id, prompt.slice(0, 100))  // fire-and-forget
}
```

**New utility — `lib/code-space/sessionNaming.ts`:**
- `nameSessionAsync(sessionId, query)` — fires POST, updates session on success, calls fallback on error
- `extractFallbackName(query)` — rule-based extraction (strips stop words, returns first 2–4 nouns/verbs)

### App Planner integration
When `CustomPromptPanel` calls `addGeneratedProject(name, ...)`, the `name` argument is currently a static string. New flow:

1. When the user clicks "Generate diagram →", fire `POST /api/code-space/name-session` with `mode: 'app-planner'`
2. Await the response (or fallback) before calling `addGeneratedProject()`
3. Pass the 2-word AI-generated name as the project name
4. Fallback: first 2 words of the original prompt

---

## Feature 2 — Dropdown Relocation

### Goal
Move the `AgentModeSelector` (Code/Ask/Plan dropdown) from the flat nav row at the bottom of `AgentPanel` to the right side of that row, visually grouped below the submit button.

### Change
Single JSX edit in `components/code-space/AgentPanel.tsx`.

**Before:**
```jsx
<div className="mt-2 flex items-center gap-3 px-1 text-[10px]">
  <button onClick={onGenerateDiagram}>Generate Diagram</button>
  <button onClick={onOpenAppPlanner}>App Planner</button>
  <div>
    <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
  </div>
</div>
```

**After:**
```jsx
<div className="mt-1 flex items-center justify-between px-0.5">
  <div className="flex items-center gap-3 text-[10px]">
    <button onClick={onGenerateDiagram}>Generate Diagram</button>
    <button onClick={onOpenAppPlanner}>App Planner</button>
  </div>
  <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
</div>
```

The `AgentModeSelector` dropdown itself opens upward (`bottom-7 right-0`) so it will not be clipped by the panel edge — no changes needed to the selector component itself.

---

## Feature 3 — Local Model Provider

### Goal
Add a "Local Model" option to the AI provider selector. Users can configure any OpenAI-compatible inference server (Ollama, LM Studio, llama.cpp, Jan, etc.) with a full config form. Config auto-saves via Zustand persist.

### Type changes — `lib/state/store.ts`

Add `'local'` to `ProviderId`:
```ts
export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'grok' | 'foundry' | 'local'
```

Extend `ProviderConfig`:
```ts
export interface ProviderConfig {
  provider: ProviderId
  model: string
  apiKey: string
  customModel?: string
  endpoint?: string
  // New local model fields
  localBaseUrl?: string        // e.g. "http://localhost:11434/v1"
  localModelName?: string      // e.g. "llama3.2"
  localApiKey?: string         // optional, e.g. "ollama" or blank
  localContextLength?: number  // e.g. 4096
  localTemperature?: number    // e.g. 0.7
}
```

Default values when `provider === 'local'`:
- `localBaseUrl`: `"http://localhost:11434/v1"`
- `localModelName`: `""`
- `localApiKey`: `""`
- `localContextLength`: `4096`
- `localTemperature`: `0.7`

### UI changes — `components/agent/ProviderConfig.tsx`

1. Add `{ id: 'local', label: 'Local Model', envVar: '', note: 'OpenAI-compatible API (Ollama, LM Studio, llama.cpp, Jan)' }` to the `PROVIDERS` array
2. When `provider === 'local'`, hide the standard model dropdown and render the full local config form:
   - **Base URL** — text input, placeholder `http://localhost:11434/v1`
   - **Model Name** — text input, hint `e.g. llama3.2, mistral, codestral, phi3`
   - **API Key** — password input, optional, placeholder `Leave blank if not required`
   - **Context Length** — number input, default `4096`
   - **Temperature** — number input, step `0.1`, range `0–2`, default `0.7`
   - **Test Connection** button — calls `POST /api/local-model/test`, shows ✅/❌ result inline
   - Autosave note: `✓ Config auto-saved to browser storage`
3. All fields onChange write directly to Zustand store (same pattern as the existing API key field)

### New test endpoint — `POST /api/local-model/test`

Attempts a `GET {baseUrl}/models` call (OpenAI models-list endpoint). Returns:
```ts
{ ok: boolean; models?: string[]; error?: string }
```

Used only by the Test Connection button. Not part of the main agent flow.

### Agent route changes — `app/api/code-space/agent/route.ts`

When `providerId === 'local'`, initialise the OpenAI SDK client with a custom base URL:

```ts
if (providerId === 'local') {
  client = new OpenAI({
    baseURL: localBaseUrl,
    apiKey: localApiKey || 'local',  // SDK requires non-empty string
  })
  modelId = localModelName
  // Pass temperature and max_tokens from local config
  completionOptions = {
    ...completionOptions,
    temperature: localTemperature ?? 0.7,
    max_tokens: localContextLength ?? 4096,
  }
}
```

The same pattern must be applied to any other agent routes that accept a `providerId`:
- `app/api/agent/route.ts` (single layer)
- `app/api/agent/multilayer/route.ts` (multi layer — dedicated panel)
- `app/api/agent/custom/route.ts` (app planner single diagram)
- `app/api/agent/custom-multilayer/route.ts` (app planner multi-layer)
- `app/api/agent/clarify/route.ts` (app planner clarifying questions step)

### Persistence
The new `local*` fields are part of `ProviderConfig` which is already stored in Zustand's `persist` middleware. No extra localStorage wiring needed — auto-saved on every field change.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/state/store.ts` | Add `'local'` to `ProviderId`; add 5 local config fields to `ProviderConfig` |
| `components/agent/ProviderConfig.tsx` | Add Local Model to provider list; render local config form |
| `components/code-space/AgentPanel.tsx` | Restructure bottom row — `justify-between` with mode selector right-aligned |
| `components/agent/CustomPromptPanel.tsx` | Fire naming call before `addGeneratedProject()` |
| `components/code-space/CodeSpaceWorkspace.tsx` | Add `nameSessionAsync` call in `handleSubmit()` |
| `lib/code-space/sessionNaming.ts` | **New** — `nameSessionAsync()` + `extractFallbackName()` |
| `app/api/code-space/name-session/route.ts` | **New** — LLM naming endpoint |
| `app/api/local-model/test/route.ts` | **New** — Test Connection endpoint |
| `app/api/code-space/agent/route.ts` | Handle `providerId === 'local'` |
| `app/api/agent/route.ts` | Handle `providerId === 'local'` |
| `app/api/agent/multilayer/route.ts` | Handle `providerId === 'local'` |
| `app/api/agent/custom/route.ts` | Handle `providerId === 'local'` |
| `app/api/agent/custom-multilayer/route.ts` | Handle `providerId === 'local'` |
| `app/api/agent/clarify/route.ts` | Handle `providerId === 'local'` |

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Naming call fails (no key, timeout) | Silent fallback to rule-based extraction; session still gets a title |
| User cancels agent run before naming resolves | Naming call completes independently; title updates even after cancel |
| Local model base URL unreachable | Agent route returns 502 with `{ error: "Local model unreachable: {url}" }` |
| Local model name is blank | Validation in `ProviderConfig.tsx` — submit disabled, inline error shown |
| Test Connection fails | Inline error message below the button; does not block saving |

---

## Out of Scope

- Streaming support for local models (will work if the local server supports it, but not explicitly tested)
- Per-session provider overrides (all sessions in a project share the global provider config)
- Session name editing after auto-rename (already supported via existing rename UI in `SessionListSection`)
