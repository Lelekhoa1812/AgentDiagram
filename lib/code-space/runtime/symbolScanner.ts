export function extractSymbols(content: string): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/g,
    /(?:export\s+)?class\s+([A-Za-z0-9_]+)/g,
    /(?:export\s+)?interface\s+([A-Za-z0-9_]+)/g,
    /(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/g,
    /(?:async\s+)?def\s+([A-Za-z0-9_]+)/g,
    /class\s+([A-Za-z0-9_]+)\s*[:(]/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) && symbols.size < 24) {
      const name = match[1];
      if (name && !name.startsWith('_')) symbols.add(name);
    }
  }

  return Array.from(symbols);
}

export function extractLocalImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /export\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g,
    /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      if (match[1]) specifiers.add(match[1]);
    }
  }

  return Array.from(specifiers);
}
