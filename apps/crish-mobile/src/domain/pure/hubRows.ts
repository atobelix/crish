// 主界面状态板行选择（用户裁决 2026-11-02，取代 CON-4 的 hub 全量同列）：
// 「主界面是显示状态用的，不是消息列表」——只收三类对话，总数上限 4：
//   (a) 待审批的远端会话；
//   (b) 正在运行的对话（远端活动 run + 正在生成的本地线程）；
//   (c) 本次连接建立之后才完成的对话（远端以 completedAtMs >= 连接纪元
//       connectedSinceMs 为凭；本地线程以本进程内完成打点为凭）。
// 优先级 审批 > 运行中 > 刚完成；同一对话只出现一次（取最高资格段）。
// 连接前完成的历史对话一律不进——它们在完整会话列表页（抽屉/会话页）。
// 分区纪律不变：远端输入仅限当前所选设备的列表（sessionStore 设备作用域
// 保证）；本地线程是手机自身分区，不受设备切换影响。
import type { SessionSummary } from '../store/sessionReducers';
import type { LocalThreadMeta } from '../types/localChat';

/** 状态板行：远端会话行（当前设备作用域） */
export interface HubRemoteRow {
  kind: 'remote';
  id: string;
  updatedAt: number;
  session: SessionSummary;
}

/** 状态板行：本地线程行（手机自身分区） */
export interface HubLocalRow {
  kind: 'local';
  id: string;
  updatedAt: number;
  thread: LocalThreadMeta;
  /** 该线程正在生成（进「运行中」段） */
  streaming: boolean;
}

export type HubRow = HubRemoteRow | HubLocalRow;

/** 本地线程的状态板输入（元数据 + 生成态 + 本进程完成打点） */
export interface HubLocalThreadInput {
  meta: LocalThreadMeta;
  streaming: boolean;
  /** 本进程内最近一次生成完成时刻 ms；null = 本进程内未完成过 */
  completedAtMs: number | null;
}

/** 状态板总数上限（用户口径「最多三四个」） */
export const STATUS_BOARD_LIMIT = 4;

export interface StatusBoardInput {
  /** 当前设备作用域的远端会话（本地模式下调用方传空数组） */
  remoteSessions: readonly SessionSummary[];
  /** 本地线程（手机自身分区，恒参与） */
  localThreads: readonly HubLocalThreadInput[];
  /** 本次连接纪元起点 ms（connectionStore.connectedSinceMs）；null = 未连接 */
  connectedSinceMs: number | null;
  /**
   * 前景本地线程 id（任务 4 · C 步）：主页刚发送并已提交导航前往的线程。
   * 导航落地前主页仍挂载的这一轮渲染里，该线程是前景目的地而不是后台
   * 状态——不进状态板，避免「先闪一行任务动态、再切换进会话」的双切换。
   * 抑制只由调用方在导航窗口内传入，失焦即撤（见 homeScreen 接线）。
   * 缺省/为 null = 不抑制。
   */
  foregroundLocalThreadId?: string | null;
  /**
   * 远端等待 ACK 期间的基线 id 快照（任务 4 · C 步）：非 null 时，远端
   * 段只收快照内已存在的会话——等待窗口内新出现的远端会话（本次提交
   * 尚未 ACK 的会话、或窗口内他处新建的会话）一律不插进状态板，导航
   * 只认 ACK 回执里的真实 sessionId。null = 不在等待期、不抑制。
   */
  pendingRemoteBaselineIds?: ReadonlySet<string> | null;
}

interface BoardCandidate {
  row: HubRow;
  /** 段内排序键（审批/运行段 = 更新时刻；完成段 = 完成时刻；降序） */
  sortKey: number;
}

function bySortKeyDesc(a: BoardCandidate, b: BoardCandidate): number {
  if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
}

/**
 * 状态板行选择（纯函数）：审批段 → 运行段 → 完成段，截断到 STATUS_BOARD_LIMIT。
 * 远端完成资格严格要求完成打点存在且不早于连接纪元——历史完成（无打点或
 * 打点属于上一次连接）在纪元外，天然落选。
 */
export function selectStatusBoardRows(input: StatusBoardInput): HubRow[] {
  const approvals: BoardCandidate[] = [];
  const running: BoardCandidate[] = [];
  const completed: BoardCandidate[] = [];
  const placedRemote = new Set<string>();
  const placedLocal = new Set<string>();

  // 等待 ACK 窗口：远端输入先按基线快照过滤（三段共用同一份过滤结果）
  const remoteSessions = input.pendingRemoteBaselineIds
    ? input.remoteSessions.filter((s) =>
        input.pendingRemoteBaselineIds!.has(s.id)
      )
    : input.remoteSessions;

  for (const session of remoteSessions) {
    const row: HubRemoteRow = {
      kind: 'remote',
      id: session.id,
      updatedAt: session.updatedAt ?? session.receivedAtMs,
      session,
    };
    if (session.pendingApprovalCount > 0) {
      approvals.push({ row, sortKey: row.updatedAt });
      placedRemote.add(session.id);
    } else if (session.activeRunIds.length > 0) {
      running.push({ row, sortKey: row.updatedAt });
      placedRemote.add(session.id);
    }
  }
  for (const session of remoteSessions) {
    if (placedRemote.has(session.id)) continue;
    const completedAtMs = session.completedAtMs ?? null;
    if (
      completedAtMs !== null &&
      input.connectedSinceMs !== null &&
      completedAtMs >= input.connectedSinceMs
    ) {
      completed.push({
        row: {
          kind: 'remote',
          id: session.id,
          updatedAt: session.updatedAt ?? session.receivedAtMs,
          session,
        },
        sortKey: completedAtMs,
      });
      placedRemote.add(session.id);
    }
  }
  for (const local of input.localThreads) {
    // 前景抑制：刚发送并已提交导航的线程不作后台状态行（任务 4 · C 步）
    if (
      input.foregroundLocalThreadId != null &&
      local.meta.id === input.foregroundLocalThreadId
    ) {
      continue;
    }
    const row: HubLocalRow = {
      kind: 'local',
      id: local.meta.id,
      updatedAt: local.meta.updatedAt,
      thread: local.meta,
      streaming: local.streaming,
    };
    if (local.streaming) {
      running.push({ row, sortKey: local.meta.updatedAt });
      placedLocal.add(local.meta.id);
    } else if (local.completedAtMs !== null) {
      completed.push({ row, sortKey: local.completedAtMs });
      placedLocal.add(local.meta.id);
    }
  }

  approvals.sort(bySortKeyDesc);
  running.sort(bySortKeyDesc);
  completed.sort(bySortKeyDesc);
  return [...approvals, ...running, ...completed]
    .slice(0, STATUS_BOARD_LIMIT)
    .map((candidate) => candidate.row);
}
