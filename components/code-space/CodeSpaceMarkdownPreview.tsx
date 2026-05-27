'use client';

import type { CodeSpaceProject } from '@/lib/code-space/core';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';

interface CodeSpaceMarkdownPreviewProps {
  project: CodeSpaceProject;
  filePath: string;
  markdown: string;
  theme: 'dark' | 'light';
  onOpenFile: (filePath: string, options?: { preview?: boolean }) => void;
}

export function CodeSpaceMarkdownPreview({
  project,
  filePath,
  markdown,
  theme,
  onOpenFile,
}: CodeSpaceMarkdownPreviewProps) {
  return (
    <div className="markdown-preview h-full min-h-0 overflow-auto bg-[#1e1e1e] px-5 py-4">
      <MarkdownRenderer
        markdown={markdown}
        theme={theme}
        currentFilePath={filePath}
        rootPath={project.rootPath ?? ''}
        onOpenFile={onOpenFile}
        contentClassName="mx-auto max-w-4xl rounded-xl border border-[#2a2a2a] bg-[#181818] px-5 py-4 shadow-2xl"
      />
    </div>
  );
}
