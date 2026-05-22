'use client';

import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Diagram, Point } from '../ir/types';
import type { LayoutResult, LayoutRect } from '../layout/elk';
import type { LayoutStrategy } from '../layout/strategies';
import { getProviderDefaultModel } from '@/lib/agent/provider-models';
import type { ProviderId } from '../agent/providers/types';
import { readUiPreferences, writeUiPreference } from './uiPreferences';
import {
  type StoredProject,
  type MultiLayerOutput,
  addStoredProject,
  readStoredProjects,
  removeStoredProject,
  writeStoredProjects,
  renameStoredProject,
  readActiveProjectId,
  writeActiveProjectId,
} from './projectStorage';

// Re-export so all existing imports from this module continue to work.
export type { LayerDiagram, MultiLayerOutput } from './projectStorage';

export type Mode = 'editor' | 'agent' | 'multi-layer' | 'custom-prompt';
export type ThemeMode = 'dark' | 'light';

export type SelectionKind = 'node' | 'group' | 'edge' | null;

export interface Selection {
  id: string | null;
  kind: SelectionKind;
}

export interface Overrides {
  nodes: Record<string, Partial<LayoutRect>>;
  groups: Record<string, Partial<LayoutRect>>;
  edges: Record<string, { bends: Point[] }>;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  customModel?: string;
  endpoint?: string;
}

const DEFAULT_PROVIDER: ProviderConfig = {
  provider: 'openai',
  model: getProviderDefaultModel('openai'),
  apiKey: '',
};

interface State {
  mode: Mode;
  theme: ThemeMode;
  dslText: string;
  diagram: Diagram | null;
  layoutResult: LayoutResult | null;
  layoutStrategy: LayoutStrategy;
  overrides: Overrides;
  selection: Selection;
  viewport: Viewport;
  provider: ProviderConfig;
  diagramType: 'architecture' | 'sequence' | 'class' | 'data-flow' | 'deployment';
  focusPrompt: string;
  instructionMarkdown: string;

  // Agent mode
  agentSessionId: string | null;
  agentRunning: boolean;
  agentStage: string | null;
  agentLog: Array<{ ts: number; stage: string; message: string; level: 'info' | 'warn' | 'error' }>;

  // Multi-Layer mode
  multiLayer: MultiLayerOutput | null;
  activeLayer: string; // 'overview' or one of layers[*].name

  // Quick Mode: skip per-file LLM summarization in agent pipelines. Default off.
  quickMode: boolean;

  // MAX Mode: remove the default relevance cap so analysis can consider every scanned file.
  maxMode: boolean;

  // Instruction Mode: generate a Markdown implementation guide alongside the diagram.
  instructionMode: boolean;

  // Project tabs — user-generated projects saved to localStorage
  generatedProjects: StoredProject[];
  activeProjectId: string | null;

  setMode: (mode: Mode) => void;
  setTheme: (theme: ThemeMode) => void;
  setDsl: (text: string) => void;
  setDiagram: (diagram: Diagram | null) => void;
  setLayoutResult: (result: LayoutResult | null) => void;
  setStrategy: (strategy: LayoutStrategy) => void;
  setOverride: <K extends keyof Overrides>(scope: K, id: string, value: Overrides[K][string]) => void;
  clearOverrides: () => void;
  setSelection: (sel: Selection) => void;
  setViewport: (v: Viewport) => void;
  setProvider: (cfg: Partial<ProviderConfig>) => void;
  setDiagramType: (t: State['diagramType']) => void;
  setFocusPrompt: (s: string) => void;
  setInstructionMarkdown: (markdown: string) => void;
  hydrateUiPreferences: () => void;
  startAgent: (sessionId: string) => void;
  pushAgentLog: (entry: Omit<State['agentLog'][number], 'ts'>) => void;
  setAgentStage: (stage: string | null) => void;
  stopAgent: () => void;
  setMultiLayer: (output: MultiLayerOutput | null) => void;
  setActiveLayer: (name: string) => void;
  setQuickMode: (enabled: boolean) => void;
  setMaxMode: (enabled: boolean) => void;
  setInstructionMode: (enabled: boolean) => void;
  addGeneratedProject: (name: string, dsl: string, multiLayer?: MultiLayerOutput, instructionMarkdown?: string) => void;
  openProject: (project: { id: string; dsl: string; multiLayer?: MultiLayerOutput | null; instructionMarkdown?: string }) => void;
  removeGeneratedProject: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
  renameGeneratedProject: (id: string, name: string) => void;
  reorderGeneratedProjects: (projects: StoredProject[]) => void;
}

export const useDiagramStore = create<State>()(
  temporal(
    (set) => ({
      mode: 'editor',
      theme: 'dark',
      dslText: '',
      diagram: null,
      layoutResult: null,
      layoutStrategy: 'auto',
      overrides: { nodes: {}, groups: {}, edges: {} },
      selection: { id: null, kind: null },
      viewport: { x: 0, y: 0, scale: 1 },
      provider: DEFAULT_PROVIDER,
      diagramType: 'architecture',
      focusPrompt: '',
      instructionMarkdown: '',
      agentSessionId: null,
      agentRunning: false,
      agentStage: null,
      agentLog: [],
      multiLayer: null,
      activeLayer: 'overview',
      quickMode: false,
      maxMode: false,
      instructionMode: false,
      generatedProjects: [],
      activeProjectId: null,
      setMode: (mode) => {
        writeUiPreference('mode', mode);
        set({ mode });
      },
      setTheme: (theme) => {
        writeUiPreference('theme', theme);
        set({ theme });
      },
      setDsl: (text) => {
        writeUiPreference('dslText', text);
        set({ dslText: text });
      },
      setDiagram: (diagram) => set({ diagram }),
      setLayoutResult: (result) => set({ layoutResult: result }),
      setStrategy: (strategy) => {
        writeUiPreference('layoutStrategy', strategy);
        set({ layoutStrategy: strategy });
      },
      setOverride: (scope, id, value) =>
        set((state) => ({
          overrides: {
            ...state.overrides,
            [scope]: { ...state.overrides[scope], [id]: value },
          },
        })),
      clearOverrides: () => set({ overrides: { nodes: {}, groups: {}, edges: {} } }),
      setSelection: (sel) => set({ selection: sel }),
      setViewport: (v) => set({ viewport: v }),
      setProvider: (cfg) =>
        set((state) => {
          const provider = { ...state.provider, ...cfg };
          writeUiPreference('provider', {
            provider: provider.provider,
            model: provider.model,
            customModel: provider.customModel,
            endpoint: provider.endpoint,
          });
          return { provider };
        }),
      setDiagramType: (t) => {
        writeUiPreference('diagramType', t);
        set({ diagramType: t });
      },
      setFocusPrompt: (s) => {
        writeUiPreference('focusPrompt', s);
        set({ focusPrompt: s });
      },
      hydrateUiPreferences: () => {
        const preferences = readUiPreferences();
        const generatedProjects = readStoredProjects();
        const activeProjectId = readActiveProjectId();
        const activeProject = generatedProjects.find((p) => p.id === activeProjectId);
        const restoredMultiLayer = activeProject?.multiLayer ?? null;
        const restoredDsl = activeProject?.dsl ?? preferences.dslText;
        const restoredInstructionMarkdown = activeProject?.instructionMarkdown ?? preferences.instructionMarkdown ?? '';
        // Root Cause vs Logic: the active project tab and the editor text were restored from different localStorage keys, so a generated repo tab could show stale scratch text like "/" and render no diagram. Prefer the active project's saved DSL whenever that project still exists.
        set((state) => ({
          generatedProjects,
          activeProjectId,
          multiLayer: restoredMultiLayer,
          ...(preferences.mode ? { mode: preferences.mode } : {}),
          ...(preferences.theme ? { theme: preferences.theme } : {}),
          ...(preferences.layoutStrategy ? { layoutStrategy: preferences.layoutStrategy } : {}),
          ...(preferences.diagramType ? { diagramType: preferences.diagramType } : {}),
          ...(preferences.focusPrompt !== undefined ? { focusPrompt: preferences.focusPrompt } : {}),
          instructionMarkdown: restoredInstructionMarkdown,
          ...(preferences.activeLayer ? { activeLayer: preferences.activeLayer } : {}),
          ...(restoredDsl !== undefined ? { dslText: restoredDsl } : {}),
          ...(preferences.quickMode !== undefined ? { quickMode: preferences.quickMode } : {}),
          ...(preferences.maxMode !== undefined ? { maxMode: preferences.maxMode } : {}),
          ...(preferences.instructionMode !== undefined ? { instructionMode: preferences.instructionMode } : {}),
          ...(preferences.provider
            ? {
                provider: {
                  ...state.provider,
                  ...preferences.provider,
                  apiKey: state.provider.apiKey,
                },
              }
            : {}),
        }));
      },
      startAgent: (sessionId) =>
        set({ agentSessionId: sessionId, agentRunning: true, agentLog: [], agentStage: null }),
      pushAgentLog: (entry) =>
        set((state) => ({ agentLog: [...state.agentLog, { ts: Date.now(), ...entry }] })),
      setAgentStage: (stage) => set({ agentStage: stage }),
      stopAgent: () => set({ agentRunning: false, agentSessionId: null }),
      setMultiLayer: (output) =>
        set({ multiLayer: output, activeLayer: output ? 'overview' : 'overview' }),
      setInstructionMarkdown: (markdown) => {
        writeUiPreference('instructionMarkdown', markdown);
        set({ instructionMarkdown: markdown });
      },
      setActiveLayer: (name) => {
        writeUiPreference('activeLayer', name);
        set({ activeLayer: name });
      },
      setQuickMode: (enabled) => {
        writeUiPreference('quickMode', enabled);
        set({ quickMode: enabled });
      },
      setMaxMode: (enabled) => {
        writeUiPreference('maxMode', enabled);
        set({ maxMode: enabled });
      },
      setInstructionMode: (enabled) => {
        writeUiPreference('instructionMode', enabled);
        set({ instructionMode: enabled });
      },
      addGeneratedProject: (name, dsl, multiLayer?, instructionMarkdown?) => {
        const project = addStoredProject(name, dsl, multiLayer, instructionMarkdown);
        writeActiveProjectId(project.id);
        if (instructionMarkdown !== undefined) writeUiPreference('instructionMarkdown', instructionMarkdown);
        set((state) => ({
          generatedProjects: [project, ...state.generatedProjects],
          activeProjectId: project.id,
          instructionMarkdown: instructionMarkdown ?? '',
          ...(multiLayer ? { multiLayer, activeLayer: 'overview' } : {}),
        }));
      },
      openProject: (project) => {
        writeUiPreference('dslText', project.dsl);
        writeUiPreference('instructionMarkdown', project.instructionMarkdown ?? '');
        writeActiveProjectId(project.id);
        set({
          dslText: project.dsl,
          activeProjectId: project.id,
          multiLayer: project.multiLayer ?? null,
          instructionMarkdown: project.instructionMarkdown ?? '',
          activeLayer: 'overview',
          overrides: { nodes: {}, groups: {}, edges: {} },
        });
      },
      removeGeneratedProject: (id) => {
        removeStoredProject(id);
        set((state) => {
          const generatedProjects = state.generatedProjects.filter((p) => p.id !== id);
          const activeProjectId = state.activeProjectId === id ? null : state.activeProjectId;
          if (state.activeProjectId === id) writeActiveProjectId(null);
          return { generatedProjects, activeProjectId };
        });
      },
      setActiveProjectId: (id) => {
        writeActiveProjectId(id);
        set({ activeProjectId: id });
      },
      renameGeneratedProject: (id, name) => {
        renameStoredProject(id, name);
        set((state) => ({
          generatedProjects: state.generatedProjects.map((p) => (p.id === id ? { ...p, name } : p)),
        }));
      },
      reorderGeneratedProjects: (projects) => {
        writeStoredProjects(projects);
        set({ generatedProjects: projects });
      },
    }),
    {
      partialize: (state) => ({
        dslText: state.dslText,
        overrides: state.overrides,
        theme: state.theme,
      }),
      limit: 100,
    },
  ),
);
