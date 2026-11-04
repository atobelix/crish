// 抽屉会话列表三态裁决（批 D，2026-11-03；批 A ContentState 家族在
// 抽屉侧的消费面 + 深比 02-5/06-4 防闪口径）：
// - 有行即内容：状态面永不覆盖已到手的数据（后台刷新不闪、断线保留
//   的快照照常呈现——与同步呈现裁决同律）；
// - 数据未到不先闪空态：远端冷启（已连接、从未对账成功、对账未失败）
//   与本地未水合都先落「加载中」，空态只在数据面已定局时出现；
// - 错误只在列表为空时占面（有行时的同步失败走主页悬浮面，不在
//   列表里重复呈现——同步板裁决）；
// - 空态文案沿既有分区口径（搜索无果 / 本地恒「还没有会话」/ 远端
//   未连接用连接文案），本函数只做状态裁决、不造新文案。
// 「加载中」的实际出画还须过防闪窗（useDelayedFlag +
// DRAWER_LIST_LOADING_DELAY_MS）：窗内呈现空白（blank），数据在窗内
// 到达则直接出内容/空态，加载面不闪现。
import type { SessionSyncStatus } from '@/domain/store/connectionStore';
import type { DrawerPartition } from '@/domain/pure/drawerRows';

export type DrawerListState =
  | { kind: 'content' }
  | { kind: 'loading'; label: string }
  | { kind: 'error' }
  | { kind: 'empty'; text: string };

/** 呈现态 = 裁决态 + 防闪窗内的空白态 */
export type DrawerListViewState = DrawerListState | { kind: 'blank' };

export interface DrawerListStateInput {
  partition: DrawerPartition;
  /** 当前分区的行数（搜索过滤后；>0 恒为内容态） */
  rowCount: number;
  query: string;
  connected: boolean;
  syncStatus: SessionSyncStatus;
  /** 最近一次对账成功时刻 ms（从未成功 = null） */
  lastReconcileAt: number | null;
  /** 本地线程元数据是否已水合 */
  localHydrated: boolean;
}

/**
 * 加载防闪窗（ms）：状态持续未定局超过此窗才出加载面。此为时序门
 * 常量（同 Sheet 键盘交接超时先例），非动画时长，不入 theme.motion。
 */
export const DRAWER_LIST_LOADING_DELAY_MS = 200;

export function deriveDrawerListState(
  input: DrawerListStateInput
): DrawerListState {
  if (input.rowCount > 0) return { kind: 'content' };
  const searching = input.query.trim().length > 0;
  if (input.partition === 'local') {
    if (!input.localHydrated) {
      return { kind: 'loading', label: '正在加载本地会话…' };
    }
    return {
      kind: 'empty',
      text: searching ? '没有匹配的会话' : '还没有会话',
    };
  }
  // 远端分区
  if (!input.connected) {
    return {
      kind: 'empty',
      text: searching ? '没有匹配的会话' : '连接桌面后同步会话',
    };
  }
  if (
    input.lastReconcileAt === null &&
    (input.syncStatus === 'idle' || input.syncStatus === 'syncing')
  ) {
    // 冷启首拉未回：数据未到，先加载、不闪空态
    return { kind: 'loading', label: '正在同步会话…' };
  }
  if (input.syncStatus === 'error' && !searching) {
    return { kind: 'error' };
  }
  return {
    kind: 'empty',
    text: searching ? '没有匹配的会话' : '还没有会话',
  };
}
