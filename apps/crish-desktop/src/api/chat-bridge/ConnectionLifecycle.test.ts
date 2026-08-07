/**
 * ConnectionLifecycle 单测（Tauri IPC transport 版，C3.1）。
 * - 完整 run-task / 事件流契约见 ConnectionLifecycle.tauri.test.ts；
 * - 本文件覆盖 createFinishController / createStreamCancel / ensureEngineConnected 纯逻辑面。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureEngineConnected,
  composeSystemPrompt,
  buildHistoryMessages,
  resolveContextWindow,
  HISTORY_CAP,
} from './ConnectionLifecycle';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import type { SessionMessage } from '../../store/types';
import type { Settings } from '../clientApi';
import { getControlMetrics, resetControlMetrics } from '../controlMetrics';

const { fakeTransport, startRunTask, loadSessionBodyMock } = vi.hoisted(() => {
  const fakeTransport = {
    waitUntilConnected: vi.fn(async () => true),
    isReady: vi.fn(() => true),
    onMessage: vi.fn(() => () => undefined),
    getStatus: vi.fn(() => 'connected' as const),
    onStatus: vi.fn(() => () => undefined),
    request: vi.fn(async () => ({ ok: true })),
    send: vi.fn(async () => undefined),
    stop: vi.fn(),
  };
  return {
    fakeTransport,
    // P1-F2：startRunTask 观测句柄（取消竞态断言「未被调用」）
    startRunTask: vi.fn(async () => undefined),
    // P1-F2：createStreamSession 动态 import 的历史真源 mock（同 tauri 测试）
    loadSessionBodyMock: vi.fn(async () => []),
  };
});

vi.mock('../transport', () => ({
  getTransport: () => fakeTransport,
  startRunTask,
  resetTransportForTests: () => undefined,
  TauriTransport: class TauriTransport {},
}));

// P1-F2：createStreamSession 内 `await import('../session-persistence/sessionRustDb')`
// 的水合数据源 mock（同 ConnectionLifecycle.tauri.test.ts 模式）
vi.mock('../session-persistence/sessionRustDb', () => ({
  loadSessionBody: loadSessionBodyMock,
}));

vi.mock('../projectStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectStore')>();
  return {
    ...actual,
    getWorkspacePath: () => 'C:/tmp/ws',
  };
});

vi.mock('../storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storeAccess')>();
  return {
    ...actual,
    getPermissionMode: () => 'ask',
  };
});

vi.mock('../clientApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clientApi')>();
  return {
    ...actual,
    clientApi: {
      ...actual.clientApi,
      getSettingsEx: vi.fn().mockResolvedValue({
        defaultThinkingLevel: 'medium',
        responseStyle: 'medium',
      }),
    },
  };
});

function makeState(partial: Partial<StreamState> = {}): StreamState {
  return {
    cancelled: false,
    finished: false,
    assistantText: '',
    assistantThought: '',
    unsub: null,
    endTimer: null,
    ...partial,
  };
}

describe('composeSystemPrompt（P1：三形态唯一确定）', () => {
  const guidance = 'Response style: balanced. Be clear and complete.';

  it('base 与 guidance 都存在 → 各自 trim 后按 "\\n\\n" 拼接', () => {
    expect(
      composeSystemPrompt('  Base instructions.  ', `  ${guidance}  `)
    ).toBe(`Base instructions.\n\n${guidance}`);
  });

  it('guidance 为空 → 仅 base（trim 后）', () => {
    expect(composeSystemPrompt('  Base only.  ', undefined)).toBe('Base only.');
    expect(composeSystemPrompt('Base only.', '   ')).toBe('Base only.');
  });

  it('base 为空 → 仅 guidance（trim 后）', () => {
    expect(composeSystemPrompt(undefined, `  ${guidance}  `)).toBe(guidance);
    expect(composeSystemPrompt('', guidance)).toBe(guidance);
  });

  it('两者皆空（undefined / 空串 / 纯空白）→ undefined', () => {
    expect(composeSystemPrompt(undefined, undefined)).toBeUndefined();
    expect(composeSystemPrompt('', undefined)).toBeUndefined();
    expect(composeSystemPrompt(undefined, '')).toBeUndefined();
    expect(composeSystemPrompt('   ', '  ')).toBeUndefined();
  });

  it('base 含 "Response style:" 字样不特殊处理（同配置形态唯一）', () => {
    const baseWithStyle = 'Response style: thorough. User says hi.';
    expect(composeSystemPrompt(baseWithStyle, guidance)).toBe(
      `${baseWithStyle}\n\n${guidance}`
    );
  });
});

describe('buildHistoryMessages（P4 T-31：store 消息 → history 载荷）', () => {
  const makeMsg = (partial: Partial<SessionMessage>): SessionMessage =>
    ({
      id: 'm1',
      sender: 'user',
      timestamp: 1,
      ...partial,
    }) as SessionMessage;

  it('映射形状：camelCase 字段组装（sender/text/thinking/tool_calls_json/tool_call_results_json/status/timestamp）', () => {
    const history = buildHistoryMessages([
      makeMsg({
        id: 'u1',
        sender: 'user',
        text: '第一轮问题',
        timestamp: 100,
        status: 'completed',
      }),
      makeMsg({
        id: 'a1',
        sender: 'assistant',
        text: '第一轮回复',
        thinking: '思考过程',
        timestamp: 200,
        status: 'completed',
        toolCalls: [
          { id: 'c1', name: 'bash', arguments: '{"x":1}', status: 'success' },
        ],
        toolCallResults: [{ id: 'c1', output: 'done', isError: false }],
      }),
      makeMsg({ id: 'u2', sender: 'user', text: '追问', timestamp: 300 }),
    ]);
    expect(history).toEqual([
      {
        id: 'u1',
        sender: 'user',
        text: '第一轮问题',
        timestamp: 100,
        status: 'completed',
      },
      {
        id: 'a1',
        sender: 'assistant',
        text: '第一轮回复',
        thinking: '思考过程',
        timestamp: 200,
        status: 'completed',
        tool_calls_json:
          '[{"id":"c1","name":"bash","arguments":"{\\"x\\":1}","status":"success"}]',
        tool_call_results_json: '[{"id":"c1","output":"done","isError":false}]',
      },
      { id: 'u2', sender: 'user', text: '追问', timestamp: 300 },
    ]);
    // 未组装 blocks_json（前端 timeline 形状与 AgentMessageBlock 不兼容，引擎合成兜底）
    expect(history?.[1]).not.toHaveProperty('blocks_json');
  });

  it('空会话 / 无任何合格消息 → undefined（不传 = 引擎现状单消息 run）', () => {
    expect(buildHistoryMessages([])).toBeUndefined();
    expect(buildHistoryMessages(undefined)).toBeUndefined();
    expect(buildHistoryMessages(null)).toBeUndefined();
    expect(
      buildHistoryMessages([
        makeMsg({
          id: 'p1',
          sender: 'user',
          text: '半成品',
          status: 'processing',
        }),
        makeMsg({
          id: 'p2',
          sender: 'assistant',
          text: '失败',
          status: 'error',
        }),
        makeMsg({ id: 'p3', sender: 'user', text: '排队', status: 'queued' }),
      ])
    ).toBeUndefined();
  });

  it(`上限截断：超过 ${HISTORY_CAP} 条只保留最近 ${HISTORY_CAP} 条`, () => {
    const messages = Array.from({ length: 120 }, (_, i) =>
      makeMsg({
        id: `m${i}`,
        sender: i % 2 === 0 ? 'user' : 'assistant',
        text: `消息${i}`,
        timestamp: i,
      })
    );
    const history = buildHistoryMessages(messages)!;
    expect(history).toHaveLength(HISTORY_CAP);
    expect(history[0]?.id).toBe('m20');
    expect(history[HISTORY_CAP - 1]?.id).toBe('m119');
  });

  it('自定义 cap 生效（超长会话只回传尾部窗口）', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ id: `m${i}`, sender: 'user', text: `q${i}`, timestamp: i })
    );
    expect(buildHistoryMessages(messages, { cap: 3 })).toEqual([
      { id: 'm7', sender: 'user', text: 'q7', timestamp: 7 },
      { id: 'm8', sender: 'user', text: 'q8', timestamp: 8 },
      { id: 'm9', sender: 'user', text: 'q9', timestamp: 9 },
    ]);
  });

  it('excludeId 排除当前 run 的 user 消息（历史与 prompt 不重复）', () => {
    const history = buildHistoryMessages(
      [
        makeMsg({ id: 'h1', sender: 'user', text: '旧问题', timestamp: 1 }),
        makeMsg({
          id: 'cur',
          sender: 'user',
          text: '当前问题',
          timestamp: 2,
          status: 'completed',
        }),
        makeMsg({
          id: 'h2',
          sender: 'assistant',
          text: '回复中',
          timestamp: 3,
          status: 'processing',
        }),
      ],
      { excludeId: 'cur' }
    );
    expect(history).toEqual([
      { id: 'h1', sender: 'user', text: '旧问题', timestamp: 1 },
    ]);
  });

  it('非 user/assistant sender 跳过（System/Tool 瞬态角色不回传）', () => {
    const history = buildHistoryMessages([
      makeMsg({ id: 'sys', sender: 'system' as never, text: '瞬态' }),
      makeMsg({ id: 'u1', sender: 'user', text: '正常', timestamp: 9 }),
    ]);
    expect(history).toEqual([
      { id: 'u1', sender: 'user', text: '正常', timestamp: 9 },
    ]);
  });
});

describe('resolveContextWindow（P4 T-31：contextWindow 解析）', () => {
  afterEach(() => {
    localStorage.removeItem('crish_active_profile_id');
    localStorage.removeItem('crish_active_model_id');
    localStorage.removeItem('crish_model_meta_v1');
  });

  it('设置显式键优先（Settings.contextWindow 预留键；非正数 / NaN 忽略）', () => {
    expect(
      resolveContextWindow({ contextWindow: 64_000 } as unknown as Settings)
    ).toBe(64_000);
    expect(
      resolveContextWindow({ contextWindow: 0 } as unknown as Settings)
    ).toBeUndefined();
    expect(
      resolveContextWindow({ contextWindow: NaN } as unknown as Settings)
    ).toBeUndefined();
  });

  it('无设置键 → 生效模型 catalog 元数据（getModelMeta.contextLength）', () => {
    localStorage.setItem('crish_active_profile_id', 'p1');
    localStorage.setItem('crish_active_model_id', 'deepseek-chat');
    localStorage.setItem(
      'crish_model_meta_v1',
      JSON.stringify({
        'p1::deepseek-chat': {
          profileId: 'p1',
          model: 'deepseek-chat',
          enabled: true,
          contextLength: 131_072,
        },
      })
    );
    expect(resolveContextWindow()).toBe(131_072);
  });

  it('无显式设置且无目录数据 → undefined（缺省不发）', () => {
    expect(resolveContextWindow()).toBeUndefined();
    expect(resolveContextWindow(null)).toBeUndefined();
    expect(
      resolveContextWindow({ responseStyle: 'medium' } as Settings)
    ).toBeUndefined();
  });
});

describe('ConnectionLifecycle（Tauri IPC 版）', () => {
  beforeEach(() => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    fakeTransport.request.mockClear();
    fakeTransport.send.mockClear();
    resetControlMetrics();
  });

  describe('ensureEngineConnected', () => {
    it('核心就绪 → ok:true（waitUntilConnected 即 core_get_status 轮询）', async () => {
      const res = await ensureEngineConnected();
      expect(res.ok).toBe(true);
      expect(fakeTransport.waitUntilConnected).toHaveBeenCalledWith(20_000);
    });

    it('核心未就绪 → ok:false + network 文案', async () => {
      vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(false);
      const res = await ensureEngineConnected();
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
    });
  });

  describe('createFinishController', () => {
    it('invokes onComplete when finishing stream state', () => {
      const approvalFlow = new ApprovalFlowMachine();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
      };
      const cleanup = vi.fn();
      const state = makeState();

      const controller = createFinishController(
        approvalFlow,
        callbacks,
        cleanup,
        state
      );

      controller.finish(true);

      expect(state.finished).toBe(true);
      expect(cleanup).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
    });
  });

  describe('createStreamCancel', () => {
    it('force 默认：state 收口 + onComplete（run-control L3 经 compositionRoot 分派）', async () => {
      const approvalFlow = new ApprovalFlowMachine();
      const onComplete = vi.fn();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete,
      };
      const cleanup = vi.fn();
      const state = makeState();

      const cancel = createStreamCancel(
        'run-test-1',
        callbacks,
        approvalFlow,
        cleanup,
        state
      );

      cancel();

      expect(state.cancelled).toBe(true);
      expect(state.finished).toBe(true);
      expect(cleanup).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
      // metrics：L3 force_cancel 只记一次 level
      expect(getControlMetrics().run_control_L3).toBe(1);
    });

    it('cooperative 模式 → L2（metrics 记 L2）', () => {
      const approvalFlow = new ApprovalFlowMachine();
      const callbacks: StreamCallbacks = {
        onChunk: vi.fn(),
        onThought: vi.fn(),
        onToolStart: vi.fn(),
        onToolError: vi.fn(),
        onToolSuccess: vi.fn(),
        onComplete: vi.fn(),
      };
      const state = makeState();

      const cancel = createStreamCancel(
        'run-coop-1',
        callbacks,
        approvalFlow,
        () => undefined,
        state
      );

      cancel({ mode: 'cooperative' });

      expect(state.cancelled).toBe(true);
      expect(getControlMetrics().run_control_L2).toBe(1);
      expect(getControlMetrics().run_control_L3).toBe(0);
    });
  });
});

describe('取消与启动竞态（P1-F2：waitUntilConnected 挂起期间 stop）', () => {
  beforeEach(() => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    fakeTransport.onMessage.mockClear();
    startRunTask.mockClear();
    loadSessionBodyMock.mockClear();
    loadSessionBodyMock.mockResolvedValue([]);
    resetControlMetrics();
  });

  it('waitUntilConnected 挂起期间 cancel → 连接就绪后 startRunTask 不被调用（run 不启动）', async () => {
    // 手动可控挂起 promise：模拟核心未就绪窗口（1.5s 轮询未完成）
    let resolveWait!: (value: boolean) => void;
    const pending = new Promise<boolean>((res) => {
      resolveWait = res;
    });
    vi.mocked(fakeTransport.waitUntilConnected).mockImplementation(
      () => pending
    );

    const onComplete = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete,
    };
    const state = makeState();
    const approvalFlow = new ApprovalFlowMachine();
    const cleanup = vi.fn();
    const finish = vi.fn();

    // 真实 createStreamSession：挂起在 waitUntilConnected（勿 mock 本体）
    const sessionPromise = createStreamSession(
      'cancel during wait',
      'sess-race-1',
      'run-race-1',
      callbacks,
      undefined,
      state,
      () => undefined,
      finish
    );

    // 挂起期间用户点停止：置 cancelled/finished 并派发 L3 force_cancel
    const cancel = createStreamCancel(
      'run-race-1',
      callbacks,
      approvalFlow,
      cleanup,
      state
    );
    cancel();

    expect(state.cancelled).toBe(true);
    expect(state.finished).toBe(true);

    // 连接随后就绪：createStreamSession 恢复执行
    resolveWait(true);
    await sessionPromise;

    // 取消后 run 不得启动（当前 309 行后无取消检查 → 直接继续 → 红）
    expect(startRunTask).not.toHaveBeenCalled();
    // 守卫命中时静默返回：不订阅、不 onChunk/onRunError、不再二次收口
    expect(fakeTransport.onMessage).not.toHaveBeenCalled();
    expect(callbacks.onChunk).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    // cancel 自身已收口（onComplete 由 createStreamCancel 触发）
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('正常路径回归：无取消 → startRunTask 被调用且携带正确 runId', async () => {
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
    };
    const state = makeState();

    await createStreamSession(
      'normal start',
      'sess-norm-1',
      'run-norm-1',
      callbacks,
      undefined,
      state,
      () => undefined,
      vi.fn()
    );

    expect(startRunTask).toHaveBeenCalledTimes(1);
    const params = startRunTask.mock.calls[0][1] as Record<string, unknown>;
    expect(params.runId).toBe('run-norm-1');
    expect(params.prompt).toBe('normal start');
    expect(params.sessionId).toBe('sess-norm-1');
  });
});
