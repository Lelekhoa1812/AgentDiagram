export type AgentSSEEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; tool: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; tool: string; output: unknown; durationMs: number; error?: string }
  | { type: 'diff_proposed'; diffId: string; filePath: string; oldContent: string; newContent: string }
  | { type: 'terminal_chunk'; chunk: string }
  | { type: 'lint_errors'; filePath: string; errors: Array<{ file: string; line: number; col: number; severity: 'error' | 'warning'; message: string; rule?: string }> }
  | { type: 'agent_done'; summary: string; filesChanged: string[] }
  | { type: 'agent_error'; message: string; recoverable: boolean }
  | { type: 'tool_budget_warning'; used: number; max: number };

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'system'; content: string }
  | { role: 'tool'; content: string };
