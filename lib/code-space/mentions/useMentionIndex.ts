'use client';

// Motivation vs Logic: The agent composer needs a single, project-scoped view of the file index
// that survives unmount/remount, debounces refreshes, and falls back gracefully when the user
// hasn't opened a project yet. This hook centralizes that lifecycle so AgentPanel/composer
// consumers don't have to reinvent debouncing, race-safe state, or seed data.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildMentionIndex, type FileMentionIndex } from './index';
import type { MentionIndexEntryInput } from './types';

export type MentionIndexStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseMentionIndexResult {
  index: FileMentionIndex;
  status: MentionIndexStatus;
  error?: string;
  truncated: boolean;
  refresh: () => void;
}

const EMPTY_INDEX: FileMentionIndex = buildMentionIndex([]);
const REFRESH_DEBOUNCE_MS = 400;

interface CachedPayload {
  files: MentionIndexEntryInput[];
  truncated: boolean;
  generatedAt: number;
}

const memoryCache = new Map<string, CachedPayload>();

interface FetchResponse {
  rootPath: string;
  generatedAt: number;
  files: Array<{ path: string; size?: number; mtime?: number }>;
  truncated: boolean;
}

async function fetchMentionIndexPayload(rootPath: string, refresh: boolean): Promise<CachedPayload> {
  const params = new URLSearchParams({ rootPath });
  if (refresh) params.set('refresh', 'true');
  const response = await fetch(`/api/code-space/mention-index?${params.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to load mention index (${response.status})`);
  }
  const json = (await response.json()) as FetchResponse;
  return {
    files: (json.files ?? []).map((file) => ({
      path: file.path,
      size: file.size,
      mtime: file.mtime,
    })),
    truncated: Boolean(json.truncated),
    generatedAt: json.generatedAt ?? Date.now(),
  };
}

export function useMentionIndex(
  rootPath: string | null | undefined,
  options?: { seedPaths?: ReadonlyArray<string> },
): UseMentionIndexResult {
  const [payload, setPayload] = useState<CachedPayload | null>(() => {
    if (!rootPath) return null;
    return memoryCache.get(rootPath) ?? null;
  });
  const [status, setStatus] = useState<MentionIndexStatus>(() =>
    rootPath ? (memoryCache.has(rootPath) ? 'ready' : 'idle') : 'idle',
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const seedPaths = options?.seedPaths;

  const load = useCallback(
    async (force: boolean) => {
      if (!rootPath) return;
      const id = ++requestId.current;
      setStatus('loading');
      setError(undefined);
      try {
        const next = await fetchMentionIndexPayload(rootPath, force);
        if (id !== requestId.current) return;
        memoryCache.set(rootPath, next);
        setPayload(next);
        setStatus('ready');
      } catch (err) {
        if (id !== requestId.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    },
    [rootPath],
  );

  useEffect(() => {
    if (!rootPath) {
      setPayload(null);
      setStatus('idle');
      setError(undefined);
      return;
    }
    const cached = memoryCache.get(rootPath);
    if (cached) {
      setPayload(cached);
      setStatus('ready');
    }
    void load(false);
  }, [rootPath, load]);

  const refresh = useCallback(() => {
    if (!rootPath) return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void load(true);
    }, REFRESH_DEBOUNCE_MS);
  }, [rootPath, load]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const index = useMemo(() => {
    const serverFiles = payload?.files ?? [];
    const seeds = seedPaths ?? [];
    if (serverFiles.length === 0 && seeds.length === 0) return EMPTY_INDEX;
    const merged: MentionIndexEntryInput[] = serverFiles.slice();
    if (seeds.length) {
      const seen = new Set(merged.map((entry) => entry.path));
      for (const candidate of seeds) {
        if (!candidate || seen.has(candidate)) continue;
        merged.push({ path: candidate });
        seen.add(candidate);
      }
    }
    return buildMentionIndex(merged);
  }, [payload, seedPaths]);

  return {
    index,
    status,
    error,
    truncated: payload?.truncated ?? false,
    refresh,
  };
}
