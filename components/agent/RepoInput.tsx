'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface BrowseEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

interface RepoInputProps {
  onScan: (path: string, result: ScanResult, ignoredFolders: string[]) => void;
  onConfigChange?: (path: string, ignoredFolders: string[]) => void;
}

// Motivation vs Logic: the browser is the user's main lever to keep noisy folders/files out of
// the agent's view, so we surface it inline (always visible) rather than hiding it behind a "..."
// modal. Each row exposes a kebab menu with Cancel/Ignore so the action is explicit and
// reversible — clicking Ignore appends to the existing `ignoredFolders` list which the analyze
// API already plumbs straight into the scanner.
export function RepoInput({ onScan, onConfigChange }: RepoInputProps) {
  const [path, setPath] = useState('');
  const [ignoredFolders, setIgnoredFolders] = useState<string[]>([]);
  const [browserParent, setBrowserParent] = useState('');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  const browserRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const savedPath = readUiPreference('repoPath');
    const savedIgnored = readUiPreference('repoIgnoredFolders') ?? [];
    if (savedIgnored.length) {
      setIgnoredFolders(savedIgnored);
    }

    if (savedPath) {
      setPath(savedPath);
      onConfigChange?.(savedPath, savedIgnored);
    } else {
      fetch('/api/repo/scan')
        .then((r) => r.json())
        .then((d: { defaultPath?: string }) => {
          if (d.defaultPath) {
            setPath(d.defaultPath);
            onConfigChange?.(d.defaultPath, savedIgnored);
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadEntries = useCallback(
    async (parent = '') => {
      if (!path) return;
      setLoadingEntries(true);
      setBrowseError(null);
      try {
        const res = await fetch('/api/repo/directories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootPath: path, parent }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBrowseError(data.error ?? 'Could not list folder');
          setEntries([]);
          return;
        }
        setBrowserParent(data.parent ?? '');
        const next: BrowseEntry[] = Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data.directories)
            ? data.directories.map((d: { name: string; path: string }) => ({ ...d, type: 'dir' as const }))
            : [];
        setEntries(next);
      } catch (err) {
        setBrowseError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        setLoadingEntries(false);
      }
    },
    [path],
  );

  // Auto-load the root listing whenever the path changes so the picker is never empty.
  useEffect(() => {
    if (!path) {
      setEntries([]);
      setBrowserParent('');
      return;
    }
    void loadEntries('');
  }, [path, loadEntries]);

  // Close the kebab menu on outside click.
  useEffect(() => {
    if (!activeMenu) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && browserRef.current && !browserRef.current.contains(target)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [activeMenu]);

  const onPathChange = (value: string) => {
    writeUiPreference('repoPath', value);
    setPath(value);
    setResult(null);
    onConfigChange?.(value, ignoredFolders);
  };

  const updateIgnoredFolders = (next: string[]) => {
    const cleaned = [
      ...new Set(next.map((item) => item.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    setIgnoredFolders(cleaned);
    writeUiPreference('repoIgnoredFolders', cleaned);
    setResult(null);
    onConfigChange?.(path, cleaned);
  };

  const parentFolder = browserParent ? browserParent.split('/').slice(0, -1).join('/') : '';

  const ignoredSet = useMemo(() => new Set(ignoredFolders), [ignoredFolders]);

  // Motivation vs Logic: once a path is on the ignore list the agent never reads it, so leaving
  // it in the browser just adds noise. We hide both direct matches and any descendants of an
  // ignored folder — the chip row at the top is the single, authoritative place to unignore.
  const isPathIgnored = useCallback(
    (relPath: string): boolean => {
      if (ignoredSet.has(relPath)) return true;
      for (const ignored of ignoredFolders) {
        if (relPath.startsWith(`${ignored}/`)) return true;
      }
      return false;
    },
    [ignoredFolders, ignoredSet],
  );

  const visibleEntries = useMemo(
    () => entries.filter((entry) => !isPathIgnored(entry.path)),
    [entries, isPathIgnored],
  );

  const hiddenCount = entries.length - visibleEntries.length;

  const onIgnoreEntry = (entry: BrowseEntry) => {
    setActiveMenu(null);
    if (ignoredSet.has(entry.path)) return;
    updateIgnoredFolders([...ignoredFolders, entry.path]);
  };

  const onOpenEntry = (entry: BrowseEntry) => {
    if (entry.type !== 'dir') return;
    setActiveMenu(null);
    void loadEntries(entry.path);
  };

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
            onClick={() => void loadEntries('')}
            disabled={!path || loadingEntries}
            title="Refresh folder listing"
            className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 font-semibold hover:bg-ink-700 disabled:opacity-50"
          >
            ↻
          </button>
        </div>
        <div className="mt-1 text-[10px] text-ink-400">
          Default is the parent of <code>AgentDiagram/</code> — i.e. the project you cloned this into.
        </div>
      </div>

      <div className="space-y-2 rounded-md border border-ink-800 bg-ink-950/70 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-widest text-ink-400">Ignored paths</div>
          {ignoredFolders.length > 0 && (
            <button
              type="button"
              onClick={() => updateIgnoredFolders([])}
              className="text-[10px] text-ink-400 hover:text-ink-100"
            >
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
                title="Remove from ignore list"
              >
                {folder} ×
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-ink-500">No extra folders ignored.</div>
        )}
      </div>

      <div ref={browserRef} className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-ink-400">Folder browser</div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500" title={browserParent || '.'}>
              {browserParent || '.'}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void loadEntries(parentFolder)}
              disabled={!browserParent || loadingEntries}
              className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] hover:bg-ink-700 disabled:opacity-50"
            >
              Up
            </button>
            <button
              type="button"
              onClick={() => void loadEntries('')}
              disabled={!path || loadingEntries}
              className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] hover:bg-ink-700 disabled:opacity-50"
            >
              Root
            </button>
          </div>
        </div>

        {browseError && (
          <div className="rounded border border-red-500/50 bg-red-500/10 p-2 text-red-200">{browseError}</div>
        )}

        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded border border-ink-800 bg-ink-900/70 p-1">
          {loadingEntries ? (
            <div className="p-2 text-ink-400">Loading…</div>
          ) : visibleEntries.length ? (
            visibleEntries.map((entry) => {
              const menuOpen = activeMenu === entry.path;
              const isDir = entry.type === 'dir';
              return (
                <div
                  key={entry.path}
                  className="group relative flex items-center gap-2 rounded px-2 py-1 hover:bg-ink-800"
                >
                  <span className="w-4 shrink-0 text-center text-[11px] text-ink-500">
                    {isDir ? '📁' : '📄'}
                  </span>
                  {isDir ? (
                    <button
                      type="button"
                      onClick={() => onOpenEntry(entry)}
                      className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-200 hover:text-accent"
                      title={`Open ${entry.path}`}
                    >
                      {entry.name}
                    </button>
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-300"
                      title={entry.path}
                    >
                      {entry.name}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveMenu((current) => (current === entry.path ? null : entry.path))}
                    className="shrink-0 rounded px-2 py-0.5 text-[12px] text-ink-400 hover:bg-ink-700 hover:text-ink-100"
                    title="Actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                  >
                    …
                  </button>
                  {menuOpen && (
                    <div
                      role="menu"
                      className="absolute right-2 top-full z-10 mt-1 flex w-44 flex-col gap-1 rounded-md border border-ink-700 bg-ink-900 p-1 shadow-xl"
                    >
                      {isDir && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => onOpenEntry(entry)}
                          className="rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-ink-800"
                        >
                          Open folder
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => onIgnoreEntry(entry)}
                        className="rounded border border-coral/40 bg-coral/10 px-2 py-1 text-left text-[11px] text-coral hover:bg-coral/20"
                      >
                        Ignore
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setActiveMenu(null)}
                        className="rounded px-2 py-1 text-left text-[11px] text-ink-400 hover:bg-ink-800"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="p-2 text-ink-500">
              {entries.length ? 'All entries here are ignored.' : 'Empty folder.'}
            </div>
          )}
        </div>
        <div className="text-[10px] text-ink-500">
          AgentDiagram’s own folder, common build/cache directories
          {hiddenCount > 0 ? `, and ${hiddenCount} ignored entr${hiddenCount === 1 ? 'y' : 'ies'}` : ''} are hidden automatically.
        </div>
      </div>

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
