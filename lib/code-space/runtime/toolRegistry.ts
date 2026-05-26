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
      description: 'Read a text file from the active workspace.',
      inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'search_text',
      description: 'Search text across files in the active workspace.',
      inputSchema: objectSchema({ query: { type: 'string' }, glob: { type: 'string' } }, ['query']),
      riskLevel: 'safe',
      permission: 'auto',
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
      name: 'apply_patch',
      description: 'Apply an approved patch proposal to the active workspace.',
      inputSchema: objectSchema({ patchId: { type: 'string' } }, ['patchId']),
      riskLevel: 'medium',
      permission: 'approval_required',
    }),
  );
  registry.register(
    baseTool({
      name: 'run_command',
      description: 'Run an approved terminal command in the workspace.',
      inputSchema: objectSchema({ command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, ['command']),
      riskLevel: 'high',
      permission: 'approval_required',
      timeoutMs: 120_000,
      logPolicy: 'redacted',
    }),
  );

  return registry;
}
