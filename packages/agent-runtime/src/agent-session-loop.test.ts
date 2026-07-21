import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentMessage,
  JsonObject,
  PermissionDecision,
} from '@crish/shared-types';
import type {
  AgentProviderRequest,
  AgentTool,
  RuntimePermissionPolicy,
} from './types';
import type { ProviderStreamContractEvent } from './provider-stream-contract';
import { AgentSessionLoop } from './agent-session-loop';
import { AgentInputQueue } from './agent-input-queue';
import { ConversationEngine } from './runtime-components/conversation-engine';
import { ContextManager } from './runtime-components/context-manager';
import { ProviderCallGateway } from './runtime-components/provider-call-gateway';
import { SessionRecorder } from './session';
import { TokenTracker } from './provider-transport/token-tracker';
import { InMemorySessionStore } from '.';
import { ExtensionRegistry } from './hooks';

function noopProviderStream(): AsyncIterable<ProviderStreamContractEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start' };
      yield { type: 'delta', delta: { type: 'text', text: 'hello' } };
      yield { type: 'end', finishReason: 'stop' };
    },
  };
}

function createMockProviderGateway(
  streamFn: () => AsyncIterable<ProviderStreamContractEvent>
): ProviderCallGateway {
  return new (class extends ProviderCallGateway {
    async *call(
      provider: { id: string },
      request: AgentProviderRequest
    ): AsyncGenerator<
      ProviderStreamContractEvent,
      { text: string; toolCalls: unknown[]; finishReason: string }
    > {
      void provider;
      void request;
      const events: ProviderStreamContractEvent[] = [];
      for await (const event of streamFn()) {
        events.push(event);
        yield event;
      }
      const text = events
        .filter(
          (
            e
          ): e is {
            type: 'delta';
            delta: { type: 'text'; text: string };
          } & ProviderStreamContractEvent =>
            e.type === 'delta' && e.delta.type === 'text'
        )
        .map((e) => e.delta.text)
        .join('');
      const toolCalls = events
        .filter(
          (
            e
          ): e is {
            type: 'tool-call';
            phase: string;
            toolCall: { id: string; toolName: string; input: JsonObject };
          } & ProviderStreamContractEvent =>
            e.type === 'tool-call' && e.phase === 'end'
        )
        .map((e) => ({
          id: e.toolCall.id,
          toolName: e.toolCall.toolName,
          input: e.toolCall.input,
        }));
      const endEvent = events.find(
        (
          e
        ): e is {
          type: 'end';
          finishReason: string;
          error?: { message: string };
        } & ProviderStreamContractEvent => e.type === 'end'
      );
      return {
        response: {
          finishReason: endEvent?.finishReason ?? 'stop',
          text: text || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        streamEvents: events,
      };
    }
  })();
}

function createTestLoop(overrides?: {
  providerStream?: () => AsyncIterable<ProviderStreamContractEvent>;
  tools?: AgentTool[];
  permissionPolicy?: RuntimePermissionPolicy;
  abortController?: AbortController;
  options?: Record<string, unknown>;
}) {
  const providerStream = overrides?.providerStream ?? noopProviderStream;
  const tools = overrides?.tools ?? [];
  const abortController = overrides?.abortController ?? new AbortController();
  const sessionId = 'test_session';
  const store = new InMemorySessionStore();
  const recorder = new SessionRecorder(store);
  const inputQueue = new AgentInputQueue();
  const conversation = new ConversationEngine({
    sessionId,
    maxTurns: 10,
    modelId: 'test-model',
    systemPrompt: '',
    cwd: 'C:/workspace',
  });
  const contextManager = new ContextManager({ secretRedactor: false });
  const tokenTracker = new TokenTracker('test-model', 128_000, {});
  const permissionPolicy: RuntimePermissionPolicy =
    overrides?.permissionPolicy ?? {
      decide: async () => ({ behavior: 'allow' }) as PermissionDecision,
    };
  const providerGateway = createMockProviderGateway(providerStream);
  const extensionRegistry = new ExtensionRegistry();

  const loop = new AgentSessionLoop(
    {
      sessionId,
      cwd: 'C:/workspace',
      provider: {
        id: 'test-provider',
        stream: async function* () {
          /* unused when gateway is mocked */
        },
      },
      tools,
      permissionPolicy,
      ...(overrides?.options ?? {}),
    },
    inputQueue,
    conversation,
    contextManager,
    providerGateway,
    tools,
    abortController,
    recorder,
    sessionId,
    tokenTracker,
    permissionPolicy,
    extensionRegistry
  );

  return loop;
}

async function collectEvents(
  loop: AgentSessionLoop,
  input: string | AgentMessage
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
  const events: AgentEvent[] = [];
  const iterator = loop.run(input);
  let messages: AgentMessage[] = [];
  while (true) {
    const result = await iterator.next();
    if (result.done) {
      messages = result.value;
      break;
    }
    events.push(result.value);
  }
  return { events, messages };
}

describe('AgentSessionLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes a full session cycle: start -> turn -> end', async () => {
    const loop = createTestLoop();
    const { events } = await collectEvents(loop, 'hello');

    expect(events.some((e) => e.type === 'agent-start')).toBe(true);
    expect(events.some((e) => e.type === 'turn-start')).toBe(true);
    expect(events.some((e) => e.type === 'message-start')).toBe(true);
    expect(events.some((e) => e.type === 'message-delta')).toBe(true);
    expect(events.some((e) => e.type === 'message-end')).toBe(true);
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
    expect(events.some((e) => e.type === 'agent-end')).toBe(true);

    const endEvent = events.find((e) => e.type === 'agent-end') as Extract<
      AgentEvent,
      { type: 'agent-end' }
    >;
    expect(endEvent.reason).toBe('stop');
  });

  it('produces tool-call -> tool-result roundtrip', async () => {
    const loop = createTestLoop({
      tools: [
        {
          name: 'echo',
          label: 'echo',
          description: 'echo',
          category: 'internal',
          concurrency: 'parallel',
          isReadOnly: () => true,
          summarize: (input: JsonObject) => String(input.msg),
          async execute(input: JsonObject) {
            return { text: `echo:${input.msg}` };
          },
        },
      ],
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'start' };
          yield {
            type: 'tool-call',
            phase: 'end',
            toolCall: { id: 'call_1', toolName: 'echo', input: { msg: 'hi' } },
          };
          yield { type: 'end', finishReason: 'tool-call' };
        },
      }),
      permissionPolicy: {
        decide: async () => ({ behavior: 'allow' }) as PermissionDecision,
      },
    });

    const { events } = await collectEvents(loop, 'run echo');

    expect(events.some((e) => e.type === 'tool-start')).toBe(true);
    expect(events.some((e) => e.type === 'tool-end')).toBe(true);
    const toolEnd = events.find((e) => e.type === 'tool-end') as Extract<
      AgentEvent,
      { type: 'tool-end' }
    >;
    expect(toolEnd.result.isError).toBe(false);
    expect(toolEnd.result.output.text).toBe('echo:hi');
  });

  it('propagates provider stream errors as runtime-error', async () => {
    const loop = createTestLoop({
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'start' };
          yield { type: 'error', error: { message: 'upstream failure' } };
        },
      }),
    });

    const { events } = await collectEvents(loop, 'trigger error');

    expect(events.some((e) => e.type === 'runtime-error')).toBe(true);
    const errorEvent = events.find(
      (e) => e.type === 'runtime-error'
    ) as Extract<AgentEvent, { type: 'runtime-error' }>;
    expect(errorEvent.error).toMatch(/upstream failure/i);
    const endEvent = events.find((e) => e.type === 'agent-end') as Extract<
      AgentEvent,
      { type: 'agent-end' }
    >;
    expect(endEvent.reason).toBe('error');
  });

  it('cancels session when abort signal is triggered during streaming', async () => {
    const abortController = new AbortController();
    const loop = createTestLoop({
      abortController,
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'start' };
          yield { type: 'delta', delta: { type: 'text', text: 'partial' } };
          abortController.abort('user cancelled');
          yield { type: 'end', finishReason: 'stop' };
        },
      }),
    });

    const { events } = await collectEvents(loop, 'do work');

    const endEvent = events.find((e) => e.type === 'agent-end') as Extract<
      AgentEvent,
      { type: 'agent-end' }
    >;
    expect(endEvent.reason).toBe('aborted');
  });

  it('restores provider tool input before execution', async () => {
    const executedInputs: JsonObject[] = [];
    let providerCalled = 0;
    const loop = createTestLoop({
      tools: [
        {
          name: 'echo',
          label: 'echo',
          description: 'echo tool',
          category: 'internal',
          concurrency: 'exclusive',
          isReadOnly: () => true,
          summarize: () => 'echo',
          async execute(input: JsonObject) {
            executedInputs.push(input);
            return { text: 'ok' };
          },
        },
      ],
      providerStream: () => {
        providerCalled++;
        if (providerCalled === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'start' };
              yield {
                type: 'tool-call',
                phase: 'end',
                toolCall: {
                  id: 'call_1',
                  toolName: 'echo',
                  input: { value: '[SECRET_1]' },
                },
              };
              yield { type: 'end', finishReason: 'tool-call' };
            },
          };
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'start' };
            yield { type: 'delta', delta: { type: 'text', text: 'done' } };
            yield { type: 'end', finishReason: 'stop' };
          },
        };
      },
      permissionPolicy: {
        decide: async () => ({ behavior: 'allow' }) as PermissionDecision,
      },
    });

    await collectEvents(loop, 'use tool');

    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toEqual({ value: '[SECRET_1]' });
  });

  it('emits turn events in correct order', async () => {
    const loop = createTestLoop();
    const { events } = await collectEvents(loop, 'test');

    const turnTypes = events
      .filter((e) => e.type.startsWith('turn-'))
      .map((e) => e.type);
    expect(turnTypes).toContain('turn-start');
    expect(turnTypes).toContain('turn-end');
  });

  it('handles denied tool permission gracefully', async () => {
    const loop = createTestLoop({
      tools: [
        {
          name: 'danger',
          label: 'danger',
          description: 'dangerous',
          category: 'internal',
          concurrency: 'exclusive',
          isReadOnly: () => false,
          summarize: () => 'danger',
          async execute() {
            return { text: 'should not run' };
          },
        },
      ],
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'start' };
          yield {
            type: 'tool-call',
            phase: 'end',
            toolCall: { id: 'call_danger', toolName: 'danger', input: {} },
          };
          yield { type: 'end', finishReason: 'tool-call' };
        },
      }),
      permissionPolicy: {
        decide: async () =>
          ({ behavior: 'deny', reason: 'not allowed' }) as PermissionDecision,
      },
    });

    const { events } = await collectEvents(loop, 'run danger');
    const toolEnd = events.find((e) => e.type === 'tool-end') as Extract<
      AgentEvent,
      { type: 'tool-end' }
    >;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.output.text).toMatch(/denied|not allowed/i);
  });

  it('expands bare user-denied into actionable softDeny tool-result', async () => {
    const loop = createTestLoop({
      tools: [
        {
          name: 'danger',
          label: 'danger',
          description: 'dangerous',
          category: 'internal',
          concurrency: 'exclusive',
          isReadOnly: () => false,
          summarize: () => 'danger',
          async execute() {
            return { text: 'should not run' };
          },
        },
      ],
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'start' };
          yield {
            type: 'tool-call',
            phase: 'end',
            toolCall: { id: 'call_user_deny', toolName: 'danger', input: {} },
          };
          yield { type: 'end', finishReason: 'tool-call' };
        },
      }),
      permissionPolicy: {
        decide: async () =>
          ({ behavior: 'deny', reason: 'user-denied' }) as PermissionDecision,
      },
    });

    const { events } = await collectEvents(loop, 'run danger');
    const toolEnd = events.find((e) => e.type === 'tool-end') as Extract<
      AgentEvent,
      { type: 'tool-end' }
    >;
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.output.text).toMatch(/用户拒绝|do not assume/i);
    expect(toolEnd.result.output.json).toMatchObject({
      softDeny: true,
      code: 'user_denied',
    });
    expect(events.some((e) => e.type === 'runtime-error')).toBe(false);
  });

  it('approval expired is softDeny tool-result and does not abort the run', async () => {
    let executed = false;
    let providerCalls = 0;
    const loop = createTestLoop({
      tools: [
        {
          name: 'danger',
          label: 'danger',
          description: 'dangerous',
          category: 'internal',
          concurrency: 'exclusive',
          isReadOnly: () => false,
          summarize: () => 'danger',
          async execute() {
            executed = true;
            return { text: 'should not run' };
          },
        },
      ],
      // First turn: tool-call that will soft-deny on approval expiry.
      // Second turn: stop with text so the run can finish without max-turns noise.
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          providerCalls += 1;
          yield { type: 'start' };
          if (providerCalls === 1) {
            yield {
              type: 'tool-call',
              phase: 'end',
              toolCall: { id: 'call_expired', toolName: 'danger', input: {} },
            };
            yield { type: 'end', finishReason: 'tool-call' };
            return;
          }
          yield {
            type: 'delta',
            delta: { type: 'text', text: '改用其他方案继续' },
          };
          yield { type: 'end', finishReason: 'stop' };
        },
      }),
      permissionPolicy: {
        decide: async () =>
          ({
            behavior: 'deny',
            reason:
              'Approval timed out; operation skipped — retry later or continue with other steps',
            metadata: {
              softDeny: true,
              approval: { status: 'expired', reason: 'timeout' },
            },
          }) as PermissionDecision,
      },
    });

    const { events } = await collectEvents(loop, 'run danger');
    const toolEnd = events.find((e) => e.type === 'tool-end') as Extract<
      AgentEvent,
      { type: 'tool-end' }
    >;
    expect(executed).toBe(false);
    expect(toolEnd).toBeDefined();
    expect(toolEnd.result.isError).toBe(true);
    expect(toolEnd.result.output.text).toMatch(/timed out|超时|retry/i);
    expect(toolEnd.result.output.json).toMatchObject({
      softDeny: true,
      code: 'approval_expired',
    });
    // Must not throw / runtime-error-abort the session for approval timeout.
    expect(events.some((e) => e.type === 'runtime-error')).toBe(false);
    // Run continues past the softDeny and reaches a clean stop on the next turn.
    expect(providerCalls).toBeGreaterThanOrEqual(2);
    const endEvent = events.find((e) => e.type === 'agent-end') as
      Extract<AgentEvent, { type: 'agent-end' }> | undefined;
    expect(endEvent).toBeDefined();
    expect(endEvent!.reason).toBe('stop');
  });

  it('preserves original user input message in events', async () => {
    const loop = createTestLoop();
    const { events } = await collectEvents(loop, 'my original input');

    const msgStart = events.find(
      (e) =>
        e.type === 'message-start' &&
        (e as Extract<AgentEvent, { type: 'message-start' }>).message?.role ===
          'user'
    ) as Extract<AgentEvent, { type: 'message-start' }> | undefined;
    expect(msgStart).toBeDefined();
    const textBlock = msgStart!.message?.blocks?.find(
      (b) => b.type === 'text'
    ) as { text?: string } | undefined;
    expect(textBlock?.text).toBe('my original input');
  });

  it('reports error when provider returns empty assistant turn', async () => {
    const loop = createTestLoop({
      providerStream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'start' };
          yield { type: 'end', finishReason: 'stop' };
        },
      }),
    });

    const { events } = await collectEvents(loop, 'empty');
    const endEvent = events.find((e) => e.type === 'agent-end') as Extract<
      AgentEvent,
      { type: 'agent-end' }
    >;
    expect(endEvent.reason).toBe('error');
  });
});
