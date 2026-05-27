# Code Space UI Improvements

## Summary
Polish the Code Space right panel by compacting the section headers, renaming the patch review area to `Review`, expanding the chat input into a 5-row textarea, and adding an `@` file-mention input with ghost-overlay highlighting.

## Key Changes
- Compact `components/code-space/CollapsibleSection.tsx` so the headers feel denser and visually consistent with the rest of the Code Space sidebar.
- Update `components/code-space/AgentPanel.tsx` so the review section is labeled `Review` instead of `Patch Review`.
- Replace the single-line prompt input in `components/code-space/AgentPanel.tsx` with a growing textarea that supports `Shift+Enter` for newline entry and keeps the send button aligned to the bottom edge.
- Add a reusable `components/code-space/FileMentionInput.tsx` component that handles `@`-triggered file lookup, ghost overlay rendering, and keyboard navigation.
- Wire `components/code-space/CodeSpaceWorkspace.tsx` to pass the project file path list into `AgentPanel`, then down into the new mention input component.
- Add focused tests around the new file mention component and the revised Code Space sidebar interactions.

## Test Plans
- Add component coverage for `FileMentionInput`:
  - it renders a textarea
  - it opens the suggestion dropdown when `@` is typed
  - it hides the dropdown when no mention is active
  - it inserts the selected file mention on `Enter`
  - it preserves newline entry with `Shift+Enter`
- Add component coverage for `AgentPanel`:
  - `View plan...` still opens the current plan artifact
  - the build button hides once the plan has been built
  - the code changes rail still shows applied patches
- Add a typecheck pass after the sidebar edits.

## Assumptions
- The new file mention experience is limited to the Code Space chat input, not the entire app shell.
- The component should reuse existing Code Space file lists and mention utilities rather than inventing a second lookup index.
- The right-panel UI is intended to stay visually compact rather than growing into a broader command palette.
