# AgentDiagram

An open-source, locally-runnable diagram-as-code editor with an agentic repo explorer. Inspired by Eraser's diagram-as-code workflow, but with no external service dependency — the DSL, layout, renderer, exporter, and multi-provider AI pipeline all live in this repo.

Two modes share a single shell:

- **Code Editor Render** — paste DSL into Monaco, render it to a dark Eraser-style SVG diagram with nested colored groups and orthogonal edges, drag nodes/groups around, edit properties in the inspector, export PNG / SVG / JSON.
- **Agentic Repo Explorer** — pick OpenAI / Anthropic / Gemini / Azure Foundry, point at the repo you cloned this into, watch a polishe staged-analysis animation, then edit the generated diagram.

The reference example [`examples/FLOW.txt`](examples/FLOW.txt) renders in a style matching [`examples/v2.1.0.png`](examples/v2.1.0.png): near-black canvas, nested rounded containers with thin colored borders and tinted fills, small title pills on each group, compact icon+label nodes, and dense orthogonal connectors.

## Quick start

```bash
git clone <repo-url> path/to/your-project/AgentDiagram
cd path/to/your-project/AgentDiagram
cp .env.local.example .env.local      # fill in keys you intend to use
npm install
npm run dev
```

Open <http://localhost:3000>. The Agentic RFQ example is preloaded — you should see a dense colored architecture diagram render automatically.

## Layout

```
your-project/
├── src/ …
├── package.json
└── AgentDiagram/        ← this repo lives inside the repo it analyzes
```

By default the agent mode scans the parent of `AgentDiagram/`. Override with `AGENTDIAGRAM_DEFAULT_REPO_PATH` or by typing a different absolute path in the UI.

## DSL at a glance

```
Frontend [color: sky, icon: monitor] {
  UI [icon: layout]
  Router [icon: git-branch]
}

API [color: indigo, icon: server] {
  Auth [icon: shield]
}

UI > Router
Router > Auth
Router <> Auth: bidirectional
Auth -- Router         // dashed
```

Names can contain spaces, pipes (`Tables from DOCX | PDF`), and ampersands (`Quality & Sanitize`). Edge operators (`>`, `<`, `<>`, `--`, `=>`) must have whitespace on both sides.

Full grammar: [docs/dsl-grammar.md](docs/dsl-grammar.md).

## AI providers

| Provider     | Env var            | Default model              |
|--------------|--------------------|----------------------------|
| OpenAI       | `OPENAI_API_KEY`   | `gpt-5.5`                  |
| Anthropic    | `CLAUDE_API_KEY`   | `opus-4.7`                 |
| Gemini       | `GEMINI_API_KEY`   | `gemini-3.1-pro`           |
| Grok (xAI)   | `GROK_API_KEY`     | `grok-3`                   |
| Azure Foundry| `FOUNDRY_API_KEY`  | custom deployment name     |

Every provider call goes through an **infinite-retry wrapper with exponential backoff and `Retry-After` honoring**. The UI shows "Retrying in 8s (attempt 3)" live during analysis and lets you cancel.

Details: [docs/providers.md](docs/providers.md).

## Architecture

[docs/architecture.md](docs/architecture.md) — module map, why SVG-first, why DSL-as-source-of-truth + side-car overrides, the staged AI pipeline.

## Scripts

```bash
npm run dev          # dev server (http://localhost:3000)
npm run build        # production build
npm run start        # serve production build
npm run lint         # ESLint
npm run typecheck    # TypeScript without emit
npm test             # Vitest
npm run test:e2e     # Playwright
npm run test:visual  # visual regression vs examples/v2.1.0.png
```

## Privacy

- Repo scanning happens **server-side on your own machine**. AI calls send only **selected file chunks** plus per-file summaries, not the whole repo.
- Per-file summaries are cached locally under `.agentdiagram-cache/` (gitignored). The cache is keyed on `sha1(provider | model | path | content)` so unchanged files skip the LLM call on repeat runs.
- API keys you type into the UI live only in server-process memory for the current analysis. They are not written to disk, not echoed back to the browser, and not logged.

## Known limitations

- Sequence and class diagrams parse and render through the same flow layout for v1. Dedicated sequence (lifelines) and class (header / fields / methods) layouts are planned.
- No multi-user persistence; projects save to IndexedDB or as `.diagram.json` files.
- The default model names (`gpt-5.5`, `opus-4.7`, `gemini-3.1-pro`, `grok-3`) match the configured values. If a model isn't yet available on your account, switch via the dropdown — `OPENAI_MODEL` / `CLAUDE_MODEL` / `GEMINI_MODEL` / `GROK_MODEL` envs also override the in-app default.

## License
MIT — see [LICENSE](LICENSE).
