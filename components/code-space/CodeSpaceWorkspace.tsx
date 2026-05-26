'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import {
  Archive,
  Bot,
  Box,
  ChevronDown,
  ChevronRight,
  Code2,
  File,
  FileCode2,
  ChevronLeft,
  Folder,
  FolderOpen,
  GitBranch,
  History,
  Layers3,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { useDiagramStore } from '@/lib/state/store';
import { writeUiPreference } from '@/lib/state/uiPreferences';
import {
  classifyCodeSpaceIntent,
  createCodeSpaceProject,
  dedupeCodeSpaceProjects,
  detectCodeSpaceLanguage,
  getCodeSpaceProjectDedupKey,
  isCodeSpaceHiddenPath,
  type CodeSpaceAgentSession,
  type CodeSpaceBottomTab,
  type CodeSpaceEditorTab,
  type CodeSpaceProject,
  type CodeSpaceTreeNode,
} from '@/lib/code-space/core';
import { BottomPanel } from '@/components/code-space/BottomPanel';
import {
  deleteCodeSpaceProject,
  readCodeSpacePreferences,
  readCodeSpaceProjects,
  readCodeSpaceSessions,
  readCodeSpaceTabs,
  saveCodeSpaceProject,
  saveCodeSpaceSession,
  saveCodeSpaceTab,
  writeCodeSpacePreferences,
} from '@/lib/code-space/persistence';
import { registerDslLanguage } from '@/components/editor/dslLanguage';
import { ProviderConfig } from '@/components/agent/ProviderConfig';

interface FilePayload {
  path: string;
  content: string;
  hash: string;
  modifiedAt: number;
}

interface FolderBrowserEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

interface FolderBrowserResponse {
  root?: string;
  parent?: string;
  resolved?: string;
  entries?: FolderBrowserEntry[];
  directories?: Array<{ name: string; path: string }>;
  error?: string;
}

interface TreeResponse {
  entries: CodeSpaceTreeNode[];
}

const DEFAULT_SESSION_EXAMPLES = [
  'Explain this repo',
  'Run checks',
  'Fix the failing build',
  'Add a feature',
  'Refactor selected code',
];

function nowId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function projectNameFromPath(rootPath: string): string {
  return rootPath.replace(/\/+$/, '').split('/').pop() || rootPath;
}

function dirname(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function basename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function normalizeToPosix(filePath: string) {
  return filePath.replace(/\\/g, '/');
}

function parentPath(filePath: string) {
  const normalized = normalizeToPosix(filePath).replace(/\/+$/, '');
  const hasLeadingSlash = normalized.startsWith('/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) {
    return hasLeadingSlash ? '/' : '';
  }
  segments.pop();
  if (!segments.length) {
    return hasLeadingSlash ? '/' : '';
  }
  const joined = segments.join('/');
  return hasLeadingSlash ? `/${joined}` : joined;
}

function joinPathSegments(parent: string, child: string) {
  const normalizedParent = normalizeToPosix(parent).replace(/\/+$/, '');
  const normalizedChild = normalizeToPosix(child).replace(/^\/+/, '');
  if (!normalizedParent || normalizedParent === '.') {
    return normalizedChild;
  }
  if (normalizedParent === '/') {
    return `/${normalizedChild}`;
  }
  return `${normalizedParent}/${normalizedChild}`;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const existingIds = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of incoming) {
    if (!existingIds.has(item.id)) {
      merged.push(item);
      existingIds.add(item.id);
    }
  }
  return merged;
}

function createSession(projectId: string | null, title = 'New coding session', mode: CodeSpaceAgentSession['mode'] = 'agent'): CodeSpaceAgentSession {
  const ts = Date.now();
  return {
    id: nowId('session'),
    projectId,
    title,
    status: 'idle',
    mode,
    messages: [],
    toolCalls: [],
    plan: [],
    todos: [],
    changesets: [],
    verificationResults: [],
    createdAt: ts,
    updatedAt: ts,
    archived: false,
    localCacheVersion: 1,
  };
}

function fileIcon(path: string) {
  const language = detectCodeSpaceLanguage(path);
  if (language === 'typescript' || language === 'javascript') return <FileCode2 size={14} className="text-blue-300" />;
  if (language === 'css' || language === 'scss') return <FileCode2 size={14} className="text-pink-300" />;
  if (language === 'markdown') return <FileCode2 size={14} className="text-sky-300" />;
  if (language === 'json') return <FileCode2 size={14} className="text-yellow-300" />;
  return <File size={14} className="text-ink-400" />;
}

export function CodeSpaceWorkspace() {
  const setMode = useDiagramStore((s) => s.setMode);
  const theme = useDiagramStore((s) => s.theme);
  const [projects, setProjects] = useState<CodeSpaceProject[]>([]);
  const [sessions, setSessions] = useState<CodeSpaceAgentSession[]>([]);
  const [tabs, setTabs] = useState<CodeSpaceEditorTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, FilePayload>>({});
  const [treeChildren, setTreeChildren] = useState<Record<string, CodeSpaceTreeNode[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loadingTree, setLoadingTree] = useState<Record<string, boolean>>({});
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  const [leftWidth, setLeftWidth] = useState(304);
  const [rightWidth, setRightWidth] = useState(380);
  const [bottomVisible, setBottomVisible] = useState(true);
  const [bottomActiveTab, setBottomActiveTab] = useState<CodeSpaceBottomTab>('output');
  const [minimapEnabled, setMinimapEnabled] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [revealHidden, setRevealHidden] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [providerConfigOpen, setProviderConfigOpen] = useState(false);
  const [zipSummary, setZipSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectNameInput, setProjectNameInput] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<CodeSpaceProject | null>(null);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [folderBrowserRoot, setFolderBrowserRoot] = useState<string>('');
  const [folderBrowserParent, setFolderBrowserParent] = useState<string>('');
  const [folderBrowserEntries, setFolderBrowserEntries] = useState<FolderBrowserEntry[]>([]);
  const [folderBrowserLoading, setFolderBrowserLoading] = useState(false);
  const [folderBrowserError, setFolderBrowserError] = useState<string | null>(null);
  const [folderBrowserManualPath, setFolderBrowserManualPath] = useState('');
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const projectsRef = useRef<CodeSpaceProject[]>([]);
  const autoDeletingProjectIds = useRef<Set<string>>(new Set());
  // Root Cause vs Logic: Hidden-only roots (e.g. `.git`) look empty in the explorer; only run the empty-folder check once per project so we do not re-trigger loadTree in a loop.
  const emptyAutoDeleteCheckedIds = useRef<Set<string>>(new Set());
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    setProjectNameInput(activeProject?.name ?? '');
  }, [activeProject?.name]);

  useEffect(() => {
    const preferences = readCodeSpacePreferences();
    setActiveProjectId(preferences.activeProjectId ?? null);
    setActiveSessionId(preferences.activeSessionId ?? null);
    setLeftVisible(preferences.leftSidebarVisible ?? true);
    setRightVisible(preferences.rightSidebarVisible ?? true);
    setLeftWidth(preferences.leftWidth ?? 304);
    setRightWidth(preferences.rightWidth ?? 380);
    setBottomVisible(preferences.bottomPanelVisible ?? true);
    setBottomActiveTab(preferences.bottomActiveTab ?? 'output');
    setMinimapEnabled(preferences.minimapEnabled ?? false);
    setWordWrap(preferences.wordWrap ?? true);
    setRevealHidden(preferences.revealHiddenFiles ?? false);

    void Promise.all([readCodeSpaceProjects(), readCodeSpaceSessions(), readCodeSpaceTabs()]).then(
      ([storedProjects, storedSessions, storedTabs]) => {
        // Root Cause vs Logic: Slow preference hydration was overwriting new projects/rows before the user saw them, so keep existing entries and only append the stored metadata.
        // Motivation vs Logic: Older storage can hold two rows that resolve to the same folder (different ids generated before path normalization, or duplicates from re-adds). Dedupe after merge and purge the stale rows from IndexedDB so the sidebar matches what we persist.
        setProjects((current) => {
          const merged = mergeById(current, storedProjects);
          const { kept, removed } = dedupeCodeSpaceProjects(merged);
          const keptIds = new Set(kept.map((project) => project.id));
          for (const stale of removed) {
            if (keptIds.has(stale.id)) continue;
            void deleteCodeSpaceProject(stale.id);
          }
          return kept;
        });
        setSessions((current) => mergeById(current, storedSessions));
        setTabs((current) => mergeById(current, storedTabs));
        if (!preferences.activeProjectId && storedProjects[0]) {
          setActiveProjectId((prev) => prev ?? storedProjects[0].id);
        }
        if (!preferences.activeSessionId && storedSessions[0]) {
          setActiveSessionId((prev) => prev ?? storedSessions[0].id);
        }
      },
    );
  }, []);

  useEffect(() => {
    writeCodeSpacePreferences({
      activeProjectId,
      activeSessionId,
      leftSidebarVisible: leftVisible,
      rightSidebarVisible: rightVisible,
      leftWidth,
      rightWidth,
      bottomPanelVisible: bottomVisible,
      bottomActiveTab,
      minimapEnabled,
      wordWrap,
      revealHiddenFiles: revealHidden,
    });
  }, [
    activeProjectId,
    activeSessionId,
    bottomVisible,
    bottomActiveTab,
    leftVisible,
    leftWidth,
    minimapEnabled,
    revealHidden,
    rightVisible,
    rightWidth,
    wordWrap,
  ]);

  const updateSession = useCallback((session: CodeSpaceAgentSession) => {
    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    void saveCodeSpaceSession(session);
  }, []);

  const ensureSession = useCallback(() => {
    if (activeSession) return activeSession;
    const session = createSession(activeProjectId);
    setActiveSessionId(session.id);
    updateSession(session);
    return session;
  }, [activeProjectId, activeSession, updateSession]);

  const refreshGitStatus = useCallback(async (project: CodeSpaceProject) => {
    if (!project.rootPath) return;
    try {
      const res = await fetch('/api/code-space/git-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootPath: project.rootPath }),
      });
      const git = await res.json();
      const next = { ...project, git, branch: git.branch ?? project.branch, updatedAt: Date.now() };
      setProjects((current) => current.map((item) => (item.id === next.id ? next : item)));
      await saveCodeSpaceProject(next);
    } catch {
      // Git status is opportunistic; non-git folders still work as editable projects.
    }
  }, []);

  const finalizeProjectRemoval = useCallback((projectId: string) => {
    emptyAutoDeleteCheckedIds.current.delete(projectId);
    let remainingProjects: CodeSpaceProject[] = [];
    setProjects((current) => {
      remainingProjects = current.filter((item) => item.id !== projectId);
      return remainingProjects;
    });
    setSessions((current) => {
      const next = current.filter((session) => session.projectId !== projectId);
      setActiveSessionId((activeId) => {
        if (activeId && !next.some((session) => session.id === activeId)) {
          return next[0]?.id ?? null;
        }
        return activeId;
      });
      return next;
    });
    setTabs((current) => {
      const next = current.filter((tab) => tab.projectId !== projectId);
      setActiveTabId((activeId) => {
        if (activeId && !next.some((tab) => tab.id === activeId)) {
          return null;
        }
        return activeId;
      });
      return next;
    });
    setActiveProjectId((activeId) => {
      if (activeId !== projectId) return activeId;
      setLocalPath('');
      return remainingProjects[0]?.id ?? null;
    });
  }, []);

  // Root Cause vs Logic: Helpers used in multiple callbacks must exist before those closures run; define this before `verifyAndDeleteEmptyProject` so the TDZ never fires.
  const deleteProjectDirectory = useCallback(async (project: CodeSpaceProject) => {
    if (!project.rootPath) throw new Error('Unable to delete a project without a root path');
    const parent = parentPath(project.rootPath);
    if (!parent) throw new Error('Unable to delete the root folder');
    const targetFolder = basename(project.rootPath);
    const res = await fetch('/api/code-space/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', rootPath: parent, path: targetFolder }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Delete failed');
    return data;
  }, []);

  // Root Cause vs Logic: `loadTree` depends on this helper via its dependency array, so declare it before `loadTree` to avoid the temporal dead zone that caused the ReferenceError.
  // Motivation vs Logic: A sidebar entry that resolves to an empty directory (or to a path that no
  // longer exists on disk) is dead weight—e.g. a half-finished `git clone` that produced just a
  // bare folder. We confirm the directory is genuinely empty by listing it with revealHidden=true
  // and only then drop it from the sidebar and IndexedDB. We intentionally do NOT remove the
  // directory on disk: the user explicitly added that path and may want to populate it later.
  const verifyAndDeleteEmptyProject = useCallback(
    async (project: CodeSpaceProject) => {
      if (!project.rootPath) return;
      if (autoDeletingProjectIds.current.has(project.id)) return;
      autoDeletingProjectIds.current.add(project.id);
      try {
        const params = new URLSearchParams({ rootPath: project.rootPath, path: '', revealHidden: 'true' });
        const res = await fetch(`/api/code-space/files?${params.toString()}`);
        const data = await res.json();
        const missingOnDisk = !res.ok && /ENOENT|no such file|not found/i.test(data.error ?? '');
        if (!res.ok && !missingOnDisk) {
          throw new Error(data.error ?? 'Unable to verify folder contents');
        }
        const hasEntries = res.ok && Array.isArray(data.entries) && data.entries.length > 0;
        if (hasEntries) return;
        finalizeProjectRemoval(project.id);
        await deleteCodeSpaceProject(project.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        autoDeletingProjectIds.current.delete(project.id);
      }
    },
    [finalizeProjectRemoval],
  );

  const loadTree = useCallback(
    async (project: CodeSpaceProject, folderPath = '') => {
      if (!project.rootPath) return;
      if (autoDeletingProjectIds.current.has(project.id)) return;
      const key = `${project.id}:${folderPath}`;
      setLoadingTree((current) => ({ ...current, [key]: true }));
      setError(null);
      try {
        const params = new URLSearchParams({
          rootPath: project.rootPath,
          path: folderPath,
          revealHidden: revealHidden ? 'true' : 'false',
        });
        const res = await fetch(`/api/code-space/files?${params.toString()}`);
        const data = (await res.json()) as TreeResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Could not load folder');
        setTreeChildren((current) => ({ ...current, [key]: data.entries ?? [] }));
        if (
          !folderPath &&
          (!data.entries || data.entries.length === 0) &&
          !emptyAutoDeleteCheckedIds.current.has(project.id)
        ) {
          emptyAutoDeleteCheckedIds.current.add(project.id);
          void verifyAndDeleteEmptyProject(project);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingTree((current) => ({ ...current, [key]: false }));
      }
    },
    [revealHidden, verifyAndDeleteEmptyProject],
  );

  const loadTreeRef = useRef(loadTree);
  const refreshGitStatusRef = useRef(refreshGitStatus);
  const verifyAndDeleteEmptyProjectRef = useRef(verifyAndDeleteEmptyProject);
  loadTreeRef.current = loadTree;
  refreshGitStatusRef.current = refreshGitStatus;
  verifyAndDeleteEmptyProjectRef.current = verifyAndDeleteEmptyProject;

  // Root Cause vs Logic: Depending on `loadTree` in this effect re-ran whenever project state changed, causing a refresh loop; only react to active project / reveal-hidden changes.
  useEffect(() => {
    const project = projectsRef.current.find((item) => item.id === activeProjectId);
    if (!project) return;
    void loadTreeRef.current(project, '');
    void refreshGitStatusRef.current(project);
  }, [activeProjectId, revealHidden]);

  // Motivation vs Logic: `loadTree` only sweeps the active project, so a non-active dead row (for
  // example, a half-finished `git clone` that produced an empty folder named "triage") would sit
  // in the sidebar until the user clicked it. Whenever the project list changes, check any
  // projects we have not yet verified once in the background so empty entries fall off on their
  // own. `emptyAutoDeleteCheckedIds` prevents duplicate checks per project per session.
  useEffect(() => {
    if (!projects.length) return;
    const pending = projects.filter(
      (project) =>
        project.rootPath &&
        !emptyAutoDeleteCheckedIds.current.has(project.id) &&
        !autoDeletingProjectIds.current.has(project.id),
    );
    if (!pending.length) return;
    for (const project of pending) {
      emptyAutoDeleteCheckedIds.current.add(project.id);
      void verifyAndDeleteEmptyProjectRef.current(project);
    }
  }, [projects]);

  const addProject = useCallback(
    async (project: CodeSpaceProject) => {
      const nextProject = { ...project, active: true };
      // Motivation vs Logic: If the user re-opens a folder (or re-pastes the same GitHub URL) we
      // want to refresh the existing sidebar row instead of stacking a second duplicate. Dedup by
      // the normalized rootPath/repoUrl so two rows pointing at the same project collapse into
      // one, and purge any stale IndexedDB rows whose ids differ from the surviving entry.
      const nextDedupKey = getCodeSpaceProjectDedupKey(nextProject);
      let staleIdsToDelete: string[] = [];
      setProjects((current) => {
        const merged = [nextProject, ...current.map((item) => ({ ...item, active: false }))];
        const { kept, removed } = dedupeCodeSpaceProjects(merged);
        staleIdsToDelete = removed
          .filter((item) => item.id !== nextProject.id && getCodeSpaceProjectDedupKey(item) === nextDedupKey)
          .map((item) => item.id);
        return kept;
      });
      for (const staleId of staleIdsToDelete) {
        void deleteCodeSpaceProject(staleId);
      }
      setActiveProjectId(nextProject.id);
      await saveCodeSpaceProject(nextProject);
      void loadTree(nextProject, '');
      void refreshGitStatus(nextProject);
    },
    [loadTree, refreshGitStatus],
  );

  const openLocalProject = useCallback(
    async (pathOverride?: string) => {
      const candidate = (pathOverride ?? localPath).trim();
      if (!candidate) return;
      const project = createCodeSpaceProject({
        name: projectNameFromPath(candidate),
        sourceType: 'local',
        rootPath: candidate,
        source: { sourceType: 'local', repoPath: candidate, authMode: 'none' },
      });
      setLocalPath(candidate);
      await addProject(project);
    },
    [addProject, localPath],
  );

  const cloneGithubProject = useCallback(
    async (urlOverride?: string) => {
      const candidate = (urlOverride ?? repoUrl).trim();
      if (!candidate) return;
      setError(null);
      setRepoUrl(candidate);
      try {
        const res = await fetch('/api/repo/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: { sourceType: 'github', repoPath: '', repoUrl: candidate, authMode: 'none' },
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Clone failed');
        const project = createCodeSpaceProject({
          name: projectNameFromPath(data.resolved),
          sourceType: 'github',
          rootPath: data.resolved,
          repoRef: data.clonedFrom,
          source: { sourceType: 'github', repoPath: data.resolved, repoUrl: candidate, authMode: 'none' },
        });
        await addProject(project);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [addProject, repoUrl],
  );

  const promptToCloneGithub = useCallback(async () => {
    const selection = window.prompt('Enter the GitHub repo URL');
    if (!selection) return;
    await cloneGithubProject(selection);
  }, [cloneGithubProject]);

  // Motivation vs Logic: Browsers can't hand the Code Space backend an absolute folder path
  // (the `<input webkitdirectory>` API hides `file.path` outside Electron), so we delegate
  // folder picking to the existing server-side `/api/repo/directories` endpoint. It already
  // walks the host filesystem with the same path guard and returns absolute paths, which lets
  // us create projects automatically without the browser's "trust this site" upload prompt.
  const loadFolderBrowserEntries = useCallback(
    async (root: string, parent = '') => {
      setFolderBrowserLoading(true);
      setFolderBrowserError(null);
      try {
        const res = await fetch('/api/repo/directories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootPath: root || undefined, parent }),
        });
        const data = (await res.json()) as FolderBrowserResponse;
        if (!res.ok) {
          setFolderBrowserError(data.error ?? 'Could not list folder');
          setFolderBrowserEntries([]);
          return;
        }
        const nextRoot = data.root ?? root;
        const nextEntries: FolderBrowserEntry[] = Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data.directories)
            ? data.directories.map((entry) => ({ ...entry, type: 'dir' as const }))
            : [];
        setFolderBrowserRoot(nextRoot);
        setFolderBrowserParent(data.parent ?? parent ?? '');
        setFolderBrowserEntries(nextEntries);
        if (!folderBrowserManualPath || folderBrowserManualPath === root) {
          setFolderBrowserManualPath(nextRoot);
        }
      } catch (err) {
        setFolderBrowserError(err instanceof Error ? err.message : String(err));
        setFolderBrowserEntries([]);
      } finally {
        setFolderBrowserLoading(false);
      }
    },
    [folderBrowserManualPath],
  );

  const openFolderBrowser = useCallback(() => {
    setError(null);
    setFolderBrowserOpen(true);
    const initialRoot = localPath.trim() || folderBrowserRoot || '';
    setFolderBrowserManualPath(initialRoot);
    void loadFolderBrowserEntries(initialRoot, '');
  }, [folderBrowserRoot, loadFolderBrowserEntries, localPath]);

  const closeFolderBrowser = useCallback(() => {
    setFolderBrowserOpen(false);
  }, []);

  const handleFolderBrowserSelect = useCallback(
    async (absolutePath: string) => {
      const candidate = absolutePath.trim();
      if (!candidate) return;
      closeFolderBrowser();
      await openLocalProject(candidate);
    },
    [closeFolderBrowser, openLocalProject],
  );

  const handleManualOpen = useCallback(() => {
    if (!localPath.trim()) {
      openFolderBrowser();
      return;
    }
    void openLocalProject();
  }, [localPath, openFolderBrowser, openLocalProject]);

  // Motivation vs Logic: Allow project icons to trigger the same rename endpoint so the stored path and labels stay in sync.
  const renameProjectInternal = useCallback(
    async (project: CodeSpaceProject, nextName: string) => {
      if (!project.rootPath) {
        setError('Unable to rename project without a root path');
        return;
      }
      const parent = parentPath(project.rootPath);
      if (!parent) {
        setError('Unable to rename the root folder');
        if (project.id === activeProjectId) {
          setProjectNameInput(project.name);
        }
        return;
      }
      const currentFolder = basename(project.rootPath);
      setRenamingProjectId(project.id);
      setError(null);
      try {
        const res = await fetch('/api/code-space/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', rootPath: parent, path: currentFolder, nextPath: nextName }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'Rename failed');
        const nextRootPath = joinPathSegments(parent, nextName);
        const nextProject = {
          ...project,
          name: nextName,
          rootPath: nextRootPath,
          source: project.source ? { ...project.source, repoPath: nextRootPath } : undefined,
          updatedAt: Date.now(),
        };
        setProjects((current) => current.map((item) => (item.id === nextProject.id ? nextProject : item)));
        await saveCodeSpaceProject(nextProject);
        if (project.id === activeProjectId) {
          setLocalPath(nextRootPath);
          setProjectNameInput(nextName);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        if (project.id === activeProjectId) {
          setProjectNameInput(project.name);
        }
      } finally {
        setRenamingProjectId(null);
      }
    },
    [activeProjectId, saveCodeSpaceProject],
  );

  const commitProjectRename = useCallback(async () => {
    if (!activeProject) return;
    const nextName = projectNameInput.trim();
    if (!nextName || nextName === activeProject.name) {
      setProjectNameInput(activeProject.name);
      return;
    }
    await renameProjectInternal(activeProject, nextName);
  }, [activeProject, projectNameInput, renameProjectInternal]);

  const promptProjectRename = useCallback(
    (project: CodeSpaceProject) => {
      const candidate = window.prompt('Rename project', project.name);
      if (!candidate) return;
      const nextName = candidate.trim();
      if (!nextName || nextName === project.name) return;
      void renameProjectInternal(project, nextName);
    },
    [renameProjectInternal],
  );

  const confirmProjectDeletion = useCallback(async () => {
    if (!projectToDelete) return;
    setIsDeletingProject(true);
    setError(null);
    try {
      await deleteProjectDirectory(projectToDelete);
      finalizeProjectRemoval(projectToDelete.id);
      await deleteCodeSpaceProject(projectToDelete.id);
      setProjectToDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeletingProject(false);
    }
  }, [deleteProjectDirectory, finalizeProjectRemoval, projectToDelete]);

  const openFile = useCallback(
    async (project: CodeSpaceProject, filePath: string) => {
      if (!project.rootPath) return;
      const existing = tabs.find((tab) => tab.projectId === project.id && tab.path === filePath);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      setError(null);
      try {
        const res = await fetch('/api/code-space/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'read', rootPath: project.rootPath, path: filePath }),
        });
        const data = (await res.json()) as FilePayload & { error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Could not open file');
        const tab: CodeSpaceEditorTab = {
          id: nowId('tab'),
          projectId: project.id,
          path: filePath,
          language: detectCodeSpaceLanguage(filePath),
          contentHash: data.hash,
          dirty: false,
          pinned: true,
          preview: false,
          lastOpenedAt: Date.now(),
        };
        setFileContents((current) => ({ ...current, [tab.id]: data }));
        setTabs((current) => [tab, ...current]);
        setActiveTabId(tab.id);
        await saveCodeSpaceTab(tab);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [tabs],
  );

  const saveActiveFile = useCallback(async () => {
    if (!activeProject?.rootPath || !activeTab) return;
    const payload = fileContents[activeTab.id];
    if (!payload) return;
    setError(null);
    try {
      const res = await fetch('/api/code-space/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'write',
          rootPath: activeProject.rootPath,
          path: activeTab.path,
          content: payload.content,
          expectedHash: activeTab.contentHash,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      const nextTab = { ...activeTab, contentHash: data.hash, dirty: false, lastOpenedAt: Date.now() };
      setTabs((current) => current.map((tab) => (tab.id === nextTab.id ? nextTab : tab)));
      setFileContents((current) => ({ ...current, [activeTab.id]: { ...payload, hash: data.hash } }));
      await saveCodeSpaceTab(nextTab);
      void refreshGitStatus(activeProject);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeProject, activeTab, fileContents, refreshGitStatus]);

  const runFileAction = useCallback(
    async (body: Record<string, unknown>) => {
      if (!activeProject?.rootPath) return;
      setError(null);
      try {
        const res = await fetch('/api/code-space/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootPath: activeProject.rootPath, ...body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? 'File operation failed');
        const folder = typeof body.path === 'string' ? dirname(body.path) : '';
        await loadTree(activeProject, folder);
        await loadTree(activeProject, '');
        void refreshGitStatus(activeProject);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [activeProject, loadTree, refreshGitStatus],
  );

  const createFile = useCallback(() => {
    const target = window.prompt('Create file at project-relative path');
    if (!target) return;
    void runFileAction({ action: 'write', path: target, content: '' });
  }, [runFileAction]);

  const createFolder = useCallback(() => {
    const target = window.prompt('Create folder at project-relative path');
    if (!target) return;
    void runFileAction({ action: 'mkdir', path: target });
  }, [runFileAction]);

  const renameActiveFile = useCallback(() => {
    if (!activeTab) return;
    const target = window.prompt('Rename to project-relative path', activeTab.path);
    if (!target || target === activeTab.path) return;
    void runFileAction({ action: 'rename', path: activeTab.path, nextPath: target });
    setTabs((current) => current.map((tab) => (tab.id === activeTab.id ? { ...tab, path: target, language: detectCodeSpaceLanguage(target) } : tab)));
  }, [activeTab, runFileAction]);

  const duplicateActiveFile = useCallback(() => {
    if (!activeTab) return;
    const target = window.prompt('Duplicate to project-relative path', `${activeTab.path}.copy`);
    if (!target) return;
    void runFileAction({ action: 'duplicate', path: activeTab.path, nextPath: target });
  }, [activeTab, runFileAction]);

  const deleteActiveFile = useCallback(() => {
    if (!activeTab || !window.confirm(`Delete ${activeTab.path}? This cannot be undone here.`)) return;
    void runFileAction({ action: 'delete', path: activeTab.path });
    setTabs((current) => current.filter((tab) => tab.id !== activeTab.id));
    setActiveTabId(null);
  }, [activeTab, runFileAction]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) {
        if (event.key === 'Escape') setModalOpen(false);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        setLeftVisible((value) => !value);
      } else if (key === 'i') {
        event.preventDefault();
        setRightVisible((value) => !value);
      } else if (key === 's') {
        event.preventDefault();
        void saveActiveFile();
      } else if (key === '\\') {
        event.preventDefault();
        setBottomVisible((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [saveActiveFile]);

  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor as Monaco.editor.IStandaloneCodeEditor;
    monacoRef.current = monaco;
    registerDslLanguage(monaco);
    monaco.editor.setTheme(theme === 'light' ? 'agentdiagram-light' : 'agentdiagram-dark');
  };

  const onEditorChange = (value?: string) => {
    if (!activeTab) return;
    const content = value ?? '';
    setFileContents((current) => ({
      ...current,
      [activeTab.id]: {
        ...(current[activeTab.id] ?? { path: activeTab.path, hash: activeTab.contentHash, modifiedAt: Date.now() }),
        content,
      },
    }));
    setTabs((current) => current.map((tab) => (tab.id === activeTab.id ? { ...tab, dirty: content !== fileContents[activeTab.id]?.content || tab.dirty } : tab)));
  };

  const submitPrompt = useCallback(() => {
    if (!prompt.trim()) return;
    const session = ensureSession();
    const intents = classifyCodeSpaceIntent(prompt);
    const lifecycle = ['Plan', 'Apply', 'Review Diff', 'Run Checks', 'Finalize'];
    const ts = Date.now();
    const next: CodeSpaceAgentSession = {
      ...session,
      title: session.messages.length ? session.title : prompt.slice(0, 56),
      status: intents.includes('answer/question') || intents.includes('repository_explanation') ? 'planning' : 'planning',
      messages: [
        ...session.messages,
        { id: nowId('msg'), role: 'user', content: prompt, createdAt: ts },
        {
          id: nowId('msg'),
          role: 'assistant',
          content: `I classified this as ${intents.join(', ')}. I will inspect project context, prepare a plan, show reviewable diffs before risky changes, and run the safest discovered checks before finalizing.`,
          createdAt: ts + 1,
        },
      ],
      plan: [
        `Gather context from ${activeProject?.name ?? 'the active project'}, open files, manifests, docs, tests, and current git diff.`,
        'Produce a short implementation plan with acceptance criteria.',
        'Apply changes as a reversible session changeset and show the diff.',
        'Run relevant checks from package manifests or project config, then iterate on failures.',
      ],
      todos: lifecycle.map((text, index) => ({ id: `todo:${index}`, text, done: index === 0 })),
      toolCalls: [
        ...session.toolCalls,
        {
          id: nowId('tool'),
          name: 'classify_task',
          status: 'success',
          summary: `Detected ${intents.length} intent${intents.length === 1 ? '' : 's'}: ${intents.join(', ')}`,
          input: { prompt },
          output: { intents },
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      updatedAt: ts,
    };
    updateSession(next);
    setPrompt('');

    if (intents.includes('system_diagram')) {
      writeUiPreference('repoPath', activeProject?.rootPath ?? '');
      writeUiPreference('repoSourceType', activeProject?.sourceType === 'github' ? 'github' : 'local');
      setMode('multi-layer');
    }
  }, [activeProject, ensureSession, prompt, setMode, updateSession]);

  const routeToSystemDiagram = () => {
    if (!activeProject?.rootPath) return;
    writeUiPreference('repoPath', activeProject.rootPath);
    writeUiPreference('repoSourceType', activeProject.sourceType === 'github' ? 'github' : 'local');
    setMode('multi-layer');
  };

  const uploadPlanningZip = async (file: File) => {
    setZipSummary(null);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/code-space/plan-zip', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Planning zip validation failed');
        return;
      }
      const project = createCodeSpaceProject({
        name: file.name.replace(/\.zip$/i, ''),
        sourceType: 'zip',
        repoRef: file.name,
      });
      await addProject(project);
      const session = createSession(project.id, `Fresh start: ${project.name}`, 'fresh-start');
      const contextList = data.contextFiles?.map((entry: { path: string }) => `- ${entry.path}`).join('\n') ?? '';
      session.messages = [
        {
          id: nowId('msg'),
          role: 'system',
          content: `Fresh Start upload loaded ${data.planningFiles.length} planning file(s) and ${data.dslOrCodeFiles.length} DSL/code file(s).\n${contextList}`,
          createdAt: Date.now(),
        },
      ];
    session.plan = [
      'Read planning markdown first and extract acceptance criteria.',
      'Map DSL/code files to implementation tasks.',
      'Create scaffolding, components, routes, APIs, styling, tests, and docs required by the plan.',
      'Validate each TODO against the uploaded plan before marking it complete.',
    ];
    session.todos = session.plan.map((text, index) => ({ id: `fresh:${index}`, text, done: false }));
    updateSession(session);
    setActiveSessionId(session.id);
    setZipSummary(`Loaded ${data.planningFiles.length} planning file(s), ${data.dslOrCodeFiles.length} DSL/code file(s).`);
  };

  const renderTree = (project: CodeSpaceProject, folderPath = '', depth = 0) => {
    const key = `${project.id}:${folderPath}`;
    const nodes = treeChildren[key] ?? [];
    if (loadingTree[key]) {
      return <div className="px-3 py-1.5 text-[12px] text-ink-500">Loading folder…</div>;
    }
    return nodes
      .filter((node) => revealHidden || !isCodeSpaceHiddenPath(node.path))
      .filter((node) => !projectSearch || node.path.toLowerCase().includes(projectSearch.toLowerCase()))
      .map((node) => {
        const nodeKey = `${project.id}:${node.path}`;
        const isOpen = expanded[nodeKey];
        const isActive = activeTab?.projectId === project.id && activeTab.path === node.path;
        return (
          <div key={nodeKey}>
            <button
              type="button"
              aria-current={isActive ? 'true' : undefined}
              aria-expanded={node.type === 'dir' ? isOpen : undefined}
              onClick={() => {
                if (node.type === 'dir') {
                  setExpanded((current) => ({ ...current, [nodeKey]: !current[nodeKey] }));
                  if (!isOpen) void loadTree(project, node.path);
                } else {
                  void openFile(project, node.path);
                }
              }}
              className={`group flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-[12px] ${
                isActive ? 'bg-[#37373d] text-[#d4d4d4]' : 'text-[#b9b9b9] hover:bg-[#2a2d2e]'
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={node.path}
            >
              {node.type === 'dir' ? (
                isOpen ? <ChevronDown size={13} className="text-ink-500" /> : <ChevronRight size={13} className="text-ink-500" />
              ) : (
                <span className="w-[13px]" />
              )}
              {node.type === 'dir' ? (
                isOpen ? <FolderOpen size={14} className="text-accent-warm" /> : <Folder size={14} className="text-accent-warm/80" />
              ) : (
                fileIcon(node.path)
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.hidden && <span className="rounded bg-ink-800 px-1 text-[9px] text-ink-500">hidden</span>}
            </button>
            {node.type === 'dir' && isOpen && renderTree(project, node.path, depth + 1)}
          </div>
        );
      });
  };

  const activeContent = activeTab ? fileContents[activeTab.id]?.content ?? '' : '';
  const breadcrumbs = activeProject && activeTab ? [activeProject.name, ...activeTab.path.split('/').filter(Boolean)] : [];
  const filteredSessions = sessions.filter((session) => {
    if (session.projectId && activeProjectId && session.projectId !== activeProjectId) return false;
    if (!sessionSearch) return true;
    return `${session.title} ${session.messages.map((message) => message.content).join(' ')}`
      .toLowerCase()
      .includes(sessionSearch.toLowerCase());
  });
  const recentSessions = filteredSessions.filter((session) => !session.archived);
  const archivedSessions = filteredSessions.filter((session) => session.archived);
  // Motivation vs Logic: showing a quick snapshot of the root entries keeps the preview actionable before any file is opened.
  const activeProjectPreviewKey = activeProject ? `${activeProject.id}:` : '';
  const activeProjectPreviewNodes = activeProjectPreviewKey ? treeChildren[activeProjectPreviewKey] ?? [] : [];
  const activeProjectPreviewLoading = activeProjectPreviewKey ? Boolean(loadingTree[activeProjectPreviewKey]) : false;
  const activeProjectPreviewSnapshot = activeProjectPreviewNodes.slice(0, 5);

  return (
    <main className="code-space-workbench flex min-h-0 flex-1 overflow-hidden bg-[#181818] text-[#d4d4d4]">
      {leftVisible && (
        <aside className="flex min-h-0 shrink-0 border-r border-[#2a2a2a] bg-[#151515]" style={{ width: leftWidth }}>
          <div className="flex w-11 flex-col items-center gap-2 border-r border-[#2a2a2a] bg-[#181818] py-3">
            <button className="rounded-md bg-[#37373d] p-2 text-[#d4d4d4]" type="button" title="Explorer">
              <Folder size={17} />
            </button>
            <button className="rounded-md p-2 text-[#8b8b8b] hover:bg-[#2a2d2e]" type="button" title="Search">
              <Search size={17} />
            </button>
            <button className="rounded-md p-2 text-[#8b8b8b] hover:bg-[#2a2d2e]" type="button" title="Source Control">
              <GitBranch size={17} />
            </button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 items-center justify-between border-b border-[#2a2a2a] px-3 text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
              Explorer
              <div className="flex items-center gap-1">
                <button type="button" title="Create file" onClick={createFile} disabled={!activeProject} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40">
                  <File size={13} />
                </button>
                <button type="button" title="Create folder" onClick={createFolder} disabled={!activeProject} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40">
                  <Folder size={13} />
                </button>
                <button type="button" title="Refresh tree" onClick={() => activeProject && void loadTree(activeProject, '')} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                  <RefreshCw size={13} />
                </button>
                <button type="button" title="Collapse all" onClick={() => setExpanded({})} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="space-y-3 border-b border-[#2a2a2a] p-3">
              <input value={projectSearch} onChange={(e) => setProjectSearch(e.target.value)} placeholder="Search in project" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 text-[12px] outline-none focus:border-accent/70" />
              <div className="space-y-3">
                <div className="space-y-1 text-[11px] text-[#8b8b8b]">
                  <div className="uppercase tracking-wider">Enter path manually</div>
                  <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="/path/to/repo" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 font-mono text-[11px]" />
                  <button type="button" onClick={() => void handleManualOpen()} className="w-full rounded border border-[#2a2a2a] bg-[#252526] px-2 py-1.5 text-[11px] hover:bg-[#2a2d2e]">Open Path</button>
                </div>
                <div className="space-y-1 text-[11px] text-[#8b8b8b]">
                  <div className="uppercase tracking-wider">Clone GitHub</div>
                  <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 font-mono text-[11px]" />
                  <button type="button" onClick={() => void cloneGithubProject()} className="w-full rounded border border-accent/40 bg-accent/15 px-2 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/25">Clone GitHub</button>
                </div>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-[#8b8b8b]">
                <input type="checkbox" checked={revealHidden} onChange={(e) => setRevealHidden(e.target.checked)} />
                Reveal hidden/generated folders
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {projects.length === 0 ? (
                <div className="m-3 rounded border border-dashed border-[#37373d] p-4 text-[12px] text-[#8b8b8b]">
                  Open a local path or clone GitHub to start.
                </div>
              ) : (
                projects.map((project) => {
                  const isActiveProject = project.id === activeProjectId;
                  const isOpen = expanded[project.id] ?? isActiveProject;
                  return (
                <div key={project.id} className="mb-1">
                  <div className="relative group">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => {
                        setActiveProjectId(project.id);
                        setExpanded((current) => ({ ...current, [project.id]: !isOpen }));
                      }}
                      className={`flex h-8 w-full items-center gap-1 rounded px-2 pr-16 text-left text-[12px] ${isActiveProject ? 'bg-[#37373d] text-[#d4d4d4]' : 'text-[#cccccc] hover:bg-[#2a2d2e]'}`}
                    >
                      {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <Box size={14} className={project.sourceType === 'github' ? 'text-accent-cool' : 'text-accent-warm'} />
                      <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
                      <span className="rounded bg-[#252526] px-1.5 py-0.5 text-[9px] uppercase text-[#8b8b8b]">{project.sourceType}</span>
                    </button>
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 pointer-events-none">
                      <button
                        type="button"
                        title="Rename project"
                        onClick={(event) => {
                          event.stopPropagation();
                          promptProjectRename(project);
                        }}
                        className="pointer-events-auto rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        title="Delete project"
                        onClick={(event) => {
                          event.stopPropagation();
                          setProjectToDelete(project);
                        }}
                        className="pointer-events-auto rounded p-1 text-red-400 hover:bg-red-500/10"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <>
                      <div className="ml-7 flex gap-2 py-1 text-[10px] text-[#8b8b8b]">
                        <span>{project.git?.branch ?? project.branch ?? 'no branch'}</span>
                        <span>{project.git?.changedFiles ?? 0} changed</span>
                      </div>
                      {renderTree(project)}
                    </>
                  )}
                </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[35px] items-center border-b border-[#2a2a2a] bg-[#1e1e1e]">
          <button type="button" onClick={() => setLeftVisible((value) => !value)} className="mx-1 rounded p-1.5 text-[#8b8b8b] hover:bg-[#2a2d2e]" title="Toggle explorer (Cmd/Ctrl+B)">
            <PanelLeft size={15} />
          </button>
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button key={tab.id} type="button" onClick={() => setActiveTabId(tab.id)} className={`group flex h-[35px] max-w-52 items-center gap-2 border-r border-[#2a2a2a] px-3 text-[12px] ${activeTabId === tab.id ? 'bg-[#1e1e1e] text-[#d4d4d4]' : 'bg-[#181818] text-[#8b8b8b] hover:bg-[#2a2d2e]'}`}>
                {fileIcon(tab.path)}
                <span className="truncate">{basename(tab.path)}</span>
                {tab.dirty && <span className="h-2 w-2 rounded-full bg-accent" />}
                <span onClick={(event) => { event.stopPropagation(); setTabs((current) => current.filter((item) => item.id !== tab.id)); if (activeTabId === tab.id) setActiveTabId(null); }} className="rounded p-0.5 opacity-0 hover:bg-[#37373d] group-hover:opacity-100">
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
          <button type="button" onClick={saveActiveFile} disabled={!activeTab?.dirty} className="mx-1 rounded p-1.5 text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40" title="Save active file (Cmd/Ctrl+S)">
            <Save size={15} />
          </button>
          <button type="button" onClick={renameActiveFile} disabled={!activeTab} className="rounded px-2 py-1 text-[11px] text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40">Rename</button>
          <button type="button" onClick={duplicateActiveFile} disabled={!activeTab} className="rounded px-2 py-1 text-[11px] text-[#8b8b8b] hover:bg-[#2a2d2e] disabled:opacity-40">Duplicate</button>
          <button type="button" onClick={deleteActiveFile} disabled={!activeTab} className="rounded px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-40">Delete</button>
          <button type="button" onClick={() => setRightVisible((value) => !value)} className="mx-1 rounded p-1.5 text-[#8b8b8b] hover:bg-[#2a2d2e]" title="Toggle agent (Cmd/Ctrl+I)">
            <PanelRight size={15} />
          </button>
        </div>

        <div className="flex h-7 items-center gap-1 border-b border-[#2a2a2a] bg-[#181818] px-3 text-[11px] text-[#8b8b8b]">
          {breadcrumbs.length ? breadcrumbs.map((crumb, index) => (
            <span key={`${crumb}-${index}`} className={index === breadcrumbs.length - 1 ? 'text-[#cccccc]' : ''}>
              {index > 0 && <span className="mx-1 text-[#555]">/</span>}
              {crumb}
            </span>
          )) : <span>No file selected</span>}
        </div>

        <div className="min-h-0 flex-1 bg-[#1e1e1e]">
          {activeTab ? (
            <Editor
              height="100%"
              theme={theme === 'light' ? 'agentdiagram-light' : 'agentdiagram-dark'}
              language={activeTab.language}
              path={`${activeTab.projectId}/${activeTab.path}`}
              value={activeContent}
              onChange={onEditorChange}
              onMount={onEditorMount}
              options={{
                readOnly: activeTab.path.includes('/generated/'),
                minimap: { enabled: minimapEnabled },
                wordWrap: wordWrap ? 'on' : 'off',
                fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                lineNumbers: 'on',
                folding: true,
                bracketPairColorization: { enabled: true },
                guides: { indentation: true, bracketPairs: true },
                renderWhitespace: 'selection',
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          ) : activeProject ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-3xl rounded-xl border border-[#2a2a2a] bg-[#181818] p-6 shadow-2xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Code2 className="text-accent" size={30} />
                    <h2 className="text-lg font-semibold text-[#d4d4d4]">Project Preview</h2>
                    <p className="text-sm text-[#8b8b8b]">Preview the root folder before opening files or running tasks.</p>
                  </div>
                  <div className="text-xs uppercase tracking-wider text-[#6b6b6b]">{basename(activeProject.rootPath ?? activeProject.name)}</div>
                </div>
                <div className="mt-4 space-y-4 text-left">
                  <div className="space-y-1">
                    <label className="text-[12px] font-semibold text-[#bfbfbf]">Root folder name</label>
                    <input
                      value={projectNameInput}
                      onChange={(e) => setProjectNameInput(e.target.value)}
                      onBlur={() => void commitProjectRename()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void commitProjectRename();
                        }
                      }}
                    disabled={renamingProjectId === activeProject?.id}
                      className="w-full rounded border border-[#2a2a2a] bg-[#121212] px-3 py-2 text-sm outline-none transition focus:border-accent/60"
                    />
                    <p className="text-[11px] text-[#6b6b6b]">Press Enter or leave the field to rename the folder on disk.</p>
                  </div>
                  <div className="space-y-2">
                    <div className="text-[11px] uppercase tracking-wider text-[#8b8b8b]">Preview</div>
                    {activeProjectPreviewLoading ? (
                      <div className="text-[12px] text-[#8b8b8b]">Loading preview…</div>
                    ) : activeProjectPreviewSnapshot.length ? (
                      <div className="space-y-1">
                        {activeProjectPreviewSnapshot.map((node) => (
                          <div key={node.path} className="flex items-center gap-2 rounded border border-[#2a2a2a] bg-[#1e1e1e] px-3 py-1 text-[12px] text-[#d4d4d4]">
                            {node.type === 'dir' ? <Folder size={14} className="text-accent-warm" /> : <File size={14} className="text-ink-400" />}
                            <span className="flex-1 truncate">{node.name}</span>
                            <span className="text-[10px] text-[#6d6d6d]">{node.type}</span>
                          </div>
                        ))}
                        {activeProjectPreviewNodes.length > activeProjectPreviewSnapshot.length && (
                          <div className="text-[11px] text-[#8b8b8b]">And {activeProjectPreviewNodes.length - activeProjectPreviewSnapshot.length} more item(s)…</div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[11px] text-[#8b8b8b]">The folder looks empty—add files to see them here.</div>
                    )}
                  </div>
                  <div className="text-[11px] text-[#8b8b8b]">
                    Root path: <span className="font-mono text-[11px] text-[#d4d4d4]">{activeProject.rootPath ?? 'Unknown'}</span>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={() => setLeftVisible(true)} className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[11px] text-[#d4d4d4]">Show Explorer</button>
                    <button type="button" onClick={() => activeProject && void loadTree(activeProject, '')} className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/25">Refresh Preview</button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-2xl rounded-xl border border-[#2a2a2a] bg-[#181818] p-7 text-center">
                <Wand2 className="mx-auto mb-3 text-accent" size={34} />
                <h2 className="text-xl font-semibold">Open a project to enter Code Space</h2>
                <p className="mt-2 text-sm text-[#8b8b8b]">Use Explorer to open a local folder, clone from GitHub, or start from Fresh Start.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => setModalOpen(true)} className="rounded border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-semibold text-accent">Fresh Start</button>
                  <button type="button" onClick={openFolderBrowser} className="rounded border border-[#2a2a2a] bg-[#252526] px-4 py-2 text-sm">Open Path</button>
                  <button type="button" onClick={() => void promptToCloneGithub()} className="rounded border border-[#2a2a2a] bg-[#252526] px-4 py-2 text-sm">Clone GitHub</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {bottomVisible && (
          <BottomPanel
            activeSession={activeSession}
            bottomActiveTab={bottomActiveTab}
            error={error}
            minimapEnabled={minimapEnabled}
            onToggleMinimap={() => setMinimapEnabled((value) => !value)}
            wordWrap={wordWrap}
            onToggleWordWrap={() => setWordWrap((value) => !value)}
            onTabChange={(tab) => setBottomActiveTab(tab)}
            onHide={() => setBottomVisible(false)}
            projectName={activeProject?.name ?? 'No project'}
            projectRoot={activeProject?.rootPath ?? undefined}
          />
        )}
      </section>

      {rightVisible && (
        <aside className="flex min-h-0 shrink-0 flex-col border-l border-[#2a2a2a] bg-[#181818]" style={{ width: rightWidth }}>
          <div className="flex h-11 items-center justify-between border-b border-[#2a2a2a] px-3">
            <div className="flex items-center gap-2 text-sm font-semibold"><Bot size={16} className="text-accent" /> Agent Sessions</div>
            <button type="button" onClick={() => { const session = createSession(activeProjectId); setActiveSessionId(session.id); updateSession(session); }} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-2 py-1 text-[11px] text-accent">
              <Plus size={13} /> New Session
            </button>
          </div>
          <div className="space-y-3 border-b border-[#2a2a2a] p-3">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2.5 text-[#8b8b8b]" />
              <input value={sessionSearch} onChange={(e) => setSessionSearch(e.target.value)} placeholder="Search sessions and agents" className="h-8 w-full rounded border border-[#2a2a2a] bg-[#151515] pl-7 pr-2 text-[12px]" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setModalOpen(true)} className="rounded border border-[#2a2a2a] bg-[#252526] px-2 py-2 text-[12px] font-semibold hover:bg-[#2a2d2e]"><Sparkles className="mr-1 inline" size={13} /> Fresh Start</button>
              <button type="button" disabled={!activeProject} onClick={routeToSystemDiagram} title={activeProject ? 'Route active project to Multi Layer' : 'Open, clone, or select a project first'} className="rounded border border-[#2a2a2a] bg-[#252526] px-2 py-2 text-[12px] font-semibold hover:bg-[#2a2d2e] disabled:cursor-not-allowed disabled:opacity-40"><Layers3 className="mr-1 inline" size={13} /> Generate Diagram</button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-[#8b8b8b]">Recent</div>
            {recentSessions.length ? recentSessions.map((session) => (
              <button key={session.id} type="button" onClick={() => setActiveSessionId(session.id)} className={`mb-1 w-full rounded border px-2 py-2 text-left text-[12px] ${activeSessionId === session.id ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:border-[#2a2a2a] hover:bg-[#252526]'}`}>
                <div className="truncate font-medium">{session.title}</div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-[#8b8b8b]"><History size={11} /> {session.status} · {new Date(session.updatedAt).toLocaleString()}</div>
              </button>
            )) : <div className="rounded border border-dashed border-[#37373d] p-3 text-[12px] text-[#8b8b8b]">No sessions yet.</div>}
            <div className="mb-2 mt-5 text-[11px] uppercase tracking-wider text-[#8b8b8b]">Archived</div>
            {archivedSessions.length ? archivedSessions.map((session) => <div key={session.id} className="flex items-center gap-2 text-[12px] text-[#8b8b8b]"><Archive size={12} /> {session.title}</div>) : <div className="text-[12px] text-[#555]">Nothing archived.</div>}
          </div>
          <div className="border-t border-[#2a2a2a] p-3">
            {!activeSession?.messages.length && (
              <div className="mb-2 flex flex-wrap gap-1">
                {DEFAULT_SESSION_EXAMPLES.map((example) => <button key={example} type="button" onClick={() => setPrompt(example)} className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#8b8b8b] hover:bg-[#252526]">{example}</button>)}
              </div>
            )}
            {activeSession?.plan.length ? (
              <div className="mb-3 rounded border border-[#2a2a2a] bg-[#151515] p-2 text-[11px]">
                <div className="mb-1 font-semibold text-[#cccccc]">Lifecycle</div>
                {activeSession.todos.map((todo) => <div key={todo.id} className={todo.done ? 'text-green-300' : 'text-[#8b8b8b]'}>{todo.done ? '✓' : '○'} {todo.text}</div>)}
              </div>
            ) : null}
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask Code Space to plan, edit, debug, refactor, test, or explain…" className="h-24 w-full resize-none rounded border border-[#2a2a2a] bg-[#151515] p-2 text-[12px] outline-none focus:border-accent/60" />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-[#8b8b8b]">Plan → Apply → Review Diff → Run Checks → Finalize</span>
              <button type="button" onClick={submitPrompt} className="flex items-center gap-1 rounded border border-accent/40 bg-accent/20 px-3 py-1.5 text-[12px] font-semibold text-accent"><Play size={13} /> Send</button>
            </div>
            {/* Motivation vs Logic: Surfacing the config link right here keeps model/provider tweaks close to the prompt context so sessions stay uninterrupted. */}
            <div className="mt-1 text-[10px]">
            <button
              type="button"
              onClick={() => setProviderConfigOpen(true)}
              className="text-accent underline decoration-[1px] underline-offset-2 hover:text-[#d4d4d4] focus-visible:outline-accent/70"
            >
                Open Model Configs
              </button>
            </div>
          </div>
        </aside>
      )}

      {folderBrowserOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFolderBrowser();
          }}
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Open local folder</h2>
                <p className="mt-1 text-[12px] text-[#8b8b8b]">
                  Browse your machine&apos;s filesystem and pick a project root. The selected absolute path is used directly—no upload prompt required.
                </p>
              </div>
              <button type="button" onClick={closeFolderBrowser} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                <X size={16} />
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                title="Up one level"
                onClick={() => {
                  const next = folderBrowserParent.split('/').slice(0, -1).filter(Boolean).join('/');
                  void loadFolderBrowserEntries(folderBrowserRoot, next);
                }}
                disabled={folderBrowserLoading || !folderBrowserParent}
                className="rounded border border-[#2a2a2a] bg-[#252526] p-1.5 text-[#d4d4d4] hover:bg-[#2a2d2e] disabled:opacity-40"
              >
                <ChevronLeft size={14} />
              </button>
              <input
                value={folderBrowserManualPath}
                onChange={(event) => setFolderBrowserManualPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const next = folderBrowserManualPath.trim();
                    if (!next) return;
                    void loadFolderBrowserEntries(next, '');
                  }
                }}
                placeholder="/absolute/path/to/folder"
                className="h-8 w-full rounded border border-[#2a2a2a] bg-[#1e1e1e] px-2 font-mono text-[11px] outline-none focus:border-accent/70"
              />
              <button
                type="button"
                onClick={() => {
                  const next = folderBrowserManualPath.trim();
                  if (!next) return;
                  void loadFolderBrowserEntries(next, '');
                }}
                className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[11px] hover:bg-[#2a2d2e]"
              >
                Go
              </button>
            </div>
            <div className="mt-2 flex items-center gap-1 text-[11px] text-[#8b8b8b]">
              <span className="uppercase tracking-wider">Root</span>
              <span className="font-mono text-[11px] text-[#d4d4d4]">{folderBrowserRoot || '—'}</span>
              {folderBrowserParent && (
                <>
                  <span className="text-[#555]">/</span>
                  <span className="font-mono text-[11px] text-[#d4d4d4]">{folderBrowserParent}</span>
                </>
              )}
            </div>
            <div className="mt-3 min-h-[200px] flex-1 overflow-y-auto rounded border border-[#2a2a2a] bg-[#0f0f0f]">
              {folderBrowserLoading ? (
                <div className="p-4 text-[12px] text-[#8b8b8b]">Loading…</div>
              ) : folderBrowserError ? (
                <div className="p-4 text-[12px] text-red-300">{folderBrowserError}</div>
              ) : folderBrowserEntries.length === 0 ? (
                <div className="p-4 text-[12px] text-[#8b8b8b]">This folder is empty.</div>
              ) : (
                <ul className="divide-y divide-[#1f1f1f]">
                  {folderBrowserEntries.map((entry) => (
                    <li key={`${entry.type}:${entry.path}`}>
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.type !== 'dir') return;
                          void loadFolderBrowserEntries(folderBrowserRoot, entry.path);
                        }}
                        disabled={entry.type !== 'dir'}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-[#1a1a1a] ${entry.type === 'dir' ? 'text-[#d4d4d4]' : 'cursor-default text-[#8b8b8b]'}`}
                      >
                        {entry.type === 'dir' ? (
                          <Folder size={14} className="text-accent-warm" />
                        ) : (
                          <File size={14} className="text-ink-400" />
                        )}
                        <span className="flex-1 truncate">{entry.name}</span>
                        <span className="text-[10px] uppercase tracking-wider text-[#6d6d6d]">{entry.type}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-[#8b8b8b]">
                Opens the folder currently shown above as a Code Space project.
              </span>
              <button
                type="button"
                onClick={closeFolderBrowser}
                className="rounded border border-[#2a2a2a] bg-[#252526] px-3 py-1.5 text-[12px] hover:bg-[#2a2d2e]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const root = folderBrowserRoot;
                  const parent = folderBrowserParent;
                  const absolute = parent ? `${root.replace(/\/+$/, '')}/${parent}` : root;
                  void handleFolderBrowserSelect(absolute);
                }}
                disabled={folderBrowserLoading || (!folderBrowserRoot && !folderBrowserParent)}
                className="rounded border border-accent/40 bg-accent/20 px-3 py-1.5 text-[12px] font-semibold text-accent hover:bg-accent/30 disabled:opacity-40"
              >
                Open this folder
              </button>
            </div>
          </div>
        </div>
      )}
      {modalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalOpen(false); }}>
          <div className="w-full max-w-lg rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Fresh Start</h2>
                <p className="mt-1 text-sm text-[#8b8b8b]">Upload the planning zip generated from Custom App, or brainstorm a new app there first.</p>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"><X size={16} /></button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="cursor-pointer rounded-lg border border-accent/40 bg-accent/10 p-4 hover:bg-accent/20">
                <Upload className="mb-2 text-accent" size={22} />
                <div className="font-semibold">Upload Zip</div>
                <div className="mt-1 text-xs text-[#8b8b8b]">Validates planning/instruction markdown plus DSL/code files and starts a fresh-build session.</div>
                <input type="file" accept=".zip" className="hidden" onChange={(e) => e.target.files?.[0] && void uploadPlanningZip(e.target.files[0])} />
              </label>
              <button type="button" onClick={() => { setModalOpen(false); setMode('custom-prompt'); }} className="rounded-lg border border-[#2a2a2a] bg-[#252526] p-4 text-left hover:bg-[#2a2d2e]">
                <Sparkles className="mb-2 text-accent-warm" size={22} />
                <div className="font-semibold">Brainstorm App</div>
                <div className="mt-1 text-xs text-[#8b8b8b]">Go to Custom App and choose instruction/planning mode so the generated zip includes an app-planning .md file plus all DSL code files.</div>
              </button>
            </div>
            {zipSummary && <div className="mt-4 rounded border border-green-400/40 bg-green-400/10 p-3 text-sm text-green-200">{zipSummary}</div>}
            {error && <details className="mt-4 rounded border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-200"><summary>Upload or workspace error</summary><div className="mt-2 whitespace-pre-wrap font-mono text-xs">{error}</div></details>}
          </div>
        </div>
      )}
      {projectToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProjectToDelete(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Delete project</h2>
                <p className="mt-1 text-sm text-[#8b8b8b]">
                  This removes <span className="font-semibold text-[#d4d4d4]">{projectToDelete.name}</span> from disk permanently.
                </p>
              </div>
              <button type="button" onClick={() => setProjectToDelete(null)} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]">
                <X size={16} />
              </button>
            </div>
            <div className="mt-4 text-[11px] text-[#8b8b8b]">
              <div>Project root:</div>
              <div className="font-mono text-[11px] text-[#d4d4d4]">{projectToDelete.rootPath ?? 'Unknown'}</div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setProjectToDelete(null)} className="rounded border border-[#2a2a2a] bg-[#252526] px-4 py-2 text-sm hover:bg-[#2a2d2e]">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmProjectDeletion}
                disabled={isDeletingProject}
                className="rounded bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {isDeletingProject ? 'Deleting…' : 'Delete project'}
              </button>
            </div>
          </div>
        </div>
      )}
      {providerConfigOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProviderConfigOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-[#2a2a2a] bg-[#181818] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Model Configs</h2>
                <p className="mt-1 text-sm text-[#8b8b8b]">Choose or validate the AI provider you want this session to use.</p>
              </div>
              <button type="button" onClick={() => setProviderConfigOpen(false)} className="rounded p-1 text-[#8b8b8b] hover:bg-[#2a2d2e]"><X size={16} /></button>
            </div>
            <div className="mt-4">
              <ProviderConfig />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
