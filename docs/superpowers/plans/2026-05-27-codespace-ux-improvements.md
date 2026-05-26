# Code Space UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three independent UX improvements to Code Space — dropdown relocation, local model provider, and session auto-naming.

**Architecture:** Feature 2 (dropdown) is a single JSX edit. Feature 3 (local model) layers a new `LocalModelProvider` onto the existing `makeProvider` factory, extends `ProviderConfig` with local fields, and adds two new API routes. Feature 1 (naming) adds a small client-side utility and a new `POST /api/code-space/name-session` endpoint, wired into the first submit of every session.

**Tech Stack:** Next.js 14 App Router, TypeScript, Zod, Zustand, Vitest, OpenAI SDK (for local model), Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-05-27-codespace-ux-improvements-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `components/code-space/AgentPanel.tsx` | Dropdown placement |
| Modify | `lib/agent/providers/types.ts` | Add `'local'` to ProviderId; add `temperature?` / `maxTokens?` to ProviderConfig |
| **New** | `lib/agent/providers/local.ts` | LocalModelProvider class |
| Modify | `lib/agent/providers/index.ts` | Add local to PROVIDER_ENV + makeProvider + ProviderSession |
| Modify | `lib/state/store.ts` | Add 5 local fields to ProviderConfig |
| Modify | `components/agent/ProviderConfig.tsx` | Local Model radio + full config form |
| **New** | `app/api/local-model/test/route.ts` | Test Connection endpoint |
| Modify | `app/api/code-space/agent/route.ts` | Add `'local'` to z.enum |
| Modify | `app/api/agent/clarify/route.ts` | Add `'local'` to z.enum + temperature/maxTokens |
| Modify | `app/api/agent/custom/route.ts` | Add `'local'` to z.enum + temperature/maxTokens |
| Modify | `app/api/agent/custom-multilayer/route.ts` | Add `'local'` to z.enum + temperature/maxTokens |
| Modify | `app/api/agent/multilayer/route.ts` | Add `'local'` to z.enum + temperature/maxTokens |
| Modify | `components/code-space/CodeSpaceWorkspace.tsx` | Local model fields in fetch + nameSessionAsync call |
| Modify | `components/agent/CustomPromptPanel.tsx` | Local model fields in clarify/generate calls + naming |
| Modify | `components/multilayer/MultiLayerPanel.tsx` | Local model fields in multilayer generate call |
| **New** | `lib/code-space/sessionNaming.ts` | `nameSessionAsync` + `extractFallbackName` |
| **New** | `lib/code-space/__tests__/sessionNaming.test.ts` | Tests for sessionNaming utilities |
| **New** | `app/api/code-space/name-session/route.ts` | LLM naming endpoint |
| Modify | `components/agent/CustomPromptPanel.tsx` | Fire naming before addGeneratedProject |

---

## Task 1 — Move agent mode dropdown below submit button

**Files:**
- Modify: `components/code-space/AgentPanel.tsx`

- [ ] **Step 1.1 — Open the file and find the bottom nav div**

  Open `components/code-space/AgentPanel.tsx`. Find the `<div>` that contains the Generate Diagram button, App Planner button, and `<AgentModeSelector>`. It looks like this:

  ```jsx
  <div className="mt-2 flex items-center gap-3 px-1 text-[10px]">
    <button
      type="button"
      onClick={onGenerateDiagram}
      ...
    >
      Generate Diagram
    </button>
    <button
      type="button"
      onClick={onOpenAppPlanner}
      ...
    >
      App Planner
    </button>
    <div>
      <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
    </div>
  </div>
  ```

- [ ] **Step 1.2 — Replace with justify-between layout**

  Replace the entire div (including all three children) with:

  ```jsx
  <div className="mt-1 flex items-center justify-between px-0.5">
    <div className="flex items-center gap-3 text-[10px]">
      <button
        type="button"
        onClick={onGenerateDiagram}
        disabled={!canGenerateDiagram || isRunning}
        title={canGenerateDiagram ? 'Open the current project in Multi Layer mode' : 'Open a project first'}
        className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff] disabled:cursor-not-allowed disabled:text-[#6e7681] disabled:no-underline"
      >
        Generate Diagram
      </button>
      <button
        type="button"
        onClick={onOpenAppPlanner}
        className="text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]"
      >
        App Planner
      </button>
    </div>
    <AgentModeSelector mode={agentMode} disabled={isRunning} onChange={onAgentModeChange} />
  </div>
  ```

  Note: `AgentModeSelector` is now a direct child (not wrapped in `<div>`), right-aligned by `justify-between`.

- [ ] **Step 1.3 — Verify visually**

  Run `npm run dev`, open Code Space, confirm the mode selector sits right-aligned directly below the ⚡ submit button, and the Generate Diagram / App Planner links are on the left of the same row.

- [ ] **Step 1.4 — Commit**

  ```bash
  git add components/code-space/AgentPanel.tsx
  git commit -m "feat(code-space): move agent mode selector below submit, right-aligned"
  ```

---

## Task 2 — Add 'local' to ProviderId and extend ProviderConfig

**Files:**
- Modify: `lib/agent/providers/types.ts`

- [ ] **Step 2.1 — Add 'local' to ProviderId**

  In `lib/agent/providers/types.ts`, replace:

  ```typescript
  export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'foundry' | 'grok';
  ```

  With:

  ```typescript
  export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'foundry' | 'grok' | 'local';
  ```

- [ ] **Step 2.2 — Add temperature and maxTokens to ProviderConfig**

  In the same file, replace:

  ```typescript
  export interface ProviderConfig {
    apiKey: string;
    endpoint?: string;
  }
  ```

  With:

  ```typescript
  export interface ProviderConfig {
    apiKey: string;
    endpoint?: string;
    /** Used by LocalModelProvider only — ignored by all other providers. */
    temperature?: number;
    /** Used by LocalModelProvider only — ignored by all other providers. */
    maxTokens?: number;
  }
  ```

- [ ] **Step 2.3 — Commit**

  ```bash
  git add lib/agent/providers/types.ts
  git commit -m "feat(providers): add 'local' to ProviderId; add temperature/maxTokens to ProviderConfig"
  ```

---

## Task 3 — Create LocalModelProvider

**Files:**
- Create: `lib/agent/providers/local.ts`
- Modify: `lib/agent/providers/index.ts`

- [ ] **Step 3.1 — Create the provider file**

  Create `lib/agent/providers/local.ts`:

  ```typescript
  /**
   * Local Model provider — OpenAI-compatible API.
   * Works with Ollama, LM Studio, llama.cpp, Jan, and any server that exposes
   * an OpenAI-compatible /v1 endpoint.
   */
  import OpenAI from 'openai';
  import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';

  export class LocalModelProvider implements Provider {
    id = 'local' as const;
    private client: OpenAI;
    private temperature: number;
    private maxTokens: number;

    constructor(cfg: ProviderConfig) {
      const baseURL = (cfg.endpoint ?? 'http://localhost:11434/v1').replace(/\/$/, '');
      this.client = new OpenAI({
        baseURL,
        apiKey: cfg.apiKey || 'local', // OpenAI SDK requires a non-empty string
        dangerouslyAllowBrowser: false,
      });
      this.temperature = cfg.temperature ?? 0.7;
      this.maxTokens = cfg.maxTokens ?? 4096;
    }

    async validate(_model: string): Promise<ValidationResult> {
      try {
        // List models as a connectivity check — all OpenAI-compatible servers support this.
        await this.client.models.list();
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
      }
    }

    async chat(params: ChatParams): Promise<string> {
      const messages = params.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = {
        model: params.model,
        messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      };
      if (params.jsonSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'output', schema: params.jsonSchema, strict: true },
        };
      }
      const res = await this.client.chat.completions.create(body, {
        signal: params.signal,
      });
      return res.choices[0]?.message?.content ?? '';
    }
  }
  ```

- [ ] **Step 3.2 — Wire into provider registry**

  In `lib/agent/providers/index.ts`, make these four changes:

  **Add import** (after the GrokProvider import on line 5):
  ```typescript
  import { LocalModelProvider } from './local';
  ```

  **Add to PROVIDER_ENV** (add `local` entry):
  ```typescript
  export const PROVIDER_ENV: Record<ProviderId, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'CLAUDE_API_KEY',
    gemini: 'GEMINI_API_KEY',
    foundry: 'FOUNDRY_API_KEY',
    grok: 'GROK_API_KEY',
    local: 'LOCAL_MODEL_API_KEY',
  };
  ```

  **Add to `getDefaultProvider`** — update the `env ===` guard so TypeScript stays happy (add `|| env === 'local'`):
  ```typescript
  export function getDefaultProvider(): ProviderId {
    const env = process.env.AGENTDIAGRAM_DEFAULT_PROVIDER?.toLowerCase();
    if (
      env === 'openai' || env === 'anthropic' || env === 'gemini' ||
      env === 'foundry' || env === 'grok' || env === 'local'
    ) {
      return env;
    }
    return 'openai';
  }
  ```

  **Add to `makeProvider` switch**:
  ```typescript
  export function makeProvider(id: ProviderId, cfg: ProviderConfig): Provider {
    switch (id) {
      case 'openai':
        return new OpenAIProvider(cfg);
      case 'anthropic':
        return new AnthropicProvider(cfg);
      case 'gemini':
        return new GeminiProvider(cfg);
      case 'foundry':
        return new FoundryProvider(cfg);
      case 'grok':
        return new GrokProvider(cfg);
      case 'local':
        return new LocalModelProvider(cfg);
    }
  }
  ```

  **Add temperature + maxTokens to ProviderSession**:
  ```typescript
  export interface ProviderSession {
    id: ProviderId;
    model: string;
    endpoint?: string;
    apiKey: string;
    temperature?: number;
    maxTokens?: number;
  }
  ```

  **Update `chatWithRetry`** to pass temperature/maxTokens to makeProvider (replace the makeProvider call inside chatWithRetry):
  ```typescript
  export async function chatWithRetry(
    session: ProviderSession,
    messages: ChatMessage[],
    opts: {
      signal?: AbortSignal;
      onRetry?: RetryListener;
      jsonSchema?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const provider = makeProvider(session.id, {
      apiKey: session.apiKey,
      endpoint: session.endpoint,
      temperature: session.temperature,
      maxTokens: session.maxTokens,
    });
    return withRetry(
      () => {
        const params: ChatParams = {
          model: session.model,
          messages,
          signal: opts.signal,
          jsonSchema: opts.jsonSchema,
        };
        return provider.chat(params);
      },
      { signal: opts.signal, onRetry: opts.onRetry },
    );
  }
  ```

- [ ] **Step 3.3 — Check TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors relating to `local` or `LocalModelProvider`. Fix any type errors before continuing.

- [ ] **Step 3.4 — Commit**

  ```bash
  git add lib/agent/providers/local.ts lib/agent/providers/index.ts
  git commit -m "feat(providers): add LocalModelProvider for OpenAI-compatible local servers"
  ```

---

## Task 4 — Add local config fields to Zustand store

**Files:**
- Modify: `lib/state/store.ts`

- [ ] **Step 4.1 — Extend ProviderConfig in the store**

  In `lib/state/store.ts`, find the `ProviderConfig` interface (around line 140) and replace it:

  ```typescript
  export interface ProviderConfig {
    provider: ProviderId;
    model: string;
    apiKey: string;
    customModel?: string;
    endpoint?: string;
    // Local model fields — only used when provider === 'local'
    localBaseUrl?: string;       // e.g. "http://localhost:11434/v1"
    localModelName?: string;     // e.g. "llama3.2"
    localApiKey?: string;        // optional; e.g. "ollama" or blank
    localContextLength?: number; // default 4096
    localTemperature?: number;   // default 0.7
  }
  ```

- [ ] **Step 4.2 — Run type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no new errors. The new fields are optional so existing code remains valid.

- [ ] **Step 4.3 — Commit**

  ```bash
  git add lib/state/store.ts
  git commit -m "feat(store): add local model config fields to ProviderConfig"
  ```

---

## Task 5 — Add Local Model option to ProviderConfig UI

**Files:**
- Modify: `components/agent/ProviderConfig.tsx`

- [ ] **Step 5.1 — Add 'local' to PROVIDERS array**

  In `components/agent/ProviderConfig.tsx`, find the `PROVIDERS` array (lines 14–20) and add the local entry at the end:

  ```typescript
  const PROVIDERS: Array<{ id: ProviderId; label: string; envVar: string; note: string }> = [
    { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', note: 'Models degrade in capability from top to bottom.' },
    { id: 'anthropic', label: 'Anthropic', envVar: 'CLAUDE_API_KEY', note: 'Models degrade in capability from top to bottom.' },
    { id: 'gemini', label: 'Gemini', envVar: 'GEMINI_API_KEY', note: 'Models degrade in capability from top to bottom.' },
    { id: 'grok', label: 'xAI Grok', envVar: 'GROK_API_KEY', note: 'Fast multi-modal chat with Grok-family defaults.' },
    { id: 'foundry', label: 'Azure Foundry', envVar: 'FOUNDRY_API_KEY', note: 'Provide the deployment name for your custom model.' },
    { id: 'local', label: 'Local Model', envVar: '', note: 'OpenAI-compatible API — works with Ollama, LM Studio, llama.cpp, Jan.' },
  ];
  ```

- [ ] **Step 5.2 — Add local config form JSX**

  The component currently shows a model `<select>` when `provider.provider !== 'foundry'`. We need to also exclude `'local'` from the model select, and show the local config form instead.

  Find this block (around line 93):
  ```tsx
  {provider.provider !== 'foundry' && (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Model</div>
      <select ...>
  ```

  Change the condition from `provider.provider !== 'foundry'` to `provider.provider !== 'foundry' && provider.provider !== 'local'`:
  ```tsx
  {provider.provider !== 'foundry' && provider.provider !== 'local' && (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Model</div>
      <select
        value={provider.model}
        onChange={(e) => setProvider({ model: e.target.value })}
        className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
      >
        {MODELS_BY_PROVIDER[provider.provider]?.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <div className="mt-1 text-[10px] text-ink-400">
        Models are listed in order of capability — switch down if the top one isn&apos;t available on your account.
      </div>
    </div>
  )}
  ```

  Then immediately after that block, add the local config form:
  ```tsx
  {provider.provider === 'local' && (
    <div className="space-y-3">
      <div className="rounded-md border border-green-900/50 bg-green-950/30 px-3 py-2 text-[11px] text-green-400">
        🟢 OpenAI-compatible API · Works with Ollama, LM Studio, llama.cpp, Jan
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Base URL</div>
        <input
          type="text"
          value={provider.localBaseUrl ?? 'http://localhost:11434/v1'}
          onChange={(e) => setProvider({ localBaseUrl: e.target.value })}
          placeholder="http://localhost:11434/v1"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
          autoComplete="off"
        />
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Model Name</div>
        <input
          type="text"
          value={provider.localModelName ?? ''}
          onChange={(e) => setProvider({ localModelName: e.target.value })}
          placeholder="llama3.2"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
          autoComplete="off"
        />
        <div className="mt-1 text-[10px] text-ink-400">e.g. llama3.2, mistral, codestral, phi3</div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">
          API Key <span className="normal-case text-ink-500">(optional)</span>
        </div>
        <input
          type="password"
          value={provider.localApiKey ?? ''}
          onChange={(e) => setProvider({ localApiKey: e.target.value })}
          placeholder="Leave blank if not required"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
          autoComplete="off"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Context Length</div>
          <input
            type="number"
            value={provider.localContextLength ?? 4096}
            onChange={(e) => setProvider({ localContextLength: Number(e.target.value) })}
            min={256}
            step={256}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
          />
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Temperature</div>
          <input
            type="number"
            value={provider.localTemperature ?? 0.7}
            onChange={(e) => setProvider({ localTemperature: Number(e.target.value) })}
            min={0}
            max={2}
            step={0.1}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
          />
        </div>
      </div>

      <LocalModelTestButton
        baseUrl={provider.localBaseUrl ?? ''}
        apiKey={provider.localApiKey ?? ''}
      />

      <div className="text-[10px] text-ink-500">✓ Config auto-saved to browser storage</div>
    </div>
  )}
  ```

- [ ] **Step 5.3 — Add LocalModelTestButton component**

  Add this component at the top of the file, just before the `export function ProviderConfig` declaration:

  ```tsx
  function LocalModelTestButton({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
    const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
    const [error, setError] = useState('');
    const [models, setModels] = useState<string[]>([]);

    async function handleTest() {
      if (!baseUrl) return;
      setStatus('testing');
      setError('');
      setModels([]);
      try {
        const res = await fetch('/api/local-model/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl, apiKey }),
        });
        const data = (await res.json()) as { ok: boolean; models?: string[]; error?: string };
        if (data.ok) {
          setStatus('ok');
          setModels(data.models ?? []);
        } else {
          setStatus('fail');
          setError(data.error ?? 'Connection failed');
        }
      } catch (err) {
        setStatus('fail');
        setError(err instanceof Error ? err.message : 'Network error');
      }
    }

    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={!baseUrl || status === 'testing'}
          className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs hover:bg-ink-700 disabled:opacity-50"
        >
          {status === 'testing' ? 'Testing…' : 'Test Connection'}
        </button>
        {status === 'ok' && (
          <span className="text-[11px] text-green-400">
            ✓ Connected{models.length > 0 ? ` · ${models.length} model(s)` : ''}
          </span>
        )}
        {status === 'fail' && (
          <span className="truncate text-[11px] text-red-400" title={error}>
            ✕ {error}
          </span>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 5.4 — Run type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors. If `setProvider` type-checks against the old `ProviderConfig`, it will now accept `localBaseUrl` etc because you added those fields in Task 4.

- [ ] **Step 5.5 — Commit**

  ```bash
  git add components/agent/ProviderConfig.tsx
  git commit -m "feat(ui): add Local Model provider option with full config form"
  ```

---

## Task 6 — Add test-connection endpoint

**Files:**
- Create: `app/api/local-model/test/route.ts`

- [ ] **Step 6.1 — Create the route**

  Create `app/api/local-model/test/route.ts`:

  ```typescript
  import { NextRequest } from 'next/server';
  import { z } from 'zod';

  const BodySchema = z.object({
    baseUrl: z.string().min(1),
    apiKey: z.string().optional().default(''),
  });

  export async function POST(req: NextRequest) {
    const result = BodySchema.safeParse(await req.json());
    if (!result.success) {
      return Response.json({ ok: false, error: result.error.message }, { status: 400 });
    }

    const { baseUrl, apiKey } = result.data;
    const url = `${baseUrl.replace(/\/$/, '')}/models`;

    try {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      });
      if (!res.ok) {
        return Response.json({ ok: false, error: `Server returned HTTP ${res.status}` });
      }
      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const models = json.data?.map((m) => m.id) ?? [];
      return Response.json({ ok: true, models });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      return Response.json({ ok: false, error: msg });
    }
  }
  ```

- [ ] **Step 6.2 — Manual smoke test**

  If you have Ollama running locally:
  ```bash
  curl -s -X POST http://localhost:3000/api/local-model/test \
    -H 'Content-Type: application/json' \
    -d '{"baseUrl":"http://localhost:11434/v1"}' | jq .
  ```
  Expected: `{ "ok": true, "models": ["llama3.2", ...] }` (or similar model list).

- [ ] **Step 6.3 — Commit**

  ```bash
  git add app/api/local-model/test/route.ts
  git commit -m "feat(api): add local-model test-connection endpoint"
  ```

---

## Task 7 — Add 'local' to all agent route schemas

**Files:**
- Modify: `app/api/code-space/agent/route.ts`
- Modify: `app/api/agent/clarify/route.ts`
- Modify: `app/api/agent/custom/route.ts`
- Modify: `app/api/agent/custom-multilayer/route.ts`
- Modify: `app/api/agent/multilayer/route.ts`

The change is the same in each file: add `'local'` to the `provider` z.enum, and (for the non-code-space routes) add optional `temperature` and `maxTokens` fields to the body schema, and thread them into the ProviderSession passed to pipeline functions.

- [ ] **Step 7.1 — Update `app/api/code-space/agent/route.ts`**

  Find the `BodySchema` (around line 18). Change:
  ```typescript
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry']),
  ```
  To:
  ```typescript
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry', 'local']),
  ```
  Also add after the `endpoint` field:
  ```typescript
  localTemperature: z.number().min(0).max(2).optional(),
  localContextLength: z.number().int().positive().optional(),
  ```

- [ ] **Step 7.2 — Update `app/api/agent/clarify/route.ts`**

  Find the `provider` z.enum line (line 11). Change:
  ```typescript
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok']),
  ```
  To:
  ```typescript
  provider: z.enum(['openai', 'anthropic', 'gemini', 'foundry', 'grok', 'local']),
  ```
  Add optional temperature/maxTokens fields to the body schema (after `endpoint`):
  ```typescript
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  ```
  Then find the ProviderSession object being passed to `runClarify` and extend it:
  ```typescript
  // Find the session config object (something like { id: cfg.provider, model, apiKey, endpoint })
  // Add temperature and maxTokens to it:
  {
    id: cfg.provider,
    model,
    apiKey,
    endpoint,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  }
  ```

- [ ] **Step 7.3 — Update `app/api/agent/custom/route.ts`**

  Same as Step 7.2: add `'local'` to provider enum, add `temperature`/`maxTokens` to schema, add them to the session config passed to `runCustomPlan`.

- [ ] **Step 7.4 — Update `app/api/agent/custom-multilayer/route.ts`**

  Same pattern: add `'local'` to provider enum (line 10), add `temperature`/`maxTokens` to schema, thread into session config for `runCustomMultiLayerPlan`.

- [ ] **Step 7.5 — Update `app/api/agent/multilayer/route.ts`**

  Same pattern: add `'local'` to provider enum (line 14), add `temperature`/`maxTokens` to schema, thread into session config for `runMultiLayerPipeline`.

- [ ] **Step 7.6 — Type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -40
  ```

  Expected: no errors. If TypeScript reports `ProviderSession` is missing `temperature`/`maxTokens`, you may have missed adding them to the ProviderSession interface in Task 3.2 — fix there first.

- [ ] **Step 7.7 — Commit**

  ```bash
  git add \
    app/api/code-space/agent/route.ts \
    app/api/agent/clarify/route.ts \
    app/api/agent/custom/route.ts \
    app/api/agent/custom-multilayer/route.ts \
    app/api/agent/multilayer/route.ts
  git commit -m "feat(api): accept 'local' provider in all agent route schemas"
  ```

---

## Task 8 — Wire local model fields through CodeSpaceWorkspace fetch call

**Files:**
- Modify: `components/code-space/CodeSpaceWorkspace.tsx`

- [ ] **Step 8.1 — Update the model/apiKey/endpoint derivation for local**

  In `CodeSpaceWorkspace.tsx`, find the `handleRunAgent` function (search for `const model = provider.provider === 'foundry'`). The current lines look like:

  ```typescript
  const model = provider.provider === 'foundry' ? (provider.customModel ?? provider.model) : provider.model;
  const apiKey = provider.apiKey || getApiKey(provider.provider);
  const enableThinking = provider.provider === 'anthropic';
  ```

  Replace with:

  ```typescript
  const model =
    provider.provider === 'foundry'
      ? (provider.customModel ?? provider.model)
      : provider.provider === 'local'
        ? (provider.localModelName ?? '')
        : provider.model;
  const apiKey =
    provider.provider === 'local'
      ? (provider.localApiKey ?? '')
      : (provider.apiKey || getApiKey(provider.provider));
  const enableThinking = provider.provider === 'anthropic';
  ```

- [ ] **Step 8.2 — Add local fields to the fetch body**

  In the same `handleRunAgent` function, find the `fetch('/api/code-space/agent', ...)` call. Find the `body: JSON.stringify({ ... })` and add `endpoint` and local-specific fields:

  ```typescript
  body: JSON.stringify({
    sessionId: sessionWithPrompt.id,
    projectRoot: project.rootPath,
    projectName: project.name,
    messages: latestHistory,
    model,
    providerId: provider.provider,
    apiKey,
    endpoint: provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint,
    localTemperature: provider.provider === 'local' ? provider.localTemperature : undefined,
    localContextLength: provider.provider === 'local' ? provider.localContextLength : undefined,
    // ... rest of existing fields unchanged
  }),
  ```

  Do not remove any existing fields — only add the two new optional ones and update `endpoint`.

- [ ] **Step 8.3 — Type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no new errors.

- [ ] **Step 8.4 — Commit**

  ```bash
  git add components/code-space/CodeSpaceWorkspace.tsx
  git commit -m "feat(code-space): pass local model fields through agent fetch call"
  ```

---

## Task 9 — Create sessionNaming utility (TDD)

**Files:**
- Create: `lib/code-space/__tests__/sessionNaming.test.ts`
- Create: `lib/code-space/sessionNaming.ts`

- [ ] **Step 9.1 — Write the failing tests first**

  Create `lib/code-space/__tests__/sessionNaming.test.ts`:

  ```typescript
  import { describe, expect, it } from 'vitest';
  import { extractFallbackName } from '../sessionNaming';

  describe('extractFallbackName', () => {
    it('returns up to 4 title-cased words, stripping stop words', () => {
      expect(extractFallbackName('add a sidebar navigation component for the dashboard')).toBe(
        'Add Sidebar Navigation Component',
      );
    });

    it('strips common stop words', () => {
      expect(extractFallbackName('build an authentication flow for the app')).toBe(
        'Build Authentication Flow App',
      );
    });

    it('respects maxWords param — used by app-planner (max 2)', () => {
      expect(extractFallbackName('fix the login bug in the auth service', 2)).toBe('Fix Login');
    });

    it('returns "New Session" when query is blank', () => {
      expect(extractFallbackName('')).toBe('New Session');
    });

    it('returns "New Session" when all words are stop words', () => {
      expect(extractFallbackName('a an the is are')).toBe('New Session');
    });

    it('handles a query shorter than maxWords', () => {
      expect(extractFallbackName('refactor auth')).toBe('Refactor Auth');
    });

    it('handles extra whitespace and punctuation', () => {
      expect(extractFallbackName('  build!!  a  chatbox??? ')).toBe('Build Chatbox');
    });
  });
  ```

- [ ] **Step 9.2 — Run tests to confirm they fail**

  ```bash
  npx vitest run lib/code-space/__tests__/sessionNaming.test.ts 2>&1 | tail -20
  ```

  Expected: all tests FAIL with "Cannot find module '../sessionNaming'".

- [ ] **Step 9.3 — Implement sessionNaming.ts**

  Create `lib/code-space/sessionNaming.ts`:

  ```typescript
  /**
   * Session auto-naming utilities.
   *
   * nameSessionAsync: fires a background LLM call to generate a meaningful title,
   * falls back to extractFallbackName on any error.
   *
   * extractFallbackName: lightweight rule-based extraction used as fallback.
   */

  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'in', 'on',
    'at', 'by', 'for', 'with', 'from', 'of', 'and', 'but', 'or', 'nor',
    'so', 'yet', 'i', 'my', 'me', 'we', 'our', 'it', 'its', 'this', 'that',
    'these', 'those',
  ]);

  /** Returns up to `maxWords` title-cased non-stop words from `query`. */
  export function extractFallbackName(query: string, maxWords = 4): string {
    const words = query
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !STOP_WORDS.has(w.toLowerCase()))
      .slice(0, maxWords)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

    return words.length > 0 ? words.join(' ') : 'New Session';
  }

  export interface NamingProviderConfig {
    providerId: string;
    model: string;
    apiKey?: string;
    endpoint?: string;
  }

  /**
   * Fires POST /api/code-space/name-session in the background (no await at call site).
   * Calls `updateFn` with the resolved name on success or after fallback.
   * Never throws — all errors are swallowed and handled via fallback.
   */
  export async function nameSessionAsync(
    sessionId: string,
    query: string,
    providerCfg: NamingProviderConfig,
    updateFn: (id: string, title: string) => void,
    mode: 'code-space' | 'app-planner' = 'code-space',
  ): Promise<void> {
    const maxWords = mode === 'app-planner' ? 2 : 4;
    try {
      const res = await fetch('/api/code-space/name-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.slice(0, 100),
          providerId: providerCfg.providerId,
          model: providerCfg.model,
          apiKey: providerCfg.apiKey,
          endpoint: providerCfg.endpoint,
          mode,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { name?: string };
      const name = data.name?.trim();
      if (name) {
        updateFn(sessionId, name);
        return;
      }
      throw new Error('Empty name returned');
    } catch {
      // Silent fallback — user sees rule-based name, never an error
      updateFn(sessionId, extractFallbackName(query, maxWords));
    }
  }
  ```

- [ ] **Step 9.4 — Run tests to confirm they pass**

  ```bash
  npx vitest run lib/code-space/__tests__/sessionNaming.test.ts 2>&1 | tail -20
  ```

  Expected: all 7 tests PASS.

- [ ] **Step 9.5 — Commit**

  ```bash
  git add lib/code-space/sessionNaming.ts lib/code-space/__tests__/sessionNaming.test.ts
  git commit -m "feat(code-space): add sessionNaming utility with extractFallbackName + nameSessionAsync"
  ```

---

## Task 10 — Create the name-session endpoint

**Files:**
- Create: `app/api/code-space/name-session/route.ts`

- [ ] **Step 10.1 — Create the route**

  Create `app/api/code-space/name-session/route.ts`:

  ```typescript
  import { NextRequest } from 'next/server';
  import { z } from 'zod';
  import { makeProvider, PROVIDER_ENV } from '@/lib/agent/providers';

  const BodySchema = z.object({
    query: z.string().min(1).max(100),
    providerId: z.enum(['openai', 'anthropic', 'gemini', 'grok', 'foundry', 'local']),
    model: z.string().min(1),
    apiKey: z.string().optional().default(''),
    endpoint: z.string().optional(),
    mode: z.enum(['code-space', 'app-planner']).default('code-space'),
  });

  export async function POST(req: NextRequest) {
    const result = BodySchema.safeParse(await req.json());
    if (!result.success) {
      return Response.json({ error: result.error.message }, { status: 400 });
    }

    const { query, providerId, model, apiKey, endpoint, mode } = result.data;
    const resolvedKey = apiKey || process.env[PROVIDER_ENV[providerId]] || '';

    const maxWords = mode === 'app-planner' ? 2 : 4;
    const namingPrompt = `You are a session title generator.
Given a task description, return ONLY a title of up to ${maxWords} words.
No punctuation. No quotes. Title case.
Examples: "Frontend Chatbox Design", "Fix Auth Bug", "API Rate Limiter"

Task: ${query}`;

    try {
      const provider = makeProvider(providerId, {
        apiKey: resolvedKey,
        endpoint,
      });
      const raw = await provider.chat({
        messages: [{ role: 'user', content: namingPrompt }],
        model,
      });
      const name = raw.trim().replace(/^["']|["']$/g, ''); // strip any surrounding quotes
      return Response.json({ name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return Response.json({ error: msg }, { status: 500 });
    }
  }
  ```

- [ ] **Step 10.2 — Verify it builds**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 10.3 — Commit**

  ```bash
  git add app/api/code-space/name-session/route.ts
  git commit -m "feat(api): add name-session endpoint for LLM-generated session titles"
  ```

---

## Task 11 — Wire auto-naming into CodeSpaceWorkspace

**Files:**
- Modify: `components/code-space/CodeSpaceWorkspace.tsx`

- [ ] **Step 11.1 — Import nameSessionAsync**

  At the top of `components/code-space/CodeSpaceWorkspace.tsx`, add to the imports from `@/lib/code-space/`:

  ```typescript
  import { nameSessionAsync } from '@/lib/code-space/sessionNaming';
  ```

- [ ] **Step 11.2 — Add the naming call in handleRunAgent**

  In `handleRunAgent`, immediately before the `fetch('/api/code-space/agent', ...)` call, add:

  ```typescript
  // Auto-name new sessions from the first message
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  if (
    activeSession &&
    activeSession.messages.length === 0 &&
    activeSession.title === 'New coding session'
  ) {
    // fire-and-forget — updates session title when LLM responds (~1s)
    void nameSessionAsync(
      activeSession.id,
      userPrompt,
      {
        providerId: provider.provider,
        model,
        apiKey,
        endpoint: provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint,
      },
      (id, title) => {
        // updateSession is the same function used by the rename UI
        updateSession(id, { title });
      },
      'code-space',
    );
  }
  ```

  Note: `updateSession` should already exist in scope — it's the function that saves session changes to IndexedDB and updates React state. If the actual function name differs, search for the rename handler in `SessionListSection` usage to find the correct name.

- [ ] **Step 11.3 — Type check and manual test**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```

  Then run the dev server, create a new Code Space session, submit a first message, and confirm the session title in the sidebar changes from "New coding session" to a meaningful 2–4 word title within ~1–2 seconds.

- [ ] **Step 11.4 — Commit**

  ```bash
  git add components/code-space/CodeSpaceWorkspace.tsx
  git commit -m "feat(code-space): auto-name sessions from first user message"
  ```

---

## Task 12 — Wire auto-naming into App Planner (CustomPromptPanel)

**Files:**
- Modify: `components/agent/CustomPromptPanel.tsx`

- [ ] **Step 12.1 — Import nameSessionAsync and extractFallbackName**

  Add to the imports in `components/agent/CustomPromptPanel.tsx`:

  ```typescript
  import { nameSessionAsync } from '@/lib/code-space/sessionNaming';
  ```

- [ ] **Step 12.2 — Get provider config from store**

  Near the top of the component (where `useDiagramStore` is already called), add `provider` to the destructured store values:

  ```typescript
  const provider = useDiagramStore((s) => s.provider);
  ```

  (Search for existing `useDiagramStore` usage in the component to find where to add this — do not duplicate the hook call, add `provider` to an existing destructure.)

- [ ] **Step 12.3 — Replace static name with AI-named version — single-layer**

  Find the single-layer result handler (around line 315). The current code is:

  ```typescript
  } else if (ev.type === 'result') {
    sawResult = true;
    const instructionMarkdown = ev.instructionMarkdown ?? '';
    setInstructionMarkdown(instructionMarkdown);
    setDsl(ev.dsl);
    const name = prompt.trim().split(/\s+/).slice(0, 3).join(' ') || 'custom';
    addGeneratedProject(name, ev.dsl, undefined, instructionMarkdown);
    setMode('editor');
  ```

  Replace the `name` line and `addGeneratedProject` call:

  ```typescript
  } else if (ev.type === 'result') {
    sawResult = true;
    const instructionMarkdown = ev.instructionMarkdown ?? '';
    setInstructionMarkdown(instructionMarkdown);
    setDsl(ev.dsl);
    // Generate AI name (awaited here since we need it before creating the project)
    const projectModel =
      provider.provider === 'foundry'
        ? (provider.customModel ?? provider.model)
        : provider.provider === 'local'
          ? (provider.localModelName ?? '')
          : provider.model;
    let name = prompt.trim().split(/\s+/).slice(0, 2).join(' ') || 'custom';
    try {
      const res = await fetch('/api/code-space/name-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: prompt.slice(0, 100),
          providerId: provider.provider,
          model: projectModel,
          apiKey: provider.provider === 'local' ? provider.localApiKey : provider.apiKey,
          endpoint:
            provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint,
          mode: 'app-planner',
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { name?: string };
        if (data.name?.trim()) name = data.name.trim();
      }
    } catch {
      // fallback already set above
    }
    addGeneratedProject(name, ev.dsl, undefined, instructionMarkdown);
    setMode('editor');
  ```

- [ ] **Step 12.4 — Replace static name — multi-layer**

  Find the multi-layer result handler (around line 318–329). The current code is:

  ```typescript
  } else if (ev.type === 'result-multilayer') {
    sawResult = true;
    const instructionMarkdown = ev.instructionMarkdown ?? '';
    setInstructionMarkdown(instructionMarkdown);
    const out = ev.output as MultiLayerOutput;
    setMultiLayer(out);
    clearOverrides();
    setActiveLayer('overview');
    setDsl(out.overview.dsl);
    const name = prompt.trim().split(/\s+/).slice(0, 3).join(' ') || 'custom';
    addGeneratedProject(name, out.overview.dsl, out, instructionMarkdown);
    setMode('editor');
  ```

  Replace the `name` + `addGeneratedProject` block with:

  ```typescript
  } else if (ev.type === 'result-multilayer') {
    sawResult = true;
    const instructionMarkdown = ev.instructionMarkdown ?? '';
    setInstructionMarkdown(instructionMarkdown);
    const out = ev.output as MultiLayerOutput;
    setMultiLayer(out);
    clearOverrides();
    setActiveLayer('overview');
    setDsl(out.overview.dsl);
    const projectModel =
      provider.provider === 'foundry'
        ? (provider.customModel ?? provider.model)
        : provider.provider === 'local'
          ? (provider.localModelName ?? '')
          : provider.model;
    let name = prompt.trim().split(/\s+/).slice(0, 2).join(' ') || 'custom';
    try {
      const res = await fetch('/api/code-space/name-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: prompt.slice(0, 100),
          providerId: provider.provider,
          model: projectModel,
          apiKey: provider.provider === 'local' ? provider.localApiKey : provider.apiKey,
          endpoint:
            provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint,
          mode: 'app-planner',
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { name?: string };
        if (data.name?.trim()) name = data.name.trim();
      }
    } catch {
      // fallback already set above
    }
    addGeneratedProject(name, out.overview.dsl, out, instructionMarkdown);
    setMode('editor');
  ```

- [ ] **Step 12.5 — Remap local model fields in the main clarify/generate fetch calls**

  CustomPromptPanel calls `/api/agent/clarify` and then `/api/agent/custom` (or `/api/agent/custom-multilayer`). Both receive `provider`, `model`, `apiKey`, `endpoint` from the component. For a `'local'` provider these need to be remapped the same way as in Task 8.

  Find any `fetch('/api/agent/clarify', ...)` call in the component. Inside the body, find where `model`, `apiKey`, `endpoint` are set and replace with:

  ```typescript
  const resolvedModel =
    provider.provider === 'foundry'
      ? (provider.customModel ?? provider.model)
      : provider.provider === 'local'
        ? (provider.localModelName ?? '')
        : provider.model;
  const resolvedApiKey =
    provider.provider === 'local' ? (provider.localApiKey ?? '') : provider.apiKey;
  const resolvedEndpoint =
    provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint;
  ```

  Then use `resolvedModel`, `resolvedApiKey`, `resolvedEndpoint` in the fetch body (replacing the previous `model`, `apiKey`, `endpoint` references). Apply the same substitution to the `/api/agent/custom` and `/api/agent/custom-multilayer` fetch calls in the same file.

- [ ] **Step 12.7 — Type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors.

- [ ] **Step 12.8 — Manual test**

  Run `npm run dev`, open App Planner, submit a prompt, answer the clarifying questions, generate a diagram. When redirected to the editor, confirm the project name in the project list is a meaningful 1–2 word title rather than the raw first 3 words of the prompt.

- [ ] **Step 12.9 — Commit**

  ```bash
  git add components/agent/CustomPromptPanel.tsx
  git commit -m "feat(app-planner): local model field remapping + auto-name generated projects"
  ```

---

## Task 13 — Wire local model fields through MultiLayerPanel

**Files:**
- Modify: `components/multilayer/MultiLayerPanel.tsx`

- [ ] **Step 13.1 — Read the fetch call in MultiLayerPanel**

  Open `components/multilayer/MultiLayerPanel.tsx`. Find the `fetch('/api/agent/multilayer', ...)` call and locate where `model`, `apiKey`, and `endpoint` are set in the request body.

- [ ] **Step 13.2 — Ensure provider is read from store**

  Confirm `provider` is already destructured from `useDiagramStore`. If not, add:

  ```typescript
  const provider = useDiagramStore((s) => s.provider);
  ```

- [ ] **Step 13.3 — Remap fields for local model**

  Before the `fetch` call, add:

  ```typescript
  const resolvedModel =
    provider.provider === 'foundry'
      ? (provider.customModel ?? provider.model)
      : provider.provider === 'local'
        ? (provider.localModelName ?? '')
        : provider.model;
  const resolvedApiKey =
    provider.provider === 'local' ? (provider.localApiKey ?? '') : provider.apiKey;
  const resolvedEndpoint =
    provider.provider === 'local' ? provider.localBaseUrl : provider.endpoint;
  ```

  Replace the `model`, `apiKey`, `endpoint` values in the fetch body with `resolvedModel`, `resolvedApiKey`, `resolvedEndpoint`. Also add the optional temperature/maxTokens:

  ```typescript
  temperature: provider.provider === 'local' ? provider.localTemperature : undefined,
  maxTokens: provider.provider === 'local' ? provider.localContextLength : undefined,
  ```

- [ ] **Step 13.4 — Type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors.

- [ ] **Step 13.5 — Commit**

  ```bash
  git add components/multilayer/MultiLayerPanel.tsx
  git commit -m "feat(multilayer): wire local model fields through multilayer generate call"
  ```

---

## Final checks

- [ ] **Run full test suite**

  ```bash
  npx vitest run 2>&1 | tail -20
  ```

  Expected: all existing tests pass; the 7 new `sessionNaming` tests pass.

- [ ] **Run type check**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: zero errors.

- [ ] **Add `.superpowers/` to `.gitignore` if not already present**

  ```bash
  grep -q '.superpowers' .gitignore || echo '.superpowers/' >> .gitignore
  git add .gitignore
  git commit -m "chore: ignore .superpowers/ brainstorm artefacts"
  ```
