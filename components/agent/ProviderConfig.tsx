'use client';

import { useState } from 'react';
import { useDiagramStore } from '@/lib/state/store';
import {
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  PROVIDER_DEFAULTS,
} from '@/lib/agent/providers';
import type { ProviderId } from '@/lib/agent/providers/types';

const PROVIDERS: Array<{ id: ProviderId; label: string; envVar: string; note: string }> = [
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', note: 'Models degrade in capability from top to bottom.' },
  { id: 'anthropic', label: 'Anthropic', envVar: 'CLAUDE_API_KEY', note: 'Models degrade in capability from top to bottom.' },
  { id: 'gemini', label: 'Gemini', envVar: 'GEMINI_API_KEY', note: 'Models degrade in capability from top to bottom.' },
  { id: 'grok', label: 'xAI Grok', envVar: 'GROK_API_KEY', note: 'Fast multi-modal chat with Grok-family defaults.' },
  { id: 'foundry', label: 'Azure Foundry', envVar: 'FOUNDRY_API_KEY', note: 'Provide the deployment name for your custom model.' },
];

const MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  gemini: GEMINI_MODELS,
  foundry: [],
  grok: GROK_MODELS,
};

export function ProviderConfig() {
  const provider = useDiagramStore((s) => s.provider);
  const setProvider = useDiagramStore((s) => s.setProvider);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; error?: string } | null>(null);

  const onProviderChange = (id: typeof provider.provider) => {
    setProvider({ provider: id, model: PROVIDER_DEFAULTS[id] });
    setValidation(null);
  };

  const onValidate = async () => {
    setValidating(true);
    setValidation(null);
    try {
      const res = await fetch('/api/agent/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: provider.provider === 'foundry' ? provider.customModel ?? '' : provider.model,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
        }),
      });
      const data = await res.json();
      setValidation(data);
    } catch (err) {
      setValidation({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-ink-400">AI Provider</div>

      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <label
            key={p.id}
            className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors ${
              provider.provider === p.id
                ? 'border-accent/60 bg-accent/10'
                : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
            }`}
          >
            <input
              type="radio"
              name="provider"
              checked={provider.provider === p.id}
              onChange={() => onProviderChange(p.id)}
              className="accent-accent"
            />
            <div className="flex-1">
              <div className="text-ink-100">{p.label}</div>
              <div className="text-[10px] text-ink-400">{p.envVar}</div>
            </div>
          </label>
        ))}
      </div>

      {provider.provider !== 'foundry' && (
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

      {provider.provider === 'foundry' && (
        <>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Endpoint</div>
            <input
              value={provider.endpoint ?? ''}
              onChange={(e) => setProvider({ endpoint: e.target.value })}
              placeholder="https://<your-resource>.openai.azure.com"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Deployment (model name)</div>
            <input
              value={provider.customModel ?? ''}
              onChange={(e) => setProvider({ customModel: e.target.value, model: e.target.value })}
              placeholder="e.g. my-gpt-deployment"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
            />
          </div>
        </>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-ink-400">
          <span>API Key (optional — falls back to .env.local)</span>
        </div>
        <input
          type="password"
          value={provider.apiKey}
          onChange={(e) => setProvider({ apiKey: e.target.value })}
          placeholder="sk-…"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
          autoComplete="off"
        />
        <div className="mt-1 text-[10px] text-ink-400">
          Held in server memory only for this analysis — never written to disk or sent to the browser again.
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onValidate}
          disabled={validating}
          className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs hover:bg-ink-700 disabled:opacity-50"
        >
          {validating ? 'Checking…' : 'Validate key'}
        </button>
        {validation && (
          <div
            className={`flex-1 truncate text-[11px] ${validation.ok ? 'text-green-300' : 'text-red-300'}`}
            title={validation.error}
          >
            {validation.ok ? '✓ Provider ready' : `✕ ${validation.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
