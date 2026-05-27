/**
 * Session auto-naming utilities.
 *
 * nameSessionAsync: fires a background LLM call to generate a meaningful title,
 * falls back to extractFallbackName on any error.
 *
 * extractFallbackName: lightweight rule-based extraction used as fallback.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'in', 'on',
  'at', 'by', 'for', 'with', 'from', 'of', 'and', 'but', 'or', 'nor',
  'so', 'yet', 'i', 'my', 'me', 'we', 'our', 'it', 'its', 'this', 'that',
  'these', 'those',
]);

/** Returns up to `maxWords` title-cased non-stop words from `query`. */
export function extractFallbackName(query: string, maxWords = 4): string {
  const words = query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  return words.length > 0 ? words.join(' ') : 'New Session';
}

export interface NamingProviderConfig {
  providerId: string;
  model: string;
  apiKey?: string;
  endpoint?: string;
}

/**
 * Fires POST /api/code-space/name-session in the background (no await at call site).
 * Calls `updateFn` with the resolved name on success or after fallback.
 * Never throws — all errors are swallowed and handled via fallback.
 */
export async function nameSessionAsync(
  sessionId: string,
  query: string,
  providerCfg: NamingProviderConfig,
  updateFn: (id: string, title: string) => void,
  mode: 'code-space' | 'app-planner' = 'code-space',
): Promise<void> {
  const maxWords = mode === 'app-planner' ? 2 : 4;
  try {
    const res = await fetch('/api/code-space/name-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.slice(0, 100),
        providerId: providerCfg.providerId,
        model: providerCfg.model,
        apiKey: providerCfg.apiKey,
        endpoint: providerCfg.endpoint,
        mode,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { name?: string };
    const name = data.name?.trim();
    if (name) {
      updateFn(sessionId, name);
      return;
    }
    throw new Error('Empty name returned');
  } catch {
    // Silent fallback — user sees rule-based name, never an error
    updateFn(sessionId, extractFallbackName(query, maxWords));
  }
}
