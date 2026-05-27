# Code Space Agentic Runtime — Definitions of Done

## Objective

Code Space must behave like a real coding agent surface with Cursor-style Ask / Plan / Code modes, reviewable diffs, checkpointed writes, bounded terminal feedback, and repair loops. The implementation is not complete until the UI, route, runtime tools, patch system, validation, and rollback paths all satisfy the DoDs below.

## DoD 1 — Ask / Plan / Code mode parity

- Ask mode is strictly read-only.
- Ask mode can classify the task, inspect repository context, report evidence, and recommend next actions.
- Ask mode never emits `diff_proposed`, `file_applied`, or checkpoint-creating events.
- Plan mode creates or updates a markdown plan artifact under `.agent/plans/`.
- Plan mode includes assumptions, risks, implementation sequence, validation gates, rollback strategy, and open questions.
- Code mode emits reviewable diffs and never writes directly from the model response.
- Code mode always routes mutation through server-side patch preview/apply APIs.

## DoD 2 — Dynamic context discovery

- Context starts with explicit @ mentions, open tabs, and high-signal files.
- The agent can continue discovery through read/search/dependency-trace tools after the first turn.
- Target files must be read before edit proposals.
- Search snippets are never sufficient authority for mutation.
- Large outputs are stored as artifacts and accessed through bounded `read_artifact` or `grep_artifact` tools.
- Future LSP integration must provide definition, references, diagnostics, document symbols, workspace symbols, and call hierarchy.

## DoD 3 — Multi-agent orchestration readiness

- Complex tasks can trigger a 3 Explorers + 1 Critic workflow.
- Explorer agents are read-only and isolated from each other.
- Explorer outputs must include proposed approach, evidence, file list, risks, and confidence.
- The Critic must compare proposals, reject hallucinated claims, and select or synthesize the implementation plan.
- The Executor is the only role allowed to propose patches.
- Subagents start with blank context except inherited project rules such as `.cursorrules`, `CLAUDE.md`, `AGENTS.md`, or equivalent project guidance.

## DoD 4 — Surgical editing

- Model-facing edits use exact SEARCH/REPLACE edit blocks or server-generated before/after previews.
- The patch preview API rejects missing SEARCH blocks.
- The patch preview API rejects non-unique SEARCH blocks.
- The patch preview API rejects path traversal.
- Lightweight syntax pre-validation runs before any accepted patch is written.
- Whole-file rewrites are allowed only for new files or explicit full-file regeneration tasks.

## DoD 5 — Reviewable patch apply

- Every proposed mutation emits `diff_proposed` with old content, new content, explanation, and unified diff.
- The UI stores pending diffs until the user accepts or rejects them.
- Accepting a diff calls the patch apply API.
- Patch apply creates a checkpoint before writing.
- Patch apply verifies the current file still matches `beforeContent` before writing.
- Patch conflicts return a structured `PATCH_CONFLICT` response.
- Rejected diffs are removed from pending state without touching disk.

## DoD 6 — Verification and self-healing

- The runtime detects package-manager validation commands from project configuration.
- After accepted code patches, the agent should run available typecheck, lint, test, and build commands.
- Full command output is stored as an artifact, not injected wholesale into the model context.
- The agent reads targeted failure ranges from artifacts for repair.
- Repair turns stay scoped to changed or failing files.
- Repair loops stop after a bounded retry budget and mark the session `needs_review` when failures remain.
- A session is marked `verified` only when required validation passes after accepted changes.
- Refactor turns that rename or move files/folders must follow a move-first sequence: use shell-native operations (`mv`, `cp`, or `git mv` when available), search every affected importer and re-export, update references, then run the detected validation commands before the turn is considered complete.

## DoD 7 — Checkpoint and rollback

- Every patch apply creates a checkpoint snapshot of touched files.
- Checkpoints preserve whether a file existed before the patch.
- Restore rewrites previous content for existing files and deletes files created by the patch.
- Restore is deterministic and project-root guarded.
- UI must refresh tabs, file tree, pending diffs, and git status after restore.

## DoD 8 — Terminal safety

- Terminal commands are executed with command/args, not arbitrary shell strings, whenever possible.
- Shell-backed refactors should use `rg`/`grep` to find references, `mv`/`cp` for file moves and copies, and validation commands to confirm the workspace still compiles after path changes.
- Risky commands require approval.
- Network, install, delete, git push, migration, and credential-adjacent operations are approval-gated or blocked.
- Terminal logs are redacted for secrets before display or storage.
- Long logs are summarized and persisted as artifacts with read hints.

## DoD 9 — UI completeness

- The agent panel shows streamed chat, tool call status, validation results, and pending diffs.
- Pending diffs expose Apply and Reject actions.
- Validation results are visible and tied to commands.
- Checkpoint restore is reachable from applied patch state.
- Ask, Plan, and Code mode contracts are visible enough that users understand whether mutation will occur.

## DoD 10 — Non-regression gates

Before merging this runtime, run:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

If any command fails, store the full output as an artifact, repair surgically, and re-run the failing command.
