// approvalWiring 接线测试（R2-04 部分 4）：
// - 帧→store 动作：approval-requested（events.push / events.resume.page）→ upsert（幂等）；
//   approval-resolved（含 expired）→ handleResolved + outbox 收敛（重复 resolved 幂等忽略）；
// - 决策发送闭环：beginDecision → 入队 → flush → remote.approve/deny 帧（命令信封校验）→
//   回执 ok → outbox markSent + store markDecisionSent；失败退避重试（D6 §6.3）；
//   冲突错误（cmd.approval_mismatch）→ conflict 收敛不重试；
// - 离线入队：无接线时入队不发送，接线启动/重连（subscribe.ok）后补发；
// - 对账：resume 后 remote.listPendingApprovals 双向往收敛（引擎有补入 / 本地无移除 /
//   deciding 在途保留）；仓库失败宽容跳过。
// 测试风格对齐 filesRepository.test.ts：真实 WsGateway（注入捕获 send）+ 手工 dispatch 响应帧。
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { approvalStore } from '@/domain/store/approvalStore';
import type { ApprovalItem } from '@/domain/types/domain';
import type { PermissionRequest } from '@crish/shared-types';
import type { PendingApproval } from '@crish/shared-types';
import {
  ApprovalBridge,
  approvalOutboxCount,
  enqueueApprovalDecision,
  ensureApprovalWiring,
  gatewayListPendingApprovals,
  getApprovalWiring,
  mapReconcileApprovalItem,
  resetApprovalOutboxForTest,
  resetApprovalWiringForTest,
  type ListPendingApprovalsRepository,
} from './approvalWiring';

const T0 = 1_800_000_000_000;

function makeRequest(
  overrides: Partial<PermissionRequest> = {}
): PermissionRequest {
  return {
    id: 'approval-call-1',
    sessionId: 's-1',
    cwd: 'C:\\work',
    toolCallId: 'call-1',
    toolName: 'write_file',
    parameters: { path: 'a.ts' },
    summary: 'write a.ts',
    toolMetadata: {},
    ...overrides,
  };
}

function requestedEnvelope(
  toolCallId: string,
  overrides: Partial<PermissionRequest> = {}
): Record<string, unknown> {
  return {
    type: 'approval-requested',
    sessionId: 's-1',
    runId: 'run-42',
    timestamp: new Date(T0).toISOString(),
    request: makeRequest({ toolCallId, ...overrides }),
  };
}

function resolvedEnvelope(
  toolCallId: string,
  decision: 'approved' | 'denied' | 'expired'
): Record<string, unknown> {
  return {
    type: 'approval-resolved',
    sessionId: 's-1',
    runId: 'run-42',
    toolCallId,
    decision,
    timestamp: new Date(T0 + 100).toISOString(),
  };
}

function makePending(
  toolCallId: string,
  overrides: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    requestId: `req-${toolCallId}`,
    toolCallId,
    toolName: 'write_file',
    arbiter: 'user',
    requestedAt: T0,
    expiresAt: T0 + 120_000,
    dangerLevel: 1,
    ...overrides,
  };
}

interface SentFrame {
  kind: string;
  msgId: string;
  body: { command: string; params: Record<string, unknown> };
}

interface Harness {
  gateway: WsGateway;
  bridge: ApprovalBridge;
  sent: SentFrame[];
  /** 以最近一帧 reqMsgId 回 result.<kind>（M6 §6.1 CommandResult 信封） */
  respondOk: (kind: string, result: unknown) => void;
  /** 以最近一帧 reqMsgId 回错误帧（D3 §6.2 错误码透传） */
  respondError: (code: string, retryable?: boolean) => void;
  /** 推送审批事件帧（events.push） */
  pushEvent: (event: Record<string, unknown>) => void;
}

let t = T0;
let pushSeq = 0;
const bridges: ApprovalBridge[] = [];

function makeHarness(repo?: ListPendingApprovalsRepository): Harness {
  const sent: SentFrame[] = [];
  const gateway = new WsGateway({
    send: (raw) => {
      sent.push(JSON.parse(raw) as SentFrame);
    },
  });
  const bridge = new ApprovalBridge({
    gateway,
    now: () => t,
    ...(repo ? { listPendingApprovals: repo } : {}),
  });
  bridge.attach();
  bridges.push(bridge);
  const lastReq = (): SentFrame => sent[sent.length - 1]!;
  const harness: Harness = {
    gateway,
    bridge,
    sent,
    respondOk: (kind, result) => {
      const req = lastReq();
      gateway.dispatchFrame({
        v: 1,
        kind: `result.${kind}`,
        msgId: `resp-${sent.length}`,
        ts: t,
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
        ts: t,
        from: 'desktop',
        to: 'mobile',
        body: { reqMsgId: req.msgId, code, message: `err:${code}`, retryable },
      } as InboundEnvelope);
    },
    pushEvent: (event) => {
      pushSeq += 1;
      gateway.dispatchFrame({
        v: 1,
        kind: 'events.push',
        msgId: `push-${pushSeq}`,
        ts: t,
        from: 'desktop',
        to: 'mobile',
        body: { event, sessionId: 's-1', preview: false },
      } as InboundEnvelope);
    },
  };
  return harness;
}

function resetStores(): void {
  approvalStore.setState({
    pending: [],
    decisionBusy: {},
    outboxCount: 0,
    history: [],
    lastReconcileAt: null,
  });
  resetApprovalOutboxForTest();
}

/** VM 决策链（beginDecision → 入队 → markQueued），返回当前条目 */
function decide(
  toolCallId: string,
  decision: 'approved' | 'denied'
): ApprovalItem {
  const store = approvalStore.getState();
  const ok = store.beginDecision(toolCallId);
  expect(ok).toBe(true);
  const item = store.pending.find((p) => p.request.toolCallId === toolCallId)!;
  const outcome = enqueueApprovalDecision(item, decision);
  expect(outcome).not.toBe('full');
  store.markQueued(toolCallId);
  return item;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  t = T0;
  pushSeq = 0;
  resetStores();
  resetApprovalWiringForTest();
});

afterEach(() => {
  for (const bridge of bridges) bridge.detach();
  bridges.length = 0;
  resetApprovalWiringForTest();
  resetApprovalOutboxForTest();
});

describe('approvalWiring：帧 → store 动作', () => {
  it('approval-requested（events.push）→ upsert：runId 取信封 + 本地倒计时 120s（F2 §2.4/§8.3）', () => {
    const { pushEvent } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(1);
    const item = state.pending[0]!;
    expect(item.request.toolCallId).toBe('call-1');
    expect(item.runId).toBe('run-42');
    expect(item.receivedAtMs).toBe(t);
    expect(item.expiresAt).toBe(t + 120_000);
    expect(item.status).toBe('pending');
    expect(item.arbiter).toBe('user');
    expect(item.dangerLevel).toBe(1);
    expect(state.outboxCount).toBe(0);
  });

  it('事件双发幂等（E2E-10）：同 toolCallId 重复 requested 不重复入队、不重置本地倒计时', () => {
    const { pushEvent } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    t += 30_000; // 30 秒后双发（收口流）
    pushEvent(requestedEnvelope('call-1'));

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.receivedAtMs).toBe(T0);
    expect(state.pending[0]!.expiresAt).toBe(T0 + 120_000);
  });

  it('畸形信封宽容跳过（M6 §10.5 语义）：request 缺字段不崩溃、不产生待办', () => {
    const { pushEvent } = makeHarness();
    pushEvent({
      type: 'approval-requested',
      sessionId: 's-1',
      timestamp: new Date(t).toISOString(),
      request: { id: 'broken' }, // 缺 toolCallId 等必填字段
    });
    pushEvent({ type: 'unknown-type-xyz', sessionId: 's-1' });

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(0);
  });

  it('approval-resolved → handleResolved：待办移除 + 历史入档（F2 §7）', () => {
    const { pushEvent } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    pushEvent(resolvedEnvelope('call-1', 'approved'));

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({
      toolCallId: 'call-1',
      decision: 'approved',
      channel: 'desktop', // 本机未发送过（decisionSentAtMs 未设）→ 其他设备处理
    });
  });

  it('approval-resolved 重复到达幂等忽略（F2 §11.2）：历史不重复入档', () => {
    const { pushEvent } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    pushEvent(resolvedEnvelope('call-1', 'denied'));
    pushEvent(resolvedEnvelope('call-1', 'denied'));

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.history).toHaveLength(1);
  });

  it('approval-resolved(expired) 决策帧 → 移除 + 历史渠道 auto（F2 §8.3 / R1）', () => {
    const { pushEvent } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    pushEvent(resolvedEnvelope('call-1', 'expired'));

    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.history[0]?.decision).toBe('expired');
    expect(state.history[0]?.channel).toBe('auto');
  });

  it('events.resume.page 重放：补拉流中 requested/resolved 一并收敛（通道 B，F2 §11.1）', async () => {
    const { gateway } = makeHarness();
    pushSeq += 1;
    gateway.dispatchFrame({
      v: 1,
      kind: 'events.resume.page',
      msgId: `resume-${pushSeq}`,
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: {
        sessionId: 's-1',
        nextAfterSequence: 6,
        hasMore: false,
        events: [
          requestedEnvelope('call-1'),
          resolvedEnvelope('call-1', 'approved'),
          requestedEnvelope('call-2'),
        ],
      },
    } as InboundEnvelope);

    await tick();
    const state = approvalStore.getState();
    expect(state.pending).toHaveLength(1); // call-1 被同页 resolved 收口，仅剩 call-2
    expect(state.pending[0]!.request.toolCallId).toBe('call-2');
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.toolCallId).toBe('call-1');
  });
});

describe('approvalWiring：决策发送闭环（outbox 重放）', () => {
  it('成功回执：flush → remote.approve 帧 → ok → outbox sent + store markDecisionSent（F2 §11.3）', async () => {
    const { pushEvent, bridge, sent, respondOk } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'approved');

    const p = bridge.flush();
    // 命令信封（M6 §4.2.1：remote.approve / command=approve / params 不含 decision 字段）
    expect(sent[sent.length - 1]!.kind).toBe('remote.approve');
    expect(sent[sent.length - 1]!.body.command).toBe('approve');
    expect(sent[sent.length - 1]!.body.params).toEqual({
      toolCallId: 'call-1',
      runId: 'run-42',
    });
    respondOk('approve', {
      ok: true,
      toolCallId: 'call-1',
      decision: 'approved',
    });
    await p;

    const state = approvalStore.getState();
    expect(approvalOutboxCount()).toBe(0); // markSent：sent 不计角标，等待事件确认
    expect(state.pending).toHaveLength(0); // markDecisionSent：命令回执先到者收敛
    expect(state.history[0]).toMatchObject({
      toolCallId: 'call-1',
      decision: 'approved',
      channel: 'mobile', // 本机发送（decisionSentAtMs 已设）
    });
    expect(state.outboxCount).toBe(0);
  });

  it('两阶段确认（D6 §6.3）：approval-resolved 事件到达 → outbox 出队收口', async () => {
    const { pushEvent, bridge, respondOk } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'approved');
    const p = bridge.flush();
    respondOk('approve', {
      ok: true,
      toolCallId: 'call-1',
      decision: 'approved',
    });
    await p;
    expect(approvalOutboxCount()).toBe(0);

    // 事件确认：队列元素彻底清除（confirmResolved），历史保持单条（幂等）
    pushEvent(resolvedEnvelope('call-1', 'approved'));
    expect(approvalOutboxCount()).toBe(0);
    expect(approvalStore.getState().history).toHaveLength(1);
  });

  it('拒绝决策：remote.deny 帧携带 reason（F2 §2.3 deny 可带理由）', async () => {
    const { pushEvent, bridge, sent, respondOk } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'denied');
    // 覆盖决策附加理由（D6 §6.2 同键覆盖）
    const item = approvalStore
      .getState()
      .pending.find((p) => p.request.toolCallId === 'call-1')!;
    enqueueApprovalDecision(item, 'denied', '风险过高');
    approvalStore.getState().markQueued('call-1');

    const p = bridge.flush();
    expect(sent[sent.length - 1]!.kind).toBe('remote.deny');
    expect(sent[sent.length - 1]!.body.command).toBe('deny');
    expect(sent[sent.length - 1]!.body.params).toEqual({
      toolCallId: 'call-1',
      runId: 'run-42',
      reason: '风险过高',
    });
    respondOk('deny', { ok: true, toolCallId: 'call-1', decision: 'denied' });
    await p;
    expect(approvalStore.getState().history[0]?.decision).toBe('denied');
  });

  it('网络失败退避重试：cmd.timeout → failed + nextRetryAtMs；退避到期重发成功（D6 §6.3）', async () => {
    const { pushEvent, bridge, sent, respondOk, respondError } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'approved');

    // 第一次发送：网络超时（retryable）→ 退避 1s（attempts=1）
    const p1 = bridge.flush();
    expect(sent).toHaveLength(1);
    respondError('cmd.timeout', true);
    await p1;
    expect(approvalOutboxCount()).toBe(1); // failed 仍计角标（待发送）
    expect(approvalStore.getState().pending).toHaveLength(1); // store 条目保持 queued（重试中）

    // 退避到期（+1s）后重放 → 成功
    t += 1_000;
    const p2 = bridge.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.kind).toBe('remote.approve');
    respondOk('approve', {
      ok: true,
      toolCallId: 'call-1',
      decision: 'approved',
    });
    await p2;

    expect(approvalOutboxCount()).toBe(0);
    expect(approvalStore.getState().pending).toHaveLength(0);
    expect(approvalStore.getState().history[0]?.channel).toBe('mobile');
  });

  it('冲突错误（cmd.approval_mismatch）：不可重试 → 队列收敛 + 条目 conflict（F2 §11.2 / D6 §6.3）', async () => {
    const { pushEvent, bridge, respondError } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'approved');

    const p = bridge.flush();
    respondError('cmd.approval_mismatch', false);
    await p;

    const state = approvalStore.getState();
    expect(approvalOutboxCount()).toBe(0); // confirmResolved：出队不再重试
    expect(state.pending[0]?.status).toBe('conflict');
    expect(state.pending[0]?.decisionBusy).toBe(false);
  });

  it('单飞防重入：重放期间二次 flush 不重复发送（M5 §4.6.1）', async () => {
    const { pushEvent, bridge, sent, respondOk } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'approved');

    const p1 = bridge.flush();
    const p2 = bridge.flush(); // 在途重放 → 直接返回
    expect(sent).toHaveLength(1);
    await p2;
    expect(sent).toHaveLength(1);
    // 回执后本次重放收敛，仍无第二次发送
    respondOk('approve', {
      ok: true,
      toolCallId: 'call-1',
      decision: 'approved',
    });
    await p1;
    expect(sent).toHaveLength(1);
    expect(approvalOutboxCount()).toBe(0);
  });
});

describe('approvalWiring：离线入队与重连补发', () => {
  it('无接线时入队不发送（离线决策，R2-ux §3.5）；接线启动 attach 扫描补发', async () => {
    const store = approvalStore.getState();
    store.upsertPending({
      request: makeRequest(),
      runId: null,
      arbiter: 'user',
      dangerLevel: 1,
      receivedAtMs: t,
      expiresAt: t + 120_000,
      status: 'pending',
      decisionStatus: 'idle',
      decisionBusy: false,
    });
    decide('call-1', 'approved');
    expect(approvalOutboxCount()).toBe(1); // 已入队

    // 无接线：不发任何帧
    const { sent, respondOk } = makeHarness(); // attach 即触发恢复扫描
    expect(sent[sent.length - 1]!.kind).toBe('remote.approve');
    respondOk('approve', {
      ok: true,
      toolCallId: 'call-1',
      decision: 'approved',
    });
    await tick();

    expect(approvalOutboxCount()).toBe(0);
    expect(approvalStore.getState().pending).toHaveLength(0);
  });

  it('重连补发：events.subscribe.ok（连接就绪）→ flush 重放失败条目 + 对账触发', async () => {
    const { pushEvent, gateway, bridge, sent, respondError } = makeHarness();
    pushEvent(requestedEnvelope('call-1'));
    decide('call-1', 'approved');

    // 断网期间发送失败（transport.closed）
    const p = bridge.flush();
    respondError('transport.closed', true);
    await p;
    expect(approvalOutboxCount()).toBe(1);

    // 网络恢复（重连）→ subscribe.ok → 补发 + 对账（C13 帧同时发出）
    t += 1_000;
    pushSeq += 1;
    gateway.dispatchFrame({
      v: 1,
      kind: 'events.subscribe.ok',
      msgId: `subok-${pushSeq}`,
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: {},
    } as InboundEnvelope);
    const approveFrames = sent.filter((f) => f.kind === 'remote.approve');
    const approveFrame = approveFrames[approveFrames.length - 1]!; // 最近一次重发（非首败帧）
    expect(approveFrame).toBeDefined();
    gateway.dispatchFrame({
      v: 1,
      kind: 'result.approve',
      msgId: 'resp-reconnect-approve',
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: {
        reqMsgId: approveFrame.msgId,
        ok: true,
        result: { ok: true, toolCallId: 'call-1', decision: 'approved' },
      },
    } as InboundEnvelope);
    // 对账 C13 响应（空待办；引擎命令占位，宽容处理）
    const lpaFrame = sent.find(
      (f) => f.kind === 'remote.listPendingApprovals'
    )!;
    gateway.dispatchFrame({
      v: 1,
      kind: 'result.listPendingApprovals',
      msgId: 'resp-reconnect-lpa',
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: {
        reqMsgId: lpaFrame.msgId,
        ok: true,
        result: { approvals: [] },
      },
    } as InboundEnvelope);
    await tick();

    expect(approvalOutboxCount()).toBe(0);
    expect(approvalStore.getState().pending).toHaveLength(0);
    expect(approvalStore.getState().lastReconcileAt).toBe(t);
  });
});

describe('approvalWiring：对账（resume 后 pending 同步，F2 §4.1）', () => {
  it('subscribe.ok → remote.listPendingApprovals：引擎有补入（引擎时间戳）+ 本地无移除 + deciding 保留', async () => {
    const repo: ListPendingApprovalsRepository = jest.fn(async () => ({
      approvals: [
        makePending('engine-1', { dangerLevel: 2, summary: '高危写入' }),
      ],
      latestSequence: 9,
    }));
    const { gateway } = makeHarness(repo);
    // 本地种子：local-only（待移除）+ in-flight（deciding，保留）
    const store = approvalStore.getState();
    store.upsertPending({
      request: makeRequest({ toolCallId: 'local-only' }),
      runId: null,
      arbiter: 'user',
      dangerLevel: 1,
      receivedAtMs: t,
      expiresAt: t + 120_000,
      status: 'pending',
      decisionStatus: 'idle',
      decisionBusy: false,
    });
    store.upsertPending({
      request: makeRequest({ toolCallId: 'in-flight' }),
      runId: null,
      arbiter: 'user',
      dangerLevel: 1,
      receivedAtMs: t,
      expiresAt: t + 120_000,
      status: 'deciding',
      decisionStatus: 'sending',
      decisionBusy: true,
    });

    // 重连就绪 → 对账触发
    pushSeq += 1;
    gateway.dispatchFrame({
      v: 1,
      kind: 'events.subscribe.ok',
      msgId: `subok-${pushSeq}`,
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: {},
    } as InboundEnvelope);
    await tick();
    expect(repo).toHaveBeenCalledTimes(1);

    const pending = approvalStore.getState().pending;
    expect(pending).toHaveLength(2);
    const engineItem = pending.find(
      (p) => p.request.toolCallId === 'engine-1'
    )!;
    expect(engineItem.dangerLevel).toBe(2); // 桌面推导不重算（M6 §4.2.2）
    expect(engineItem.receivedAtMs).toBe(T0); // 对账取引擎时间戳（F2 §3.3）
    expect(engineItem.request.summary).toBe('高危写入');
    expect(
      pending.find((p) => p.request.toolCallId === 'local-only')
    ).toBeUndefined();
    expect(
      pending.find((p) => p.request.toolCallId === 'in-flight')
    ).toBeDefined();
    expect(approvalStore.getState().lastReconcileAt).toBe(t);
  });

  it('本地已有条目不被投影覆盖（实时事件富数据优先；对账仅补缺失）', async () => {
    const repo: ListPendingApprovalsRepository = jest.fn(async () => ({
      approvals: [makePending('call-1')],
    }));
    const { pushEvent, bridge } = makeHarness(repo);
    pushEvent(requestedEnvelope('call-1')); // 实时事件带全量参数
    const before = approvalStore.getState().pending[0]!;

    await bridge.reconcile();
    const after = approvalStore.getState().pending[0]!;
    expect(after.request.parameters).toEqual({ path: 'a.ts' });
    expect(after.request.parameters).not.toEqual({}); // 未被空参数投影覆盖
    expect(after.receivedAtMs).toBe(before.receivedAtMs);
  });

  it('对账仓库失败宽容跳过（引擎命令未注册/网络错误 → 留痕不阻塞，事件流兜底）', async () => {
    const repo: ListPendingApprovalsRepository = jest.fn(async () => {
      throw new Error('cmd.not_found: mobile_list_pending_approvals 未注册');
    });
    const { pushEvent, bridge } = makeHarness(repo);
    pushEvent(requestedEnvelope('call-1'));

    await expect(bridge.reconcile()).resolves.toBeUndefined();
    expect(approvalStore.getState().pending).toHaveLength(1); // 本地不变
  });

  it('gatewayListPendingApprovals：经网关 invoke C13 + 生成面解析（对账响应契约）', async () => {
    const sent: SentFrame[] = [];
    const gateway = new WsGateway({
      send: (raw) => {
        sent.push(JSON.parse(raw) as SentFrame);
      },
    });
    const promise = gatewayListPendingApprovals(gateway);
    expect(sent[0]!.kind).toBe('remote.listPendingApprovals');
    expect(sent[0]!.body.command).toBe('listPendingApprovals');
    expect(sent[0]!.body.params).toEqual({});
    const req = sent[0]!;
    gateway.dispatchFrame({
      v: 1,
      kind: 'result.listPendingApprovals',
      msgId: 'resp-lpa',
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: { reqMsgId: req.msgId, ok: true, result: { approvals: [] } },
    } as InboundEnvelope);
    const res = await promise;
    expect(res.approvals).toEqual([]);
  });

  it('mapReconcileApprovalItem：arbiter/dangerLevel 归一 + 缺省兜底（F2 §3.3 对账口径）', () => {
    const item = mapReconcileApprovalItem(
      makePending('c9', {
        arbiter: 'main-agent',
        dangerLevel: 2,
        requesterRunId: 'sub-3',
        reason: '需要扩展写入范围',
        summary: '写入 README',
        sessionId: 's-9',
        cwd: 'C:\\w',
        runId: 'r-1',
      }),
      t
    );
    expect(item.arbiter).toBe('main-agent');
    expect(item.dangerLevel).toBe(2);
    expect(item.requesterRunId).toBe('sub-3');
    expect(item.reason).toBe('需要扩展写入范围');
    expect(item.request.sessionId).toBe('s-9');
    expect(item.request.parameters).toEqual({});
    expect(item.status).toBe('pending');
    expect(item.decisionStatus).toBe('idle');

    // 缺省兜底：summary → toolName；arbiter/dangerLevel 非规范值归一
    const bare = mapReconcileApprovalItem(makePending('c10'), t);
    expect(bare.request.summary).toBe('write_file');
    expect(bare.request.sessionId).toBe('');
    expect(bare.arbiter).toBe('user');
    expect(bare.dangerLevel).toBe(1);
  });
});

describe('approvalWiring：装配单例（ensureApprovalWiring）', () => {
  it('观测面未装配/未传网关 → 不启动返回 null', () => {
    expect(ensureApprovalWiring()).toBeNull();
  });

  it('显式网关 → 单例启动；入队自动触发重放（在线决策）', async () => {
    const sent: SentFrame[] = [];
    const gateway = new WsGateway({
      send: (raw) => {
        sent.push(JSON.parse(raw) as SentFrame);
      },
    });
    const wiring = ensureApprovalWiring({ gateway });
    expect(wiring).not.toBeNull();
    expect(getApprovalWiring()).toBe(wiring);

    const store = approvalStore.getState();
    store.upsertPending({
      request: makeRequest(),
      runId: 'run-42',
      arbiter: 'user',
      dangerLevel: 1,
      receivedAtMs: t,
      expiresAt: t + 120_000,
      status: 'pending',
      decisionStatus: 'idle',
      decisionBusy: false,
    });
    decide('call-1', 'approved');

    // 入队即重放（接线就绪）
    await tick();
    expect(sent[sent.length - 1]!.kind).toBe('remote.approve');
    const req = sent[sent.length - 1]!;
    gateway.dispatchFrame({
      v: 1,
      kind: 'result.approve',
      msgId: 'resp-single',
      ts: t,
      from: 'desktop',
      to: 'mobile',
      body: {
        reqMsgId: req.msgId,
        ok: true,
        result: { ok: true, toolCallId: 'call-1', decision: 'approved' },
      },
    } as InboundEnvelope);
    await tick();

    expect(approvalOutboxCount()).toBe(0);
    expect(approvalStore.getState().pending).toHaveLength(0);
  });
});
