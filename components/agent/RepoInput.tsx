'use client';

import { useEffect, useState } from 'react';
import { readUiPreference, writeUiPreference } from '@/lib/state/uiPreferences';

interface ScanResult {
  resolved: string;
  fileCount: number;
  totalBytes: number;
  byExt: Record<string, number>;
  manifests: string[];
  entrypoints: string[];
  apiRoutes: string[];
  components: string[];
  schemas: string[];
  infra: string[];
  docs: string[];
  tests: number;
  depHints: string[];
  likelyStack: string[];
}

interface DirectoryEntry {
  name: string;
  path: string;
}

interface RepoInputProps {
  onScan: (path: string, result: ScanResult, ignoredFolders: string[]) => void;
  onConfigChange?: (path: string, ignoredFolders: string[]) => void;
}

export function RepoInput({ onScan, onConfigChange }: RepoInputProps) {
  const [path, setPath] = useState('');
  const [ignoredFolders, setIgnoredFolders] = useState<string[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserParent, setBrowserParent] = useState('');
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loadingDirectories, setLoadingDirectories] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  useEffect(() => {
    const savedPath = readUiPreference('repoPath');
    if (savedPath) {
      setPath(savedPath);
      onConfigChange?.(savedPath, readUiPreference('repoIgnoredFolders') ?? []);
    }

    const savedIgnored = readUiPreference('repoIgnoredFolders') ?? [];
    if (savedIgnored.length) {
      setIgnoredFolders(savedIgnored);
    }

    if (!savedPath) {
      fetch('/api/repo/scan')
        .then((r) => r.json())
        .then((d: { defaultPath?: string }) => {
          if (d.defaultPath && !path) {
            setPath(d.defaultPath);
            onConfigChange?.(d.defaultPath, savedIgnored);
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPathChange = (value: string) => {
    writeUiPreference('repoPath', value);
    setPath(value);
    setResult(null);
    onConfigChange?.(value, ignoredFolders);
  };

  const updateIgnoredFolders = (next: string[]) => {
    const cleaned = [...new Set(next.map((item) => item.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b),
    );
    setIgnoredFolders(cleaned);
    writeUiPreference('repoIgnoredFolders', cleaned);
    setResult(null);
    onConfigChange?.(path, cleaned);
  };

  const loadDirectories = async (parent = '') => {
    if (!path) return;
    setLoadingDirectories(true);
    setError(null);
    try {
      const res = await fetch('/api/repo/directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: path, parent }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Could not list folders');
        return;
      }
      setBrowserParent(data.parent ?? '');
      setDirectories(Array.isArray(data.directories) ? data.directories : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDirectories(false);
    }
  };

  const openBrowser = () => {
    setBrowserOpen(true);
    void loadDirectories('');
  };

  const parentFolder = browserParent.split('/').slice(0, -1).join('/');

  const onPreview = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/repo/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, ignoredFolders }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Scan failed');
        setResult(null);
        return;
      }
      setResult(data);
      onScan(data.resolved, data, ignoredFolders);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-ink-400">Repository</div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Absolute path</div>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => onPathChange(e.target.value)}
            placeholder="/Users/you/projects/your-repo"
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={openBrowser}
            disabled={!path}
            title="Browse folders to ignore"
            className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 font-semibold hover:bg-ink-700 disabled:opacity-50"
          >
            ...
          </button>
        </div>
        <div className="mt-1 text-[10px] text-ink-400">
          Default is the parent of <code>AgentDiagram/</code> — i.e. the project you cloned this into.
        </div>
      </div>

      <div className="space-y-2 rounded-md border border-ink-800 bg-ink-950/70 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-widest text-ink-400">Ignored folders</div>
          {ignoredFolders.length > 0 && (
            <button type="button" onClick={() => updateIgnoredFolders([])} className="text-[10px] text-ink-400 hover:text-ink-100">
              Clear
            </button>
          )}
        </div>
        {ignoredFolders.length ? (
          <div className="flex flex-wrap gap-1.5">
            {ignoredFolders.map((folder) => (
              <button
                key={folder}
                type="button"
                onClick={() => updateIgnoredFolders(ignoredFolders.filter((item) => item !== folder))}
                className="rounded-full border border-ink-700 bg-ink-800 px-2 py-0.5 font-mono text-[10px] text-ink-200 hover:border-coral/60"
                title="Remove ignored folder"
              >
                {folder} x
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-ink-500">No extra folders ignored.</div>
        )}
      </div>

      {browserOpen && (
        <div className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-ink-400">Folder browser</div>
              <div className="mt-0.5 font-mono text-[10px] text-ink-500">{browserParent || '.'}</div>
            </div>
            <button type="button" onClick={() => setBrowserOpen(false)} className="text-[11px] text-ink-400 hover:text-ink-100">
              Close
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void loadDirectories(parentFolder)}
              disabled={!browserParent || loadingDirectories}
              className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] hover:bg-ink-700 disabled:opacity-50"
            >
              Up
            </button>
            <button
              type="button"
              onClick={() => updateIgnoredFolders([...ignoredFolders, browserParent])}
              disabled={!browserParent || ignoredFolders.includes(browserParent)}
              className="rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-50"
            >
              Ignore current
            </button>
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-ink-800 bg-ink-900/70 p-1">
            {loadingDirectories ? (
              <div className="p-2 text-ink-400">Loading folders...</div>
            ) : directories.length ? (
              directories.map((dir) => (
                <div key={dir.path} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-ink-800">
                  <button
                    type="button"
                    onClick={() => updateIgnoredFolders([...ignoredFolders, dir.path])}
                    disabled={ignoredFolders.includes(dir.path)}
                    className="min-w-0 truncate font-mono text-[11px] text-ink-200 disabled:text-ink-500"
                    title={ignoredFolders.includes(dir.path) ? 'Already ignored' : 'Click to ignore this folder'}
                  >
                    {dir.name}
                  </button>
                  <button type="button" onClick={() => void loadDirectories(dir.path)} className="text-[10px] text-ink-400 hover:text-ink-100">
                    Open
                  </button>
                </div>
              ))
            ) : (
              <div className="p-2 text-ink-500">No child folders.</div>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onPreview}
        disabled={scanning || !path}
        className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 hover:bg-ink-700 disabled:opacity-50"
      >
        {scanning ? 'Scanning…' : 'Preview repo'}
      </button>

      {error && <div className="rounded border border-red-500/50 bg-red-500/10 p-2 text-red-200">{error}</div>}

      {result && (
        <div className="space-y-1 rounded border border-ink-700 bg-ink-950 p-2 text-[11px] text-ink-300">
          <div>
            <span className="text-ink-400">Files:</span> {result.fileCount.toLocaleString()} ·{' '}
            <span className="text-ink-400">Size:</span> {Math.round(result.totalBytes / 1024).toLocaleString()} KB
          </div>
          <div>
            <span className="text-ink-400">Stack:</span> {result.likelyStack.join(', ') || 'unknown'}
          </div>
          <div>
            <span className="text-ink-400">Entrypoints:</span> {result.entrypoints.slice(0, 4).join(', ') || '—'}
          </div>
          <div>
            <span className="text-ink-400">API routes:</span> {result.apiRoutes.length} ·{' '}
            <span className="text-ink-400">Components:</span> {result.components.length} ·{' '}
            <span className="text-ink-400">Schemas:</span> {result.schemas.length}
          </div>
        </div>
      )}
    </div>
  );
}
