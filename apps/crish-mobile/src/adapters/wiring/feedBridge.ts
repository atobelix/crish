// FeedBridge（R2-05 观测面接线层，M5 §4.2 适配层职责）：
// - 设备帧消费：订阅 WsGateway 的 events.push / events.resume.page / events.resume.done /
//   session.updated / session.removed / session.updatedAll → mapDeviceFrame（R2-05a 事件映射）
//   → dispatchIngestActions（eventStore / sessionStore 动作执行）；
// - 连接相位投影：WsPhase → eventStore.setNetwork（live/reconnecting/offline，F3 §3.2.1）
//   + connectionStore.setPhase（mapWsPhase，M5 §4.3.1 投影表）；
// - 序列空洞自愈：乱序高帧暂存（stash）→ events.resume 增量补齐 → 按序 drain，
//   补洞帧不再被「乱序帧先行推进 lastSeq」误判 duplicate（实现波总方案 C1）；
//   resume.page hasMore 自动续页（M6 §9.3 ③ 增量补齐闭环）；
// - 窗口卸载策略（R2UX-05-09：≤4 活跃窗口，超出卸载最久未活跃者）——接线层调度位；
// - 设备在场查询：open 相位 fire-and-forget remote.listDevices → devicePresenceStore；
// - 会话索引同步（M1 可见化 → 2026-11-02 增量口径）：列表常态由 WS 增量事件
//   （session.updated/removed + 事件流）驱动；全量对账退为连接建立/手动刷新/
//   updatedAll 信号时的校准兜底，且带差分判定——无差分静默收尾（不写状态、
//   不置 syncing、不打成功点）；定时退避重试链已删除（用户裁决：无定时自动
//   刷新），失败只落 error 状态面，等下一次 open/前台/下拉重新校准。对账
//   成败仍写入 connectionStore（error 浮层 + 重试的数据面），不再呈「同步中」。
// 注入模式：gateway 实例构造注入（测试 mock；生产由 ReconnectingWsClient.gateway 提供）。
import { WsGateway, GatewayError } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { WsPhase } from '@/network/ReconnectingWsClient';
import { mapWsPhase } from '@/domain/pure/selectors';
import type { FeedNetwork } from '@/domain/store/eventStore';
import { eventStore, lastSeqOf } from '@/domain/store/eventStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import {
  deviceSnapshotStore,
  markLiveDataFresh,
} from '@/domain/store/deviceSnapshotStore';
import type { StoreIngestAction } from '@/domain/store/eventMappers';
import { extractEnvelope, mapDeviceFrame } from '@/domain/store/eventMappers';
import { readBool, readRecord } from '@/domain/store/eventReducers';
import type { SessionIndexEntry } from '@crish/shared-types';
import { dispatchIngestActions } from './ingestRouter';
import type { MonitorRepository } from '@/adapters/repositories/monitorRepository';
import { createLogger } from '@/adapters/platform/logger';
import { getRemoteSyncEngine } from '@/domain/store/remoteSyncEngine';

const log = createLogger('wiring');

/** 续传分页大小（F1 §3.4 对齐桌面 core_read_run_events 200/页） */
export const RESUME_PAGE_SIZE = 200;

/** 会话索引全量拉取（session.updatedAll / 重连对账触发；注入 mock 便于单测） */
export type ListSessionsRepository = (
  gateway: WsGateway
) => Promise<SessionIndexEntry[]>;

/** 全局轻订阅关键事件（确保未打开会话的审批 / 终态也能到达） */
export const CRITICAL_EVENT_TYPES: readonly string[] = [
  'approval-requested',
  'approval-resolved',
  'run-terminal',
  'runtime-error',
  'runtime-intervention-required',
  'security-audit',
  'task-started',
  'task-output',
  'task-suspicious',
  'task-completed',
  'task-failed',
  'task-killed',
  'timer-fired',
  'cron-fired',
];

/** 会话订阅上限（协议 MAX_SUBSCRIPTIONS=32） */
export const MAX_SUBSCRIPTIONS = 32;

/** 单会话回填页数上限（500 条窗口 + 起始页余量） */
const MAX_BACKFILL_PAGES = 6;

/** 从 events.push 信封提取会话级 sequence（缺省/畸形 → null） */
function sequenceOfFrame(frame: InboundEnvelope): number | null {
  const body = readRecord(frame.body) ?? {};
  const ev = readRecord(body['event']) ?? {};
  const seq = ev['sequence'];
  return typeof seq === 'number' ? seq : null;
}

export interface FeedBridgeOptions {
  /** 网关实例（生产 = ReconnectingWsClient.gateway；测试注入 mock） */
  gateway: WsGateway;
  /** 会话索引全量拉取（缺省 = 不拉取；对账收敛依赖注入方提供） */
  listSessions?: ListSessionsRepository;
  /** 监控仓库（生产注入；用于打开会话时的历史回填） */
  monitor?: MonitorRepository;
  /**
   * 本桥的属主设备（M7 盖章穿线）：本桥全部入站写入（帧分发/对账/
   * 回填）以此为来源设备，store 侧与属主盖章不符即丢弃——旧桥的
   * 在途异步结果在设备切换后不得落进新设备数据面。缺省 = 不穿线。
   */
  ownerDeviceId?: string;
}

/**
 * 设备帧 → store 动作分发的订阅管理器。attach 后开始消费；
 * 相位/投影回调由装配方（observationWiring）把 client.onPhaseChange /
 * onProjection 转发到本桥（R2-02b 接线点）。
 */
export class FeedBridge {
  private readonly gateway: WsGateway;
  private readonly listSessionsRepo?: ListSessionsRepository;
  private readonly monitor?: MonitorRepository;
  private readonly ownerDeviceId?: string;
  private unsubscribers: Array<() => void> = [];
  /** 窗口活跃度追踪（sessionId → 最近一次帧到达 ms） */
  private readonly activity = new Map<string, number>();
  /** 续传在途会话（防重入：同一会话同时只允许一个 events.resume 请求链） */
  private readonly inflightResume = new Set<string>();
  /** 续传看门狗定时器（防丢包挂死：超时自动清在途） */
  private readonly resumeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** 历史回填在途会话（防重入） */
  private readonly inflightBackfill = new Set<string>();

  /** 续传在途看门狗兜底超时（ms） */
  public static readonly RESUME_INFLIGHT_TIMEOUT_MS = 5000;

  constructor(opts: FeedBridgeOptions) {
    this.gateway = opts.gateway;
    this.listSessionsRepo = opts.listSessions;
    this.monitor = opts.monitor;
    this.ownerDeviceId = opts.ownerDeviceId;
  }

  /** 订阅观测面设备帧（幂等：重复 attach 先 detach） */
  attach(): void {
    this.detach();
    const onFrame = (frame: InboundEnvelope): void => {
      this.handleFrame(frame);
    };
    // 观测面消费子集（M6 §3.1 分发表；pair/auth/device/remote/result/stream/heartbeat/error 域归其它路由）
    this.unsubscribers = [
      this.gateway.on('events.push', onFrame),
      this.gateway.on('events.resume.page', onFrame),
      this.gateway.on('events.resume.done', onFrame),
      this.gateway.on('session.updated', onFrame),
      this.gateway.on('session.removed', onFrame),
      this.gateway.on('session.updatedAll', onFrame),
    ];
  }

  /** 释放会话续传在途锁与看门狗 */
  private clearResumeInflight(sessionId: string): void {
    const timer = this.resumeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.resumeTimers.delete(sessionId);
    }
    this.inflightResume.delete(sessionId);
  }

  /** 退订全部设备帧（页面/应用卸载时调用，M4 §8.2 退场即退订） */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    for (const timer of this.resumeTimers.values()) {
      clearTimeout(timer);
    }
    this.resumeTimers.clear();
    this.inflightResume.clear();
    this.inflightBackfill.clear();
    this.stashBySession.clear();
  }

  /** 帧入口：mapDeviceFrame → dispatchIngestActions；resume.page/done 由专用路径处理 */
  private handleFrame(frame: InboundEnvelope): void {
    if (frame.kind === 'events.resume.page') {
      this.handleResumePage(frame);
      return;
    }
    if (frame.kind === 'events.resume.done') {
      this.handleResumeDone(frame);
      return;
    }

    // 序列空洞探测（Sequence Gap Detection，实现波总方案 C1）：
    // 收到 events.push 且 sequence 大于当前游标 + 1 → 帧**暂存不投递**（防止
    // 乱序高帧先行推进 lastSeq 导致补洞帧被判 duplicate 全弃），同时触发增量
    // 回放补洞；空洞闭合后按序 drain 暂存帧。
    if (frame.kind === 'events.push') {
      const body = readRecord(frame.body) ?? {};
      const ev = readRecord(body['event']) ?? {};
      const sessionId =
        typeof ev['sessionId'] === 'string' ? ev['sessionId'] : null;
      const seq = typeof ev['sequence'] === 'number' ? ev['sequence'] : null;
      if (sessionId && seq !== null) {
        const currentSeq = lastSeqOf(sessionId);
        if (currentSeq > 0 && seq > currentSeq + 1) {
          this.stashOutOfOrder(sessionId, seq, frame);
          this.resumeSession(sessionId, currentSeq);
          return;
        }
        if (currentSeq > 0 && seq === currentSeq + 1) {
          this.applyActions(
            mapDeviceFrame({ kind: frame.kind, body: frame.body })
          );
          this.markActive(sessionId);
          this.drainStash(sessionId);
          return;
        }
      }
    }

    const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
    this.applyActions(actions);
    // 窗口活跃度刷新
    for (const action of actions) {
      if (action.kind === 'feed-append') this.markActive(action.sessionId);
    }
  }

  /** 续传分页：正常分派（feed-hydrate）+ hasMore 自动续页（M6 §9.3 ③ 增量补齐闭环） */
  private handleResumePage(frame: InboundEnvelope): void {
    const body = readRecord(frame.body) ?? {};
    const sessionId =
      typeof body['sessionId'] === 'string' ? body['sessionId'] : null;
    if (sessionId) this.markActive(sessionId);
    const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
    this.applyActions(actions);
    if (sessionId) this.drainStash(sessionId);
    if (sessionId && readBool(body, 'hasMore')) {
      // 续页：以 store 游标为下一页起点；若当前已在途则防重入
      if (!this.inflightResume.has(sessionId)) {
        this.resumeSession(sessionId, lastSeqOf(sessionId));
      }
    } else if (sessionId) {
      this.clearResumeInflight(sessionId);
    }
  }

  /** 续传完成：清在途 + drain 乱序暂存 + 游标推进 */
  private handleResumeDone(frame: InboundEnvelope): void {
    const body = readRecord(frame.body) ?? {};
    const sessionId =
      typeof body['sessionId'] === 'string' ? body['sessionId'] : null;
    if (sessionId) {
      this.markActive(sessionId);
      this.clearResumeInflight(sessionId);
      this.drainStash(sessionId);
    }
    const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
    this.applyActions(actions);
  }

  // ── 序列空洞暂存缓冲（实现波总方案 C1）──────────────────────────────────
  // 空洞闭合前到达的高序号帧在此等待；drainStash 按序投递，任何帧不再
  // 因「后到先入库推进 lastSeq」而丢失。

  private readonly stashBySession = new Map<string, InboundEnvelope[]>();

  /** 暂存乱序高帧（按 seq 升序插入；同 seq 去重） */
  private stashOutOfOrder(
    sessionId: string,
    seq: number,
    frame: InboundEnvelope
  ): void {
    const list = this.stashBySession.get(sessionId) ?? [];
    if (list.some((f) => sequenceOfFrame(f) === seq)) return;
    const next = [...list, frame];
    next.sort((a, b) => (sequenceOfFrame(a) ?? 0) - (sequenceOfFrame(b) ?? 0));
    this.stashBySession.set(sessionId, next);
  }

  /** 空洞闭合后按序 drain：seq ≤ 游标丢弃（重复），seq = 游标+1 投递，遇空洞停 */
  private drainStash(sessionId: string): void {
    const list = this.stashBySession.get(sessionId);
    if (!list || list.length === 0) return;
    this.stashBySession.delete(sessionId);
    for (const frame of list) {
      const seq = sequenceOfFrame(frame);
      const currentSeq = lastSeqOf(sessionId);
      if (seq !== null && currentSeq > 0) {
        if (seq <= currentSeq) continue; // 补洞已覆盖该帧：判重丢弃
        if (seq > currentSeq + 1) {
          // 空洞仍未闭合：剩余帧重新入 stash，等下一页补洞
          const rest = list.slice(list.indexOf(frame));
          this.stashBySession.set(sessionId, rest);
          return;
        }
      }
      const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
      this.applyActions(actions);
      for (const action of actions) {
        if (action.kind === 'feed-append') this.markActive(action.sessionId);
      }
    }
  }

  /** 统一动作执行入口（续页路径与普通路径共用） */
  private applyActions(actions: readonly StoreIngestAction[]): void {
    dispatchIngestActions(actions, {
      onSessionsRefresh: () => void this.refreshSessions(false),
      ...(this.ownerDeviceId !== undefined
        ? { sourceDeviceId: this.ownerDeviceId }
        : {}),
    });

    // 实时流式批量落盘：自动汇入 RemoteSyncEngine 异步落盘缓冲
    const syncEngine = getRemoteSyncEngine();
    if (syncEngine) {
      for (const action of actions) {
        if (action.kind === 'feed-append') {
          syncEngine.recordEvent(
            action.sessionId,
            action.frame,
            this.ownerDeviceId,
            action.preview
          );
        }
      }
    }

    this.clearStaleOnLiveIncrement(actions);
  }

  /**
   * 增量落地清陈旧（CON-3 清除条件对齐，2026-11-02）：陈旧标记的语义是
   * 「live 数据面停留在上次同步存量」——只要有真实数据面增量经本桥落地
   * （事件追加/回填、会话 upsert/移除、run 活动、审批增量、未读更新），
   * 且本桥仍是现行属主、连接相位为 ready，数据面就是活的，陈旧标记必须
   * 撤下。此前清除条件只有「全量对账落盘」一条：增量一直在流、列表早已
   * 实时更新，陈旧标注却赖着不走，呈「连上了还显示未连接」——即误报源。
   * sessions-refresh 不在此列：它只触发对账，清标归对账落地路径。
   */
  private clearStaleOnLiveIncrement(
    actions: readonly StoreIngestAction[]
  ): void {
    if (!deviceSnapshotStore.getState().liveStale) return;
    const hasIncrement = actions.some(
      (a) =>
        a.kind === 'feed-append' ||
        a.kind === 'feed-hydrate' ||
        a.kind === 'session-upsert' ||
        a.kind === 'session-remove' ||
        a.kind === 'run-active' ||
        a.kind === 'approval-delta' ||
        a.kind === 'session-unread-update'
    );
    if (!hasIncrement) return;
    if (!this.isCurrentOwner()) return;
    if (connectionStore.getState().phase !== 'ready') return;
    markLiveDataFresh();
  }

  /** 本桥是否仍是数据面现行属主（未穿线/未盖章 = 放行，与 store 盖章口径同构） */
  private isCurrentOwner(): boolean {
    if (this.ownerDeviceId === undefined) return true;
    const owner = sessionStore.getState().ownerDeviceId;
    return owner === null || owner === this.ownerDeviceId;
  }

  /**
   * 连接相位投影（ReconnectingWsClient.onPhaseChange 转发）：
   * - eventStore.network（F3 §3.2.1 事件流域视图：open → live / reconnecting → reconnecting / 其余 → offline）；
   * - connectionStore.phase（mapWsPhase 投影表，M5 §4.3.1）；
   * - open 相位：设备在场查询 + 会话索引对账（重连成功自动全量刷新，F1 §5.4）。
   */
  handlePhaseChange(phase: WsPhase): void {
    eventStore.getState().setNetwork(feedNetworkOf(phase));
    connectionStore.getState().setPhase(mapWsPhase(phase, false));
    if (phase !== 'open') {
      for (const timer of this.resumeTimers.values()) {
        clearTimeout(timer);
      }
      this.resumeTimers.clear();
      this.inflightResume.clear();
      this.inflightBackfill.clear();
    }
    if (phase === 'dead') {
      // 接线已死（重试耗尽）：此后列表内容是上次同步的存量而非实时
      // 数据，打陈旧标记供呈现层诚实标注（CON-3；判据 = 接线真实
      // 存活，不看发现快照相位；复活后对账落盘或任一真实增量落地即清标）。
      deviceSnapshotStore.getState().setLiveStale(true, Date.now());
    }
    if (phase === 'open') {
      void this.onOpen(false);
    }
  }

  /** run 详情深链：按 runId 拉取事件并按会话回填窗口 */
  async hydrateRun(runId: string): Promise<void> {
    if (!this.monitor) return;
    try {
      const result = await this.monitor.readRunEvents({
        runId,
        maxEvents: 500,
      });
      const bySession = new Map<string, typeof result.events>();
      for (const event of result.events) {
        const frame = extractEnvelope(event);
        if (!frame) continue;
        const bucket = bySession.get(frame.sessionId) ?? [];
        bucket.push(event);
        bySession.set(frame.sessionId, bucket);
      }
      for (const [sessionId, events] of bySession) {
        const frames = events
          .map((event) => extractEnvelope(event, sessionId))
          .filter(
            (frame): frame is NonNullable<typeof frame> => frame !== null
          );
        if (frames.length > 0) {
          eventStore
            .getState()
            .hydrate(
              sessionId,
              frames,
              result.nextAfterSequence,
              undefined,
              this.ownerDeviceId
            );
        }
      }
    } catch (error) {
      log.warn(`run 历史回填失败（${runId}）`, error);
    }
  }

  /**
   * 手动刷新（下拉刷新 / 错误浮层重试）：用户主动触发——本轮对账可置
   * syncing 状态面（反馈由下拉刷新原生指示/浮层承载，不另呈同步条）。
   */
  async refreshNow(): Promise<void> {
    await this.onOpen(true);
  }

  /** 连接就绪：拉会话索引 → 订阅 → 回填已打开窗口（顺序执行，避免空订阅）。 */
  private async onOpen(userInitiated: boolean): Promise<void> {
    await this.refreshSessions(userInitiated);
    this.syncSubscriptions();
    for (const sessionId of Object.keys(eventStore.getState().windows)) {
      void this.hydrateSession(sessionId);
    }
  }

  /** 会话级订阅（活跃会话前 32）+ 全局关键类型轻订阅。 */
  syncSubscriptions(): void {
    const sessions = sessionStore
      .getState()
      .sessions.filter((session) => session.isArchived !== true)
      .slice(0, MAX_SUBSCRIPTIONS);
    const lastSequences: Record<string, number> = {};
    for (const session of sessions) {
      lastSequences[session.id] = lastSeqOf(session.id);
    }
    this.gateway.send('events.subscribe', {
      sessions: sessions.map((session) => session.id),
      lastSequences,
      ackMode: 'auto',
    });
    this.gateway.send('events.subscribeAll', {
      events: [...CRITICAL_EVENT_TYPES],
    });
  }

  /**
   * 打开会话时回填历史（优先本地秒开，随后通过 monitor 增量追平）。
   * 彻底废除 RESUME_FROM_ZERO 全量盲拉，仅拉取增量差分。
   */
  async hydrateSession(sessionId: string): Promise<void> {
    if (this.inflightBackfill.has(sessionId)) return;
    this.inflightBackfill.add(sessionId);
    this.markActive(sessionId);
    try {
      const syncEngine = getRemoteSyncEngine();
      if (syncEngine) {
        // 1. 本地 SQLite 0 延迟秒开
        await syncEngine.hydrateSessionFromLocal(sessionId, this.ownerDeviceId);
        // 2. 在线时差分续传
        if (this.monitor) {
          syncEngine.setMonitor(this.monitor);
          await syncEngine.catchUpSession(sessionId, this.ownerDeviceId);
        }
        return;
      }

      // 未装配 syncEngine 时（如纯内存单测）保持从 monitor 差分续传
      if (!this.monitor) return;
      let after = lastSeqOf(sessionId);
      for (let page = 0; page < MAX_BACKFILL_PAGES; page += 1) {
        const result = await this.monitor.readSessionEvents({
          sessionId,
          afterSequence: after,
          maxEvents: RESUME_PAGE_SIZE,
        });
        const frames = result.events
          .map((event) => extractEnvelope(event, sessionId))
          .filter(
            (frame): frame is NonNullable<typeof frame> => frame !== null
          );
        if (frames.length > 0) {
          eventStore
            .getState()
            .hydrate(
              sessionId,
              frames,
              result.nextAfterSequence,
              undefined,
              this.ownerDeviceId
            );
        }
        if (!result.hasMore || result.nextAfterSequence <= after) break;
        after = result.nextAfterSequence;
      }
    } catch (error) {
      log.warn(`会话历史回填失败（${sessionId}）`, error);
    } finally {
      this.inflightBackfill.delete(sessionId);
    }
  }

  /** 单会话续传请求（在途防重入；send 推流避免 invoke 10s 超时黑洞，M6 §9.3） */
  private resumeSession(sessionId: string, afterSequence: number): void {
    if (this.inflightResume.has(sessionId)) return;
    this.inflightResume.add(sessionId);
    try {
      const sent = this.gateway.send('events.resume', {
        sessionId,
        afterSequence,
        maxEvents: RESUME_PAGE_SIZE,
      });
      if (!sent) {
        throw new GatewayError(
          'transport.closed',
          '连接未就绪，无法发送续传请求',
          true
        );
      }
      const timer = setTimeout(() => {
        this.clearResumeInflight(sessionId);
      }, FeedBridge.RESUME_INFLIGHT_TIMEOUT_MS);
      this.resumeTimers.set(sessionId, timer);
    } catch (err: unknown) {
      this.clearResumeInflight(sessionId);
      log.warn(`events.resume 失败（${sessionId}）`, err);
    }
  }

  /**
   * 会话索引对账（repository 注入时执行）——校准兜底，不是列表的常态来源
   * （常态 = WS 增量事件）。增量静默口径（2026-11-02 用户裁决）：
   * - 仅用户主动刷新（refreshNow）可置 syncing 状态面；后台对账（open /
   *   updatedAll 信号）永不置 syncing——呈现层不出现「正在同步…」；
   * - reconcile 带差分判定：真实差分落盘 → markSessionSyncSucceeded
   *   （状态 ok + 清错误 + 打点）；后台无差分且无历史错误 → 完全静默
   *   收尾（connectionStore 零写入）；无差分但此前为 error、或本轮是
   *   用户主动刷新（已置 syncing，必须收尾回 ok 否则状态面楔住）→
   *   同样记一次成功（错误浮层撤下，恢复本身是真实事件）；
   * - 失败 → markSessionSyncFailed + warn 留痕，**不排任何定时重试**
   *   （定时自动刷新已废除）；恢复靠下一次 open / 前台 / 用户下拉。
   * - 盖章丢弃（本桥已非现行属主）→ 状态面一概不动（M7/M1 同守此判据）。
   * 无对账来源（repo/monitor 均未注入）时直接返回，状态保持 idle 不动。
   */
  private async refreshSessions(userInitiated: boolean): Promise<void> {
    if (!this.listSessionsRepo && !this.monitor) return;
    if (userInitiated) {
      connectionStore.getState().markSessionSyncStarted();
    }
    try {
      // 对账以本桥属主为来源写入（M7）：设备已切换时旧桥的在途对账
      // 结果会被 store 盖章校验丢弃，不污染新设备列表。
      const droppedBefore = sessionStore.getState().droppedWriteCount;
      let changed: boolean;
      if (this.listSessionsRepo) {
        const list = await this.listSessionsRepo(this.gateway);
        changed = sessionStore
          .getState()
          .reconcile(list, undefined, this.ownerDeviceId);
      } else {
        const result = await this.monitor!.listSessions({});
        changed = sessionStore
          .getState()
          .reconcile(result.sessions, undefined, this.ownerDeviceId);
      }
      // 对账真正落盘（未被盖章丢弃）→ live 数据面转新鲜（CON-3 陈旧
      // 标注撤下）；被丢弃说明本桥已不是现行属主，不得清标、不得动
      // 现行设备的对账状态面。
      const landed =
        sessionStore.getState().droppedWriteCount === droppedBefore;
      if (landed) {
        markLiveDataFresh();
        if (
          changed ||
          userInitiated ||
          connectionStore.getState().sessionSyncStatus === 'error'
        ) {
          connectionStore.getState().markSessionSyncSucceeded();
        }
        // 后台无差分且无历史错误：静默收尾——状态、打点一概不动。
      }
      this.syncSubscriptions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      connectionStore.getState().markSessionSyncFailed(message);
      log.warn(`会话索引对账失败：${message}`);
    }
  }

  /** 窗口活跃度标记（LRU 语义：读/写都刷新活动时间） */
  private markActive(sessionId: string): void {
    this.activity.set(sessionId, Date.now());
  }
}

/** WsPhase → 事件流域连接相位（F3 §3.2.1：live / reconnecting / offline 三态） */
export function feedNetworkOf(phase: WsPhase): FeedNetwork {
  if (phase === 'open') return 'live';
  if (phase === 'reconnecting') return 'reconnecting';
  return 'offline';
}
