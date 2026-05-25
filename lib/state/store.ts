'use client';

import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Diagram, Point } from '../ir/types';
import type { LayoutResult, LayoutRect } from '../layout/elk';
import type { LayoutStrategy } from '../layout/strategies';
import { getProviderDefaultModel } from '@/lib/agent/utils/provider-models';
import type { ProviderId } from '../agent/providers/types';
import { readUiPreferences, writeUiPreference } from './uiPreferences';
import { saveDraft, deleteDraft, loadDraft } from '../cache/draftCache';
import {
  type StoredProject,
  type MultiLayerOutput,
  type LayerDiagram,
  addStoredProject,
  readStoredProjects,
  removeStoredProject,
  writeStoredProjects,
  applyProjectDsl,
  getMultiLayerDsl,
  renameStoredProject,
  readActiveProjectId,
  writeActiveProjectId,
} from './projectStorage';

// Re-export so all existing imports from this module continue to work.
export type { LayerDiagram, MultiLayerOutput } from './projectStorage';

// ---------------------------------------------------------------------------
// IndexedDB draft autosave
// ---------------------------------------------------------------------------
// Rapid keystrokes and drag events call setDsl / setOverride many times per
// second. Debouncing at 800 ms means we batch all of those into a single IDB
// write that fires shortly after the user pauses — cheap enough to ignore.
//
// _getState is populated the moment the Zustand creator runs (before any
// action can be dispatched), so the timer callback always finds it ready.
// ---------------------------------------------------------------------------
let _draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
const DRAFT_DEBOUNCE_MS = 800;
let _getState: (() => State) | null = null;

function scheduleDraftSave(): void {
  if (typeof window === 'undefined') return; // SSR guard
  if (_draftSaveTimer !== null) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(() => {
    _draftSaveTimer = null;
    if (!_getState) return;
    const state = _getState();
    const key = state.activeProjectId ?? 'scratch';
    saveDraft(key, state.dslText, state.overrides);
  }, DRAFT_DEBOUNCE_MS);
}

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

  // Multi-select: additional selected items beyond the primary `selection`.
  // Each entry mirrors the same { id, kind } shape so the canvas and scene
  // builder can treat them uniformly with the primary selection.
  multiSelection: { id: string; kind: 'node' | 'group' | 'edge' }[];

  /**
   * Apply a persisted draft (DSL + overrides) loaded from IndexedDB on page
   * start.  Deliberately bypasses localStorage writes and the draft-save
   * debounce so we don't immediately re-write what we just read.
   */
  applyDraft: (dslText: string, overrides: Overrides) => void;
  /**
   * Toggle one item in the multi-selection.  If the item is already present
   * it is removed; otherwise it is added.  The primary `selection` is left
   * unchanged so the inspector keeps showing the last explicitly-clicked item.
   */
  toggleMultiSelectItem: (item: { id: string; kind: 'node' | 'group' | 'edge' }) => void;
  /** Remove all items from the multi-selection (keeps the primary selection). */
  clearMultiSelection: () => void;
  setMode: (mode: Mode) => void;
  setTheme: (theme: ThemeMode) => void;
  setDsl: (text: string) => void;
  setDiagram: (diagram: Diagram | null) => void;
  setLayoutResult: (result: LayoutResult | null) => void;
  setStrategy: (strategy: LayoutStrategy) => void;
  setOverride: <K extends keyof Overrides>(
    scope: K,
    id: string,
    value: Overrides[K][string],
  ) => void;
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
  addSubLayers: (subLayers: LayerDiagram[]) => void;
  removeLayer: (name: string) => void;
  addGeneratedProject: (
    name: string,
    dsl: string,
    multiLayer?: MultiLayerOutput,
    instructionMarkdown?: string,
  ) => void;
  openProject: (project: {
    id: string;
    dsl: string;
    multiLayer?: MultiLayerOutput | null;
    instructionMarkdown?: string;
  }) => void;
  removeGeneratedProject: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
  renameGeneratedProject: (id: string, name: string) => void;
  reorderGeneratedProjects: (projects: StoredProject[]) => void;
}

export const useDiagramStore = create<State>()(
  temporal(
    (set, get) => {
      // Capture Zustand's getter so the draft-save timer can always read the
      // latest state without holding a reference to the store export itself.
      _getState = get;
      return {
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
      multiSelection: [],
      applyDraft: (dslText, overrides) => {
        // Applied once on page load from IndexedDB — bypasses localStorage writes
        // and does NOT schedule a new IndexedDB write to avoid a pointless round-trip.
        set({ dslText, overrides });
      },
      toggleMultiSelectItem: (item) =>
        set((state) => {
          const exists = state.multiSelection.some((i) => i.id === item.id);
          return {
            multiSelection: exists
              ? state.multiSelection.filter((i) => i.id !== item.id)
              : [...state.multiSelection, item],
          };
        }),
      clearMultiSelection: () => set({ multiSelection: [] }),
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
        scheduleDraftSave(); // Also persists to IndexedDB (debounced 800 ms)
        set((state) => {
          if (state.activeProjectId) {
            let multiLayer = state.multiLayer;
            let didUpdateProject = false;
            // Motivation vs Logic: DSL edits are autosaved through one project-shaping path so the root project DSL and any active multi-layer tab stay in sync across tab switches and browser reloads.
            const generatedProjects = state.generatedProjects.map((project) => {
              if (project.id !== state.activeProjectId) return project;
              didUpdateProject = true;
              const updatedProject = applyProjectDsl(project, text, state.activeLayer);
              multiLayer = updatedProject.multiLayer ?? null;
              return updatedProject;
            });
            if (didUpdateProject) writeStoredProjects(generatedProjects);
            return {
              dslText: text,
              generatedProjects,
              multiLayer,
            };
          }
          return { dslText: text };
        });
      },
      setDiagram: (diagram) => set({ diagram }),
      setLayoutResult: (result) => set({ layoutResult: result }),
      setStrategy: (strategy) => {
        writeUiPreference('layoutStrategy', strategy);
        set({ layoutStrategy: strategy });
      },
      setOverride: (scope, id, value) => {
        scheduleDraftSave(); // Persist drag-override positions to IndexedDB
        set((state) => ({
          overrides: {
            ...state.overrides,
            [scope]: { ...state.overrides[scope], [id]: value },
          },
        }));
      },
      clearOverrides: () => {
        scheduleDraftSave(); // Write empty overrides so the cleared state is persisted
        set({ overrides: { nodes: {}, groups: {}, edges: {} } });
      },
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
        const preferredActiveLayer = preferences.activeLayer ?? 'overview';
        const restoredActiveLayer =
          restoredMultiLayer &&
          getMultiLayerDsl(restoredMultiLayer, preferredActiveLayer) !== undefined
            ? preferredActiveLayer
            : 'overview';
        const restoredDsl = activeProject
          ? restoredMultiLayer
            ? (getMultiLayerDsl(restoredMultiLayer, restoredActiveLayer) ?? activeProject.dsl)
            : activeProject.dsl
          : preferences.dslText;
        const restoredInstructionMarkdown =
          activeProject?.instructionMarkdown ?? preferences.instructionMarkdown ?? '';
        // Root Cause vs Logic: the active project tab and the editor text were restored from different localStorage keys, so a generated repo tab could show stale scratch text like "/" and render no diagram. Prefer the active project's saved DSL whenever that project still exists.
        set((state) => ({
          generatedProjects,
          activeProjectId,
          multiLayer: restoredMultiLayer,
          activeLayer: restoredActiveLayer,
          ...(preferences.mode ? { mode: preferences.mode } : {}),
          ...(preferences.theme ? { theme: preferences.theme } : {}),
          ...(preferences.layoutStrategy ? { layoutStrategy: preferences.layoutStrategy } : {}),
          ...(preferences.diagramType ? { diagramType: preferences.diagramType } : {}),
          ...(preferences.focusPrompt !== undefined
            ? { focusPrompt: preferences.focusPrompt }
            : {}),
          instructionMarkdown: restoredInstructionMarkdown,
          ...(restoredDsl !== undefined ? { dslText: restoredDsl } : {}),
          ...(preferences.quickMode !== undefined ? { quickMode: preferences.quickMode } : {}),
          ...(preferences.maxMode !== undefined ? { maxMode: preferences.maxMode } : {}),
          ...(preferences.instructionMode !== undefined
            ? { instructionMode: preferences.instructionMode }
            : {}),
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
      addSubLayers: (subLayers) =>
        set((state) => {
          const now = Date.now();
          // Merge into existing multiLayer or bootstrap a new one whose overview
          // is the current DSL text.
          const updatedMultiLayer: MultiLayerOutput = state.multiLayer
            ? {
                ...state.multiLayer,
                layers: [...state.multiLayer.layers, ...subLayers],
              }
            : {
                overview: {
                  name: 'Overview',
                  description: 'Full diagram before splitting',
                  dsl: state.dslText,
                },
                layers: subLayers,
                generatedAt: now,
              };

          // Persist to localStorage if there is an active project tab
          let generatedProjects = state.generatedProjects;
          if (state.activeProjectId) {
            generatedProjects = state.generatedProjects.map((p) =>
              p.id === state.activeProjectId ? { ...p, multiLayer: updatedMultiLayer } : p,
            );
            writeStoredProjects(generatedProjects);
          }

          return { multiLayer: updatedMultiLayer, generatedProjects };
        }),
      removeLayer: (name) =>
        set((state) => {
          if (!state.multiLayer) return {};
          const wasActive = state.activeLayer === name;
          const updatedLayers = state.multiLayer.layers.filter((l) => l.name !== name);
          const updatedMultiLayer: MultiLayerOutput = {
            ...state.multiLayer,
            layers: updatedLayers,
          };

          // When the removed layer was active, fall back to the overview
          const newDslText = wasActive ? state.multiLayer.overview.dsl : state.dslText;
          if (wasActive) {
            writeUiPreference('activeLayer', 'overview');
            writeUiPreference('dslText', newDslText);
          }

          // Persist to localStorage if there is an active project tab
          let generatedProjects = state.generatedProjects;
          if (state.activeProjectId) {
            generatedProjects = state.generatedProjects.map((p) =>
              p.id === state.activeProjectId
                ? { ...p, multiLayer: updatedMultiLayer, ...(wasActive ? { dsl: newDslText } : {}) }
                : p,
            );
            writeStoredProjects(generatedProjects);
          }

          return {
            multiLayer: updatedMultiLayer,
            generatedProjects,
            ...(wasActive ? { activeLayer: 'overview', dslText: newDslText } : {}),
          };
        }),
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
        if (instructionMarkdown !== undefined)
          writeUiPreference('instructionMarkdown', instructionMarkdown);
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
        // Start with clean overrides so the canonical layout is shown immediately,
        // then async-restore any saved drag positions for this project from IndexedDB.
        set({
          dslText: project.dsl,
          activeProjectId: project.id,
          multiLayer: project.multiLayer ?? null,
          instructionMarkdown: project.instructionMarkdown ?? '',
          activeLayer: 'overview',
          overrides: { nodes: {}, groups: {}, edges: {} },
        });
        // Async: restore any persisted override positions for this project.
        loadDraft(project.id).then((draft) => {
          if (!draft) return;
          const hasOverrides =
            Object.keys(draft.overrides.nodes).length > 0 ||
            Object.keys(draft.overrides.groups).length > 0 ||
            Object.keys(draft.overrides.edges).length > 0;
          if (!hasOverrides) return;
          // Guard: only apply if the user hasn't already switched to a different project.
          if (_getState?.()?.activeProjectId === project.id) {
            set({ overrides: draft.overrides });
          }
        }).catch(() => { /* ignore — draft restoration is best-effort */ });
      },
      removeGeneratedProject: (id) => {
        removeStoredProject(id);
        deleteDraft(id); // Clean up persisted draft so stale overrides can't resurface
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
      };
    },
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
