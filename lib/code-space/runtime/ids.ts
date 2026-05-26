export function createCodeSpaceId(prefix: string, createdAt = Date.now()): string {
  return `${prefix}:${createdAt}:${Math.random().toString(36).slice(2, 10)}`;
}

