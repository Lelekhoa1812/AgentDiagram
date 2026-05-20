'use client';

import { useDiagramStore } from '@/lib/state/store';
import flowExample from '../../examples/flow.txt';
import tinyExample from '../../examples/tiny-flow.txt';
import sequenceExample from '../../examples/sequence.txt';
import umlExample from '../../examples/uml.txt';

interface DefaultProject {
  id: string;
  label: string;
  dsl: string;
}

const DEFAULT_PROJECTS: DefaultProject[] = [
  { id: 'default:saas', label: 'SaaS', dsl: flowExample as unknown as string },
  { id: 'default:flow', label: 'Flow', dsl: tinyExample as unknown as string },
  { id: 'default:sequence', label: 'Sequence', dsl: sequenceExample as unknown as string },
  { id: 'default:uml', label: 'UML', dsl: umlExample as unknown as string },
];

export function ExampleLoader() {
  const setDsl = useDiagramStore((s) => s.setDsl);
  const clear = useDiagramStore((s) => s.clearOverrides);
  const activeProjectId = useDiagramStore((s) => s.activeProjectId);
  const setActiveProjectId = useDiagramStore((s) => s.setActiveProjectId);
  const generatedProjects = useDiagramStore((s) => s.generatedProjects);
  const removeGeneratedProject = useDiagramStore((s) => s.removeGeneratedProject);

  const loadProject = (id: string, dsl: string) => {
    clear();
    setDsl(dsl);
    setActiveProjectId(id);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span className="mr-1 shrink-0 text-[10px] uppercase tracking-[0.18em] text-ink-400">Projects</span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {DEFAULT_PROJECTS.map((proj) => {
          const isActive = activeProjectId === proj.id;
          return (
            <button
              key={proj.id}
              onClick={() => loadProject(proj.id, proj.dsl)}
              className={`surface-transition shrink-0 rounded-md border px-2.5 py-1.5 text-[11px] hover:-translate-y-0.5 ${
                isActive
                  ? 'border-accent/60 bg-accent/10 text-ink-100'
                  : 'border-ink-700 bg-ink-900 text-ink-200 hover:border-accent/50 hover:text-ink-100'
              }`}
              type="button"
            >
              {proj.label}
            </button>
          );
        })}

        {generatedProjects.length > 0 && (
          <span className="shrink-0 text-ink-700">|</span>
        )}

        {generatedProjects.map((proj) => {
          const isActive = activeProjectId === proj.id;
          return (
            <span
              key={proj.id}
              className={`surface-transition group flex shrink-0 items-center gap-0.5 rounded-md border text-[11px] hover:-translate-y-0.5 ${
                isActive
                  ? 'border-accent/60 bg-accent/10'
                  : 'border-ink-700 bg-ink-900 hover:border-accent/50'
              }`}
            >
              <button
                onClick={() => loadProject(proj.id, proj.dsl)}
                className={`px-2.5 py-1.5 ${isActive ? 'text-ink-100' : 'text-ink-200 hover:text-ink-100'}`}
                type="button"
              >
                {proj.name}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeGeneratedProject(proj.id);
                }}
                className="mr-1 flex h-4 w-4 items-center justify-center rounded-sm text-ink-500 opacity-0 transition-opacity hover:bg-ink-700 hover:text-ink-200 group-hover:opacity-100"
                type="button"
                title="Remove project"
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
