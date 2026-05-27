export type ToolRiskLevel = 'safe' | 'medium' | 'high' | 'blocked';
export type ToolPermission = 'auto' | 'approval_required' | 'blocked';

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  outputSchema?: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  permission: ToolPermission;
  timeoutMs: number;
  retryPolicy: {
    retries: number;
    retryableErrors: string[];
  };
  cancellable: boolean;
  logPolicy: 'full' | 'summary' | 'redacted';
  secretRedaction: boolean;
  observationCompression: 'none' | 'truncate' | 'summarize';
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeToolDefinition>();

  register(tool: RuntimeToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): RuntimeToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): RuntimeToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): RuntimeToolDefinition['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

function baseTool(
  tool: Pick<RuntimeToolDefinition, 'name' | 'description' | 'inputSchema' | 'riskLevel' | 'permission'> &
    Partial<Omit<RuntimeToolDefinition, 'name' | 'description' | 'inputSchema' | 'riskLevel' | 'permission'>>,
): RuntimeToolDefinition {
  return {
    timeoutMs: 30_000,
    retryPolicy: { retries: 0, retryableErrors: [] },
    cancellable: true,
    logPolicy: 'summary',
    secretRedaction: true,
    observationCompression: 'truncate',
    ...tool,
  };
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    baseTool({
      name: 'repo_map',
      description: 'Map repository files, top directories, key configuration files, languages, frameworks, package manager, scripts, and validation surfaces before planning edits.',
      inputSchema: objectSchema({ depth: { type: 'number' }, includeHidden: { type: 'boolean' } }),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'list_files',
      description: 'List project files and folders inside the active workspace.',
      inputSchema: objectSchema({ path: { type: 'string' }, recursive: { type: 'boolean' } }),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'read_file',
      description: 'Read a text file from the active workspace. Agents must read a file before proposing changes to it.',
      inputSchema: objectSchema({ path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, ['path']),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'search_text',
      description: 'Search text across files in the active workspace, returning match locations and nearby context. Use this before refactors to find file names, imports, exports, call sites, and other references that must be updated.',
      inputSchema: objectSchema({ query: { type: 'string' }, glob: { type: 'string' }, contextLines: { type: 'number' } }, ['query']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'dependency_trace',
      description: 'Trace imports, exports, related files, and unresolved edges around selected implementation surfaces. Use this after a file move or rename to find every importer, re-export, and downstream usage that needs repair.',
      inputSchema: objectSchema({ paths: { type: 'array', items: { type: 'string' } }, direction: { type: 'string' } }, ['paths']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'validation_strategy',
      description: 'Detect typecheck, lint, test, build, format, and preview commands for the current stack before implementation starts.',
      inputSchema: objectSchema({ changedPaths: { type: 'array', items: { type: 'string' } } }),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'risk_assessment',
      description: 'Classify edit risk, blast radius, approval gates, rollback expectations, and validation requirements.',
      inputSchema: objectSchema({ intents: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } } }),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'git_status',
      description: 'Read git branch and changed-file state.',
      inputSchema: objectSchema({}),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'git_diff',
      description: 'Read the current workspace diff.',
      inputSchema: objectSchema({ path: { type: 'string' } }),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'propose_edit_blocks',
      description: 'Propose exact SEARCH/REPLACE edit blocks. The server exact-matches, rejects ambiguous blocks, syntax-validates, and returns a reviewable diff without writing to disk.',
      inputSchema: objectSchema(
        {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                search: { type: 'string' },
                replace: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['path', 'search', 'replace', 'reason'],
            },
          },
        },
        ['edits'],
      ),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'propose_patch',
      description: 'Create a reviewable patch proposal with file-level before/after content, unified diff, explanation, and validation intent. Does not write to disk.',
      inputSchema: objectSchema(
        {
          files: { type: 'array', items: { type: 'object' } },
          explanation: { type: 'string' },
          validationCommands: { type: 'array', items: { type: 'string' } },
        },
        ['files', 'explanation'],
      ),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'apply_patch',
      description: 'Apply an approved patch proposal to the active workspace after checkpoint creation and conflict checking.',
      inputSchema: objectSchema({ patchId: { type: 'string' } }, ['patchId']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
    }),
  );
  registry.register(
    baseTool({
      name: 'restore_checkpoint',
      description: 'Restore a previously created checkpoint and rewind all files captured by that checkpoint.',
      inputSchema: objectSchema({ checkpointRef: { type: 'string' }, reason: { type: 'string' } }, ['checkpointRef']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
    }),
  );
  registry.register(
    baseTool({
      name: 'run_command',
      description: 'Run an approved terminal command in the workspace and stream output to the terminal panel. Prefer this for shell-native refactors and maintenance tasks such as mv, cp, rg, find, git status, and validation commands after a rename or move. Full output should be stored as an artifact for bounded reads.',
      inputSchema: objectSchema({ command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, ['command', 'reason']),
      riskLevel: 'high',
      permission: 'approval_required',
      timeoutMs: 120_000,
      logPolicy: 'redacted',
    }),
  );
  registry.register(
    baseTool({
      name: 'read_artifact',
      description: 'Read a bounded line range from a stored terminal, validation, grep, docs, or large-file artifact instead of injecting the full output into context.',
      inputSchema: objectSchema({ artifactId: { type: 'string' }, path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, ['path', 'startLine', 'endLine']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'grep_artifact',
      description: 'Search inside a stored artifact without loading the full artifact into the agent context.',
      inputSchema: objectSchema({ artifactId: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' }, contextLines: { type: 'number' } }, ['path', 'pattern']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'spawn_subagent',
      description: 'Spawn an isolated temporary subagent with a blank context window for explorer, critic, docs-reader, test-writer, or verifier roles.',
      inputSchema: objectSchema(
        {
          role: { type: 'string' },
          task: { type: 'string' },
          allowedTools: { type: 'array', items: { type: 'string' } },
          readOnly: { type: 'boolean' },
          maxToolCalls: { type: 'number' },
        },
        ['role', 'task'],
      ),
      riskLevel: 'safe',
      permission: 'auto',
      timeoutMs: 180_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'browser_preview_check',
      description: 'Record a manual or automated preview/browser validation requirement for UI changes. Execution remains approval-gated.',
      inputSchema: objectSchema({ url: { type: 'string' }, scenario: { type: 'string' } }, ['scenario']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 120_000,
      observationCompression: 'summarize',
    }),
  );

  return registry;
}
