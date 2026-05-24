/**
 * IndexDB Cache for Pre-Rendered Diagrams
 *
 * Provides persistent browser storage for diagram layout results and
 * pre-routed edges. Enables instant rendering on page reload without
 * re-running expensive layout and routing passes.
 *
 * Cache entries include:
 * - layoutResult: The ELK-computed or Graphviz-computed layout
 * - routedEdges: Pre-computed SVG paths and control points (optional)
 * - Project/layer metadata for cache invalidation on deletion
 * - LRU timestamp for eviction when storage quota is reached
 *
 * **Important**: Cache is automatically cleared when users delete layers or projects.
 * Do not store cache entries that reference deleted entities.
 */

import type { LayoutResult } from '../layout/elk';
import type { RoutedEdgePath } from '../render/edgePath';

/**
 * Cached routed edge path with edgeId for reconstruction in the main thread.
 */
interface CachedRoutedEdge extends RoutedEdgePath {
  edgeId: string;
}

const DB_NAME = 'diagram-cache';
const STORE_NAME = 'diagrams';
const MAX_SIZE = 50; // Max number of cached diagrams (LRU eviction)

export interface CachedDiagram {
  cacheKey: string; // djb2 hash of diagram structure
  dslHash: string; // hash of original DSL source
  projectId: string; // for project-level deletion
  layerId: string; // for layer-level deletion
  timestamp: number; // last accessed (milliseconds since epoch)
  layoutResult: LayoutResult; // ELK or Graphviz layout
  routedEdges?: CachedRoutedEdge[]; // pre-routed edge paths with IDs (array for JSON serialization)
}

/**
 * Retrieve cached layout and routed edges by cache key.
 * Updates timestamp on hit for LRU tracking.
 */
export async function getCachedLayout(
  cacheKey: string,
): Promise<{
  layoutResult: LayoutResult;
  routedEdges?: CachedRoutedEdge[];
} | null> {
  try {
    const db = await openDB();
    const store = db
      .transaction([STORE_NAME], 'readonly')
      .objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const req = store.get(cacheKey);
      req.onsuccess = () => {
        const entry = req.result as CachedDiagram | undefined;
        if (entry) {
          // Async update timestamp without blocking the read
          db.transaction([STORE_NAME], 'readwrite')
            .objectStore(STORE_NAME)
            .put({
              ...entry,
              timestamp: Date.now(),
            });

          resolve({
            layoutResult: entry.layoutResult,
            routedEdges: entry.routedEdges,
          });
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[IndexDB] Failed to retrieve cached layout:', err);
    return null;
  }
}

/**
 * Store layout and routed edges in IndexDB.
 * Evicts oldest (LRU) entry if cache is at MAX_SIZE.
 */
export async function cacheLayoutResult(
  cacheKey: string,
  layoutResult: LayoutResult,
  routedEdges: CachedRoutedEdge[] | undefined,
  projectId: string,
  layerId: string,
  dslHash: string,
): Promise<void> {
  try {
    const db = await openDB();

    // First, check if cache is full and evict oldest entry
    const store = db
      .transaction([STORE_NAME], 'readwrite')
      .objectStore(STORE_NAME);

    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count >= MAX_SIZE) {
        // Get all entries and sort by timestamp
        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
          const all = getAllReq.result as CachedDiagram[];
          const oldest = all.sort((a, b) => a.timestamp - b.timestamp)[0];
          if (oldest) {
            store.delete(oldest.cacheKey);
          }
        };
      }

      // Now insert/update the new entry
      const entry: CachedDiagram = {
        cacheKey,
        layoutResult,
        routedEdges,
        projectId,
        layerId,
        dslHash,
        timestamp: Date.now(),
      };
      store.put(entry);
    };
  } catch (err) {
    console.warn('[IndexDB] Failed to cache layout result:', err);
    // Silently fail — caching is an optimization, not critical
  }
}

/**
 * Clear all cache entries for a specific layer.
 * Called when user deletes a layer.
 */
export async function clearByLayerId(layerId: string): Promise<void> {
  try {
    const db = await openDB();
    const store = db
      .transaction([STORE_NAME], 'readwrite')
      .objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result as CachedDiagram[];
        for (const entry of all) {
          if (entry.layerId === layerId) {
            store.delete(entry.cacheKey);
          }
        }
        resolve();
      };
      getAllReq.onerror = () => reject(getAllReq.error);
    });
  } catch (err) {
    console.warn('[IndexDB] Failed to clear cache by layer:', err);
  }
}

/**
 * Clear all cache entries for a specific project.
 * Called when user deletes a project.
 */
export async function clearByProjectId(projectId: string): Promise<void> {
  try {
    const db = await openDB();
    const store = db
      .transaction([STORE_NAME], 'readwrite')
      .objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const getAllReq = store.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result as CachedDiagram[];
        for (const entry of all) {
          if (entry.projectId === projectId) {
            store.delete(entry.cacheKey);
          }
        }
        resolve();
      };
      getAllReq.onerror = () => reject(getAllReq.error);
    });
  } catch (err) {
    console.warn('[IndexDB] Failed to clear cache by project:', err);
  }
}

/**
 * Clear all cached diagrams.
 * Used by manual cache clear in Settings.
 */
export async function clearAllCache(): Promise<void> {
  try {
    const db = await openDB();
    const store = db
      .transaction([STORE_NAME], 'readwrite')
      .objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[IndexDB] Failed to clear all cache:', err);
  }
}

/**
 * Get the total number of cached diagrams.
 * Used for diagnostics and the Settings UI.
 */
export async function getCacheSize(): Promise<number> {
  try {
    const db = await openDB();
    const store = db
      .transaction([STORE_NAME], 'readonly')
      .objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[IndexDB] Failed to get cache size:', err);
    return 0;
  }
}

/**
 * Open or create the IndexDB database.
 * Called on first access; subsequent calls reuse the same connection.
 */
async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
