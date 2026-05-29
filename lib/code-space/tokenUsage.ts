const USAGE_STORAGE_KEY = 'code_space_token_usage_v1';
const LIMITS_STORAGE_KEY = 'code_space_token_limits_v1';

const DEFAULT_LIMITS = {
  session: 10_000_000,
  daily: 10_000_000,
  weekly: 50_000_000,
};

export interface TokenUsageLimits {
  session: number;
  daily: number;
  weekly: number;
}

interface UsageRecord {
  timestamp: number;
  tokens: number;
  provider: string;
}

// In-memory session accumulator — resets on page reload
let sessionTokenCount = 0;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function addSessionTokens(tokens: number, provider = 'unknown'): void {
  if (tokens <= 0) return;
  sessionTokenCount += tokens;
  if (typeof window === 'undefined') return;
  try {
    const records = getStoredRecords();
    records.push({ timestamp: Date.now(), tokens, provider });
    // Keep only last 30 days of records
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const pruned = records.filter((r) => r.timestamp > cutoff);
    window.localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(pruned));
  } catch {
    // localStorage unavailable — session count still works
  }
}

function getStoredRecords(): UsageRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as UsageRecord[];
  } catch {
    return [];
  }
}

export function getSessionTokens(): number {
  return sessionTokenCount;
}

export function getDailyTokens(timezone?: string): number {
  const records = getStoredRecords();
  const todayStr = toDateString(new Date(), timezone);
  return records
    .filter((r) => toDateString(new Date(r.timestamp), timezone) === todayStr)
    .reduce((sum, r) => sum + r.tokens, 0);
}

export function getWeeklyTokens(): number {
  const records = getStoredRecords();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return records
    .filter((r) => r.timestamp >= weekAgo)
    .reduce((sum, r) => sum + r.tokens, 0);
}

function toDateString(date: Date, timezone?: string): string {
  return date.toLocaleDateString('en-CA', timezone ? { timeZone: timezone } : {});
}

export function getTokenLimits(): TokenUsageLimits {
  if (typeof window === 'undefined') return { ...DEFAULT_LIMITS };
  try {
    const raw = window.localStorage.getItem(LIMITS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LIMITS };
    const saved = JSON.parse(raw) as Partial<TokenUsageLimits>;
    return {
      session: saved.session ?? DEFAULT_LIMITS.session,
      daily: saved.daily ?? DEFAULT_LIMITS.daily,
      weekly: saved.weekly ?? DEFAULT_LIMITS.weekly,
    };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

export function saveTokenLimits(limits: TokenUsageLimits): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIMITS_STORAGE_KEY, JSON.stringify(limits));
  } catch {
    // localStorage unavailable
  }
}

export function resetSessionTokens(): void {
  sessionTokenCount = 0;
}
