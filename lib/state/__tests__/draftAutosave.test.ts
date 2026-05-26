import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveDraft, deleteDraft, loadDraft } = vi.hoisted(() => ({
  saveDraft: vi.fn(async () => undefined),
  deleteDraft: vi.fn(async () => undefined),
  loadDraft: vi.fn(async () => null),
}));

vi.mock('../../cache/draftCache', () => ({
  deleteDraft,
  loadDraft,
  saveDraft,
}));

import { useDiagramStore } from '../store';

describe('draft autosave', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    saveDraft.mockClear();
    deleteDraft.mockClear();
    loadDraft.mockClear();
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

    useDiagramStore.setState({
      dslText: '',
      overrides: { nodes: {}, groups: {}, edges: {} },
      activeProjectId: null,
      generatedProjects: [],
      multiLayer: null,
      activeLayer: 'overview',
    });
  });

  it('persists the latest DSL change immediately', async () => {
    useDiagramStore.getState().setDsl('Architecture\nService > Database');

    await vi.waitFor(() => {
      expect(saveDraft).toHaveBeenCalledTimes(1);
    });

    expect(saveDraft).toHaveBeenCalledWith(
      'scratch',
      'Architecture\nService > Database',
      { nodes: {}, groups: {}, edges: {} },
    );
  });
});
