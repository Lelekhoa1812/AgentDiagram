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
  addStoredProject,
  readStoredProjects,
  removeStoredProject,
  writeStoredProjects,
  renameStoredProject,
  readActiveProjectId,
  writeActiveProjectId,
} from './projectStorage';

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

export interface LayerDiagram {
  name: string;
  description: string;
  dsl: string;
}

export interface MultiLayerOutput {
  /** High-level diagram covering all layers */
  overview: LayerDiagram;
  /** One sub-diagram per layer */
  layers: LayerDiagram[];
  generatedAt: number;
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
  hydrateUiPreferences: () => void;
  startAgent: (sessionId: string) => void;
  pushAgentLog: (entry: Omit<State['agentLog'][number], 'ts'>) => void;
  setAgentStage: (stage: string | null) => void;
  stopAgent: () => void;
  setMultiLayer: (output: MultiLayerOutput | null) => void;
  setActiveLayer: (name: string) => void;
  setQuickMode: (enabled: boolean) => void;
  addGeneratedProject: (name: string, dsl: string) => void;
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
      agentSessionId: null,
      agentRunning: false,
      agentStage: null,
      agentLog: [],
      multiLayer: null,
      activeLayer: 'overview',
      quickMode: false,
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
        // Motivation vs Logic: UI choices should survive reloads, but credentials stay session-only so localStorage never contradicts the API key copy.
        set((state) => ({
          generatedProjects,
          activeProjectId,
          ...(preferences.mode ? { mode: preferences.mode } : {}),
          ...(preferences.theme ? { theme: preferences.theme } : {}),
          ...(preferences.layoutStrategy ? { layoutStrategy: preferences.layoutStrategy } : {}),
          ...(preferences.diagramType ? { diagramType: preferences.diagramType } : {}),
          ...(preferences.focusPrompt !== undefined ? { focusPrompt: preferences.focusPrompt } : {}),
          ...(preferences.activeLayer ? { activeLayer: preferences.activeLayer } : {}),
          ...(preferences.dslText !== undefined ? { dslText: preferences.dslText } : {}),
          ...(preferences.quickMode !== undefined ? { quickMode: preferences.quickMode } : {}),
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
      setActiveLayer: (name) => {
        writeUiPreference('activeLayer', name);
        set({ activeLayer: name });
      },
      setQuickMode: (enabled) => {
        writeUiPreference('quickMode', enabled);
        set({ quickMode: enabled });
      },
      addGeneratedProject: (name, dsl) => {
        const project = addStoredProject(name, dsl);
        writeActiveProjectId(project.id);
        set((state) => ({
          generatedProjects: [project, ...state.generatedProjects],
          activeProjectId: project.id,
        }));
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
