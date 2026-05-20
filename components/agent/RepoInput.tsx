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

export function RepoInput({ onScan }: { onScan: (path: string, result: ScanResult) => void }) {
  const [path, setPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  useEffect(() => {
    const savedPath = readUiPreference('repoPath');
    if (savedPath) {
      setPath(savedPath);
      return;
    }

    fetch('/api/repo/scan')
      .then((r) => r.json())
      .then((d: { defaultPath?: string }) => {
        if (d.defaultPath && !path) setPath(d.defaultPath);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPathChange = (value: string) => {
    writeUiPreference('repoPath', value);
    setPath(value);
  };

  const onPreview = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/repo/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Scan failed');
        setResult(null);
        return;
      }
      setResult(data);
      onScan(data.resolved, data);
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
        <input
          value={path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder="/Users/you/projects/your-repo"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[11px]"
        />
        <div className="mt-1 text-[10px] text-ink-400">
          Default is the parent of <code>AgentDiagram/</code> — i.e. the project you cloned this into.
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
