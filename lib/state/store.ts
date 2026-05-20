'use client';

import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Diagram, Point } from '../ir/types';
import type { LayoutResult, LayoutRect } from '../layout/elk';
import type { LayoutStrategy } from '../layout/strategies';
import type { ProviderId } from '../agent/providers/types';

export type Mode = 'editor' | 'agent' | 'multi-layer';
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
  model: 'gpt-5.5',
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
  startAgent: (sessionId: string) => void;
  pushAgentLog: (entry: Omit<State['agentLog'][number], 'ts'>) => void;
  setAgentStage: (stage: string | null) => void;
  stopAgent: () => void;
  setMultiLayer: (output: MultiLayerOutput | null) => void;
  setActiveLayer: (name: string) => void;
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
      setMode: (mode) => set({ mode }),
      setTheme: (theme) => set({ theme }),
      setDsl: (text) => set({ dslText: text }),
      setDiagram: (diagram) => set({ diagram }),
      setLayoutResult: (result) => set({ layoutResult: result }),
      setStrategy: (strategy) => set({ layoutStrategy: strategy }),
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
      setProvider: (cfg) => set((state) => ({ provider: { ...state.provider, ...cfg } })),
      setDiagramType: (t) => set({ diagramType: t }),
      setFocusPrompt: (s) => set({ focusPrompt: s }),
      startAgent: (sessionId) =>
        set({ agentSessionId: sessionId, agentRunning: true, agentLog: [], agentStage: null }),
      pushAgentLog: (entry) =>
        set((state) => ({ agentLog: [...state.agentLog, { ts: Date.now(), ...entry }] })),
      setAgentStage: (stage) => set({ agentStage: stage }),
      stopAgent: () => set({ agentRunning: false, agentSessionId: null }),
      setMultiLayer: (output) =>
        set({ multiLayer: output, activeLayer: output ? 'overview' : 'overview' }),
      setActiveLayer: (name) => set({ activeLayer: name }),
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
