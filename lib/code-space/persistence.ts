'use client';

import type { CodeSpaceAgentSession, CodeSpaceEditorTab, CodeSpaceProject } from './core';

const DB_NAME = 'agentdiagram-code-space';
const DB_VERSION = 1;
const PROJECT_STORE = 'projects';
const SESSION_STORE = 'sessions';
const TAB_STORE = 'tabs';
const PREFERENCES_KEY = 'agentdiagram:code-space:preferences:v1';

export interface CodeSpaceLayoutPreferences {
  activeProjectId?: string | null;
  activeSessionId?: string | null;
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomPanelVisible?: boolean;
  minimapEnabled?: boolean;
  wordWrap?: boolean;
  revealHiddenFiles?: boolean;
}

function canUseIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function openCodeSpaceDb(): Promise<IDBDatabase> {
  if (!canUseIndexedDb()) return Promise.reject(new Error('IndexedDB is unavailable'));

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const store = db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(TAB_STORE)) {
        const store = db.createObjectStore(TAB_STORE, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openCodeSpaceDb();
    return await new Promise<T[]>((resolve, reject) => {
      const request = db.transaction([storeName], 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function putInStore<T>(storeName: string, value: T): Promise<void> {
  const db = await openCodeSpaceDb();
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction([storeName], 'readwrite').objectStore(storeName).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function readCodeSpacePreferences(): CodeSpaceLayoutPreferences {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CodeSpaceLayoutPreferences;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function writeCodeSpacePreferences(next: CodeSpaceLayoutPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...readCodeSpacePreferences(), ...next }));
  } catch {
    // Local preferences are non-critical; keep the workbench usable if storage is full.
  }
}

export async function readCodeSpaceProjects(): Promise<CodeSpaceProject[]> {
  return getAllFromStore<CodeSpaceProject>(PROJECT_STORE);
}

export async function saveCodeSpaceProject(project: CodeSpaceProject): Promise<void> {
  await putInStore(PROJECT_STORE, project);
}

export async function readCodeSpaceSessions(): Promise<CodeSpaceAgentSession[]> {
  const sessions = await getAllFromStore<CodeSpaceAgentSession>(SESSION_STORE);
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveCodeSpaceSession(session: CodeSpaceAgentSession): Promise<void> {
  await putInStore(SESSION_STORE, session);
}

export async function readCodeSpaceTabs(): Promise<CodeSpaceEditorTab[]> {
  const tabs = await getAllFromStore<CodeSpaceEditorTab>(TAB_STORE);
  return tabs.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export async function saveCodeSpaceTab(tab: CodeSpaceEditorTab): Promise<void> {
  await putInStore(TAB_STORE, tab);
}
