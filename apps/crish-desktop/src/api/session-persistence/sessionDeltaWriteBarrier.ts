/**
 * sessionDeltaWriteBarrier — 会话持久化唯一增量写屏障（SessionDeltaWriteBarrier）
 *
 * 1. 水合门闩（闭环 VULN-06 / Wave 2 W2-6）：初始水合未完成或处于降级模式（fallback_committed）
 *    期间，拦截全量空骨架对磁盘的清空型覆写（full_session_index）与全量孤儿清理（orphan_cleanup），
 *    100% 放行单会话增量写入（single_session_delta）；仅加载局部窗口的会话禁止截断覆写
 *    （windowed_session_truncate，W3-4）。
 * 2. 指纹差分：按单会话指纹与 activeSessionId / folderOrder 判定实质变更，
 *    无变更的防抖写盘直接跳过（initStorePersistence）。
 *
 * 迟到快照合并见 ./sessionLateArrivalMerge；启动回灌 3-Way Merge 见 ./sessionThreeWayMerge；
 * 启动挂起 / 空库熔断见 ./sessionWriteBarriers。
 */

import type { SessionState } from '../../store/types';
import { isPendingDraftSessionId as isPendingDraft } from '@crish/shared-types';

export interface SessionWriteDelta {
  hasChanges: boolean;
  dirtySessionIds: string[];
  removedSessionIds: string[];
  metaChanged: boolean;
}

/**
 * 会话持久化增量写屏障（全应用单例见 sessionDeltaWriteBarrier）
 */
export class SessionDeltaWriteBarrier {
  private isFallbackMode = false;
  private isHydrated = false;
  private newlyCreatedSessionIds = new Set<string>();
  private liveSessionsMap = new Map<string, SessionState>();
  private digestsById = new Map<string, string>();
  private lastActiveSessionId = '';
  private lastFolderOrderKey = '';

  /** 设置是否处于降级模式（如冷启动 1000ms 超时 fallback_committed 阶段） */
  setFallbackMode(fallback: boolean): void {
    this.isFallbackMode = fallback;
  }

  getIsFallbackMode(): boolean {
    return this.isFallbackMode;
  }

  /** 标记水合是否已经完成 */
  setHydrated(hydrated: boolean): void {
    this.isHydrated = hydrated;
    if (hydrated) {
      this.isFallbackMode = false;
    }
  }

  getIsHydrated(): boolean {
    return this.isHydrated;
  }

  /** 登记用户在延迟/降级水合期间新建的会话 */
  registerCreatedSession(sessionOrId: string | SessionState): void {
    if (typeof sessionOrId === 'string') {
      if (sessionOrId && !isPendingDraft(sessionOrId)) {
        this.newlyCreatedSessionIds.add(sessionOrId);
      }
    } else if (sessionOrId?.id && !isPendingDraft(sessionOrId.id)) {
      this.newlyCreatedSessionIds.add(sessionOrId.id);
      this.liveSessionsMap.set(sessionOrId.id, sessionOrId);
    }
  }

  isNewlyCreatedSession(sessionId: string): boolean {
    return this.newlyCreatedSessionIds.has(sessionId);
  }

  getNewlyCreatedSessionIds(): Set<string> {
    return new Set(this.newlyCreatedSessionIds);
  }

  registerLiveSession(session: SessionState): void {
    if (session?.id && !isPendingDraft(session.id)) {
      this.liveSessionsMap.set(session.id, session);
    }
  }

  getLiveSessions(): SessionState[] {
    return Array.from(this.liveSessionsMap.values());
  }

  clearNewlyCreatedSessions(): void {
    this.newlyCreatedSessionIds.clear();
    this.liveSessionsMap.clear();
  }

  /**
   * 细粒度写屏障阻断判定：
   * - 放行单会话增量写入（single_session_delta）：100% 允许用户新建会话正文/增量消息落盘
   * - 拦截全量清空型覆写（full_session_index）：降级/未水合期空会话列表严禁覆写磁盘索引
   * - 拦截孤儿清理（orphan_cleanup）：降级/未水合期严禁全量清理孤儿会话，防止抹杀磁盘历史
   */
  shouldBlockWrite(
    target:
      | 'full_session_index'
      | 'single_session_delta'
      | 'orphan_cleanup'
      | 'windowed_session_truncate',
    payload?: unknown
  ): boolean {
    // 窗口化截断保护：无论是否处于降级期，若会话仅在内存中加载了首屏局部窗口，
    // 严禁执行全量冲刷覆写，防止抹杀未拉取的历史记录 (W3-4 资产安全防线)
    if (target === 'windowed_session_truncate') {
      const p = payload as
        | {
            sessionId?: string;
            currentLength?: number;
            totalCount?: number;
            hasOlderMessages?: boolean;
          }
        | undefined;
      if (p?.hasOlderMessages) {
        return true;
      }
      if (
        typeof p?.totalCount === 'number' &&
        typeof p?.currentLength === 'number' &&
        p.totalCount > p.currentLength
      ) {
        return true;
      }
      return false;
    }

    // 正常水合已完成且非降级期：全面放行
    if (!this.isFallbackMode && this.isHydrated) {
      return false;
    }

    // 增量写入单会话实体：100% 放行！
    if (target === 'single_session_delta') {
      return false;
    }

    // 孤儿清理：在未水合或降级期间必须阻断，防止内存骨架抹杀磁盘历史全量会话
    if (target === 'orphan_cleanup') {
      return true;
    }

    // 全量索引覆写：空列表强行拦截
    if (target === 'full_session_index') {
      const list = payload as unknown[] | undefined;
      if (!list || list.length === 0) {
        return true;
      }
      return false;
    }

    return false;
  }

  /** 单会话写盘指纹：标题 / 文件夹 / 置顶 / 消息数 / 末条消息 / agents 数 */
  static computeSessionDigest(session: SessionState): string {
    const msgs = session.messages ?? [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    return [
      session.id,
      session.title ?? '',
      session.folder ?? '',
      session.isPinned ? '1' : '0',
      String(msgs.length),
      lastMsg?.id ?? '',
      String(lastMsg?.text?.length ?? 0),
      String(session.agents?.length ?? 0),
    ].join('|');
  }

  /** 以当前（已落盘）状态为基线播种指纹，之后的 computeDelta 只报告相对基线的变化 */
  seedFromSessions(
    sessions: readonly SessionState[],
    activeSessionId: string,
    folderOrder: readonly string[]
  ): void {
    this.digestsById.clear();
    for (const s of sessions) {
      if (!s?.id) continue;
      this.digestsById.set(
        s.id,
        SessionDeltaWriteBarrier.computeSessionDigest(s)
      );
    }
    this.lastActiveSessionId = activeSessionId;
    this.lastFolderOrderKey = folderOrder.join('\u0001');
  }

  /** 计算相对上次基线的脏会话 / 删除会话 / 元数据变化；有变化时推进基线 */
  computeDelta(
    sessions: readonly SessionState[],
    activeSessionId: string,
    folderOrder: readonly string[]
  ): SessionWriteDelta {
    const dirtySessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    const nextDigests = new Map<string, string>();

    for (const s of sessions) {
      if (!s?.id) continue;
      const digest = SessionDeltaWriteBarrier.computeSessionDigest(s);
      nextDigests.set(s.id, digest);
      if (this.digestsById.get(s.id) !== digest) {
        dirtySessionIds.push(s.id);
      }
    }

    for (const prevId of this.digestsById.keys()) {
      if (!nextDigests.has(prevId)) {
        removedSessionIds.push(prevId);
      }
    }

    const folderKey = folderOrder.join('\u0001');
    const metaChanged =
      this.lastActiveSessionId !== activeSessionId ||
      this.lastFolderOrderKey !== folderKey;

    const hasChanges =
      dirtySessionIds.length > 0 || removedSessionIds.length > 0 || metaChanged;

    if (hasChanges) {
      this.digestsById = nextDigests;
      this.lastActiveSessionId = activeSessionId;
      this.lastFolderOrderKey = folderKey;
    }

    return {
      hasChanges,
      dirtySessionIds,
      removedSessionIds,
      metaChanged,
    };
  }

  /** 测试辅助：重置屏障状态 */
  reset(): void {
    this.isFallbackMode = false;
    this.isHydrated = false;
    this.newlyCreatedSessionIds.clear();
    this.liveSessionsMap.clear();
    this.digestsById.clear();
    this.lastActiveSessionId = '';
    this.lastFolderOrderKey = '';
  }
}

/** 模块默认单例 */
export const sessionDeltaWriteBarrier = new SessionDeltaWriteBarrier();
