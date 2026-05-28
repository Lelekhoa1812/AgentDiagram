# Code Space agent behavior review plan

## Goal
Implement Cursor-like review behavior for agent-generated code changes in Code Space while preserving current execution-policy semantics and session history.

## Current behavior summary (from code)

### Sidebar review panel (`AgentPanel`)
- The `Code changes` section is rendered from merged `pendingDiffs` and `appliedDiffs` (`visibleDiffs`).
- In Confirm policy (`executionPolicy !== 'auto'`), pending diff cards show per-card **Reject** and **Apply** actions.
- In Auto policy, pending diffs are auto-applied from `CodeSpaceWorkspace` via an effect watching `executionPolicy === 'auto'`.
- Diff display already supports line-level red/green styling in `renderDiff` when content is a unified diff.

### Workspace (`CodeSpaceWorkspace`)
- Contains core handlers for:
  - `acceptPendingDiff(diffId)` and `rejectPendingDiff(diffId)`.
  - Auto-apply effect that applies all pending diffs in Auto mode.
- Does **not** currently wire file-card click interactions from sidebar to open the corresponding editor file.
- Monaco editor currently opens editable file content only; there is no overlay of pending hunks, inline hunk controls, or side-by-side diff editor for review.

## Requirement-by-requirement implementation plan

### 1) Confirm mode must always show Accept/Reject controls (Auto mode can auto-apply)

#### Required changes
1. **Enforce policy contract in UI + guardrails**
   - Keep per-diff action buttons visible whenever `diff.kind === 'pending' && executionPolicy !== 'auto'`.
   - Add a dedicated **pending review header action group** in `AgentPanel` (optional but recommended) with "Accept all" / "Reject all" in Confirm mode only.
2. **Prevent accidental auto application in Confirm mode**
   - Keep auto-apply effect gated by `executionPolicy === 'auto'` (already present), and add test coverage so this cannot regress.
3. **Label consistency**
   - Rename button text from `Apply` to `Accept` for parity with product requirement language.

#### Tests
- `AgentPanel` unit test: Confirm mode shows both buttons for each pending card.
- `AgentPanel` unit test: Auto mode does not show per-card pending buttons and shows auto status label.
- `CodeSpaceWorkspace` unit test: pending diffs are auto-applied only when policy is Auto.

---

### 2) Clicking file cards in Code Changes opens that file in editor

#### Required changes
1. **Prop plumbing**
   - Add `onOpenDiffFile?: (filePath: string) => void` to `AgentPanelProps`.
   - Pass callback from `CodeSpaceWorkspace` where `activeProject` + `openFile(project, filePath)` are available.
2. **Card interaction UX**
   - Make file path row (or whole card header) a button with hover/focus state and keyboard support.
   - On click:
     - Resolve file path against active project.
     - Open file tab if not open; focus existing tab if open.
3. **Edge handling**
   - If file no longer exists (deleted patch), show non-blocking toast/status message.

#### Tests
- `AgentPanel` test: clicking file card invokes callback with correct path.
- `CodeSpaceWorkspace` integration-like component test: callback opens/focuses tab.

---

### 3) Show proper red/green git diff for changed files

#### Required changes
1. **Normalize diff source**
   - Ensure pending cards always receive `unifiedDiff` for display when available from runtime patch output.
   - If unavailable, generate unified diff in client using previous/new content and hunk headers (small utility in `lib/code-space`), instead of current fallback `oldContent --- newContent` block.
2. **Improve diff renderer fidelity**
   - Preserve context lines, headers (`diff --git`, `index`, `---`, `+++`, `@@`) with dedicated classes.
   - Add gutter indicators (+/-) and optional split-view toggle later (phase 2).
3. **Consistency across pending/applied views**
   - Applied cards should retain rendered unified diff snapshot (if available) so historical review remains colorized.

#### Tests
- Snapshot test for unified diff render with mixed additions/deletions.
- Utility test for fallback unified diff generation.

---

### 4) In-editor diff visibility + per-hunk Accept/Reject (Cursor-like)

#### Architectural approach (recommended)
1. **Introduce review state model**
   - New derived selector in workspace: `pendingDiffsByFile`, each containing parsed hunks.
   - Parse unified diff into structured hunks (`filePath`, `header`, `oldStart`, `oldLines`, `newStart`, `newLines`, `patchText`, `accepted?`).
2. **Monaco integration strategy**
   - Phase 1 (faster):
     - Use Monaco decorations to color changed ranges in the active editor.
     - Add inline CodeLens-style commands above each hunk: `Accept hunk` / `Reject hunk`.
   - Phase 2 (enhanced):
     - Add optional side-by-side `DiffEditor` mode toggle for active file review.
3. **Patch-level apply/reject actions**
   - Extend callbacks to support hunk granularity:
     - `onAcceptDiff(diffId, hunkId?)`
     - `onRejectDiff(diffId, hunkId?)`
   - Update patch application pipeline to apply subset hunks safely (server-side preferred for correctness); fallback client patching must validate context.
4. **Sidebar ↔ editor synchronization**
   - Selecting a diff card sets `selectedDiffFilePath`.
   - Opening file auto-scrolls to first pending hunk.
   - Accept/reject actions from editor instantly update sidebar counts and card status.

#### Risks / constraints
- Partial-hunk apply is the hardest part; naive text replacement risks corruption when file drift exists.
- Best practice: add API endpoint to apply/reject selected hunk IDs atomically against current file hash.

#### Tests
- Hunk parser unit tests with multi-hunk files.
- Editor decoration tests (or integration tests with Monaco mocks).
- Apply/reject hunk flow test ensuring only selected hunk is committed and pending state updates.

## Proposed delivery phases

### Phase A (low risk, high impact)
- Confirm-mode button guarantees + button label normalization.
- File-card click opens editor file.
- Better unified diff rendering in sidebar.

### Phase B (core review UX)
- Active-file diff decorations in Monaco.
- Hunk parsing and per-hunk Accept/Reject controls in editor.

### Phase C (polish)
- Optional side-by-side DiffEditor mode.
- Accept/Reject all hunks per file, keyboard shortcuts, improved scrolling/selection.

## Suggested file touch list
- `components/code-space/AgentPanel.tsx`
- `components/code-space/CodeSpaceWorkspace.tsx`
- `components/code-space/__tests__/AgentPanel.test.tsx`
- (new) `lib/code-space/diff/unified.ts` (fallback diff generation + parsing helpers)
- (new tests) `lib/code-space/__tests__/unifiedDiff.test.ts`

## Acceptance criteria checklist
- In Confirm mode, each pending diff always has visible Accept and Reject actions.
- In Auto mode, pending diffs auto-apply without manual actions.
- Clicking a file card opens/focuses that file in editor.
- Sidebar diff blocks render proper red/green unified diff lines.
- Editor shows pending diff ranges for currently opened changed file.
- User can Accept/Reject individual hunks from editor UI; sidebar stays in sync.
