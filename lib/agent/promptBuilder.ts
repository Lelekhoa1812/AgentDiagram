import type { DiagramKind } from './classifier';
import { COLOR_NAMES } from '../ir/types';

export const DSL_GRAMMAR_SUMMARY = `
AgentDiagram DSL syntax:
- Comments start with // and extend to end of line.
- Groups:    Name [color: COLOR, icon: ICON] { ...children... }
- Nodes:     Name [color: COLOR, icon: ICON]
- Edges:     Source > Target           (forward)
             Source < Target           (reverse)
             Source <> Target          (bidirectional)
             Source -- Target          (dashed/related)
             Source => Target          (thick / primary path)
- Edge labels: Source > Target: label text
- Names CAN contain spaces, pipes (|), and ampersands (& or "and").
- Edge operators must be whitespace-surrounded so names can include "|" etc.
- Valid colors: ${COLOR_NAMES.join(', ')}.
- Output ONLY DSL. No code fences. No prose outside // comments.
`;

const DIAGRAM_KIND_HINTS: Record<DiagramKind, string> = {
  architecture: 'High-level system architecture: subsystems as groups, services/components as nodes, integration edges between them.',
  sequence: 'Sequence: participants as top-level nodes (no nesting), edges as ordered messages with descriptive labels.',
  class: 'Class diagram: each class is a node with shape: class, fields/methods listed where helpful, inheritance/composition via edges.',
  'data-flow': 'Data-flow: data sources → transformations → sinks. Use orthogonal flow direction; label edges with data type.',
  deployment: 'Deployment: environments, services, infra primitives. Group by environment, edge between deployable units.',
};

export function diagramHints(kind: DiagramKind): string {
  return DIAGRAM_KIND_HINTS[kind];
}
