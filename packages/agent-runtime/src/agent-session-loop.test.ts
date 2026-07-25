import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentMessage,
  PermissionDecision,
} from '@crish/shared-types';
import type {
  AgentProvider,
  AgentProviderRequest,
  AgentTool,
  RuntimePermissionPolicy,
  AgentRuntimeOptions,
} from './types';
import { AgentSessionLoop } from './agent-session-loop';
import { AgentInputQueue } from './agent-input-queue';
import { ConversationEngine } from './runtime-components/conversation-engine';
import { ContextManager } from './runtime-components/context-manager';
import { ProviderCallGateway } from './runtime-components/provider-call-gateway';
import { SessionRecorder } from './session';
import { TokenTracker } from './provider-transport/token-tracker';
import { TokenLedger } from './token-ledger';
import { PricingEngine } from './pricing-engine';
import { InMemorySessionStore } from './session';
import { ExtensionRegistry } from './hooks';

type MockEvent = Record<string, unknown>;

function createMockGateway(events: MockEvent[]): any {
  return new (class extends ProviderCallGateway {
    async *call(_provider: AgentProvider, _request: AgentProviderRequest): any {
      for (const e of events) yield e as any;
      const toolCalls = events
        .filter((e: any) => e.type === 'tool-call' && e.phase === 'end')
        .map((e: any) => ({ id: e.toolCall.id, toolName: e.toolCall.toolName, input: e.toolCall.input }));
      const endEvent: any = events.find((e: any) => e.type === 'end');
      const errEvent: any = events.find((e: any) => e.type === 'error');
      return {
        response: {
          finishReason: endEvent?.finishReason ?? (errEvent ? 'error' : 'stop'),
          text: events.filter((e: any) => e.type === 'delta' && e.delta?.type === 'text').map((e: any) => e.delta.text).join('') || '',
          toolCalls: toolCalls.length > 0 ? toolCalls : [],
          diagnostics: [],
          error: errEvent?.error?.message ?? endEvent?.error?.message,
        },
        streamEvents: events,
      };
    }
  })();
}

function createLoop(
  events: MockEvent[],
  tools: AgentTool[] = [],
  permissionPolicy?: RuntimePermissionPolicy,
  abortController?: AbortController,
  maxTurns?: number,
): AgentSessionLoop {
  const sessionId = 'test';
  const store = new InMemorySessionStore();
  const recorder = new SessionRecorder(store);
  const inputQueue = new AgentInputQueue();
  const conversation = new ConversationEngine({
    sessionId, maxTurns: maxTurns ?? 10, modelId: 'test', systemPrompt: '', cwd: '/',
  });
  const contextManager = new ContextManager({ secretRedactor: false });
  const tokenTracker = new TokenTracker();
  const ledger = new TokenLedger(new PricingEngine());
  const defaultPermit: RuntimePermissionPolicy = permissionPolicy ?? {
    decide: async () => ({ behavior: 'allow' }) as PermissionDecision,
  };
  const ctrl = abortController ?? new AbortController();
  const extensionRegistry = new ExtensionRegistry();
  const gateway = createMockGateway(events);

  const options: AgentRuntimeOptions = {
    sessionId, cwd: '/',
    provider: { id: 't', stream: async function* () {} } as any,
    tools, permissionPolicy: defaultPermit,
  };

  return new AgentSessionLoop(
    options, inputQueue, conversation, contextManager, gateway, tools,
    ctrl, recorder, sessionId, tokenTracker, ledger, defaultPermit, extensionRegistry,
  );
}

async function collectEvents(
  loop: AgentSessionLoop,
  input: string,
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
  afterEach(() => { vi.useRealTimers(); });

  // ─── J-9: Core session events ───────────────

  it('emits agent-start and agent-end for a full run', async () => {
    const loop = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'hello' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    const { events } = await collectEvents(loop, 'hello');
    expect(events.some((e) => e.type === 'agent-start')).toBe(true);
    const endEvent = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(endEvent).toBeDefined();
  });

  it('records user input message', async () => {
    const loop = createLoop([
      { type: 'start' },
      { type: 'end', finishReason: 'stop' },
    ]);
    const { events } = await collectEvents(loop, 'my input');
    const msgStart = events.find(
      (e) => e.type === 'message-start' && (e as any).message?.role === 'user'
    ) as any;
    expect(msgStart).toBeDefined();
    expect((msgStart as any)?.message?.blocks?.[0]?.text).toBe('my input');
  });

  it('abort signal cancels session', async () => {
    const ac = new AbortController();
    ac.abort('cancelled');
    const loop = createLoop([], [], undefined, ac);
    const { events } = await collectEvents(loop, 'test');
    const endEvent = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(endEvent.reason).toBe('aborted');
  });

  // ─── J-9: State machine reachability ─────────

  describe('state machine state reachability', () => {
    it('reaches awaiting-input (user message emitted)', async () => {
      const loop = createLoop([
        { type: 'start' },
        { type: 'end', finishReason: 'stop' },
      ]);
      const { events } = await collectEvents(loop, 'test');
      expect(events.some((e) => e.type === 'message-start' && (e as any).message?.role === 'user')).toBe(true);
    });

    it('reaches abort state', async () => {
      const ac = new AbortController();
      ac.abort('x');
      const loop = createLoop([], [], undefined, ac);
      const { events } = await collectEvents(loop, 'test');
      const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
      expect(end.reason).toBe('aborted');
    });

    it('reaches done state via max turns', async () => {
      const loop = createLoop([
        { type: 'start' },
        { type: 'delta', delta: { type: 'text', text: 't' } },
        { type: 'end', finishReason: 'stop' },
      ], [], undefined, undefined, 1);
      const { events } = await collectEvents(loop, 'test');
      const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
      expect(end).toBeDefined();
    });
  });
});
