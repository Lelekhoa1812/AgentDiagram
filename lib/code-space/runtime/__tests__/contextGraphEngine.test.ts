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

  it('maps container runtime paths back to repository files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'context-graph-runtime-path-'));
    try {
      await mkdir(path.join(root, 'api'), { recursive: true });
      await writeFile(path.join(root, 'api/database.py'), 'class DatabaseManager:\n    pass\n');
      await writeFile(path.join(root, 'api/app.py'), 'from .database import DatabaseManager\n');
      await writeFile(path.join(root, 'README.md'), '# medbot\n');

      const context = await new ContextGraphEngine().collectProjectContext(
        root,
        'Disable MongoDB and RAG. Runtime failed in File "/app/api/database.py", line 49 during MongoClient initialization.',
        { mode: 'code' },
      );

      expect(context.selectedFiles).toContain('api/database.py');
      const target = context.files.find((file) => file.path === 'api/database.py');
      expect(target?.reasons).toContain('explicit_file');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('boosts data and retrieval surfaces when the prompt names MongoDB or RAG capabilities', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'context-graph-rag-'));
    try {
      await mkdir(path.join(root, 'api'), { recursive: true });
      await writeFile(path.join(root, 'api/database.py'), 'def initialize_mongodb():\n    return None\n');
      await writeFile(path.join(root, 'api/chatbot.py'), 'class RAGMedicalChatbot:\n    pass\n');
      await writeFile(path.join(root, 'api/routes.py'), 'from .chatbot import RAGMedicalChatbot\n');
      await writeFile(path.join(root, 'README.md'), '# medbot\n');

      const context = await new ContextGraphEngine().collectProjectContext(
        root,
        'Completely disable MongoDB connection and RAG for clinical passage retrieval.',
        { mode: 'code' },
      );

      expect(context.selectedFiles).toEqual(expect.arrayContaining(['api/database.py', 'api/chatbot.py']));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
