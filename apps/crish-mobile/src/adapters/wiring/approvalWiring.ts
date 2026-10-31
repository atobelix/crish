// 审批域接线（R2-04 部分 4）：设备帧 → approvalStore 动作 + 决策发送闭环（outbox 重放）
// - 帧消费：events.push / events.resume.page 中 approval-requested → upsert
//   （mapApprovalRequested，runId 取信封，F2 §2.4）；approval-resolved（含 expired）
//   → handleResolved + outbox confirmResolved（幂等收敛：重复 resolved 忽略，D6 §6.3）；
// - 决策发送闭环（F2 §8.2 / M5 §4.6 / D6 §6.2-6.3）：VM 决策 → enqueueApprovalDecision 入队
//   → collectReplayable FIFO 单飞重放 → WsGateway.invoke remote.approve / remote.deny
//   → 命令回执 ok：outbox markSent（等待 approval-resolved 事件确认出队，两阶段确认）
//     + store markDecisionSent（与事件先到者，幂等，F2 §11.3）；
//   → 网络/超时失败：outbox recordFailure + 指数退避 1s→4s→16s→60s（D6 §6.3），
//     到点经 retryTimer 重放；冲突/过期错误（cmd.approval_mismatch / approval.expired 等）
//     ：不可重试（D6 §6.3 不自动重试 conflict/stale）→ markDecisionConflict + 队列收敛；
//   → 断线期间入队：无连接时条目保持 pending，重连后 events.subscribe.ok 触发补发
//     （R2-ux §3.5 离线 outbox 场景）；
// - 重连对账（F2 §4.1 / D6 §6.5）：每次连接就绪（events.subscribe.ok，冷启动/重连同源）
//   → flush + reconcile（remote.listPendingApprovals 对账命令，repository 接口注入，
//   引擎未注册时宽容跳过留痕）；对账语义：引擎有本地无 → 补入（receivedAtMs 取引擎
//   时间戳，F2 §3.3）；本地有引擎无 → 对账确认移除（deciding 在途条目保留，命令由
//   桌面裁决不主动丢弃，D6 §6.5）；
// - 注入模式（observationWiring 同风格）：gateway 实例 + now 时钟 + listPendingApprovals
//   repository 构造注入，测试 mock；单例装配见 ensureApprovalWiring。
//
// 职责边界：outbox 状态持有从 useApprovalDetailVm 迁移至本接线层（原 VM 注释「届时本态
// 移除」的落点）；持久化经 OutboxPersistAdapter 落 SQLite approval_queue
// （DB 不可用时降级内存态，见 adapters/persistence/outboxPersist.ts）。
import { WsGateway, GatewayError } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { approvalStore } from '@/domain/store/approvalStore';
import {
  mapApprovalRequested,
  mapApprovalResolved,
} from '@/domain/store/approvalMappers';
import type { EventEnvelopeFrame } from '@/domain/store/eventReducers';
import { readRecord, readString } from '@/domain/store/eventReducers';
import { extractEnvelope } from '@/domain/store/eventMappers';
import type { ApprovalItem } from '@/domain/types/domain';
import {
  collectReplayable,
  confirmResolved,
  createOutboxState,
  enqueueDecision,
  hydrateOutbox,
  markSent,
  recordFailure,
  snapshotOutbox,
  type EnqueueInput,
  type OutboxItem,
  type OutboxState,
} from '@/domain/data/outbox';
import {
  createDefaultOutboxPersist,
  type OutboxPersistAdapter,
} from '@/adapters/persistence/outboxPersist';
import { getSqlDriver } from '@/adapters/persistence/persistBootstrap';
import { ensureDatabaseReady } from '@/db/dbBootstrap';
import { SqlApprovalQueueDao } from '@/db/dao';
import { parseEngineEvent } from '@crish/shared-types';
import type { PermissionRequest } from '@crish/shared-types';
import { parseListPendingApprovalsResult } from '@crish/shared-types';
import type {
  ApproveResult,
  CommandRequest,
  ListPendingApprovalsResult,
  PendingApproval,
} from '@crish/shared-types';
import { getObservationWiring, onObservationOpen } from './observationWiring';

// ── 决策冲突/终局错误码（不可重试；D6 §6.3 不自动重试 conflict/stale） ────────
// - cmd.approval_mismatch：toolCallId 不在待审批集合（I-02 语义，F2 §11.2 冲突表）；
// - approval.expired / approval.rejected：引擎错误域（error.rs:150-152）；
// - cmd.not_found / cmd.denied / cmd.invalid：目标不存在 / 命令未授权 / 参数非法。
const PERMANENT_DECISION_ERROR_CODES: ReadonlySet<string> = new Set([
  'cmd.approval_mismatch',
  'cmd.not_found',
  'cmd.denied',
  'cmd.invalid',
  'approval.expired',
  'approval.rejected',
]);

// ── outbox 内存态（M5 §4.6：接线层持有；VM 经 enqueueApprovalDecision 共用） ──

let outboxState: OutboxState = createOutboxState();

/** 未完成 outbox 条数（pending/failed 计入角标，sent 等待确认不计，R2UX-04-05） */
export function approvalOutboxCount(): number {
  return outboxState.items.filter((i) => i.status !== 'sent').length;
}

/** 测试隔离：清空内存 outbox 队列（仅测试调用） */
export function resetApprovalOutboxForTest(): void {
  outboxState = createOutboxState();
}

/** 审批 store 角标同步（outbox 三态任何变化后调用，M5 §3.1 setOutboxCount） */
function syncOutboxCount(): void {
  approvalStore.getState().setOutboxCount(approvalOutboxCount());
}

// ── 命令构造（C11/C12/C13，M6 §4.2；协议注册表锁定的 kind/command 双射） ──────

export interface ApprovalCommandRequest {
  kind: 'remote.approve' | 'remote.deny';
  body: CommandRequest;
}

/** C11 remote.approve：decision 恒 approved（跨端参数不提供 decision 字段，M6 §4.2.1） */
export function buildApproveRequest(
  toolCallId: string,
  runId?: string
): ApprovalCommandRequest {
  return {
    kind: 'remote.approve',
    body: {
      command: 'approve',
      params: {
        toolCallId,
        ...(runId !== undefined ? { runId } : {}),
      },
    },
  };
}

/** C12 remote.deny：reason ≤ 256 字符（F2 §2.3，缺省由桌面补 "user denied"） */
export function buildDenyRequest(
  toolCallId: string,
  reason?: string,
  runId?: string
): ApprovalCommandRequest {
  return {
    kind: 'remote.deny',
    body: {
      command: 'deny',
      params: {
        toolCallId,
        ...(runId !== undefined ? { runId } : {}),
        ...(reason !== undefined ? { reason } : {}),
      },
    },
  };
}

/** C13 remote.listPendingApprovals：启动对账（参数恒空，可选 afterSequence 增量） */
function buildListPendingApprovalsRequest(): {
  kind: 'remote.listPendingApprovals';
  body: CommandRequest;
} {
  return {
    kind: 'remote.listPendingApprovals',
    body: { command: 'listPendingApprovals', params: {} },
  };
}

// ── 对账仓库（F2 §12.2 mobile_list_pending_approvals 占位命令） ───────────────

/** 待审批对账仓库（注入 mock 面；生产缺省 = 网关命令实现，引擎未注册时错误留痕） */
export type ListPendingApprovalsRepository = (
  gateway: WsGateway
) => Promise<ListPendingApprovalsResult>;

/** 网关实现：invoke C13 → 生成面解析（M5 §1.3 不手写第二套校验） */
export async function gatewayListPendingApprovals(
  gateway: WsGateway
): Promise<ListPendingApprovalsResult> {
  const raw: unknown = await gateway.invoke(
    'remote.listPendingApprovals',
    buildListPendingApprovalsRequest().body
  );
  const parsed = parseListPendingApprovalsResult(raw);
  if (!parsed.ok) {
    throw new Error(`审批对账响应解析失败：${parsed.error}`);
  }
  return parsed.data;
}

// ── 对账条目映射（投影 → ApprovalItem；本地附加按 F2 §3.3 口径） ─────────────

/**
 * 对账投影 → ApprovalItem（F2 §4.1 启动对账补入）：
 * - parameters 全量不下发（D6 §7.2 隐私红线），投影只有摘要 → 构造空参数占位
 *   （决策不依赖参数全量，M6 §4.2.2；参数详情由实时事件路径补全）；
 * - receivedAtMs/expiresAt 取引擎时间戳（F2 §3.3：对账时为引擎时间戳）；
 * - dangerLevel 以桌面推导为准（M6 §4.2.2 移动端不重算）。
 */
export function mapReconcileApprovalItem(
  pa: PendingApproval,
  _nowMs: number
): ApprovalItem {
  const request: PermissionRequest = {
    id: pa.requestId,
    sessionId: pa.sessionId ?? '',
    cwd: pa.cwd ?? '',
    toolCallId: pa.toolCallId,
    toolName: pa.toolName,
    parameters: {},
    summary: pa.summary ?? pa.toolName,
    toolMetadata: {},
  };
  return {
    request,
    runId: pa.runId ?? null,
    arbiter: pa.arbiter === 'main-agent' ? 'main-agent' : 'user',
    dangerLevel: pa.dangerLevel === 2 ? 2 : 1,
    receivedAtMs: pa.requestedAt,
    expiresAt: pa.expiresAt,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...(pa.requesterRunId !== undefined
      ? { requesterRunId: pa.requesterRunId }
      : {}),
    ...(pa.reason !== undefined ? { reason: pa.reason } : {}),
  };
}

// ── 接线桥（FeedBridge 同构：attach/detach + 帧消费 + 对账驱动） ─────────────

export interface ApprovalWiringOptions {
  /** 网关实例（生产 = ReconnectingWsClient.gateway；测试注入 mock） */
  gateway: WsGateway;
  /** 时钟注入（缺省 Date.now；测试可固定/推进） */
  now?: () => number;
  /** 待审批对账仓库（缺省 = gatewayListPendingApprovals 网关实现） */
  listPendingApprovals?: ListPendingApprovalsRepository;
  /** 持久化适配器（缺省 = SecureStoreOutboxAdapter，抗进程强杀） */
  persistAdapter?: OutboxPersistAdapter;
}

export class ApprovalBridge {
  private readonly gateway: WsGateway;
  private readonly nowFn: () => number;
  private readonly listPendingRepo: ListPendingApprovalsRepository;
  readonly persistAdapter?: OutboxPersistAdapter;
  private unsubscribers: Array<() => void> = [];
  /** outbox 重放单飞（M5 §4.6.1：禁止并发重放） */
  private replayInflight = false;
  /** 退避重试定时器（到点自动重放 failed 条目，D6 §6.3 事件驱动 + 定时兜底） */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ApprovalWiringOptions) {
    this.gateway = opts.gateway;
    this.nowFn = opts.now ?? (() => Date.now());
    this.listPendingRepo =
      opts.listPendingApprovals ?? gatewayListPendingApprovals;
    this.persistAdapter = opts.persistAdapter;
  }

  private syncAndPersist(): void {
    syncOutboxCount();
    if (!this.persistAdapter) return;
    // 持久化失败不得静默：离线决策丢失是用户可见的数据事故，必须留下
    // 可观测错误（console.error + 可选 onError 上报），而不是 void 吞掉。
    void this.persistAdapter.save(snapshotOutbox(outboxState)).catch((e) => {
      console.error('[approvalWiring] outbox 持久化失败，离线决策可能丢失:', e);
    });
  }

  /** 从 SQLite approval_queue 水合恢复 Outbox 队列 */
  async hydrate(): Promise<void> {
    if (!this.persistAdapter) return;
    try {
      const persisted = await this.persistAdapter.load();
      if (persisted.length > 0) {
        outboxState = hydrateOutbox(persisted, this.nowFn());
        syncOutboxCount();
      }
    } catch (e) {
      console.error('[approvalWiring] outbox 水合失败:', e);
    }
  }

  /** 订阅审批设备帧 + 连接就绪信号（幂等：重复 attach 先 detach） */
  attach(): void {
    this.detach();
    this.unsubscribers = [
      this.gateway.on('events.push', (frame) => this.handleFrame(frame)),
      this.gateway.on('events.resume.page', (frame) =>
        this.handleResumePage(frame)
      ),
      // 连接就绪（冷启动/重连都会触发）：outbox 重放 + 待办对账（F2 §4.1 / D6 §6.5）
      this.gateway.on('events.subscribe.ok', () => this.onSyncReady()),
    ];
    // 接线装配即扫描一次：应用重启/迟到装配时恢复未发送决策（outbox 恢复扫描）
    void this.flushOnce();
  }

  /** 退订全部审批帧（页面/应用卸载时调用，M4 §8.2 退场即退订） */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 触发 outbox 重放（fire-and-forget；入队/重连后调用；单飞防重入） */
  flush(): Promise<void> {
    return this.flushOnce();
  }

  /** 待办对账（remote.listPendingApprovals；失败宽容跳过，事件流兜底） */
  async reconcile(): Promise<void> {
    try {
      const result = await this.listPendingRepo(this.gateway);
      this.applyReconcile(result);
    } catch (err) {
      console.warn(
        `[wiring] 审批对账失败（跳过，事件流/下次重连兜底）：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── 帧消费 ──────────────────────────────────────────────────────────────

  /** 实时帧（events.push）：body.event 信封 → 审批动作 */
  private handleFrame(frame: InboundEnvelope): void {
    const body = readRecord(frame.body);
    const envelope = extractEnvelope(
      body?.['event'],
      readString(body, 'sessionId')
    );
    if (!envelope) return; // 非事件/畸形帧宽容跳过（M6 §10.5 语义，不打断连接）
    this.consumeEnvelope(envelope);
  }

  /** 续传页（events.resume.page）：补拉流中的审批事件重放（离线期间错过的
   *  requested/resolved 收口，三通道收敛之通道 B，F2 §11.1） */
  private handleResumePage(frame: InboundEnvelope): void {
    const body = readRecord(frame.body);
    const events = body?.['events'];
    if (!Array.isArray(events)) return;
    const fallbackSessionId = readString(body, 'sessionId');
    for (const raw of events) {
      const envelope = extractEnvelope(raw, fallbackSessionId);
      if (envelope) this.consumeEnvelope(envelope);
    }
  }

  /** 连接就绪（events.subscribe.ok）：重放 + 对账（每次连接恰好一次，幂等安全） */
  private onSyncReady(): void {
    void this.flushOnce();
    void this.reconcile();
  }

  /** 事件信封 → 审批 store 动作（parseEngineEvent 严格解析，M5 §1.4 走生成面） */
  private consumeEnvelope(env: EventEnvelopeFrame): void {
    const parsed = parseEngineEvent(env);
    if (!parsed.ok) return; // 解析失败宽容跳过（非审批事件/畸形载荷，Unknown 语义）
    const event = parsed.data;
    if (event.type === 'approval-requested') {
      // 信封 runId（F2 §2.4；实时预览帧可能缺失 → null）
      const runId = readString(env, 'runId') ?? null;
      approvalStore
        .getState()
        .upsertPending(mapApprovalRequested(event, runId, this.nowFn()));
      return;
    }
    if (event.type === 'approval-resolved') {
      const view = mapApprovalResolved(event, this.nowFn());
      const store = approvalStore.getState();
      // 幂等收敛（F2 §11.2）：移除 + 历史；resolveApproval 未命中 → 无操作，
      // 重复 resolved / 已由命令回执处理 → 幂等忽略
      store.handleResolved(view.toolCallId, view.decision, view.resolvedAtMs);
      // outbox 确认出队：sent 收口 / 事件先到（未发送）清理（M5 §4.6.2 冲突收敛表）
      outboxState = confirmResolved(outboxState, view.toolCallId);
      this.syncAndPersist();
      return;
    }
    // 其余类型（run-terminal 等）不属审批桥消费面，宽容跳过（D6 §6.4 即时失效后续轮次）
  }

  // ── 决策发送闭环（outbox 重放） ─────────────────────────────────────────

  /** 单飞重放：collectReplayable（pending 立即 / failed 退避到期）→ 逐条发送 →
   *  每条都迁移终态（sent/出队/failed），循环必然收敛 */
  private async flushOnce(): Promise<void> {
    if (this.replayInflight) return;
    this.replayInflight = true;
    try {
      for (;;) {
        const batch = collectReplayable(outboxState, this.nowFn());
        if (batch.length === 0) break;
        let shouldStopBatch = false;
        for (const item of batch) {
          const ok = await this.sendOne(item);
          if (!ok) {
            // 快速失败防雪崩：遇底层断开或单次失败，中断当批后续串行
            shouldStopBatch = true;
            break;
          }
        }
        syncOutboxCount();
        if (shouldStopBatch) break;
      }
      this.scheduleBackoffRetry();
    } finally {
      this.replayInflight = false;
    }
  }

  /** 单条决策发送：命令回执 ok → markSent + markDecisionSent；失败 → 退避/冲突收敛 */
  private async sendOne(item: OutboxItem): Promise<boolean> {
    const now = this.nowFn();
    const req =
      item.decision === 'approved'
        ? buildApproveRequest(item.toolCallId, item.runId)
        : buildDenyRequest(item.toolCallId, item.reason, item.runId);
    try {
      // 网关已校验 CommandResult.ok===true（WsGateway.routeResponse），结果内容
      // 不参与本地状态机（真值收敛靠 approval-resolved 事件，D6 §6.3 两阶段确认）
      await this.gateway.invoke<ApproveResult>(req.kind, req.body);
      // 命令回执 ok：outbox pending/failed → sent（等待事件确认出队）；store 收敛
      // markDecisionSent（与 approval-resolved 先到者；条目已移除 → 幂等无操作）
      outboxState = markSent(outboxState, item.id, now);
      approvalStore
        .getState()
        .markDecisionSent(item.toolCallId, item.decision, now);
      this.syncAndPersist();
      return true;
    } catch (err) {
      const code = err instanceof GatewayError ? err.code : 'internal';
      if (PERMANENT_DECISION_ERROR_CODES.has(code)) {
        // 冲突/过期/NotFound：不可重试（D6 §6.3 不自动重试 stale/conflict）——
        // 队列收敛（出队）+ 条目置 conflict（F2 §11.2 冲突表「该请求已被其他设备处理」）
        outboxState = confirmResolved(outboxState, item.toolCallId);
        approvalStore.getState().markDecisionConflict(item.toolCallId);
        this.syncAndPersist();
        return true;
      } else {
        // 网络/超时/服务端瞬态：退避待重试（D6 §6.3 1s→4s→16s→60s 封顶）
        outboxState = recordFailure(
          outboxState,
          item.id,
          err instanceof Error ? err.message : String(err),
          now
        );
        this.syncAndPersist();
        this.scheduleBackoffRetry();
        return false;
      }
    }
  }

  /** 退避重试定时：以最近的可重试 failed 条目 nextRetryAtMs 为准（动态防饥饿聚合，到点自动重放） */
  private scheduleBackoffRetry(): void {
    const now = this.nowFn();
    let earliest: number | null = null;
    for (const item of outboxState.items) {
      if (item.status === 'failed' && item.nextRetryAtMs !== null) {
        if (earliest === null || item.nextRetryAtMs < earliest) {
          earliest = item.nextRetryAtMs;
        }
      }
    }
    if (earliest === null) {
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      return;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        void this.flushOnce();
      },
      Math.max(0, earliest - now)
    );
  }

  // ── 对账应用（F2 §4.1 双向往收敛） ────────────────────────────────────────

  private applyReconcile(result: ListPendingApprovalsResult): void {
    const store = approvalStore.getState();
    const now = this.nowFn();
    const engineIds = new Set(result.approvals.map((a) => a.toolCallId));
    const local = store.pending;
    const localIds = new Set(local.map((p) => p.request.toolCallId));
    // 引擎有、本地无 → 入队（含离线期间遗漏，F2 §4.1）
    for (const pa of result.approvals) {
      if (!localIds.has(pa.toolCallId)) {
        store.upsertPending(mapReconcileApprovalItem(pa, now));
      }
    }
    // 本地有、引擎无 → 已被处理/过期 → 对账确认移除（F2 §4.1；D6 §6.5 以权威为准）。
    // deciding 在途条目保留：命令由桌面裁决，不主动丢弃（保守，D6 §6.5 第 1 条）
    for (const p of local) {
      if (!engineIds.has(p.request.toolCallId) && p.status !== 'deciding') {
        store.removePending(p.request.toolCallId);
      }
    }
    store.setLastReconcileAt(now);
  }
}

// ── 装配（observationWiring 同风格：start 组合 / ensure 单例 / reset 测试隔离） ──

export interface ApprovalWiring {
  bridge: ApprovalBridge;
  /** 立即触发 outbox 重放（await 可测；重连/入队后由接线方调用） */
  flush: () => Promise<void>;
  /** 待办对账（mobile_list_pending_approvals 占位命令；失败宽容留痕） */
  reconcile: () => Promise<void>;
  /** 网关实例（与观测面共享同一连接） */
  gateway: WsGateway;
}

/** 装配审批接线（网关 + 桥订阅；测试注入 mock 网关/时钟/对账仓库） */
export function startApprovalWiring(
  opts: ApprovalWiringOptions
): ApprovalWiring {
  const bridge = new ApprovalBridge(opts);
  bridge.attach();
  return {
    bridge,
    flush: () => bridge.flush(),
    reconcile: () => bridge.reconcile(),
    gateway: opts.gateway,
  };
}

let singleton: ApprovalWiring | null = null;

/**
 * 审批接线单例（审批中心页挂载调用；幂等）。
 * 网关缺省取观测面接线（ensureObservationWiring 的 ReconnectingWsClient.gateway，
 * 与事件流同一连接）；观测面未装配/未配对 → 返回 null 不启动。
 *
 * DB 就绪门禁（实现波总方案 D3）：Outbox 持久化必须绑定 SQLite——装配前等待
 * `ensureDatabaseReady()`，杜绝「配对接线早于 DB → getSqlDriver() 为 null →
 * 单例永久降级内存态」的启动竞态。仅当 DB 明确失败（driver=null）时才落入
 * 内存态并 console.error 留痕（诚实降级，非静默竞态）。
 */
export function ensureApprovalWiring(
  opts: Omit<ApprovalWiringOptions, 'gateway'> & { gateway?: WsGateway } = {}
): ApprovalWiring | null {
  if (singleton) return singleton;
  const gateway = opts.gateway ?? getObservationWiring()?.client.gateway;
  if (!gateway) {
    // gateway 尚未就绪（冷启动中观察面接线晚于本调用）：注册一次性补齐，
    // 连接 open 时自动装配。不再静默失败留下永久缺口。
    ensurePendingRegistration();
    return null;
  }
  void ensureDatabaseReady().then((driver) => {
    if (singleton) return;
    if (!driver) {
      console.error(
        '[approvalWiring] DB 装配失败，离线决策仅内存暂存（进程被杀将丢失）'
      );
    }
    singleton = startApprovalWiring({
      // driver=null 仅发生在 DB 明确故障；正常路径此处必为 SQLite driver
      persistAdapter: createDefaultOutboxPersist(driver),
      ...opts,
      gateway,
    });
    void singleton.bridge.hydrate();
  });
  return null;
}

/**
 * 「等待 gateway 就绪」的单次注册（幂等）。
 *
 * 与 ensureApprovalWiring 一样有 `if (singleton)` 前置，因此 open 回调里
 * 重入本函数是安全的：已有单例即早返回，不会重复装配。
 */
let pendingOpenUnsubscribe: (() => void) | null = null;

function ensurePendingRegistration(): void {
  if (pendingOpenUnsubscribe) return;
  pendingOpenUnsubscribe = onObservationOpen(() => {
    pendingOpenUnsubscribe?.();
    pendingOpenUnsubscribe = null;
    ensureApprovalWiring();
  });
}

/** 当前审批接线单例读取（测试/诊断；未启动返回 null） */
export function getApprovalWiring(): ApprovalWiring | null {
  return singleton;
}

/** 测试隔离：清空审批接线单例（仅测试调用） */
export function resetApprovalWiringForTest(): void {
  singleton?.bridge.detach();
  singleton = null;
  clearPendingOpenRegistration();
}

/** 解绑 / 换机：销毁审批接线单例，并穿透清理落盘真源（SQLite approval_queue）。 */
export function disposeApprovalWiring(): void {
  singleton?.bridge.detach();
  singleton = null;
  clearPendingOpenRegistration();
  outboxState = createOutboxState();
  // 磁盘残留必须同步清除：换机后旧桌面的离线决策若被新连接水合回放，
  // 将构成跨主机越权执行（实现波总方案 V18a）。DB 未就绪/故障时无法清理，
  // 交由 hydrate 门禁侧的隔离语义兜底（无凭据不装配）。
  const driver = getSqlDriver();
  if (driver) {
    new SqlApprovalQueueDao(driver).clear().catch((error: unknown) => {
      console.error(
        '[approvalWiring] 解绑清理 approval_queue 失败：',
        error instanceof Error ? error.message : String(error)
      );
    });
  }
}

/** 撤销「等待 gateway 就绪」注册（解散单例时调用，避免悬挂回调） */
function clearPendingOpenRegistration(): void {
  pendingOpenUnsubscribe?.();
  pendingOpenUnsubscribe = null;
}

// ── 决策入队（VM 共用入口；接线就绪时立即触发重放） ─────────────────────────

/**
 * 决策入 outbox（幂等键 toolCallId + decision，D6 §6.2；msgId 供重发幂等，D3 §8.5）。
 * 返回 outbox 入队结果：ok / superseded（同键覆盖）/ full（容量满拒绝）。
 * 入队后同步审批角标；接线单例就绪（在线）→ 立即触发重放，未就绪（离线）→ 等待
 * events.subscribe.ok 重连补发（R2-ux §3.5 离线决策场景）。
 */
export function enqueueApprovalDecision(
  item: ApprovalItem,
  decision: 'approved' | 'denied',
  reason?: string
): 'ok' | 'superseded' | 'full' {
  const nowMs = Date.now();
  const input: EnqueueInput = {
    id: `${item.request.toolCallId}::${decision}::${nowMs}`,
    toolCallId: item.request.toolCallId,
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(item.runId !== null ? { runId: item.runId } : {}),
    msgId: `approval-${item.request.toolCallId}-${decision}-${nowMs}`,
    createdAtMs: nowMs,
  };
  const result = enqueueDecision(outboxState, input, nowMs);
  outboxState = result.state;
  syncOutboxCount();
  if (singleton?.bridge.persistAdapter) {
    void singleton.bridge.persistAdapter
      .save(snapshotOutbox(outboxState))
      .catch((e) => {
        console.error(
          '[approvalWiring] outbox 持久化失败，离线决策可能丢失:',
          e
        );
      });
  }
  if (result.outcome !== 'full') {
    void singleton?.flush();
  }
  return result.outcome;
}
