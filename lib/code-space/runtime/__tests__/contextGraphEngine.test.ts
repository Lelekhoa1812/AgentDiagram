import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextGraphEngine } from '../contextGraphEngine';

describe('ContextGraphEngine', () => {
  it('promotes prompt-referenced implementation files into the evidence bundle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'context-graph-file-ref-'));
    try {
      await mkdir(path.join(root, 'backend/api'), { recursive: true });
      await writeFile(path.join(root, 'backend/api/chatbot.py'), 'class RAGMedicalChatbot:\n    pass\n');
      await writeFile(path.join(root, 'backend/api/routes.py'), 'from .chatbot import RAGMedicalChatbot\n');
      await writeFile(path.join(root, 'README.md'), '# medbot\n');

      const context = await new ContextGraphEngine().collectProjectContext(
        root,
        'Fix backend/api/chatbot.py because the application reports a Python indentation failure there.',
        { mode: 'code' },
      );

      expect(context.selectedFiles).toContain('backend/api/chatbot.py');
      const target = context.files.find((file) => file.path === 'backend/api/chatbot.py');
      expect(target?.reasons).toContain('explicit_file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
