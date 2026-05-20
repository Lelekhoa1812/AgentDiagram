# Architecture

```
                  Monaco DSL editor
                         │
                         v
       lib/dsl/lexer ─► parser ─► compiler ─► IR (lib/ir/types.ts)
                                                 │
                                                 v
                                lib/layout/elk (compound graph)
                                                 │
                                                 v
                              lib/render/svgScene (pure SVG)
                                  │              │
            components/diagram   ─┘              └─► lib/export/{svg,png}
                  (viewport)                          (same scene → guarantee
                                                       PNG-equals-screen)
```

Modules:

- **lib/dsl** — lexer, parser, compiler, formatter.
- **lib/ir** — typed Diagram IR (Group, Node, Edge).
- **lib/layout** — ELK compound-graph wrapper + measure helpers.
- **lib/render** — SVG scene builder, theme palette, arrow markers.
- **lib/icons** — inline Lucide-style SVG icon registry.
- **lib/export** — SVG / PNG export from the same scene as the viewport.
- **lib/state** — Zustand store with undo/redo (zundo temporal middleware)
  and IndexedDB persistence.
- **lib/security** — `pathGuard` blocks scanning sensitive system paths.
- **lib/agent** — repo scanner, classifier, chunker, summarizer, planner,
  DSL compiler, repair, cache, multi-provider router with retry.
- **lib/util/stream** — SSE helpers for the streamed analysis pipeline.
- **app/api/repo/scan** — server-only filesystem walk.
- **app/api/agent/analyze** — streamed staged pipeline (SSE).
- **app/api/agent/validate** — provider credential ping.
- **components/shell, editor, diagram, inspector, agent** — UI.

## Why SVG-first?

The same `buildScene()` function produces the React element tree shown
on screen *and* the SVG serialized into a PNG. There is no `html2canvas`
or screenshotting — the export is the exact same scene with a different
wrapper. This means:

- Group title pills, drop-shadow glows, arrow markers, and small labels
  are all included in the export at the correct bounding box.
- Export at 1x / 2x / 4x scales is a single canvas multiplier; nothing
  reflows.

## Why DSL-as-source-of-truth + side-car overrides?

Manual edits (drag a node, change a color in the inspector) split into two
buckets:

1. **Property edits** that have a DSL representation (color, icon, label,
   direction). These are written back into the Monaco text by a structured
   rewrite ([components/inspector/shared.ts](../components/inspector/shared.ts)).
2. **Spatial edits** (drag position, edge bend points). These go to a
   `overrides` map in Zustand and never touch the DSL — auto-layout
   regenerates positions, overrides win when present.

This lets the DSL stay clean, copy-pasteable, and AI-generatable while
still allowing arbitrary manual tweaks.

## Staged AI pipeline

See [providers.md](./providers.md) for the retry contract.

1. **Validate** — 1-token ping to confirm key + model.
2. **Scan** — `fast-glob` with `.gitignore` + safe defaults.
3. **Classify** — heuristic relevance scoring per diagram type + focus.
4. **Chunk** — token-aware splitting (4 chars ≈ 1 token).
5. **Summarize** — JSON-mode per-file summary, cached by content hash.
6. **Subsystem** — folder clustering (heuristic, no LLM).
7. **Plan** — JSON-schema-validated `DiagramPlan` from the model.
8. **Compile** — `planToDsl()` deterministic.
9. **Validate + Repair** — round-trip through the parser; one repair pass
   if needed.

Progress is streamed over SSE; the animation in
[AnalysisAnimation.tsx](../components/agent/AnalysisAnimation.tsx) reads
those events.
