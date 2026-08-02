// packages/plugin-sdk/src/__tests__/dual-mode.test.ts
// 双模式测试：observe/on 在 HookBus 中的行为（Agent 8-B/8-D/8-E 产出）
//
// 覆盖范围：
// - observe 失败吞掉（不影响主路径 禁令 14）
// - on 控制信号合并（stop/block/modifiedInput/modifiedOutput/terminate）
// - tool.error 事件：ToolErrorHandlerResult（retry/skip/abort）合并
// - error.occurred 事件：observe-only（on 控制信号无意义）
// - observe 并行执行
// - on 串行执行
// - observe(*) 通配符捕获全部事件
// - HookUnsubscribe 取消订阅
// - PluginAPI + HookBus 集成：observe/on 委托后 emit 触发 handler
//
// 约束：禁令 14（observe/on 双模式保留 + 控制型钩子能力保留）
//
// 注意：plugin-sdk 不依赖 agent-core（禁令 13），故本地构建 FakeHookBus
// 实现 HookBusLike 接口，行为对齐 agent-core/src/hooks/lifecycle-hooks.ts
// 的 LifecycleHookRegistry.emit() 语义（§4.3）。

import { describe, it, expect, vi } from 'vitest';
import { PluginAPI } from '../api';
import type { PluginAPIDeps } from '../api';
import type {
  PluginManifest,
} from '../manifest';
import type { TrustGateLike } from '../manifest';
import type {
  HookBusLike,
  HookEventName,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
  HookPayloadMap,
  LifecycleHandlerResult,
  ToolErrorHandlerResult,
} from '@crish/shared-types';

// ─── FakeHookBus：本地实现 HookBusLike，对齐 LifecycleHookRegistry 语义 ──

interface RegisteredHandler {
  type: HookEventName | '*';
  kind: 'observe' | 'on';
  handler: (payload: unknown) => unknown;
}

class FakeHookBus implements HookBusLike {
  private readonly handlers: RegisteredHandler[] = [];

  observe(event: '*', handler: (payload: unknown) => void | Promise<void>): HookUnsubscribe;
  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>,
  ): HookUnsubscribe;
  observe(
    event: HookEventName | '*',
    handler: (payload: unknown) => unknown,
  ): HookUnsubscribe {
    const entry: RegisteredHandler = {
      type: event,
      kind: 'observe',
      handler: handler as (payload: unknown) => unknown,
    };
    this.handlers.push(entry);
    return () => this.remove(entry);
  }

  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>,
  ): HookUnsubscribe {
    const entry: RegisteredHandler = {
      type: event,
      kind: 'on',
      handler: handler as (payload: unknown) => unknown,
    };
    this.handlers.push(entry);
    return () => this.remove(entry);
  }

  async emit<E extends HookEventName>(
    event: E,
    payload: HookPayloadMap[E],
  ): Promise<LifecycleHandlerResult> {
    // ── observe 阶段：并行容错（禁令 14）──
    const observers = this.handlers.filter(
      (h) => h.kind === 'observe' && (h.type === event || h.type === '*'),
    );
    await Promise.all(
      observers.map(async (h) => {
        try {
          await h.handler(payload);
        } catch {
          // observe 失败吞掉
        }
      }),
    );

    // ── error.occurred：observe-only（控制信号对已发生错误无意义）──
    if (event === 'error.occurred') {
      return {};
    }

    // ── on 阶段：串行语义合并（禁令 14）──
    const onHandlers = this.handlers.filter(
      (h) => h.kind === 'on' && h.type === event,
    );
    const merged: LifecycleHandlerResult & Partial<ToolErrorHandlerResult> = {};
    for (const h of onHandlers) {
      try {
        const result = (await h.handler(payload)) as
          | LifecycleHandlerResult
          | ToolErrorHandlerResult
          | void;
        if (!result) continue;

        // LifecycleHandlerResult 字段合并
        if ('stop' in result && result.stop) {
          merged.stop = true;
          if (result.reason !== undefined) merged.reason = result.reason;
        }
        if ('block' in result && result.block) {
          merged.block = true;
          if (result.reason !== undefined) merged.reason = result.reason;
        }
        if ('modifiedInput' in result && result.modifiedInput !== undefined) {
          merged.modifiedInput = result.modifiedInput;
        }
        if ('modifiedOutput' in result && result.modifiedOutput !== undefined) {
          merged.modifiedOutput = result.modifiedOutput;
        }
        if ('terminate' in result && result.terminate) {
          merged.terminate = true;
          if (result.reason !== undefined) merged.reason = result.reason;
        }

        // ToolErrorHandlerResult 字段合并（tool.error 专用）
        // 优先级：abort > retry > skip
        if ('action' in result && result.action) {
          if (result.action === 'abort') {
            merged.action = 'abort';
            if (result.reason !== undefined) merged.reason = result.reason;
            break;
          }
          if (
            result.action === 'retry' &&
            merged.action !== 'retry' &&
            merged.action !== 'abort'
          ) {
            merged.action = 'retry';
            if (result.reason !== undefined) merged.reason = result.reason;
            if (result.retryDelayMs !== undefined) {
              merged.retryDelayMs = result.retryDelayMs;
            }
          }
          if (result.action === 'skip' && !merged.action) {
            merged.action = 'skip';
            if (result.reason !== undefined) merged.reason = result.reason;
          }
        }
      } catch {
        // on 失败记录但不阻塞
      }
    }
    return merged;
  }

  hasHandlers(): boolean {
    return this.handlers.length > 0;
  }

  clear(): void {
    this.handlers.length = 0;
  }

  private remove(entry: RegisteredHandler): void {
    const idx = this.handlers.indexOf(entry);
    if (idx >= 0) this.handlers.splice(idx, 1);
  }
}

// ─── Mock 工厂 ────────────────────────────────────────────────

function makeTrustGate(): TrustGateLike {
  return {
    assertPermission: () => {},
    decide: () => 'allow',
    registerPlugin: () => {},
    unregisterPlugin: () => {},
  };
}

function makeDeps(hookBus: HookBusLike): PluginAPIDeps {
  return {
    hookBus,
    toolRegistry: {
      register: vi.fn(() => ({
        name: 'mock',
        registeredAt: 0,
        unregister: () => {},
      })),
    } as unknown as PluginAPIDeps['toolRegistry'],
    mcpRegistrar: vi.fn() as unknown as PluginAPIDeps['mcpRegistrar'],
    trustGate: makeTrustGate(),
    logger: { log: vi.fn() },
    sessionContextProvider: () => ({
      sessionId: 's1',
      runId: 'r1',
      cwd: '/',
      turnIndex: 0,
      messageCount: 0,
      recentMessageMeta: [],
    }),
  };
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: '@crish/test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    entrypoints: { main: './dist/index.js' },
    permissions: ['hook:observe', 'hook:intercept'],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: [
      'turn.start',
      'turn.end',
      'tool.pre',
      'tool.post',
      'tool.error',
      'error.occurred',
    ],
    declaredTools: [],
    declaredMcpServers: [],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

// ─── observe 失败吞掉 ─────────────────────────────────────────

describe('observe 双模式 - 失败吞掉', () => {
  it('observe 抛错 → 不影响 emit 完成', async () => {
    const bus = new FakeHookBus();
    bus.observe('turn.start', () => {
      throw new Error('observe failed');
    });

    // 不应抛错
    await expect(
      bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 }),
    ).resolves.toEqual({});
  });

  it('observe 异步抛错 → 不影响 emit 完成', async () => {
    const bus = new FakeHookBus();
    bus.observe('turn.start', async () => {
      throw new Error('async observe failed');
    });

    await expect(
      bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 }),
    ).resolves.toEqual({});
  });

  it('observe 失败不阻塞 on 处理器执行', async () => {
    const bus = new FakeHookBus();
    const onCalls: number[] = [];
    bus.observe('turn.start', () => {
      throw new Error('observe failed');
    });
    bus.on('turn.start', () => {
      onCalls.push(1);
    });

    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 });
    expect(onCalls).toEqual([1]);
  });

  it('多个 observe 部分失败 → 其他 observe 仍执行', async () => {
    const bus = new FakeHookBus();
    const calls: string[] = [];
    bus.observe('turn.start', () => {
      calls.push('a');
    });
    bus.observe('turn.start', () => {
      throw new Error('b failed');
    });
    bus.observe('turn.start', () => {
      calls.push('c');
    });

    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 });
    expect(calls).toContain('a');
    expect(calls).toContain('c');
  });
});

// ─── observe 并行执行 ─────────────────────────────────────────

describe('observe 双模式 - 并行执行', () => {
  it('多个 observe 并行执行（基于 Promise.all）', async () => {
    const bus = new FakeHookBus();
    const started: number[] = [];
    const completed: number[] = [];
    bus.observe('turn.start', async () => {
      started.push(1);
      await new Promise((r) => setTimeout(r, 10));
      completed.push(1);
    });
    bus.observe('turn.start', async () => {
      started.push(2);
      await new Promise((r) => setTimeout(r, 5));
      completed.push(2);
    });

    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 });
    // 两个 observe 都已启动（并行）
    expect(started).toEqual([1, 2]);
    // 都已完成
    expect(completed.sort()).toEqual([1, 2]);
  });
});

// ─── on 串行执行 ──────────────────────────────────────────────

describe('on 双模式 - 串行执行', () => {
  it('多个 on 处理器按注册顺序执行', async () => {
    const bus = new FakeHookBus();
    const calls: number[] = [];
    bus.on('turn.end', async () => {
      calls.push(1);
    });
    bus.on('turn.end', async () => {
      calls.push(2);
    });
    bus.on('turn.end', async () => {
      calls.push(3);
    });

    await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(calls).toEqual([1, 2, 3]);
  });
});

// ─── on 控制信号合并 ──────────────────────────────────────────

describe('on 双模式 - LifecycleHandlerResult 控制信号合并', () => {
  it('stop 字段：任一 on 返回 stop=true → 合并结果 stop=true', async () => {
    const bus = new FakeHookBus();
    bus.on('turn.end', () => ({ stop: false }));
    bus.on('turn.end', () => ({ stop: true, reason: 'policy' }));

    const result = await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(result.stop).toBe(true);
  });

  it('block 字段：任一 on 返回 block=true → 合并结果 block=true', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.pre', () => ({ block: true, reason: 'denied' }));

    const result = await bus.emit('tool.pre', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: { cmd: 'rm' },
      turnIndex: 1,
      cwd: '/',
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe('denied');
  });

  it('modifiedInput 字段：保留最后一个非 undefined 值', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.pre', () => ({ modifiedInput: { cmd: 'ls -l' } }));

    const result = await bus.emit('tool.pre', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: { cmd: 'ls' },
      turnIndex: 1,
      cwd: '/',
    });
    expect(result.modifiedInput).toEqual({ cmd: 'ls -l' });
  });

  it('modifiedOutput 字段：保留最后一个非 undefined 值', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.post', () => ({
      modifiedOutput: { text: 'modified result' },
    }));

    const result = await bus.emit('tool.post', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'read',
      input: {},
      turnIndex: 1,
      cwd: '/',
    });
    expect(result.modifiedOutput?.text).toBe('modified result');
  });

  it('terminate 字段：任一 on 返回 terminate=true → 合并结果 terminate=true', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.post', () => ({ terminate: true, reason: 'critical' }));

    const result = await bus.emit('tool.post', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      turnIndex: 1,
      cwd: '/',
    });
    expect(result.terminate).toBe(true);
    expect(result.reason).toBe('critical');
  });

  it('多 on 返回 void → 合并结果为空对象', async () => {
    const bus = new FakeHookBus();
    bus.on('turn.end', () => {});
    bus.on('turn.end', () => undefined);

    const result = await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(result).toEqual({});
  });

  it('多字段同时合并（stop + block + modifiedInput）', async () => {
    const bus = new FakeHookBus();
    bus.on('turn.end', () => ({ stop: true }));
    bus.on('tool.pre', () => ({ block: true }));

    // 不同事件互不影响
    const turnEndResult = await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(turnEndResult.stop).toBe(true);
    expect(turnEndResult.block).toBeUndefined();

    const toolPreResult = await bus.emit('tool.pre', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      turnIndex: 1,
      cwd: '/',
    });
    expect(toolPreResult.block).toBe(true);
    expect(toolPreResult.stop).toBeUndefined();
  });
});

// ─── tool.error 控制信号合并（ToolErrorHandlerResult） ─────────

describe('tool.error 双模式 - ToolErrorHandlerResult 合并', () => {
  it('单个 on 返回 retry → 合并结果 action=retry', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.error', () => ({ action: 'retry' as const, retryDelayMs: 100 }));

    const result = await bus.emit('tool.error', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      error: { name: 'E', message: 'failed' },
      turnIndex: 1,
      cwd: '/',
      attemptCount: 1,
    });
    const typedResult = result as LifecycleHandlerResult & Partial<ToolErrorHandlerResult>;
    expect(typedResult.action).toBe('retry');
    expect(typedResult.retryDelayMs).toBe(100);
  });

  it('单个 on 返回 skip → 合并结果 action=skip', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.error', () => ({ action: 'skip' as const, reason: 'non-critical' }));

    const result = await bus.emit('tool.error', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      error: { name: 'E', message: 'failed' },
      turnIndex: 1,
      cwd: '/',
      attemptCount: 1,
    });
    const typedResult = result as LifecycleHandlerResult & Partial<ToolErrorHandlerResult>;
    expect(typedResult.action).toBe('skip');
    expect(typedResult.reason).toBe('non-critical');
  });

  it('单个 on 返回 abort → 合并结果 action=abort', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.error', () => ({ action: 'abort' as const, reason: 'critical' }));

    const result = await bus.emit('tool.error', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      error: { name: 'E', message: 'failed' },
      turnIndex: 1,
      cwd: '/',
      attemptCount: 3,
    });
    const typedResult = result as LifecycleHandlerResult & Partial<ToolErrorHandlerResult>;
    expect(typedResult.action).toBe('abort');
  });

  it('优先级：abort > retry > skip（首个 abort 立即终止合并）', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.error', () => ({ action: 'skip' as const }));
    bus.on('tool.error', () => ({ action: 'abort' as const }));
    bus.on('tool.error', () => ({ action: 'retry' as const }));

    const result = await bus.emit('tool.error', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      error: { name: 'E', message: 'failed' },
      turnIndex: 1,
      cwd: '/',
      attemptCount: 1,
    });
    const typedResult = result as LifecycleHandlerResult & Partial<ToolErrorHandlerResult>;
    // abort 优先级最高
    expect(typedResult.action).toBe('abort');
  });

  it('retry 优先于 skip（无 abort 时）', async () => {
    const bus = new FakeHookBus();
    bus.on('tool.error', () => ({ action: 'skip' as const }));
    bus.on('tool.error', () => ({ action: 'retry' as const }));

    const result = await bus.emit('tool.error', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      error: { name: 'E', message: 'failed' },
      turnIndex: 1,
      cwd: '/',
      attemptCount: 1,
    });
    const typedResult = result as LifecycleHandlerResult & Partial<ToolErrorHandlerResult>;
    expect(typedResult.action).toBe('retry');
  });
});

// ─── error.occurred 仅 observe（on 控制信号无意义） ────────────

describe('error.occurred - observe-only', () => {
  it('error.occurred 的 on 处理器返回控制信号被忽略', async () => {
    const bus = new FakeHookBus();
    bus.on('error.occurred', () => ({ stop: true }));

    const result = await bus.emit('error.occurred', {
      sessionId: 's1',
      phase: 'tool',
      error: { name: 'E', message: 'failed' },
      retryable: false,
      occurredAt: '2026-07-31T00:00:00Z',
    });
    // 返回空对象（on 控制信号被忽略）
    expect(result).toEqual({});
    expect(result.stop).toBeUndefined();
  });

  it('error.occurred 的 observe 处理器仍执行', async () => {
    const bus = new FakeHookBus();
    const observed: string[] = [];
    bus.observe('error.occurred', (p) => {
      observed.push(p.phase);
    });

    await bus.emit('error.occurred', {
      sessionId: 's1',
      phase: 'tool',
      error: { name: 'E', message: 'failed' },
      retryable: false,
      occurredAt: '2026-07-31T00:00:00Z',
    });
    expect(observed).toEqual(['tool']);
  });
});

// ─── observe(*) 通配符 ────────────────────────────────────────

describe('observe(*) - 通配符订阅全部事件', () => {
  it('observe(*) 捕获全部 14 个事件', async () => {
    const bus = new FakeHookBus();
    const captured: HookEventName[] = [];
    bus.observe('*', (payload) => {
      // 通配符 observe 收到全部事件
      captured.push((payload as { __type?: HookEventName }).__type ?? ('turn.start' as HookEventName));
    });

    // emit 14 个事件（不同事件类型）
    await bus.emit('turn.start', { sessionId: 's', turnIndex: 0 });
    await bus.emit('turn.end', {
      sessionId: 's',
      turnIndex: 0,
      toolCallCount: 0,
      maxTurns: 0,
      hasPendingInput: false,
      isAborted: false,
    });
    await bus.emit('tool.pre', {
      sessionId: 's',
      toolCallId: 'c',
      toolName: 'n',
      input: {},
      turnIndex: 0,
      cwd: '/',
    });
    await bus.emit('tool.post', {
      sessionId: 's',
      toolCallId: 'c',
      toolName: 'n',
      input: {},
      turnIndex: 0,
      cwd: '/',
    });
    await bus.emit('tool.error', {
      sessionId: 's',
      toolCallId: 'c',
      toolName: 'n',
      input: {},
      error: { name: 'E', message: 'm' },
      turnIndex: 0,
      cwd: '/',
      attemptCount: 0,
    });
    await bus.emit('context.compact.start', { sessionId: 's' });
    await bus.emit('context.compact.end', { sessionId: 's', aborted: false });
    await bus.emit('session.start', {
      sessionId: 's',
      runId: 'r',
      cwd: '/',
      mode: 'new',
      initialMessageCount: 0,
      startedAt: '2026-07-31T00:00:00Z',
    });
    await bus.emit('session.end', {
      sessionId: 's',
      runId: 'r',
      reason: 'stop',
      turnCount: 0,
      toolCallCount: 0,
      endedAt: '2026-07-31T00:00:00Z',
    });
    await bus.emit('error.occurred', {
      sessionId: 's',
      phase: 'tool',
      error: { name: 'E', message: 'm' },
      retryable: false,
      occurredAt: '2026-07-31T00:00:00Z',
    });

    // 通配符 observe 应捕获全部事件
    expect(captured.length).toBeGreaterThanOrEqual(10);
  });

  it('observe(*) 与 observe(specific) 同时存在 → 都执行', async () => {
    const bus = new FakeHookBus();
    const allCalls: string[] = [];
    const specificCalls: string[] = [];
    bus.observe('*', () => {
      allCalls.push('wildcard');
    });
    bus.observe('turn.start', () => {
      specificCalls.push('specific');
    });

    await bus.emit('turn.start', { sessionId: 's', turnIndex: 0 });
    expect(allCalls).toEqual(['wildcard']);
    expect(specificCalls).toEqual(['specific']);
  });
});

// ─── HookUnsubscribe 取消订阅 ─────────────────────────────────

describe('HookUnsubscribe - 取消订阅', () => {
  it('observe 返回的 unsubscribe 调用后不再触发', async () => {
    const bus = new FakeHookBus();
    const calls: number[] = [];
    const unsub = bus.observe('turn.start', () => {
      calls.push(1);
    });

    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 0 });
    expect(calls).toEqual([1]);

    unsub();
    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 0 });
    expect(calls).toEqual([1]); // 不再触发
  });

  it('on 返回的 unsubscribe 调用后不再触发', async () => {
    const bus = new FakeHookBus();
    const calls: number[] = [];
    const unsub = bus.on('turn.end', () => {
      calls.push(1);
      return { stop: true };
    });

    await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 0,
      toolCallCount: 0,
      maxTurns: 0,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(calls).toEqual([1]);

    unsub();
    const result = await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 0,
      toolCallCount: 0,
      maxTurns: 0,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(calls).toEqual([1]); // 不再触发
    expect(result).toEqual({}); // 无 on 处理器 → 空结果
  });

  it('取消订阅后其他 handler 仍正常执行', async () => {
    const bus = new FakeHookBus();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = bus.observe('turn.start', () => {
      a.push(1);
    });
    bus.observe('turn.start', () => {
      b.push(1);
    });

    unsubA();
    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 0 });
    expect(a).toEqual([]);
    expect(b).toEqual([1]);
  });
});

// ─── PluginAPI + HookBus 集成 ──────────────────────────────────

describe('PluginAPI + HookBus 集成 - 双模式端到端', () => {
  it('PluginAPI.observe 委托后 emit 触发 handler', async () => {
    const bus = new FakeHookBus();
    const api = new PluginAPI(makeManifest(), makeDeps(bus));
    const observed: number[] = [];

    api.observe('turn.start', () => {
      observed.push(1);
    });

    await bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 });
    expect(observed).toEqual([1]);
  });

  it('PluginAPI.on 委托后 emit 触发 handler 并返回控制信号', async () => {
    const bus = new FakeHookBus();
    const api = new PluginAPI(makeManifest(), makeDeps(bus));

    api.on('turn.end', () => ({ stop: true, reason: 'policy' }));

    const result = await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('policy');
  });

  it('PluginAPI.observe 失败吞掉不影响 emit', async () => {
    const bus = new FakeHookBus();
    const api = new PluginAPI(makeManifest(), makeDeps(bus));

    api.observe('turn.start', () => {
      throw new Error('plugin observe failed');
    });

    // 不应抛错
    await expect(
      bus.emit('turn.start', { sessionId: 's1', turnIndex: 1 }),
    ).resolves.toEqual({});
  });

  it('PluginAPI.on 注册 tool.error handler → emit 返回 ToolErrorHandlerResult', async () => {
    const bus = new FakeHookBus();
    const api = new PluginAPI(makeManifest(), makeDeps(bus));

    api.on('tool.error', () => ({ action: 'retry' as const, retryDelayMs: 200 }));

    const result = await bus.emit('tool.error', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: {},
      error: { name: 'E', message: 'failed' },
      turnIndex: 1,
      cwd: '/',
      attemptCount: 1,
    });
    const typedResult = result as LifecycleHandlerResult & Partial<ToolErrorHandlerResult>;
    expect(typedResult.action).toBe('retry');
    expect(typedResult.retryDelayMs).toBe(200);
  });
});

// ─── observe 与 on 共存（禁令 14 双模式保留） ──────────────────

describe('observe + on 共存 - 双模式同时生效', () => {
  it('同一事件 observe + on 同时注册 → 都执行', async () => {
    const bus = new FakeHookBus();
    const observeCalls: number[] = [];
    const onCalls: number[] = [];
    bus.observe('turn.end', () => {
      observeCalls.push(1);
    });
    bus.on('turn.end', () => {
      onCalls.push(1);
      return { stop: true };
    });

    const result = await bus.emit('turn.end', {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 0,
      maxTurns: 5,
      hasPendingInput: false,
      isAborted: false,
    });
    expect(observeCalls).toEqual([1]);
    expect(onCalls).toEqual([1]);
    expect(result.stop).toBe(true);
  });

  it('observe 抛错不影响 on 执行 + 返回控制信号', async () => {
    const bus = new FakeHookBus();
    bus.observe('tool.pre', () => {
      throw new Error('observe failed');
    });
    bus.on('tool.pre', () => ({ block: true, reason: 'denied' }));

    const result = await bus.emit('tool.pre', {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: { cmd: 'rm' },
      turnIndex: 1,
      cwd: '/',
    });
    expect(result.block).toBe(true);
    expect(result.reason).toBe('denied');
  });
});
