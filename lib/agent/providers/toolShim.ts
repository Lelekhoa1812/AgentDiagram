/**
 * Prompt-based tool-calling fallback for models that lack native tool support
 * (some local servers, codex text models). We describe the tool protocol in the
 * system prompt, flatten any prior tool turns into plain text the legacy chat()
 * path understands, then parse one JSON decision back into an AssistantTurn.
 *
 * The decision JSON is either a tool call or a final answer:
 *   {"thought": "...", "tool": "name", "input": { ... }}
 *   {"thought": "...", "final": "the user-facing answer"}
 */
import { parseStructuredJson } from '../planning/structuredOutput';
import type { AssistantTurn, ChatMessage, ToolCall, ToolSpec } from './types';

const PROTOCOL = `You can use tools by responding with a single JSON object and nothing else.
To call a tool: {"thought": "<why>", "tool": "<tool_name>", "input": { <arguments> }}
To finish: {"thought": "<why>", "final": "<your final answer>"}
Rules:
- Respond with exactly one JSON object. No markdown fences, no prose before or after.
- Call exactly one tool per turn, or finish. Do not invent tool names.
- "input" must match the tool's JSON schema.`;

function renderToolCatalog(tools: ToolSpec[]): string {
  if (!tools.length) return 'No tools are available; respond only with a {"final": ...} object.';
  return tools
    .map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`)
    .join('\n');
}

/**
 * Flatten our neutral messages (which may include `tool` roles and assistant
 * `toolCalls`) into system/user/assistant-only messages the plain chat() path
 * accepts, encoding tool activity as readable text.
 */
export function flattenToolMessages(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const flattened: ChatMessage[] = [];
  const systemParts: string[] = [`${PROTOCOL}\n\nAvailable tools:\n${renderToolCatalog(tools)}`];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.unshift(message.content);
      continue;
    }
    if (message.role === 'tool') {
      const rendered = (message.toolResults ?? [])
        .map((result) => `Tool result (${result.toolCallId})${result.isError ? ' [ERROR]' : ''}:\n${result.content}`)
        .join('\n\n');
      flattened.push({ role: 'user', content: rendered || 'Tool result: (empty)' });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls
        .map((call) => JSON.stringify({ tool: call.name, input: call.input }))
        .join('\n');
      const text = message.content ? `${message.content}\n${calls}` : calls;
      flattened.push({ role: 'assistant', content: text });
      continue;
    }
    flattened.push({ role: message.role, content: message.content });
  }

  flattened.unshift({ role: 'system', content: systemParts.join('\n\n') });
  return flattened;
}

function coerceInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Parse a raw completion produced under the shim protocol into an AssistantTurn. */
export function parseShimResponse(raw: string): AssistantTurn {
  let decision: Record<string, unknown>;
  try {
    const parsed = parseStructuredJson(raw);
    decision = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Unparseable output is treated as a plain final answer so the loop can settle.
    return { text: raw.trim(), toolCalls: [], stopReason: 'end_turn' };
  }

  const thought = typeof decision.thought === 'string' ? decision.thought : '';
  if (typeof decision.tool === 'string' && decision.tool) {
    const call: ToolCall = { id: `${decision.tool}#0`, name: decision.tool, input: coerceInput(decision.input) };
    return { text: thought, toolCalls: [call], stopReason: 'tool_use' };
  }
  const final = typeof decision.final === 'string' ? decision.final : raw.trim();
  return { text: final, toolCalls: [], stopReason: 'end_turn' };
}

/**
 * Drive one shim turn: flatten → complete (caller supplies the plain chat fn) → parse.
 * `complete` receives the flattened messages and must return raw model text.
 */
export async function runToolShimTurn(
  messages: ChatMessage[],
  tools: ToolSpec[],
  complete: (flattened: ChatMessage[]) => Promise<string>,
): Promise<AssistantTurn> {
  const flattened = flattenToolMessages(messages, tools);
  const raw = await complete(flattened);
  return parseShimResponse(raw);
}
