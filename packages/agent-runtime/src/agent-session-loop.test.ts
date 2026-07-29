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

function createMockGateway(
  events: MockEvent[],
  opts?: { /** ms delay after N yields so L3 can land mid-stream */ pauseAfterIndex?: number; pauseMs?: number },
): any {
  return new (class extends ProviderCallGateway {
    async *call(_provider: AgentProvider, _request: AgentProviderRequest): any {
      let i = 0;
      for (const e of events) {
        yield e as any;
        i++;
        if (
          opts?.pauseAfterIndex !== undefined &&
          i === opts.pauseAfterIndex
        ) {
          await new Promise((r) => setTimeout(r, opts.pauseMs ?? 40));
        }
      }
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
  gatewayOpts?: { pauseAfterIndex?: number; pauseMs?: number },
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
  const gateway = createMockGateway(events, gatewayOpts);

  const options: AgentRuntimeOptions = {
    sessionId, cwd: '/',
    provider: { id: 't', stream: async function* () {} } as any,
    tools, permissionPolicy: defaultPermit,
    // 必须传入 maxTurns，session machine 才与 ConversationEngine 预算一致
    ...(maxTurns !== undefined ? { maxTurns } : {}),
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
      // budget 语义：明确 max-turns，而非 aborted
      expect(end.reason).toBe('max-turns');
    });
  });

  // ─── B0: Run control ─────────────────────────

  it('cooperative_stop yields endReason=stop (L2, not abort)', async () => {
    const loop = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'partial' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    loop.getControlBus().requestCooperativeStop('user-stop');
    const { events } = await collectEvents(loop, 'hi');
    const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(end.reason).toBe('stop');
    // 不应把协作停记成 aborted
    expect(end.reason).not.toBe('aborted');
  });

  it('force_cancel yields endReason=aborted (L3)', async () => {
    const loop = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'x' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    loop.getControlBus().requestForceCancel('force');
    const { events } = await collectEvents(loop, 'hi');
    const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(end.reason).toBe('aborted');
  });

  // ─── W6-4: continue-after-stop / continue-after-abort ─────

  it('L2 cooperative_stop keeps partial assistant text for continue', async () => {
    const loop = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'hello ' } },
      { type: 'delta', delta: { type: 'text', text: 'partial' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    loop.getControlBus().requestCooperativeStop('user-stop');
    const { events, messages } = await collectEvents(loop, 'hi');
    const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(end.reason).toBe('stop');
    const assistant = messages.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    const text = assistant
      .flatMap((m) => m.blocks)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    expect(text).toContain('partial');
    // pi-align: after stop, last non-user content retained; new user prompt can continue
    expect(messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('L3 force_cancel keeps partial assistant text (continue-after-abort)', async () => {
    // Pause after first text delta so force_cancel lands mid-stream (not before any tokens).
    const loop = createLoop(
      [
        { type: 'start' },
        { type: 'delta', delta: { type: 'text', text: 'streamed-' } },
        { type: 'delta', delta: { type: 'text', text: 'partial-abort' } },
        { type: 'end', finishReason: 'stop' },
      ],
      [],
      undefined,
      undefined,
      undefined,
      { pauseAfterIndex: 2, pauseMs: 60 },
    );
    const events: AgentEvent[] = [];
    const iterator = loop.run('hi');
    let messages: AgentMessage[] = [];
    let cancelled = false;
    while (true) {
      const result = await iterator.next();
      if (result.done) {
        messages = result.value;
        break;
      }
      events.push(result.value);
      // After first streamed text, issue L3 (simulates user force stop mid-reply)
      if (
        !cancelled &&
        result.value.type === 'message-delta' &&
        (result.value as any).block?.type === 'text'
      ) {
        cancelled = true;
        loop.getControlBus().requestForceCancel('force');
      }
    }
    const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(end.reason).toBe('aborted');
    const assistant = messages.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThanOrEqual(1);
    const text = assistant
      .flatMap((m) => m.blocks)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    expect(text).toMatch(/streamed-|partial-abort/);
  });

  it('after L2 stop, a fresh loop accepts a new user prompt (continue)', async () => {
    // Simulate continue: first run ends via L2; second AgentSessionLoop (new machine) accepts input.
    // Mirrors AgentRuntime creating a new loop per run() after cooperative stop.
    const first = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'first' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    first.getControlBus().requestCooperativeStop('stop');
    const { messages: m1 } = await collectEvents(first, 'prompt-1');
    expect(m1.some((m) => m.role === 'assistant')).toBe(true);

    const second = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'continued' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    const { events, messages: m2 } = await collectEvents(second, 'prompt-2 continue');
    const end = events.find((e) => e.type === 'agent-end') as Extract<AgentEvent, { type: 'agent-end' }>;
    expect(end.reason).toBe('stop');
    const asstText = m2
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.blocks)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    expect(asstText).toContain('continued');
  });

  it('after L3 abort, a fresh loop accepts a new user prompt (continue)', async () => {
    const first = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'aborted-partial' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    first.getControlBus().requestForceCancel('force');
    const { events: e1 } = await collectEvents(first, 'prompt-1');
    expect((e1.find((e) => e.type === 'agent-end') as any)?.reason).toBe('aborted');

    const second = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'after-abort' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    const { events: e2, messages } = await collectEvents(second, 'prompt-2');
    expect((e2.find((e) => e.type === 'agent-end') as any)?.reason).toBe('stop');
    expect(
      messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .some((b) => b.type === 'text' && b.text.includes('after-abort')),
    ).toBe(true);
  });

  it('lifecycle turn.end observe fires once per turn', async () => {
    // 需有正文 delta，否则 empty-response 走 steering 可能不进 turn-complete
    const loop = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'ok' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    const turns: number[] = [];
    loop.getLifecycleHooks().observe('turn.end', (p) => {
      turns.push(p.turnIndex);
    });
    await collectEvents(loop, 'hi');
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it('builtin health pack records turn counts after run', async () => {
    const loop = createLoop([
      { type: 'start' },
      { type: 'delta', delta: { type: 'text', text: 'ok' } },
      { type: 'end', finishReason: 'stop' },
    ]);
    expect(loop.getHealthSnapshot().turnStartCount).toBe(0);
    await collectEvents(loop, 'hi');
    const snap = loop.getHealthSnapshot();
    expect(snap.turnStartCount).toBeGreaterThanOrEqual(1);
    expect(snap.turnEndCount).toBeGreaterThanOrEqual(1);
    expect(snap.toolBlockRate).toBe(0);
  });

  // ─── B2 residual: tool.pre / tool.post wire ─────────

  it('lifecycle tool.pre block prevents tool execute; tool.post still skipped', async () => {
    const executeFn = vi.fn(async () => ({ text: 'ran' }));
    const tool: AgentTool = {
      name: 'echo',
      label: 'echo',
      description: 'echo',
      category: 'internal',
      concurrency: 'exclusive',
      isReadOnly: () => true,
      summarize: () => 'echo',
      execute: executeFn,
    };

    let callN = 0;
    const sessionId = 'test';
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    const inputQueue = new AgentInputQueue();
    const conversation = new ConversationEngine({
      sessionId, maxTurns: 10, modelId: 'test', systemPrompt: '', cwd: '/',
    });
    const contextManager = new ContextManager({ secretRedactor: false });
    const tokenTracker = new TokenTracker();
    const ledger = new TokenLedger(new PricingEngine());
    const permit: RuntimePermissionPolicy = {
      decide: async () => ({ behavior: 'allow' }) as PermissionDecision,
    };
    const ctrl = new AbortController();
    const gateway = new (class extends ProviderCallGateway {
      async *call(_provider: any, _request: any): any {
        callN += 1;
        if (callN === 1) {
          yield { type: 'start' };
          yield {
            type: 'tool-call',
            phase: 'end',
            toolCall: { id: 'c1', toolName: 'echo', input: { v: 1 } },
          };
          yield { type: 'end', finishReason: 'tool-call' };
          return {
            response: {
              finishReason: 'tool-call',
              text: '',
              toolCalls: [{ id: 'c1', toolName: 'echo', input: { v: 1 } }],
              diagnostics: [],
            },
            streamEvents: [],
          };
        }
        yield { type: 'start' };
        yield { type: 'delta', delta: { type: 'text', text: 'done' } };
        yield { type: 'end', finishReason: 'stop' };
        return {
          response: { finishReason: 'stop', text: 'done', toolCalls: [], diagnostics: [] },
          streamEvents: [],
        };
      }
    })();

    const options: AgentRuntimeOptions = {
      sessionId, cwd: '/',
      provider: { id: 't', stream: async function* () {} } as any,
      tools: [tool], permissionPolicy: permit,
    };
    const loop = new AgentSessionLoop(
      options, inputQueue, conversation, contextManager, gateway, [tool],
      ctrl, recorder, sessionId, tokenTracker, ledger, permit, new ExtensionRegistry(),
    );

    const preHits: string[] = [];
    const postHits: string[] = [];
    const turnStarts: number[] = [];
    loop.getLifecycleHooks().observe('turn.start', (p) => { turnStarts.push(p.turnIndex); });
    loop.getLifecycleHooks().on('tool.pre', (p) => {
      preHits.push(p.toolName);
      return { block: true, reason: 'blocked-in-test' };
    });
    loop.getLifecycleHooks().observe('tool.post', (p) => { postHits.push(p.toolName); });

    const { events } = await collectEvents(loop, 'run tool');
    expect(preHits).toEqual(['echo']);
    expect(executeFn).not.toHaveBeenCalled();
    expect(postHits).toEqual([]); // block → no execute → no tool.post
    expect(turnStarts.length).toBeGreaterThanOrEqual(1);
    const toolEnd = events.find((e) => e.type === 'tool-end') as Extract<AgentEvent, { type: 'tool-end' }> | undefined;
    expect(toolEnd).toBeDefined();
    expect(toolEnd!.result.isError).toBe(true);
    expect(toolEnd!.result.output.text).toMatch(/blocked-in-test/i);
  });

  it('lifecycle tool.post receives output; turn + tool hooks coexist', async () => {
    const tool: AgentTool = {
      name: 'echo',
      label: 'echo',
      description: 'echo',
      category: 'internal',
      concurrency: 'exclusive',
      isReadOnly: () => true,
      summarize: () => 'echo',
      async execute(input) {
        return { text: `echo:${String((input as any).v ?? '')}` };
      },
    };

    let callN = 0;
    const sessionId = 'test';
    const store = new InMemorySessionStore();
    const recorder = new SessionRecorder(store);
    const inputQueue = new AgentInputQueue();
    const conversation = new ConversationEngine({
      sessionId, maxTurns: 10, modelId: 'test', systemPrompt: '', cwd: '/',
    });
    const contextManager = new ContextManager({ secretRedactor: false });
    const tokenTracker = new TokenTracker();
    const ledger = new TokenLedger(new PricingEngine());
    const permit: RuntimePermissionPolicy = {
      decide: async () => ({ behavior: 'allow' }) as PermissionDecision,
    };
    const ctrl = new AbortController();
    const gateway = new (class extends ProviderCallGateway {
      async *call(_provider: any, _request: any): any {
        callN += 1;
        if (callN === 1) {
          yield { type: 'start' };
          yield {
            type: 'tool-call',
            phase: 'end',
            toolCall: { id: 'c2', toolName: 'echo', input: { v: 'hi' } },
          };
          yield { type: 'end', finishReason: 'tool-call' };
          return {
            response: {
              finishReason: 'tool-call',
              text: '',
              toolCalls: [{ id: 'c2', toolName: 'echo', input: { v: 'hi' } }],
              diagnostics: [],
            },
            streamEvents: [],
          };
        }
        yield { type: 'start' };
        yield { type: 'delta', delta: { type: 'text', text: 'final' } };
        yield { type: 'end', finishReason: 'stop' };
        return {
          response: { finishReason: 'stop', text: 'final', toolCalls: [], diagnostics: [] },
          streamEvents: [],
        };
      }
    })();

    const options: AgentRuntimeOptions = {
      sessionId, cwd: '/',
      provider: { id: 't', stream: async function* () {} } as any,
      tools: [tool], permissionPolicy: permit,
    };
    const loop = new AgentSessionLoop(
      options, inputQueue, conversation, contextManager, gateway, [tool],
      ctrl, recorder, sessionId, tokenTracker, ledger, permit, new ExtensionRegistry(),
    );

    const sequence: string[] = [];
    loop.getLifecycleHooks().observe('turn.start', () => { sequence.push('turn.start'); });
    loop.getLifecycleHooks().observe('tool.pre', (p) => { sequence.push(`tool.pre:${p.toolName}`); });
    loop.getLifecycleHooks().on('tool.post', (p) => {
      sequence.push(`tool.post:${p.output?.text ?? ''}`);
      return {};
    });
    loop.getLifecycleHooks().observe('turn.end', () => { sequence.push('turn.end'); });

    const { events } = await collectEvents(loop, 'run tool');
    expect(sequence).toContain('turn.start');
    expect(sequence).toContain('tool.pre:echo');
    expect(sequence).toContain('tool.post:echo:hi');
    expect(sequence).toContain('turn.end');
    // 顺序：pre 在 post 前
    expect(sequence.indexOf('tool.pre:echo')).toBeLessThan(sequence.indexOf('tool.post:echo:hi'));
    const toolEnd = events.find((e) => e.type === 'tool-end') as Extract<AgentEvent, { type: 'tool-end' }> | undefined;
    expect(toolEnd?.result.isError).toBe(false);
    expect(toolEnd?.result.output.text).toBe('echo:hi');
  });
});
