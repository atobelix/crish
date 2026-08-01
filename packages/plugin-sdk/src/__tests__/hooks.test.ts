// packages/plugin-sdk/src/__tests__/hooks.test.ts
// 单元测试：14 钩子类型系统（Agent 8-B 产出）
//
// 覆盖范围：
// - 14 钩子事件名联合类型（HookEventName）
// - HookPayloadMap 完整映射（14 个事件 → payload 类型）
// - observe/on 双模式 Handler 类型（HookObserveHandler / HookOnHandler）
// - LifecycleHandlerResult（stop/block/modifiedInput/modifiedOutput/terminate 5 字段）
// - ToolErrorHandlerResult（retry/skip/abort 控制信号）
// - HookUnsubscribe 取消订阅函数
// - HookAPI 接口（observe/on/registerTool/registerMcpServer/log/getSessionContext）
// - PluginLifecycle 接口（activate/deactivate）
// - PluginModule 入口模块形状
//
// 约束：禁令 14（observe/on 双模式保留 + payload 不退化 + 控制型钩子能力保留）

import { describe, it, expect } from 'vitest';
import type {
  HookEventName,
  HookPayloadMap,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
  LifecycleHandlerResult,
  ToolErrorHandlerResult,
  HookAPI,
  PluginLifecycle,
  PluginModule,
  TurnStartPayload,
  TurnEndPayload,
  ToolPrePayload,
  ToolPostPayload,
  ToolErrorPayload,
  ContextCompactStartPayload,
  ContextCompactEndPayload,
  SessionStartPayload,
  SessionEndPayload,
  ModelBeforeRequestPayload,
  ModelAfterResponsePayload,
  SubagentStartPayload,
  SubagentEndPayload,
  ErrorOccurredPayload,
} from '../hooks';

// ─── 14 钩子事件名 + payload 映射 ──────────────────────────────

describe('HookEventName - 14 钩子事件名联合类型', () => {
  it('14 个事件名全部可赋值（编译期校验）', () => {
    const events: HookEventName[] = [
      'turn.start',
      'turn.end',
      'tool.pre',
      'tool.post',
      'tool.error',
      'context.compact.start',
      'context.compact.end',
      'session.start',
      'session.end',
      'model.beforeRequest',
      'model.afterResponse',
      'subagent.start',
      'subagent.end',
      'error.occurred',
    ];
    expect(events).toHaveLength(14);
  });

  it('现有 6 个事件命名保留（禁令 14 不退化）', () => {
    const existingEvents: HookEventName[] = [
      'turn.start',
      'turn.end',
      'tool.pre',
      'tool.post',
      'context.compact.start',
      'context.compact.end',
    ];
    expect(existingEvents).toHaveLength(6);
  });

  it('新增 8 个事件命名（禁令 14 点分命名）', () => {
    const newEvents: HookEventName[] = [
      'session.start',
      'session.end',
      'model.beforeRequest',
      'model.afterResponse',
      'subagent.start',
      'subagent.end',
      'error.occurred',
      'tool.error',
    ];
    expect(newEvents).toHaveLength(8);
  });

  it('tool.error 事件保留（保留 ToolHook.onError 控制能力 禁令 14）', () => {
    const event: HookEventName = 'tool.error';
    expect(event).toBe('tool.error');
  });
});

// ─── payload 字段完整性校验（禁令 14 不退化） ──────────────────

describe('HookPayloadMap - payload 字段完整性', () => {
  it('turn.start payload 字段保留', () => {
    const payload: TurnStartPayload = {
      sessionId: 's1',
      turnIndex: 1,
    };
    expect(payload.sessionId).toBe('s1');
    expect(payload.turnIndex).toBe(1);
  });

  it('turn.end payload 全部字段保留（含 isAborted/hasPendingInput，禁令 14 不退化）', () => {
    const payload: TurnEndPayload = {
      sessionId: 's1',
      turnIndex: 1,
      toolCallCount: 2,
      maxTurns: 10,
      hasPendingInput: false,
      isAborted: false,
    };
    expect(payload.isAborted).toBe(false);
    expect(payload.hasPendingInput).toBe(false);
    expect(payload.toolCallCount).toBe(2);
    expect(payload.maxTurns).toBe(10);
  });

  it('tool.pre payload 字段保留', () => {
    const payload: ToolPrePayload = {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'read',
      input: { path: '/tmp' },
      turnIndex: 1,
      cwd: '/work',
    };
    expect(payload.toolName).toBe('read');
  });

  it('tool.post payload 字段保留（含 output/isError）', () => {
    const payload: ToolPostPayload = {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'read',
      input: {},
      output: { text: 'result' },
      isError: false,
      turnIndex: 1,
      cwd: '/work',
    };
    expect(payload.output?.text).toBe('result');
    expect(payload.isError).toBe(false);
  });

  it('tool.error payload 字段保留（attemptCount 控制重试次数）', () => {
    const payload: ToolErrorPayload = {
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'shell',
      input: { cmd: 'rm' },
      error: { name: 'Error', message: 'failed', stack: '...' },
      turnIndex: 1,
      cwd: '/work',
      attemptCount: 2,
    };
    expect(payload.attemptCount).toBe(2);
    expect(payload.error.name).toBe('Error');
  });

  it('context.compact.start payload 字段保留（trigger/tokensBefore/messageCount/reason）', () => {
    const payload: ContextCompactStartPayload = {
      sessionId: 's1',
      trigger: 'auto',
      tokensBefore: 10000,
      messageCount: 20,
      reason: 'threshold',
    };
    expect(payload.trigger).toBe('auto');
    expect(payload.tokensBefore).toBe(10000);
  });

  it('context.compact.end payload 全部诊断字段保留（禁令 14 不退化）', () => {
    const payload: ContextCompactEndPayload = {
      sessionId: 's1',
      aborted: false,
      trigger: 'auto',
      tokensBefore: 10000,
      tokensAfter: 5000,
      compressedMessageCount: 15,
      keptMessageCount: 5,
      compactionId: 'c1',
      durationMs: 200,
    };
    expect(payload.aborted).toBe(false);
    expect(payload.compactionId).toBe('c1');
    expect(payload.keptMessageCount).toBe(5);
    expect(payload.compressedMessageCount).toBe(15);
    expect(payload.tokensBefore).toBe(10000);
    expect(payload.tokensAfter).toBe(5000);
    expect(payload.durationMs).toBe(200);
  });

  it('session.start payload 字段（含 mode/sourceSessionId/initialMessageCount/startedAt）', () => {
    const payload: SessionStartPayload = {
      sessionId: 's1',
      runId: 'r1',
      cwd: '/work',
      mode: 'resume',
      sourceSessionId: 's0',
      initialMessageCount: 5,
      startedAt: '2026-07-31T00:00:00Z',
    };
    expect(payload.mode).toBe('resume');
    expect(payload.sourceSessionId).toBe('s0');
  });

  it('session.end payload 字段（含 reason/turnCount/toolCallCount/totalTokens）', () => {
    const payload: SessionEndPayload = {
      sessionId: 's1',
      runId: 'r1',
      reason: 'max-turns',
      turnCount: 10,
      toolCallCount: 5,
      totalTokens: 50000,
      endedAt: '2026-07-31T01:00:00Z',
    };
    expect(payload.reason).toBe('max-turns');
    expect(payload.totalTokens).toBe(50000);
  });

  it('model.beforeRequest payload 字段（含 providerId/model/requestId）', () => {
    const payload: ModelBeforeRequestPayload = {
      sessionId: 's1',
      runId: 'r1',
      turnIndex: 1,
      providerId: 'openai',
      model: 'gpt-4',
      messageCount: 5,
      estimatedInputTokens: 2000,
      toolCount: 3,
      requestId: 'req-1',
      cwd: '/work',
    };
    expect(payload.providerId).toBe('openai');
    expect(payload.model).toBe('gpt-4');
    expect(payload.requestId).toBe('req-1');
  });

  it('model.afterResponse payload 字段（含 finishReason/retried/retryCount）', () => {
    const payload: ModelAfterResponsePayload = {
      sessionId: 's1',
      runId: 'r1',
      turnIndex: 1,
      providerId: 'openai',
      model: 'gpt-4',
      requestId: 'req-1',
      finishReason: 'stop',
      outputTokens: 500,
      inputTokens: 2000,
      durationMs: 1500,
      retried: true,
      retryCount: 2,
    };
    expect(payload.finishReason).toBe('stop');
    expect(payload.retried).toBe(true);
    expect(payload.retryCount).toBe(2);
  });

  it('subagent.start payload 字段（含 role/capabilityMode/depth 禁令 21）', () => {
    const payload: SubagentStartPayload = {
      parentSessionId: 'p1',
      subagentSessionId: 's1',
      runId: 'r1',
      role: 'researcher',
      capabilityMode: 'read-only',
      depth: 1,
      task: 'research topic X',
      startedAt: '2026-07-31T00:00:00Z',
    };
    expect(payload.role).toBe('researcher');
    expect(payload.capabilityMode).toBe('read-only');
    expect(payload.depth).toBe(1);
  });

  it('subagent.end payload 字段（含 reason/turnCount/toolCallCount）', () => {
    const payload: SubagentEndPayload = {
      parentSessionId: 'p1',
      subagentSessionId: 's1',
      runId: 'r1',
      role: 'implementer',
      capabilityMode: 'read-write',
      depth: 1,
      reason: 'completed',
      turnCount: 3,
      toolCallCount: 5,
      endedAt: '2026-07-31T00:30:00Z',
    };
    expect(payload.reason).toBe('completed');
    expect(payload.turnCount).toBe(3);
  });

  it('error.occurred payload 字段（含 phase/error/retryable/context）', () => {
    const payload: ErrorOccurredPayload = {
      sessionId: 's1',
      runId: 'r1',
      turnIndex: 1,
      phase: 'tool',
      error: { name: 'Error', message: 'failed', code: 'TOOL_ERROR' },
      retryable: true,
      context: { tool: 'shell' },
      occurredAt: '2026-07-31T00:00:00Z',
    };
    expect(payload.phase).toBe('tool');
    expect(payload.retryable).toBe(true);
    expect(payload.error.code).toBe('TOOL_ERROR');
  });

  it('HookPayloadMap 14 个事件全部映射到 payload 类型', () => {
    const keys = Object.keys({} as HookPayloadMap) as HookEventName[];
    // 编译期：以下赋值校验每个事件都有对应的 payload 类型
    const samples: Partial<HookPayloadMap> = {
      'turn.start': { sessionId: 's', turnIndex: 0 },
      'turn.end': {
        sessionId: 's',
        turnIndex: 0,
        toolCallCount: 0,
        maxTurns: 0,
        hasPendingInput: false,
        isAborted: false,
      },
      'tool.pre': {
        sessionId: 's',
        toolCallId: 'c',
        toolName: 'n',
        input: {},
        turnIndex: 0,
        cwd: '/',
      },
      'tool.post': {
        sessionId: 's',
        toolCallId: 'c',
        toolName: 'n',
        input: {},
        turnIndex: 0,
        cwd: '/',
      },
      'tool.error': {
        sessionId: 's',
        toolCallId: 'c',
        toolName: 'n',
        input: {},
        error: { name: 'E', message: 'm' },
        turnIndex: 0,
        cwd: '/',
        attemptCount: 0,
      },
      'context.compact.start': { sessionId: 's' },
      'context.compact.end': { sessionId: 's', aborted: false },
      'session.start': {
        sessionId: 's',
        runId: 'r',
        cwd: '/',
        mode: 'new',
        initialMessageCount: 0,
        startedAt: '2026-07-31T00:00:00Z',
      },
      'session.end': {
        sessionId: 's',
        runId: 'r',
        reason: 'stop',
        turnCount: 0,
        toolCallCount: 0,
        endedAt: '2026-07-31T00:00:00Z',
      },
      'model.beforeRequest': {
        sessionId: 's',
        runId: 'r',
        turnIndex: 0,
        providerId: 'p',
        model: 'm',
        messageCount: 0,
        toolCount: 0,
        requestId: 'req',
        cwd: '/',
      },
      'model.afterResponse': {
        sessionId: 's',
        runId: 'r',
        turnIndex: 0,
        providerId: 'p',
        model: 'm',
        requestId: 'req',
        finishReason: 'stop',
        retried: false,
      },
      'subagent.start': {
        parentSessionId: 'p',
        subagentSessionId: 's',
        runId: 'r',
        role: 'researcher',
        capabilityMode: 'read-only',
        depth: 0,
        task: 't',
        startedAt: '2026-07-31T00:00:00Z',
      },
      'subagent.end': {
        parentSessionId: 'p',
        subagentSessionId: 's',
        runId: 'r',
        role: 'researcher',
        capabilityMode: 'read-only',
        depth: 0,
        reason: 'completed',
        turnCount: 0,
        toolCallCount: 0,
        endedAt: '2026-07-31T00:00:00Z',
      },
      'error.occurred': {
        sessionId: 's',
        phase: 'tool',
        error: { name: 'E', message: 'm' },
        retryable: false,
        occurredAt: '2026-07-31T00:00:00Z',
      },
    };
    expect(Object.keys(samples)).toHaveLength(14);
    expect(keys).toHaveLength(0); // 运行时为空，仅类型层校验
  });
});

// ─── Handler 类型校验（observe/on 双模式 禁令 14） ─────────────

describe('HookObserveHandler / HookOnHandler - 双模式 Handler 类型', () => {
  it('HookObserveHandler 接受 void 返回（只读容错）', () => {
    const handler: HookObserveHandler<'turn.start'> = (_payload) => {
      // observe 不可返回控制信号
    };
    expect(typeof handler).toBe('function');
  });

  it('HookObserveHandler 接受 Promise<void> 返回（异步只读）', () => {
    const handler: HookObserveHandler<'turn.start'> = async (_payload) => {
      // 异步 observe
    };
    expect(typeof handler).toBe('function');
  });

  it('HookOnHandler 接受 void 返回（无控制信号）', () => {
    const handler: HookOnHandler<'turn.end'> = (_payload) => {};
    expect(typeof handler).toBe('function');
  });

  it('HookOnHandler 接受 LifecycleHandlerResult 返回（控制信号）', () => {
    const handler: HookOnHandler<'turn.end'> = (_payload) => ({
      stop: true,
      reason: 'policy',
    });
    expect(typeof handler).toBe('function');
  });

  it('HookOnHandler 接受 ToolErrorHandlerResult 返回（tool.error 控制信号）', () => {
    const handler: HookOnHandler<'tool.error'> = (_payload) => ({
      action: 'retry' as const,
      retryDelayMs: 100,
    });
    expect(typeof handler).toBe('function');
  });

  it('HookOnHandler 接受 Promise<LifecycleHandlerResult> 返回（异步控制）', () => {
    const handler: HookOnHandler<'tool.pre'> = async (_payload) => ({
      block: true,
      reason: 'denied',
    });
    expect(typeof handler).toBe('function');
  });

  it('HookUnsubscribe 是函数类型', () => {
    const unsub: HookUnsubscribe = () => {};
    expect(typeof unsub).toBe('function');
    unsub();
  });
});

// ─── LifecycleHandlerResult 5 字段（禁令 14 保留现有控制能力） ──

describe('LifecycleHandlerResult - 5 字段控制信号', () => {
  it('stop 字段（turn.end → 建议 L2 cooperative stop）', () => {
    const result: LifecycleHandlerResult = { stop: true };
    expect(result.stop).toBe(true);
  });

  it('block 字段（tool.pre → 阻止工具执行）', () => {
    const result: LifecycleHandlerResult = { block: true, reason: 'deny' };
    expect(result.block).toBe(true);
    expect(result.reason).toBe('deny');
  });

  it('modifiedInput 字段（tool.pre → 修改工具输入）', () => {
    const result: LifecycleHandlerResult = {
      modifiedInput: { cmd: 'ls -l' },
    };
    expect(result.modifiedInput).toEqual({ cmd: 'ls -l' });
  });

  it('modifiedOutput 字段（tool.post → 改写工具输出）', () => {
    const result: LifecycleHandlerResult = {
      modifiedOutput: { text: 'modified' },
    };
    expect(result.modifiedOutput?.text).toBe('modified');
  });

  it('terminate 字段（tool.post → 终止整个 run）', () => {
    const result: LifecycleHandlerResult = {
      terminate: true,
      reason: 'critical',
    };
    expect(result.terminate).toBe(true);
  });

  it('reason 字段附带原因（block/terminate 时）', () => {
    const result: LifecycleHandlerResult = {
      block: true,
      reason: 'policy violation',
    };
    expect(result.reason).toBe('policy violation');
  });

  it('空对象（无控制信号）', () => {
    const result: LifecycleHandlerResult = {};
    expect(result.stop).toBeUndefined();
    expect(result.block).toBeUndefined();
    expect(result.terminate).toBeUndefined();
  });
});

// ─── ToolErrorHandlerResult（禁令 14 保留 ToolHook.onError 控制能力） ──

describe('ToolErrorHandlerResult - tool.error 控制信号', () => {
  it('action: retry（重试工具调用）', () => {
    const result: ToolErrorHandlerResult = {
      action: 'retry',
      retryDelayMs: 200,
    };
    expect(result.action).toBe('retry');
    expect(result.retryDelayMs).toBe(200);
  });

  it('action: skip（跳过本次调用，返回空输出）', () => {
    const result: ToolErrorHandlerResult = {
      action: 'skip',
      reason: 'non-critical',
    };
    expect(result.action).toBe('skip');
    expect(result.reason).toBe('non-critical');
  });

  it('action: abort（终止整个 run）', () => {
    const result: ToolErrorHandlerResult = {
      action: 'abort',
      reason: 'critical',
    };
    expect(result.action).toBe('abort');
    expect(result.reason).toBe('critical');
  });

  it('retry 必须含 action 字段（区别于 LifecycleHandlerResult）', () => {
    const result: ToolErrorHandlerResult = { action: 'retry' };
    expect(result.action).toBe('retry');
    expect(result.retryDelayMs).toBeUndefined();
  });
});

// ─── HookAPI 接口结构校验 ──────────────────────────────────────

describe('HookAPI - 接口结构', () => {
  it('HookAPI 含 observe / on / registerTool / registerMcpServer 方法', () => {
    // 通过 mock 对象校验接口结构（编译期校验）
    const mockApi: HookAPI = {
      manifest: {
        id: 'test',
        name: 'test',
        version: '1.0.0',
        origin: 'user-dir',
        trustLevel: 'restricted',
        entry: './index.js',
        declaredHooks: [],
        declaredTools: [],
        declaredMcpServers: [],
        declaredAgents: [],
        permissions: [],
      } as HookAPI['manifest'],
      observe: () => () => {},
      on: () => () => {},
      registerTool: () => ({ name: 't', registeredAt: 0, unregister: () => {} }),
      registerMcpServer: () => {},
      getSessionContext: () => ({
        sessionId: 's1',
        runId: 'r1',
        cwd: '/',
        turnIndex: 0,
        messageCount: 0,
        recentMessageMeta: [],
      }),
      log: () => {},
    };
    expect(typeof mockApi.observe).toBe('function');
    expect(typeof mockApi.on).toBe('function');
    expect(typeof mockApi.registerTool).toBe('function');
    expect(typeof mockApi.registerMcpServer).toBe('function');
    expect(typeof mockApi.log).toBe('function');
  });

  it('observe 返回 HookUnsubscribe（取消订阅函数）', () => {
    const mockApi: HookAPI = {
      manifest: {} as HookAPI['manifest'],
      observe: () => () => {},
      on: () => () => {},
      registerTool: () => ({ name: 't', registeredAt: 0, unregister: () => {} }),
      registerMcpServer: () => {},
      log: () => {},
    };
    const unsub = mockApi.observe('turn.start', () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('log 接受 4 个日志级别', () => {
    const levels: ('debug' | 'info' | 'warn' | 'error')[] = [
      'debug',
      'info',
      'warn',
      'error',
    ];
    expect(levels).toHaveLength(4);
  });
});

// ─── PluginLifecycle 接口 ──────────────────────────────────────

describe('PluginLifecycle - 接口结构', () => {
  it('activate 必填，deactivate 可选', () => {
    const lifecycle: PluginLifecycle = {
      activate: () => {},
    };
    expect(typeof lifecycle.activate).toBe('function');
    expect(lifecycle.deactivate).toBeUndefined();
  });

  it('activate 可返回 Promise（异步激活）', async () => {
    const lifecycle: PluginLifecycle = {
      activate: async () => {},
      deactivate: async () => {},
    };
    await lifecycle.activate({} as HookAPI);
    expect(typeof lifecycle.activate).toBe('function');
  });

  it('deactivate 可返回 Promise（异步停用）', async () => {
    const lifecycle: PluginLifecycle = {
      activate: () => {},
      deactivate: async () => {},
    };
    await lifecycle.deactivate?.();
    expect(typeof lifecycle.deactivate).toBe('function');
  });
});

// ─── PluginModule 入口模块形状 ─────────────────────────────────

describe('PluginModule - 入口模块形状', () => {
  it('支持 default 导出 PluginLifecycle', () => {
    const mod: PluginModule = {
      default: { activate: () => {} },
    };
    expect(mod.default?.activate).toBeDefined();
  });

  it('支持具名导出 activate 函数', () => {
    const mod: PluginModule = {
      activate: () => {},
    };
    expect(mod.activate).toBeDefined();
  });

  it('支持具名导出 activate + deactivate 函数', () => {
    const mod: PluginModule = {
      activate: () => {},
      deactivate: () => {},
    };
    expect(mod.activate).toBeDefined();
    expect(mod.deactivate).toBeDefined();
  });

  it('空模块允许（运行时 resolveLifecycle 会拒绝）', () => {
    const mod: PluginModule = {};
    expect(mod.default).toBeUndefined();
    expect(mod.activate).toBeUndefined();
  });
});
