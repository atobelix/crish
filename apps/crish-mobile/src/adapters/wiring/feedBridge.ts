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
// - 设备在场查询：open 相位 fire-and-forget remote.listDevices → devicePresenceStore。
// 注入模式：gateway 实例构造注入（测试 mock；生产由 ReconnectingWsClient.gateway 提供）。
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { WsPhase } from '@/network/ReconnectingWsClient';
import { mapWsPhase } from '@/domain/pure/selectors';
import type { FeedNetwork } from '@/domain/store/eventStore';
import { eventStore, lastSeqOf } from '@/domain/store/eventStore';
import { connectionStore } from '@/domain/store/connectionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { StoreIngestAction } from '@/domain/store/eventMappers';
import { extractEnvelope, mapDeviceFrame } from '@/domain/store/eventMappers';
import { readBool, readRecord } from '@/domain/store/eventReducers';
import type { SessionIndexEntry } from '@crish/shared-types';
import { dispatchIngestActions } from './ingestRouter';
import type { MonitorRepository } from '@/adapters/repositories/monitorRepository';

/** 活跃窗口上限（R2UX-05-09：M5 §9.3 内存预算 5000 条 × ≤4 窗口） */
export const MAX_ACTIVE_WINDOWS = 4;
/** 续传分页大小（F1 §3.4 对齐桌面 core_read_run_events 200/页） */
export const RESUME_PAGE_SIZE = 200;
/** 续传游标起点（快照重建 full-replay：从 0 全量回放，M6 §9.3 ③） */
export const RESUME_FROM_ZERO = 0;

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
  /** 活跃窗口上限（缺省 4，R2UX-05-09） */
  maxWindows?: number;
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
  private readonly maxWindows: number;
  private unsubscribers: Array<() => void> = [];
  /** 窗口活跃度追踪（sessionId → 最近一次帧到达 ms；卸载策略数据面） */
  private readonly activity = new Map<string, number>();
  /** 续传在途会话（防重入：同一会话同时只允许一个 events.resume 请求链） */
  private readonly inflightResume = new Set<string>();
  /** 历史回填在途会话（防重入） */
  private readonly inflightBackfill = new Set<string>();

  constructor(opts: FeedBridgeOptions) {
    this.gateway = opts.gateway;
    this.listSessionsRepo = opts.listSessions;
    this.monitor = opts.monitor;
    this.maxWindows = opts.maxWindows ?? MAX_ACTIVE_WINDOWS;
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

  /** 退订全部设备帧（页面/应用卸载时调用，M4 §8.2 退场即退订） */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /** 帧入口：mapDeviceFrame → dispatchIngestActions；resume.page 续页由专用路径处理 */
  private handleFrame(frame: InboundEnvelope): void {
    if (frame.kind === 'events.resume.page') {
      this.handleResumePage(frame);
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
          this.unloadExcessWindows();
          return;
        }
      }
    }

    const actions = mapDeviceFrame({ kind: frame.kind, body: frame.body });
    this.applyActions(actions);
    // 窗口活跃度刷新（feed 面帧计入卸载候选的活跃度）
    for (const action of actions) {
      if (action.kind === 'feed-append') this.markActive(action.sessionId);
    }
    this.unloadExcessWindows();
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
      // 续页：以 store 游标（nextAfterSequence 已并入，只升不降）为下一页起点
      this.resumeSession(sessionId, lastSeqOf(sessionId));
    } else if (sessionId) {
      this.inflightResume.delete(sessionId);
    }
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
    this.unloadExcessWindows();
  }

  /** 统一动作执行入口（续页路径与普通路径共用） */
  private applyActions(actions: readonly StoreIngestAction[]): void {
    dispatchIngestActions(actions, {
      onSessionsRefresh: () => void this.refreshSessions(),
    });
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
    if (phase === 'open') {
      void this.onOpen();
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
            .hydrate(sessionId, frames, result.nextAfterSequence);
        }
      }
    } catch (error) {
      console.warn(
        `[wiring] run 历史回填失败（${runId}）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 手动刷新（下拉刷新 / 前台恢复）：重拉会话索引并同步订阅 */
  async refreshNow(): Promise<void> {
    await this.onOpen();
  }

  /** 连接就绪：拉会话索引 → 订阅 → 回填已打开窗口（顺序执行，避免空订阅）。 */
  private async onOpen(): Promise<void> {
    await this.refreshSessions();
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
   * 打开会话时回填历史（C03 readSessionEvents 分页；已打开窗口从本地游标续传）。
   * 仅入 feed 展示面，不重放审批 / 活动 run 副作用（实时订阅负责状态增量）。
   */
  async hydrateSession(sessionId: string, fromStart = false): Promise<void> {
    if (!this.monitor || this.inflightBackfill.has(sessionId)) return;
    this.inflightBackfill.add(sessionId);
    this.markActive(sessionId);
    try {
      let after = fromStart ? RESUME_FROM_ZERO : lastSeqOf(sessionId);
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
            .hydrate(sessionId, frames, result.nextAfterSequence);
        }
        if (!result.hasMore || result.nextAfterSequence <= after) break;
        after = result.nextAfterSequence;
      }
    } catch (error) {
      console.warn(
        `[wiring] 会话历史回填失败（${sessionId}）：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.inflightBackfill.delete(sessionId);
    }
  }

  /** 单会话续传请求（在途防重入；失败清在途，下轮投影可重试） */
  private resumeSession(sessionId: string, afterSequence: number): void {
    if (this.inflightResume.has(sessionId)) return;
    this.inflightResume.add(sessionId);
    this.gateway
      .invoke('events.resume', {
        sessionId,
        afterSequence,
        maxEvents: RESUME_PAGE_SIZE,
      })
      .catch((err: unknown) => {
        this.inflightResume.delete(sessionId);
        console.warn(
          `[wiring] events.resume 失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /** 会话索引全量对账（repository 注入时执行；失败静默留痕——下次重连再收敛） */
  private async refreshSessions(): Promise<void> {
    try {
      if (this.listSessionsRepo) {
        const list = await this.listSessionsRepo(this.gateway);
        sessionStore.getState().reconcile(list);
      } else if (this.monitor) {
        const result = await this.monitor.listSessions({});
        sessionStore.getState().reconcile(result.sessions);
      } else {
        return;
      }
      this.syncSubscriptions();
    } catch (error) {
      console.warn(
        `[wiring] 会话索引对账失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 窗口活跃度标记（LRU 语义：读/写都刷新活动时间） */
  private markActive(sessionId: string): void {
    this.activity.set(sessionId, Date.now());
  }

  /** 窗口卸载策略（R2UX-05-09：超过 maxWindows 个活跃窗口 → 卸载最久未活跃者） */
  private unloadExcessWindows(): void {
    const activeCount = this.activity.size;
    if (activeCount <= this.maxWindows) return;
    const candidates = [...this.activity.entries()].sort((a, b) => a[1] - b[1]);
    const excess = activeCount - this.maxWindows;
    for (let i = 0; i < excess; i++) {
      const [sessionId] = candidates[i] ?? [];
      if (sessionId === undefined) break;
      eventStore.getState().unloadWindow(sessionId);
      this.activity.delete(sessionId);
      // 窗口已卸载：其空洞暂存帧一并丢弃（重开窗口时 hydrateSession 全量回填）
      this.stashBySession.delete(sessionId);
    }
  }
}

/** WsPhase → 事件流域连接相位（F3 §3.2.1：live / reconnecting / offline 三态） */
export function feedNetworkOf(phase: WsPhase): FeedNetwork {
  if (phase === 'open') return 'live';
  if (phase === 'reconnecting') return 'reconnecting';
  return 'offline';
}
