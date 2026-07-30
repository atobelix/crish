import { AbstractBaseEngine } from './base-engine';
import type {
  ProviderStreamEvent,
  ProviderUsage,
  AgentTool,
} from '@crish/shared-types';
import type {
  AgentProviderRequest,
  EngineOptions,
  EngineRequest,
} from '../types';
import type {
  AgentMessage,
  JsonObject,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
} from '@crish/shared-types';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

interface OllamaStreamChunk {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaEngine extends AbstractBaseEngine {
  readonly id = 'ollama';

  buildRequest(
    request: AgentProviderRequest,
    options: EngineOptions
  ): EngineRequest {
    const baseUrl =
      (options.extra?.baseUrl as string) ?? 'http://localhost:11434';
    const url = `${baseUrl.replace(/\/+$/, '')}/api/chat`;

    const body: Record<string, unknown> = {
      model: options.extra?.model as string,
      messages: [
        { role: 'system', content: request.systemPrompt ?? '' },
        ...this.convertMessages(request.messages),
      ],
      stream: options.extra?.stream !== false,
      options: {
        temperature: (options.extra?.temperature as number) ?? undefined,
        top_p: (options.extra?.topP as number) ?? undefined,
        num_predict: (options.maxTokens ?? options.extra?.maxTokens) as
          number | undefined,
      },
      keep_alive: (options.extra?.keepAlive as string) ?? '5m',
    };

    for (const key of ['temperature', 'top_p', 'num_predict'] as const) {
      if ((body.options as Record<string, unknown>)[key] === undefined) {
        delete (body.options as Record<string, unknown>)[key];
      }
    }

    if (request.tools.length > 0) {
      body.tools = this.convertTools(request.tools);
    }

    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    };
  }

  private convertMessages(messages: AgentMessage[]): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({
          role: 'system',
          content: this.textFromBlocks(msg.blocks),
        });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', content: this.textFromBlocks(msg.blocks) });
      } else if (msg.role === 'assistant') {
        const text = this.textFromBlocks(msg.blocks);
        const toolCalls = this.extractToolCalls(msg.blocks);
        const entry: OllamaMessage = { role: 'assistant', content: text };
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        result.push(entry);
      } else if (msg.role === 'tool') {
        const toolResult = msg.blocks.find(
          (block): block is ToolResultBlock => block.type === 'tool-result'
        );
        const content = toolResult
          ? JSON.stringify(toolResult.output)
          : this.textFromBlocks(msg.blocks);
        result.push({ role: 'tool', content });
      }
    }

    return result;
  }

  private textFromBlocks(blocks: AgentMessage['blocks']): string {
    return blocks
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block: TextBlock) => block.text)
      .join('');
  }

  private extractToolCalls(blocks: AgentMessage['blocks']): OllamaToolCall[] {
    return blocks
      .filter((block): block is ToolCallBlock => block.type === 'tool-call')
      .map((block: ToolCallBlock) => ({
        function: {
          name: block.toolName,
          arguments: block.input as Record<string, unknown>,
        },
      }));
  }

  private convertTools(tools: AgentTool[]): OllamaTool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? {
          type: 'object',
          properties: {},
          additionalProperties: true,
        }) as JsonObject,
      },
    }));
  }

  async *parseStream(
    response: Response,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'stop', reason: 'error', error: 'No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal?.aborted) {
          yield {
            type: 'stop',
            reason: 'error',
            error: 'Request was cancelled',
          };
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const chunk: OllamaStreamChunk = JSON.parse(trimmed);

            if (chunk.message?.content) {
              yield { type: 'text-delta', text: chunk.message.content };
            }

            if (chunk.message?.tool_calls) {
              for (const tc of chunk.message.tool_calls) {
                yield {
                  type: 'tool-call',
                  toolName: tc.function.name,
                  input: tc.function.arguments as JsonObject,
                };
              }
            }

            if (chunk.done) {
              const usage = this.extractUsage(chunk);
              yield {
                type: 'stop',
                reason: 'stop',
                ...(usage !== undefined ? { usage } : {}),
              };
              return;
            }
          } catch {
            yield {
              type: 'provider-diagnostic',
              diagnostic: {
                code: 'PARSE_ERROR',
                message: `Failed to parse Ollama stream line: ${trimmed.slice(0, 200)}`,
                severity: 'warning',
                timestamp: Date.now(),
              },
            } as unknown as ProviderStreamEvent;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'stop', reason: 'stop' };
  }

  async *parseResponse(
    body: unknown,
    _signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const data = body as OllamaStreamChunk;

    if (data.message?.content) {
      yield { type: 'text-delta', text: data.message.content };
    }

    if (data.message?.tool_calls) {
      for (const tc of data.message.tool_calls) {
        yield {
          type: 'tool-call',
          toolName: tc.function.name,
          input: tc.function.arguments as JsonObject,
        };
      }
    }

    const usage = this.extractUsage(data);
    yield {
      type: 'stop',
      reason: 'stop',
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  private extractUsage(chunk: OllamaStreamChunk): ProviderUsage | undefined {
    if (
      chunk.prompt_eval_count === undefined &&
      chunk.eval_count === undefined
    ) {
      return undefined;
    }
    const promptTokens = chunk.prompt_eval_count ?? 0;
    const completionTokens = chunk.eval_count ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }
}
