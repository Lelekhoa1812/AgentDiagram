import { beforeEach, describe, expect, it } from 'vitest';
import { useDiagramStore, type MultiLayerOutput } from '../store';
import { addStoredProject, writeActiveProjectId, writeStoredProjects } from '../projectStorage';
import { writeUiPreference } from '../uiPreferences';

describe('project tab loading', () => {
  const storage = new Map<string, string>();

  const sampleMultiLayer: MultiLayerOutput = {
    generatedAt: 1716163200000,
    overview: {
      name: 'Overview',
      description: 'High level',
      dsl: 'overview dsl',
    },
    layers: [
      {
        name: 'API',
        description: 'Requests',
        dsl: 'api dsl',
      },
      {
        name: 'Data',
        description: 'Storage',
        dsl: 'data dsl',
      },
    ],
  };

  const installLocalStorageMock = () => {
    storage.clear();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  };

  beforeEach(() => {
    installLocalStorageMock();
    writeStoredProjects([]);
    useDiagramStore.setState({
      dslText: '',
      multiLayer: null,
      activeLayer: 'overview',
      activeProjectId: null,
      generatedProjects: [],
      overrides: { nodes: {}, groups: {}, edges: {} },
      maxMode: false,
    });
  });

  it('restores the stored multi-layer bundle when reopening a generated project', () => {
    const project = addStoredProject('Repo', 'overview dsl', sampleMultiLayer);

    useDiagramStore.getState().openProject({
      id: project.id,
      dsl: project.dsl,
      multiLayer: project.multiLayer,
    });

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe(project.id);
    expect(state.dslText).toBe('overview dsl');
    expect(state.multiLayer).toEqual(sampleMultiLayer);
    expect(state.activeLayer).toBe('overview');
  });

  it('clears stale multi-layer state when opening a plain example project', () => {
    useDiagramStore.setState({
      multiLayer: sampleMultiLayer,
      activeLayer: 'Data',
      activeProjectId: 'proj-123',
      dslText: 'old dsl',
    });

    useDiagramStore.getState().openProject({
      id: 'default:flow',
      dsl: 'flow example',
    });

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe('default:flow');
    expect(state.dslText).toBe('flow example');
    expect(state.multiLayer).toBeNull();
    expect(state.activeLayer).toBe('overview');
  });

  it('hydrates the active project DSL instead of stale editor scratch text', () => {
    const project = addStoredProject('Huge Repo', 'Frontend\nBackend\nFrontend > Backend');
    writeActiveProjectId(project.id);
    writeUiPreference('dslText', '/');

    useDiagramStore.getState().hydrateUiPreferences();

    const state = useDiagramStore.getState();
    expect(state.activeProjectId).toBe(project.id);
    expect(state.dslText).toBe(project.dsl);
  });

  it('hydrates max mode from saved ui preferences', () => {
    writeUiPreference('maxMode', true);

    useDiagramStore.getState().hydrateUiPreferences();

    expect(useDiagramStore.getState().maxMode).toBe(true);
  });
});
