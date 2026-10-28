// FeedBridge（R2-05 观测面接线层，M5 §4.2 适配层职责）：
// - 设备帧消费：订阅 WsGateway 的 events.push / events.resume.page / events.resume.done /
//   session.updated / session.removed / session.updatedAll → mapDeviceFrame（R2-05a 事件映射）
//   → dispatchIngestActions（eventStore / sessionStore 动作执行）；
// - 连接相位投影：WsPhase → eventStore.setNetwork（live/reconnecting/offline，F3 §3.2.1）
//   + connectionStore.setPhase（mapWsPhase，M5 §4.3.1 投影表）；
// - 重连对账驱动（M6 §9.3，R2-02b onProjection 消费）：resume/full-replay/fresh 会话
//   逐条发 events.resume 请求（增量补齐 / 快照重建），resume.page hasMore 自动续页，
//   cleanup 清理本地投影 + 事件窗口，对账后重拉会话索引（② 投影对账收敛）；
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
import { mapDeviceFrame } from '@/domain/store/eventMappers';
import { readBool, readRecord } from '@/domain/store/eventReducers';
import type { SessionIndexEntry } from '@crish/shared-types';
import { dispatchIngestActions } from './ingestRouter';
import { devicePresenceStore } from './devicePresenceStore';

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

export interface FeedBridgeOptions {
  /** 网关实例（生产 = ReconnectingWsClient.gateway；测试注入 mock） */
  gateway: WsGateway;
  /** 会话索引全量拉取（缺省 = 不拉取；对账收敛依赖注入方提供） */
  listSessions?: ListSessionsRepository;
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
  private readonly maxWindows: number;
  private unsubscribers: Array<() => void> = [];
  /** 窗口活跃度追踪（sessionId → 最近一次帧到达 ms；卸载策略数据面） */
  private readonly activity = new Map<string, number>();
  /** 续传在途会话（防重入：同一会话同时只允许一个 events.resume 请求链） */
  private readonly inflightResume = new Set<string>();

  constructor(opts: FeedBridgeOptions) {
    this.gateway = opts.gateway;
    this.listSessionsRepo = opts.listSessions;
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

    // 序列空洞探测（Sequence Gap Detection）：
    // 若收到 events.push 且 sequence 大于当前游标 + 1，触发增量回放补洞自愈
    if (frame.kind === 'events.push') {
      const body = readRecord(frame.body) ?? {};
      const ev = readRecord(body['event']) ?? {};
      const sessionId =
        typeof ev['sessionId'] === 'string' ? ev['sessionId'] : null;
      const seq = typeof ev['sequence'] === 'number' ? ev['sequence'] : null;
      if (sessionId && seq !== null) {
        const currentSeq = lastSeqOf(sessionId);
        if (currentSeq > 0 && seq > currentSeq + 1) {
          this.resumeSession(sessionId, currentSeq);
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
    if (sessionId && readBool(body, 'hasMore')) {
      // 续页：以 store 游标（nextAfterSequence 已并入，只升不降）为下一页起点
      this.resumeSession(sessionId, lastSeqOf(sessionId));
    } else if (sessionId) {
      this.inflightResume.delete(sessionId);
    }
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
      void this.queryDevicePresence();
      void this.refreshSessions();
    }
  }

  /**
   * 重连对账驱动（ReconnectingWsClient.onProjection 转发，M6 §9.3 ①~③）：
   * - resume：events.resume 增量补齐（afterSequence = 本地游标）；
   * - full-replay / fresh：afterSequence = 0 全量回放/快照重建；
   * - cleanup：本地投影 + 事件窗口清理（② 权威无本地有）；
   * - 会话索引对账收敛（重连成功 → 重拉列表，F1 §5.4）。
   */
  handleProjection(projection: {
    resume: readonly string[];
    fullReplay: readonly string[];
    fresh: readonly string[];
    cleanup: readonly string[];
  }): void {
    for (const sessionId of projection.resume) {
      this.resumeSession(sessionId, lastSeqOf(sessionId));
    }
    for (const sessionId of projection.fullReplay) {
      this.resumeSession(sessionId, RESUME_FROM_ZERO);
    }
    for (const sessionId of projection.fresh) {
      this.resumeSession(sessionId, RESUME_FROM_ZERO);
    }
    for (const sessionId of projection.cleanup) {
      sessionStore.getState().remove(sessionId);
      eventStore.getState().unloadWindow(sessionId);
      this.activity.delete(sessionId);
    }
    void this.refreshSessions();
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

  /** 会话索引全量对账（repository 注入时执行；失败静默留痕——下次 updatedAll/重连再收敛） */
  private async refreshSessions(): Promise<void> {
    if (!this.listSessionsRepo) return;
    try {
      const list = await this.listSessionsRepo(this.gateway);
      sessionStore.getState().reconcile(list);
    } catch (err) {
      console.warn(
        `[wiring] 会话索引对账失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 设备在场查询（open 相位 fire-and-forget；失败保持 null = 未知，不伪造 0） */
  private async queryDevicePresence(): Promise<void> {
    try {
      const result = await this.gateway.invoke<{ devices: unknown[] } | null>(
        'remote.listDevices',
        {}
      );
      devicePresenceStore
        .getState()
        .setCount(
          Array.isArray(result?.devices) ? result.devices.length : null
        );
    } catch (err) {
      console.warn(
        `[wiring] 设备在场查询失败（保持未知）：${err instanceof Error ? err.message : String(err)}`
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
    }
  }
}

/** WsPhase → 事件流域连接相位（F3 §3.2.1：live / reconnecting / offline 三态） */
export function feedNetworkOf(phase: WsPhase): FeedNetwork {
  if (phase === 'open') return 'live';
  if (phase === 'reconnecting') return 'reconnecting';
  return 'offline';
}
