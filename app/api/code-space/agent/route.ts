import { NextRequest } from 'next/server';
import { z } from 'zod';
import { classifyCodeSpaceIntent } from '@/lib/code-space/core';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
});

const BodySchema = z.object({
  sessionId: z.string(),
  projectRoot: z.string(),
  projectName: z.string(),
  messages: z.array(MessageSchema).min(1),
  model: z.string(),
  providerId: z.enum(['anthropic', 'openai', 'gemini', 'grok', 'foundry']),
  apiKey: z.string().optional().default(''),
  endpoint: z.string().optional(),
  openTabs: z.array(z.string()).default([]),
  toolBudget: z.number().default(50),
  enableThinking: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json());
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const { messages, projectName, toolBudget } = body.data;
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) {
    return Response.json({ error: 'A user message is required to start the agent.' }, { status: 400 });
  }

  const intents = classifyCodeSpaceIntent(latestUserMessage.content);
  const summary = `I classified this as ${intents.join(', ')} for ${projectName}.`;
  const toolCallId = `tool:${Date.now()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: AgentSSEEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      emit({
        type: 'text_delta',
        delta: `Understood. I will work on ${latestUserMessage.content}.`,
      });
      emit({
        type: 'tool_start',
        toolCallId,
        tool: 'classify_task',
        input: { prompt: latestUserMessage.content, intents, toolBudget },
      });
      emit({
        type: 'tool_result',
        toolCallId,
        tool: 'classify_task',
        output: { intents },
        durationMs: 1,
      });
      emit({
        type: 'agent_done',
        summary,
        filesChanged: [],
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
