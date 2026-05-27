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
      description: 'Search text across files in the active workspace, returning match locations and nearby context.',
      inputSchema: objectSchema({ query: { type: 'string' }, glob: { type: 'string' }, contextLines: { type: 'number' } }, ['query']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'dependency_trace',
      description: 'Trace imports, exports, related files, and unresolved edges around selected implementation surfaces.',
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
      description: 'Apply an approved patch proposal to the active workspace after checkpoint creation.',
      inputSchema: objectSchema({ patchId: { type: 'string' } }, ['patchId']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
    }),
  );
  registry.register(
    baseTool({
      name: 'run_command',
      description: 'Run an approved terminal command in the workspace and stream output to the terminal panel.',
      inputSchema: objectSchema({ command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, ['command']),
      riskLevel: 'high',
      permission: 'approval_required',
      timeoutMs: 120_000,
      logPolicy: 'redacted',
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
