import type { AgentEvent, AgentMessage, AgentTool, ProviderUsage } from "@crish/shared-types";
import type {
  AgentProvider,
  AgentProviderRequest
} from "@crish/agent-core";
import { ProviderResponseConsumer } from "@crish/agent-core";
import {
  assemblePromptForProvider,
  type PromptProviderFamily,
  createId,
  nowIso,
  createTextMessage
} from "@crish/agent-context";
import { normalizeAndCoalesceProviderStreamEvents } from "@crish/agent-model";

export interface SubagentLoopExecutionResult {
  messages: AgentMessage[];
  events: AgentEvent[];
  totalTokens: number;
  durationMs: number;
}

export interface SubagentLoopContext {
  messages: AgentMessage[];
  systemPrompt?: string;
  cwd?: string;
  sessionId?: string;
  provider: AgentProvider;
}

function resolveProviderFamily(model: string): PromptProviderFamily {
  const id = model.toLowerCase();
  if (id.includes("anthropic") || id.includes("claude")) return "anthropic";
  if (id.includes("gemini")) return "gemini";
  return "openai-compatible";
}

function extractUsage(message: AgentMessage): ProviderUsage | undefined {
  const metadata = message.metadata;
  if (!metadata) return undefined;
  return metadata.usage as ProviderUsage | undefined;
}

function computeTotalTokens(usage: ProviderUsage | undefined): number {
  if (!usage) return 0;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
}

export async function agentLoop(
  prompt: string,
  context: SubagentLoopContext,
  config: { model: string; maxTokens?: number; tools?: AgentTool[] }
): Promise<SubagentLoopExecutionResult> {
  const startedAt = Date.now();
  const sessionId = context.sessionId ?? createId("session");
  const events: AgentEvent[] = [];

  const messages = [
    ...context.messages,
    createTextMessage("user", prompt),
  ];

  const assembled = assemblePromptForProvider({
    providerFamily: resolveProviderFamily(config.model),
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    messages,
    tools: config.tools ?? [],
  });

  const abortController = new AbortController();

  const request: AgentProviderRequest = {
    sessionId,
    cwd: context.cwd ?? "",
    ...(assembled.payload.systemPrompt !== undefined ? { systemPrompt: assembled.payload.systemPrompt } : {}),
    messages: assembled.payload.messages,
    tools: assembled.payload.tools,
    signal: abortController.signal,
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
  };

  const consumer = new ProviderResponseConsumer();
  const rawStream = context.provider.stream(request);
  const contractStream = normalizeAndCoalesceProviderStreamEvents(rawStream, {
    coalescing: {},
  });

  const { response, diagnostics } = await consumer.consume(
    contractStream,
    config.tools ?? [],
    abortController.signal,
  );

  const executionMessages: AgentMessage[] = [];

  if (response.type === "message") {
    executionMessages.push(response.message);
    events.push({
      type: "message-end",
      sessionId,
      message: response.message,
      timestamp: nowIso(),
    } as AgentEvent);
  }

  for (const diagnostic of diagnostics) {
    events.push({
      type: "provider-diagnostic",
      sessionId,
      diagnostic,
      timestamp: nowIso(),
    } as unknown as AgentEvent);
  }

  const usage =
    response.type === "message" ? extractUsage(response.message) : undefined;
  const totalTokens = computeTotalTokens(usage);

  return {
    messages: executionMessages,
    events,
    totalTokens,
    durationMs: Date.now() - startedAt,
  };
}
