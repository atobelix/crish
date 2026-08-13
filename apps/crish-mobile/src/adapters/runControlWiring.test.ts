// runControlWiring 单测（R2-05 部分 6 run 控制发送面）：
// - GatewayRunControlRepository：真实 WsGateway（注入捕获 send）+ 手工 dispatch
//   响应帧（对齐 quickRunWiring.test 风格）；成功解析 / GatewayError 透传 /
//   解析失败兜底；
// - 发送帧校验：kind=remote.runControl / body.command=runControl / params 透传
//   （level/runId/sessionId）；cancelRun → remote.cancelRun；
// - 错误码 → 文案映射（RUN_CONTROL_ERROR_TEXT：transport.closed / cmd.timeout /
//   cmd.not_found / cmd.denied 等 M6 §11.3 码）；未知码原文透传；
// - getRunControlContext 单例语义：接线未启动 → null / 装配后复用 / 测试复位。
import { WsGateway } from '@/network/WsGateway';
import type { WsSocket } from '@/network/ReconnectingWsClient';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { authStore } from '@/domain/store/authStore';
import {
  resetObservationWiringForTest,
  ensureObservationWiring,
} from '@/adapters/wiring/observationWiring';
import {
  GatewayRunControlRepository,
  getRunControlContext,
  resetRunControlContextForTest,
  runControlErrorTextOf,
  RunControlCommandError,
  RUN_CONTROL_ERROR_TEXT,
} from './runControlWiring';

const T0 = 1_800_000_000_000;

interface SentFrame {
  kind: string;
  msgId: string;
  body: { command: string; params: Record<string, unknown> };
}

interface Harness {
  gateway: WsGateway;
  sent: SentFrame[];
  /** 以最近一帧 reqMsgId 回 result.<command>（M6 §6.1 CommandResult 信封） */
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
  const lastCommand = (): string => lastReq().body.command;
  return {
    gateway,
    sent,
    respondOk: (result) => {
      const req = lastReq();
      gateway.dispatchFrame({
        v: 1,
        kind: `result.${lastCommand()}`,
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
  resetRunControlContextForTest();
  resetObservationWiringForTest();
  authStore.setState({ host: '192.168.1.100', pairState: 'paired' });
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('GatewayRunControlRepository（C25 runControl 发送 + 解析）', () => {
  it('runControl 发送帧：kind=remote.runControl / command=runControl / params 原样透传（L2 cooperative_stop）', async () => {
    const h = makeHarness();
    const repo = new GatewayRunControlRepository(h.gateway);
    const pending = repo.runControl({
      level: 'cooperative_stop',
      runId: 'r-1',
      sessionId: 's-1',
    });
    await tick();
    const frame = h.sent[0]!;
    expect(frame.kind).toBe('remote.runControl');
    expect(frame.body.command).toBe('runControl');
    expect(frame.body.params).toEqual({
      level: 'cooperative_stop',
      runId: 'r-1',
      sessionId: 's-1',
    });
    h.respondOk({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('L0 continue / L3 force_cancel level 透传（分级语义由 UI 层编排）', async () => {
    const h = makeHarness();
    const repo = new GatewayRunControlRepository(h.gateway);
    const p1 = repo.runControl({
      level: 'continue',
      runId: 'r-1',
      sessionId: 's-1',
    });
    await tick();
    expect(h.sent[0]!.body.params.level).toBe('continue');
    h.respondOk({ ok: true });
    await p1;
    const p2 = repo.runControl({
      level: 'force_cancel',
      runId: 'r-1',
      sessionId: 's-1',
    });
    await tick();
    expect(h.sent[1]!.body.params.level).toBe('force_cancel');
    h.respondOk({ ok: true });
    await expect(p2).resolves.toEqual({ ok: true });
  });

  it('cancelRun 发送帧：kind=remote.cancelRun / command=cancelRun / params 透传', async () => {
    const h = makeHarness();
    const repo = new GatewayRunControlRepository(h.gateway);
    const pending = repo.cancelRun({ runId: 'r-1', reason: '用户远程取消' });
    await tick();
    const frame = h.sent[0]!;
    expect(frame.kind).toBe('remote.cancelRun');
    expect(frame.body.command).toBe('cancelRun');
    expect(frame.body.params).toEqual({ runId: 'r-1', reason: '用户远程取消' });
    h.respondOk({ ok: true, runId: 'r-1' });
    await expect(pending).resolves.toEqual({ ok: true, runId: 'r-1' });
  });

  it('错误帧 → RunControlCommandError（code/retryable 透传）', async () => {
    const h = makeHarness();
    const repo = new GatewayRunControlRepository(h.gateway);
    const pending = repo.runControl({
      level: 'cooperative_stop',
      runId: 'r-1',
      sessionId: 's-1',
    });
    await tick();
    h.respondError('cmd.not_found', false);
    await expect(pending).rejects.toMatchObject({
      code: 'cmd.not_found',
      retryable: false,
    });
    await expect(pending).rejects.toBeInstanceOf(RunControlCommandError);
  });

  it('响应解析失败（result 缺必填字段）→ internal 兜底', async () => {
    const h = makeHarness();
    const repo = new GatewayRunControlRepository(h.gateway);
    const pending = repo.runControl({
      level: 'cooperative_stop',
      runId: 'r-1',
      sessionId: 's-1',
    });
    await tick();
    h.respondOk({}); // 缺 ok → 生成解析器拒绝
    await expect(pending).rejects.toMatchObject({ code: 'internal' });
  });

  it('transport.closed（连接未就绪）→ RunControlCommandError 透传', async () => {
    // 无 send 注入 → invoke 立即 reject transport.closed（WsGateway.ts:364-368）
    const gateway = new WsGateway();
    const repo = new GatewayRunControlRepository(gateway);
    await expect(
      repo.runControl({ level: 'continue', runId: 'r-1', sessionId: 's-1' })
    ).rejects.toMatchObject({
      code: 'transport.closed',
    });
  });
});

describe('RUN_CONTROL_ERROR_TEXT / runControlErrorTextOf（M6 §11.3 错误码映射）', () => {
  it('覆盖 runControl 错误码面：not_found / invalid / denied / transport / timeout', () => {
    expect(RUN_CONTROL_ERROR_TEXT['cmd.not_found']).toContain('不存在');
    expect(RUN_CONTROL_ERROR_TEXT['cmd.invalid']).toContain('参数');
    expect(RUN_CONTROL_ERROR_TEXT['cmd.denied']).toContain('授权');
    expect(RUN_CONTROL_ERROR_TEXT['transport.closed']).toContain('未连接');
    expect(RUN_CONTROL_ERROR_TEXT['cmd.timeout']).toContain('超时');
    expect(RUN_CONTROL_ERROR_TEXT['internal']).toContain('重试');
  });

  it('未知错误码 → 原文透传（诚实化不静默改写）', () => {
    expect(runControlErrorTextOf('weird.new.code')).toBe(
      '控制操作失败（weird.new.code）'
    );
  });
});

describe('getRunControlContext 单例语义', () => {
  it('接线未启动 → null（VM 投影未连接禁用态）', () => {
    expect(getRunControlContext()).toBeNull();
  });

  it('观测接线装配后首取创建；重复调用复用同一单例', () => {
    ensureObservationWiring({
      gateway: new WsGateway({ send: () => {} }),
      factory: mockSocketFactory,
    });
    const first = getRunControlContext();
    const second = getRunControlContext();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(typeof first!.repository.runControl).toBe('function');
    expect(typeof first!.repository.cancelRun).toBe('function');
  });

  it('resetRunControlContextForTest 清空单例（下次调用重新装配）', () => {
    ensureObservationWiring({
      gateway: new WsGateway({ send: () => {} }),
      factory: mockSocketFactory,
    });
    expect(getRunControlContext()).not.toBeNull();
    resetRunControlContextForTest();
    expect(getRunControlContext()).not.toBeNull();
  });
});
