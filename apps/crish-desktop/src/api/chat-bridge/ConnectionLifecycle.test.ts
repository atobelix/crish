/**
 * ConnectionLifecycle 单测（Tauri IPC transport 版，C3.1）。
 * - 完整 run-task / 事件流契约见 ConnectionLifecycle.tauri.test.ts；
 * - 本文件覆盖 createFinishController / createStreamCancel / ensureEngineConnected 纯逻辑面。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFinishController,
  createStreamCancel,
  createStreamSession,
  ensureEngineConnected,
  checkEngineReadyRealtime,
  composeSystemPrompt,
  buildHistoryMessages,
  resolveContextWindow,
  resolveSendThinkingFields,
  estimateTextTokens,
  ENGINE_CONNECT_TIMEOUT_MS,
} from './ConnectionLifecycle';
import { ApprovalFlowMachine } from '../approvalFlowMachine';
import type { StreamCallbacks } from '../chatApi';
import type { StreamState } from './handlers/streamState';
import type { SessionMessage } from '../../store/types';
import type { Settings } from '../clientApi';
import type { HistoryMessage } from './ConnectionLifecycle';
import { getControlMetrics, resetControlMetrics } from '../controlMetrics';
import { mockTauriCommand } from '../../test-setup';
import { DOMAIN_MESSAGES } from '../userFacingErrors';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  getBusyAttempt,
  noteBusy,
  resetBusyRetryForTests,
} from '../sessionStreamManager';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../modelsCatalogStore';
import {
  sessionRuntimeRegistry,
  setSessionThinkingTitle,
} from '../SessionRuntimeRegistry';
import type { ProviderSpec } from '../modelsCatalogTypes';

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

  it('真实工具输出保真：当 toolCalls 仅在自身携带真实 output 且 toolCallResults 缺省时，自动提取并生成配对 tool_call_results_json', () => {
    const history = buildHistoryMessages([
      makeMsg({
        id: 'u1',
        sender: 'user',
        text: '读取文件',
        status: 'completed',
        timestamp: 100,
      }),
      makeMsg({
        id: 'a1',
        sender: 'assistant',
        text: '读取完毕',
        status: 'completed',
        timestamp: 200,
        toolCalls: [
          {
            id: 'call_read_1',
            name: 'read_file',
            arguments: '{"path":"main.rs"}',
            status: 'success',
            output: 'fn main() { println!("hello"); }',
          },
          {
            id: 'call_cmd_2',
            name: 'run_cmd',
            arguments: '{"command":"cargo test"}',
            status: 'error',
            output: 'compilation failed',
          },
        ],
      }),
    ]);

    expect(history).toBeDefined();
    expect(history).toHaveLength(2);
    const asst = history?.[1];
    expect(asst?.tool_calls_json).toContain(
      '"output":"fn main() { println!(\\"hello\\"); }"'
    );
    expect(asst?.tool_calls_json).toContain('"output":"compilation failed"');
    expect(asst?.tool_call_results_json).toBe(
      JSON.stringify([
        {
          id: 'call_read_1',
          output: 'fn main() { println!("hello"); }',
          isError: false,
        },
        {
          id: 'call_cmd_2',
          output: 'compilation failed',
          isError: true,
        },
      ])
    );
  });

  it('多轮对话历史全保真：包含多轮 User、Assistant 及其完整工具调用与真实输出，尾部排查当前消息', () => {
    const history = buildHistoryMessages(
      [
        makeMsg({
          id: 'u1',
          sender: 'user',
          text: '第1轮问题',
          status: 'completed',
        }),
        makeMsg({
          id: 'a1',
          sender: 'assistant',
          text: '第1轮回复',
          status: 'completed',
          toolCalls: [
            {
              id: 't1',
              name: 'search',
              arguments: '{"q":"rust"}',
              status: 'success',
              output: 'found 10 items',
            },
          ],
        }),
        makeMsg({
          id: 'u2',
          sender: 'user',
          text: '第2轮问题',
          status: 'completed',
        }),
        makeMsg({
          id: 'a2',
          sender: 'assistant',
          text: '第2轮回复',
          status: 'completed',
          toolCalls: [
            {
              id: 't2',
              name: 'fetch',
              arguments: '{"url":"http://..."}',
              status: 'success',
              output: 'status 200 ok',
            },
          ],
        }),
        makeMsg({
          id: 'u3',
          sender: 'user',
          text: '当前正在发送的第3轮新提问',
          status: 'processing',
        }),
      ],
      { excludeId: 'u3' }
    );

    expect(history).toHaveLength(4);
    expect(history?.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(history?.[1].tool_call_results_json).toContain('found 10 items');
    expect(history?.[3].tool_call_results_json).toContain('status 200 ok');
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

  it(`默认预算内全量回传：120 条小消息（${estimateTextTokens('m0')} token/条估算）不触发截断`, () => {
    // DEEPCHECK-01 P0：预算语义取代固定条数——预算内全量 append-only，
    // 请求前缀字节稳定（旧语义 100 条尾部滑窗已废除）
    const messages = Array.from({ length: 120 }, (_, i) =>
      makeMsg({
        id: `m${i}`,
        sender: i % 2 === 0 ? 'user' : 'assistant',
        text: `m${i}`,
        timestamp: i,
      })
    );
    const history = buildHistoryMessages(messages)!;
    expect(history).toHaveLength(120);
    expect(history[0]?.id).toBe('m0');
    expect(history[119]?.id).toBe('m119');
  });

  it('自定义 tokenBudget 生效（预算截断 + 首条 user 锚点恒在）', () => {
    // 10 条 × 9 token（"m{i}" 1 token + 开销 8）= 90 > 40：锚点 m0（9 token）
    // + 尾部窗口 [m7..m9]（27 token）装下预算，中间段丢弃
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ id: `m${i}`, sender: 'user', text: `m${i}`, timestamp: i })
    );
    expect(buildHistoryMessages(messages, { tokenBudget: 40 })).toEqual([
      { id: 'm0', sender: 'user', text: 'm0', timestamp: 0 },
      { id: 'm7', sender: 'user', text: 'm7', timestamp: 7 },
      { id: 'm8', sender: 'user', text: 'm8', timestamp: 8 },
      { id: 'm9', sender: 'user', text: 'm9', timestamp: 9 },
    ]);
  });

  it('极端预算（低于单条消息）锚点仍恒在', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ id: `m${i}`, sender: 'user', text: `m${i}`, timestamp: i })
    );
    // 预算 5 < 单条 9 token：截断到只剩锚点（首条 user 永不因截断消失）
    const history = buildHistoryMessages(messages, { tokenBudget: 5 })!;
    expect(history).toEqual([
      { id: 'm0', sender: 'user', text: 'm0', timestamp: 0 },
    ]);
  });

  it('超长会话前缀稳定：同一会话两次调用（新增消息），重叠部分字节一致', () => {
    // 预算 300：call1（60 条 = 540 token）与 call2（66 条 = 594 token）
    // 都超预算 → 锚点 m0 恒在 + 尾部窗口按预算截断
    const call1 = buildHistoryMessages(
      Array.from({ length: 60 }, (_, i) =>
        makeMsg({ id: `m${i}`, sender: 'user', text: `m${i}`, timestamp: i })
      ),
      { tokenBudget: 300 }
    )!;
    const call2 = buildHistoryMessages(
      Array.from({ length: 66 }, (_, i) =>
        makeMsg({ id: `m${i}`, sender: 'user', text: `m${i}`, timestamp: i })
      ),
      { tokenBudget: 300 }
    )!;
    // 两次调用的首条字节一致 = 锚点恒在（跨 run 请求前缀以同一锚点开头）
    expect(call1[0]?.id).toBe('m0');
    expect(call2[0]?.id).toBe('m0');
    expect(JSON.stringify(call1[0])).toBe(JSON.stringify(call2[0]));
    // 重叠部分（两次调用都保留的消息，含锚点 m0 与 m34..m59）字节一致
    const overlap = (a: HistoryMessage[], b: HistoryMessage[]) =>
      a.filter((x) => b.some((y) => y.id === x.id));
    const shared1 = overlap(call1, call2);
    const shared2 = overlap(call2, call1);
    expect(shared1.length).toBeGreaterThan(0);
    expect(shared1).toEqual(shared2);
    expect(JSON.stringify(shared1)).toBe(JSON.stringify(shared2));
    // 锚点 m0 恒在两次调用中；共享窗口从 m34 起
    expect(shared1[0]?.id).toBe('m0');
    expect(shared1[1]?.id).toBe('m34');
    // 尾部窗口：最近的 m59 / m65 恒在
    expect(call1[call1.length - 1]?.id).toBe('m59');
    expect(call2[call2.length - 1]?.id).toBe('m65');
  });

  it('预算内会话两次调用：前次结果字节为后次结果前缀（append-only 全量命中）', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        makeMsg({ id: `m${i}`, sender: 'user', text: `m${i}`, timestamp: i })
      );
    const call1 = buildHistoryMessages(mk(30), { tokenBudget: 500 })!;
    const call2 = buildHistoryMessages(mk(36), { tokenBudget: 500 })!;
    // 预算内无截断 → call2 以 call1 的消息序列开头（字节级前缀 =
    // 服务端前缀缓存全量命中；数组 JSON 前缀含前一个序列的完整字节）
    expect(call2.slice(0, call1.length)).toEqual(call1);
    expect(JSON.stringify(call2.slice(0, call1.length))).toBe(
      JSON.stringify(call1)
    );
  });

  it('集成：120 条超预算会话——第 1 条锚点与最近 N 条恒在、中间按预算截断', () => {
    const messages = Array.from({ length: 120 }, (_, i) =>
      makeMsg({
        id: `m${i}`,
        sender: i % 2 === 0 ? 'user' : 'assistant',
        text: `m${i}`,
        timestamp: i,
      })
    );
    const history = buildHistoryMessages(messages, { tokenBudget: 270 })!;
    expect(history).toHaveLength(30);
    expect(history[0]?.id).toBe('m0');
    expect(history[1]?.id).toBe('m91');
    expect(history[29]?.id).toBe('m119');
    // 中间段（m1..m90）全部丢弃
    const dropped = messages
      .map((m) => m.id)
      .filter((id) => !history.some((h) => h.id === id));
    expect(dropped).toEqual(Array.from({ length: 90 }, (_, i) => `m${i + 1}`));
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

const CATALOG_PATH = 'C:\\tmp\\models.yaml';

async function loadLiveCatalog(
  providers: Record<string, ProviderSpec>
): Promise<void> {
  resetModelsCatalogMirror();
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    credentialStates: {},
    parseError: null,
    tree: { version: 2, activeModel: null, providers },
  }));
  mockTauriCommand('workbench_save_models_yaml', () => ({
    path: CATALOG_PATH,
  }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

describe('resolveContextWindow（live contextWindow；禁止 128000 假上限）', () => {
  afterEach(() => {
    localStorage.removeItem('crish_active_profile_id');
    localStorage.removeItem('crish_active_model_id');
    localStorage.removeItem('crish_model_meta_v1');
    resetModelsCatalogMirror();
    sessionRuntimeRegistry.clearAll();
  });

  it('settings / LS meta 不是规格源（不读 contextWindow 键，不读 contextLength）', async () => {
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
    expect(
      resolveContextWindow({ contextWindow: 64_000 } as unknown as Settings)
    ).toBeUndefined();
    expect(resolveContextWindow()).toBeUndefined();
  });

  it('live contextWindow 正数 → 原样取整；缺省 undefined，不发明 128000', async () => {
    localStorage.setItem('crish_active_profile_id', 'p1');
    localStorage.setItem('crish_active_model_id', 'deepseek-chat');
    await loadLiveCatalog({
      p1: {
        displayName: 'P1',
        baseUrl: 'https://example.invalid/v1',
        protocol: 'openai/chat',
        models: [
          {
            id: 'deepseek-chat',
            contextWindow: 131_072,
            thinking: { High: 'HIGH', Low: 'low' },
          },
        ],
      },
    });
    expect(resolveContextWindow()).toBe(131_072);

    localStorage.setItem('crish_active_model_id', 'no-window');
    await loadLiveCatalog({
      p1: {
        displayName: 'P1',
        baseUrl: 'https://example.invalid/v1',
        protocol: 'openai/chat',
        models: [{ id: 'no-window' }],
      },
    });
    expect(resolveContextWindow()).toBeUndefined();
    expect(resolveContextWindow()).not.toBe(128_000);
  });

  it('无活动模型 / 未加载 → undefined', () => {
    expect(resolveContextWindow()).toBeUndefined();
    expect(resolveContextWindow(null)).toBeUndefined();
  });
});

describe('resolveSendThinkingFields（会话 Title → live wire）', () => {
  afterEach(() => {
    localStorage.removeItem('crish_active_profile_id');
    localStorage.removeItem('crish_active_model_id');
    localStorage.removeItem('conex:model-thinking-pref:gemini:gpt-4o');
    localStorage.removeItem('conex:global-thinking-pref');
    resetModelsCatalogMirror();
    sessionRuntimeRegistry.clearAll();
  });

  it('会话 High → wire HIGH；不读 settings 小写标签', async () => {
    localStorage.setItem('crish_active_profile_id', 'gemini');
    localStorage.setItem('crish_active_model_id', 'gpt-4o');
    await loadLiveCatalog({
      gemini: {
        displayName: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/generate-content',
        models: [
          {
            id: 'gpt-4o',
            thinking: { Off: 'disabled', High: 'HIGH' },
          },
        ],
      },
    });
    setSessionThinkingTitle('sess-a', 'High');
    expect(resolveSendThinkingFields('sess-a')).toEqual({
      thinkingTitle: 'High',
      thinkingWire: 'HIGH',
    });
  });

  it('显式 Off → 仍交出字典 value（disabled），不省略', async () => {
    localStorage.setItem('crish_active_profile_id', 'gemini');
    localStorage.setItem('crish_active_model_id', 'gpt-4o');
    await loadLiveCatalog({
      gemini: {
        displayName: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/generate-content',
        models: [
          {
            id: 'gpt-4o',
            thinking: { Off: 'disabled', High: 'HIGH' },
          },
        ],
      },
    });
    setSessionThinkingTitle('sess-a', 'Off');
    expect(resolveSendThinkingFields('sess-a')).toEqual({
      thinkingTitle: 'Off',
      thinkingWire: 'disabled',
    });
  });

  it('非思考模型 → 省略，不伪造 Off', async () => {
    localStorage.setItem('crish_active_profile_id', 'p1');
    localStorage.setItem('crish_active_model_id', 'plain');
    await loadLiveCatalog({
      p1: {
        displayName: 'P1',
        baseUrl: 'https://example.invalid/v1',
        protocol: 'openai/chat',
        models: [{ id: 'plain' }],
      },
    });
    setSessionThinkingTitle('sess-a', 'High');
    expect(resolveSendThinkingFields('sess-a')).toEqual({});
  });

  it('原选档位不在当前模型声明中 → 省略（视为未选，不降级到 Off/High）', async () => {
    localStorage.setItem('crish_active_profile_id', 'gemini');
    localStorage.setItem('crish_active_model_id', 'gpt-4o');
    await loadLiveCatalog({
      gemini: {
        displayName: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/generate-content',
        models: [
          {
            id: 'gpt-4o',
            thinking: { Off: 'disabled', High: 'HIGH' },
          },
        ],
      },
    });
    // 'Medium' 不在 {Off, High} 中：旧行为是回落首项 'Off'，现行为省略
    setSessionThinkingTitle('sess-a', 'Medium');
    expect(resolveSendThinkingFields('sess-a')).toEqual({});
  });

  it('无会话 Title 但该模型有持久偏好 → 沿用（与档位面板同一解析源）', async () => {
    localStorage.setItem('crish_active_profile_id', 'gemini');
    localStorage.setItem('crish_active_model_id', 'gpt-4o');
    await loadLiveCatalog({
      gemini: {
        displayName: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/generate-content',
        models: [
          {
            id: 'gpt-4o',
            thinking: { Off: 'disabled', High: 'HIGH' },
          },
        ],
      },
    });
    localStorage.setItem('conex:model-thinking-pref:gemini:gpt-4o', 'High');
    expect(resolveSendThinkingFields('sess-a')).toEqual({
      thinkingTitle: 'High',
      thinkingWire: 'HIGH',
    });
  });

  it('全局偏好档位不在当前模型声明中 → 省略（视为未选，不降级）', async () => {
    localStorage.setItem('crish_active_profile_id', 'gemini');
    localStorage.setItem('crish_active_model_id', 'gpt-4o');
    await loadLiveCatalog({
      gemini: {
        displayName: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        protocol: 'google/generate-content',
        models: [
          {
            id: 'gpt-4o',
            thinking: { Off: 'disabled', High: 'HIGH' },
          },
        ],
      },
    });
    localStorage.setItem('conex:global-thinking-pref', 'Medium');
    expect(resolveSendThinkingFields('sess-a')).toEqual({});
  });
});

describe('ConnectionLifecycle（Tauri IPC 版）', () => {
  beforeEach(() => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    fakeTransport.request.mockClear();
    fakeTransport.request.mockImplementation(async () => ({ ok: true }));
    fakeTransport.send.mockClear();
    resetControlMetrics();
  });

  describe('ensureEngineConnected', () => {
    it('核心就绪 → ok:true（waitUntilConnected 即 core_get_status 轮询）', async () => {
      const res = await ensureEngineConnected();
      expect(res.ok).toBe(true);
      expect(fakeTransport.waitUntilConnected).toHaveBeenCalledWith(
        ENGINE_CONNECT_TIMEOUT_MS
      );
    });

    it('核心未就绪 → ok:false + S1 域文案（差异化：不再是恒 network 文案）', async () => {
      vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(false);
      const res = await ensureEngineConnected();
      expect(res.ok).toBe(false);
      expect(res.error).toBe('软件服务正在启动，请稍候片刻。');
    });
  });

  describe('checkEngineReadyRealtime（R7：发送前真实就绪检查）', () => {
    it('实时 core_get_status 就绪 → ok:true', async () => {
      fakeTransport.request.mockResolvedValue({
        initialized: true,
        engineReady: true,
        restore: { state: 'done' },
      });
      const res = await checkEngineReadyRealtime();
      expect(res).toMatchObject({ ok: true, domain: null, state: 'ok' });
      expect(fakeTransport.request).toHaveBeenCalledWith(
        'core_get_status',
        {},
        { timeoutMs: 3_000 }
      );
    });

    it('initialized=false → S1（本地核心未就绪）', async () => {
      fakeTransport.request.mockResolvedValue({ initialized: false });
      const res = await checkEngineReadyRealtime();
      expect(res).toMatchObject({
        ok: false,
        domain: 'S1',
        state: 'retryable_wait',
      });
    });

    it('restore.state=pending → S3（恢复会话数据中）', async () => {
      fakeTransport.request.mockResolvedValue({
        initialized: true,
        engineReady: true,
        restore: { state: 'pending' },
      });
      const res = await checkEngineReadyRealtime();
      expect(res).toMatchObject({
        ok: false,
        domain: 'S3',
        state: 'retryable_wait',
      });
    });

    it('engineReady=false → S2（provider 配置缺失）', async () => {
      fakeTransport.request.mockResolvedValue({
        initialized: true,
        restore: { state: 'done' },
        engineReady: false,
      });
      const res = await checkEngineReadyRealtime();
      expect(res).toMatchObject({
        ok: false,
        domain: 'S2',
        state: 'blocked_with_action',
      });
    });

    it('查询失败 → fail-closed 降级（ok:false + retryable_wait，禁止放行绕过配置阻断）', async () => {
      fakeTransport.request.mockRejectedValue(
        new Error('Tauri command not available: core_get_status')
      );
      const res = await checkEngineReadyRealtime();
      // 'Tauri command not available: core_get_status' → S7；无法分类时回退 S1
      expect(res.ok).toBe(false);
      expect(res.state).toBe('retryable_wait');
      expect(res.domain).not.toBeNull();
      expect(res.guidance?.action).toBe('wait');
    });

    it('查询失败且错误无法分类 → 回退 S1（核心未就绪），仍不放行', async () => {
      fakeTransport.request.mockRejectedValue(new Error('boom'));
      const res = await checkEngineReadyRealtime();
      expect(res).toMatchObject({
        ok: false,
        state: 'retryable_wait',
        domain: 'S1',
      });
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

  it('waitUntilConnected 未就绪 → S1 域文案（不恒报 network 一刀切）', async () => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(false);
    vi.mocked(fakeTransport.isReady).mockReturnValue(false);
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };
    const state = makeState();
    const finish = vi.fn();

    await createStreamSession(
      'not ready',
      'sess-notready-1',
      'run-notready-1',
      callbacks,
      undefined,
      state,
      () => undefined,
      finish
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(msg).toBe('软件服务正在启动，请稍候片刻。');
    // kind 保持 network（T-1 分级分发：持久条面）
    expect(kind).toBe('network');
    expect(startRunTask).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('startRunTask invoke 失败 catch 分支 → 传真实错误 e 做分域（S2 配置缺失文案）', async () => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    startRunTask.mockRejectedValueOnce(
      new Error('internal: provider 配置缺失（baseUrl/model/apiKey 三件套）')
    );
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };
    const state = makeState();
    const finish = vi.fn();

    await createStreamSession(
      'gate reject',
      'sess-gate-1',
      'run-gate-1',
      callbacks,
      undefined,
      state,
      () => undefined,
      finish
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg, kind] = onRunError.mock.calls[0];
    expect(msg).toBe('模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。');
    expect(kind).toBe('network');
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('catch 分支：串行守卫（SESSION_BUSY）→ 撤回助手占位、用户消息 queued、不 followUp、0 次红条', async () => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    startRunTask.mockRejectedValueOnce(
      new Error('InvalidInput: 会话 sess-gate-2 已有活动 run（串行守卫）')
    );
    const root = getCompositionRoot();
    const sid = `sess-gate-2-${Math.random().toString(36).slice(2, 8)}`;
    root.session
      .getState()
      .createSession({ title: 'busy', id: sid, activate: false });
    root.session.getState().addMessage('ws', sid, {
      id: 'u-busy-1',
      sender: 'user',
      text: 'gate reject',
      timestamp: 1,
      status: 'processing',
    });
    root.session.getState().addMessage('ws', sid, {
      id: 'a-busy-1',
      sender: 'assistant',
      text: '',
      timestamp: 2,
      status: 'processing',
    });
    const followUpSpy = vi.spyOn(root.runControl, 'followUp');
    const onThought = vi.fn();
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought,
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };
    const state = makeState();
    const finish = vi.fn();

    await createStreamSession(
      'gate reject',
      sid,
      'run-gate-2',
      callbacks,
      { clientMessageId: 'u-busy-1' },
      state,
      () => undefined,
      finish,
      'a-busy-1'
    );

    const msgs = root.session.getState().sessionsById[sid]?.messages ?? [];
    expect(msgs.find((m) => m.id === 'a-busy-1')).toBeUndefined();
    expect(msgs.find((m) => m.id === 'u-busy-1')?.status).toBe('queued');
    expect(getBusyAttempt('u-busy-1')).toBe(1);
    expect(followUpSpy).not.toHaveBeenCalled();
    expect(onRunError).not.toHaveBeenCalled();
    expect(onThought).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
    followUpSpy.mockRestore();
    resetBusyRetryForTests();
  });

  it('run 被受理（startRunTask resolve）→ 串行守卫退避计数清零', async () => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    noteBusy('sess-gate-ok', 'u-busy-ok');
    noteBusy('sess-gate-ok', 'u-busy-ok');
    expect(getBusyAttempt('u-busy-ok')).toBe(2);
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError: vi.fn(),
    };
    await createStreamSession(
      'ok',
      'sess-gate-ok',
      'run-gate-ok',
      callbacks,
      { clientMessageId: 'u-busy-ok' },
      makeState(),
      () => undefined,
      vi.fn()
    );
    expect(getBusyAttempt('u-busy-ok')).toBe(0);
  });

  it('catch 分支：内部崩溃（panic / 未捕获异常）→ S6 内部错误文案', async () => {
    vi.mocked(fakeTransport.waitUntilConnected).mockResolvedValue(true);
    vi.mocked(fakeTransport.isReady).mockReturnValue(true);
    startRunTask.mockRejectedValueOnce(
      new Error('Internal: panic: engine core crash at session.rs:42')
    );
    const onRunError = vi.fn();
    const callbacks: StreamCallbacks = {
      onChunk: vi.fn(),
      onThought: vi.fn(),
      onToolStart: vi.fn(),
      onToolError: vi.fn(),
      onToolSuccess: vi.fn(),
      onComplete: vi.fn(),
      onRunError,
    };
    const state = makeState();
    const finish = vi.fn();

    await createStreamSession(
      'panic reject',
      'sess-gate-3',
      'run-gate-3',
      callbacks,
      undefined,
      state,
      () => undefined,
      finish
    );

    expect(onRunError).toHaveBeenCalledTimes(1);
    const [msg] = onRunError.mock.calls[0];
    expect(msg).toBe('软件内部错误，请稍后重试；若反复出现请重启应用。');
  });
});
