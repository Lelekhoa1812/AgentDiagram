import { afterEach, describe, expect, it, vi } from 'vitest';
import { postFileAction } from '../CodeSpaceWorkspaceEnhancements';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postFileAction', () => {
  it('posts a filesystem mutation to the Code Space files API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ createdAt: Date.now() }),
    } as Response);

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const result = await postFileAction(
      {
        projectId: 'project-1',
        rootPath: '/workspace/medbot',
        path: 'backend/memory',
        name: 'memory',
        type: 'dir',
        directoryPath: 'backend',
      },
      {
        action: 'mkdir',
        path: 'backend/memory/new-folder',
      },
      'backend/memory',
    );

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/code-space/files',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          rootPath: '/workspace/medbot',
          action: 'mkdir',
          path: 'backend/memory/new-folder',
        }),
      }),
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
