// quickRunWiring 单测（R2-05 部分 5 快速操作发送面）：
// - GatewayRunTaskRepository：真实 WsGateway（注入捕获 send）+ 手工 dispatch 响应帧
//   （对齐 approvalWiring.test 风格）；成功解析 / GatewayError 透传 / 解析失败兜底；
// - 发送帧校验：kind=remote.runTask、body.command=runTask、params 透传（含 permissionMode）；
// - 错误码 → 文案映射（RUN_TASK_ERROR_TEXT：transport.closed / cmd.timeout /
//   cmd.session_busy 等 M6 §11.3 码）；未知码原文透传；
// - getQuickRunContext 单例语义：接线未启动 → null / 装配后复用 / 测试复位。
import { WsGateway } from '@/network/WsGateway';
import type { WsSocket } from '@/network/ReconnectingWsClient';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { authStore } from '@/domain/store/authStore';
import {
  resetObservationWiringForTest,
  ensureObservationWiring,
} from '@/adapters/wiring/observationWiring';
import {
  GatewayRunTaskRepository,
  getQuickRunContext,
  resetQuickRunContextForTest,
  runTaskErrorTextOf,
  RunTaskCommandError,
  RUN_TASK_ERROR_TEXT,
} from './quickRunWiring';

const T0 = 1_800_000_000_000;

interface SentFrame {
  kind: string;
  msgId: string;
  body: { command: string; params: Record<string, unknown> };
}

interface Harness {
  gateway: WsGateway;
  sent: SentFrame[];
  /** 以最近一帧 reqMsgId 回 result.runTask（M6 §6.1 CommandResult 信封） */
  respondOk: (result: unknown) => void;
  /** 以最近一帧 reqMsgId 回错误帧（D3 §6.2 错误码透传） */
  respondError: (code: string, retryable?: boolean) => void;
}

function makeHarness(): Harness {
  const sent: SentFrame[] = [];
  const gateway = new WsGateway({
    send: (raw) => {
      sent.push(JSON.parse(raw) as SentFrame);
    },
  });
  const lastReq = (): SentFrame => sent[sent.length - 1]!;
  return {
    gateway,
    sent,
    respondOk: (result) => {
      const req = lastReq();
      gateway.dispatchFrame({
        v: 1,
        kind: 'result.runTask',
        msgId: `resp-${sent.length}`,
        ts: T0,
        from: 'desktop',
        to: 'mobile',
        body: { reqMsgId: req.msgId, ok: true, result },
      } as InboundEnvelope);
    },
    respondError: (code, retryable = false) => {
      const req = lastReq();
      gateway.dispatchFrame({
        v: 1,
        kind: 'error',
        msgId: `err-${sent.length}`,
        ts: T0,
        from: 'desktop',
        to: 'mobile',
        body: { reqMsgId: req.msgId, code, message: `err:${code}`, retryable },
      } as InboundEnvelope);
    },
  };
}

/** mock socket（ReconnectingWsClient 工厂注入面，避免 jest 环境真实 WS） */
function mockSocketFactory(): WsSocket {
  return {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => {},
    close: () => {},
  };
}

beforeEach(() => {
  resetQuickRunContextForTest();
  resetObservationWiringForTest();
  authStore.setState({ host: '192.168.1.100', pairState: 'paired' });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('GatewayRunTaskRepository（C24 runTask 发送 + 解析）', () => {
  it('发送帧：kind=remote.runTask / command=runTask / params 原样透传（VM 层负责 permissionMode 默认值）', async () => {
    const h = makeHarness();
    const repo = new GatewayRunTaskRepository(h.gateway);
    const pending = repo.runTask({
      prompt: '检查 package.json',
      sessionId: 's-1',
      permissionMode: 'ask',
    });
    await tick();
    const frame = h.sent[0]!;
    expect(frame.kind).toBe('remote.runTask');
    expect(frame.body.command).toBe('runTask');
    expect(frame.body.params).toEqual({
      prompt: '检查 package.json',
      sessionId: 's-1',
      permissionMode: 'ask',
    });
    h.respondOk({ runId: 'r-1', sessionId: 's-1' });
    await expect(pending).resolves.toEqual({ runId: 'r-1', sessionId: 's-1' });
  });

  it('sessionId 缺省 → 不携带（桌面新建会话语义）', async () => {
    const h = makeHarness();
    const repo = new GatewayRunTaskRepository(h.gateway);
    const pending = repo.runTask({ prompt: 'hi' });
    await tick();
    expect(h.sent[0]!.body.params).toEqual({ prompt: 'hi' });
    h.respondOk({ runId: 'r-2', sessionId: 's-2' });
    await expect(pending).resolves.toEqual({ runId: 'r-2', sessionId: 's-2' });
  });

  it('错误帧 → RunTaskCommandError（code/retryable 透传）', async () => {
    const h = makeHarness();
    const repo = new GatewayRunTaskRepository(h.gateway);
    const pending = repo.runTask({ prompt: 'x' });
    await tick();
    h.respondError('cmd.session_busy', true);
    await expect(pending).rejects.toMatchObject({
      code: 'cmd.session_busy',
      retryable: true,
    });
    await expect(pending).rejects.toBeInstanceOf(RunTaskCommandError);
  });

  it('响应解析失败（result 缺必填字段）→ internal 兜底', async () => {
    const h = makeHarness();
    const repo = new GatewayRunTaskRepository(h.gateway);
    const pending = repo.runTask({ prompt: 'x' });
    await tick();
    h.respondOk({ runId: 'r-1' }); // 缺 sessionId → 生成解析器拒绝
    await expect(pending).rejects.toMatchObject({ code: 'internal' });
  });

  it('transport.closed（连接未就绪）→ RunTaskCommandError 透传', async () => {
    // 无 send 注入 → invoke 立即 reject transport.closed（WsGateway.ts:364-368）
    const gateway = new WsGateway();
    const repo = new GatewayRunTaskRepository(gateway);
    await expect(repo.runTask({ prompt: 'x' })).rejects.toMatchObject({
      code: 'transport.closed',
    });
  });
});

describe('RUN_TASK_ERROR_TEXT / runTaskErrorTextOf（M6 §11.3 错误码映射）', () => {
  it('覆盖 M6 §11.3 主要错误码：session_busy / transport.closed / timeout / 参数类', () => {
    expect(RUN_TASK_ERROR_TEXT['cmd.session_busy']).toContain(
      '桌面正在处理该会话'
    );
    expect(RUN_TASK_ERROR_TEXT['transport.closed']).toContain('未连接');
    expect(RUN_TASK_ERROR_TEXT['cmd.timeout']).toContain('超时');
    expect(RUN_TASK_ERROR_TEXT['cmd.invalid']).toContain('参数');
    expect(RUN_TASK_ERROR_TEXT['cmd.denied']).toContain('授权');
    expect(RUN_TASK_ERROR_TEXT['cmd.not_found']).toContain('会话');
    expect(RUN_TASK_ERROR_TEXT['internal']).toContain('重试');
  });

  it('未知错误码 → 原文透传（诚实化不静默改写）', () => {
    expect(runTaskErrorTextOf('weird.new.code')).toBe(
      '发起失败（weird.new.code）'
    );
  });
});

describe('getQuickRunContext 单例语义', () => {
  it('接线未启动 → null（VM 投影未连接禁用态）', () => {
    expect(getQuickRunContext()).toBeNull();
  });

  it('观测接线装配后首取创建；重复调用复用同一单例', () => {
    ensureObservationWiring({
      gateway: new WsGateway({ send: () => {} }),
      factory: mockSocketFactory,
    });
    const first = getQuickRunContext();
    const second = getQuickRunContext();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(typeof first!.repository.runTask).toBe('function');
  });

  it('resetQuickRunContextForTest 清空单例（下次调用重新装配）', () => {
    ensureObservationWiring({
      gateway: new WsGateway({ send: () => {} }),
      factory: mockSocketFactory,
    });
    expect(getQuickRunContext()).not.toBeNull();
    resetQuickRunContextForTest();
    expect(getQuickRunContext()).not.toBeNull();
  });
});
