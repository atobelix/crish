// 抽屉会话列表行组装（分区口径，用户裁决 2026-11-03，取代 U3 混排）：
// 本地是本地、远程是远程——列表只呈现当前生效目标的一个分区：
// - 分区 = 本机：只有本地线程行（今天 / 更早分组，组内按活跃时刻降序）；
// - 分区 = 远端设备：只有该设备的远端会话行——过滤沿用
//   sessionList.filterSessions、分组沿用 groupSessionsByDay，远端行
//   之间的相对次序与既有抽屉完全一致（本函数对远端零行为变化）。
// 另一分区的数据不进列表；分区身份由抽屉会话区标题的目标名表达
// （与主页设备胶囊同源），行上不再挂「本地」标识。
// 出口附 remoteTotal / localTotal（未过滤计数）作事实：空态判定由
// VM 按当前分区取用，另一分区的存量不影响本分区的空态。
import type { SessionSummary } from '../store/sessionReducers';
import type { LocalThreadMeta } from '../types/localChat';
import {
  filterSessions,
  groupSessionsByDay,
  sessionActivityMs,
  startOfLocalDay,
} from './sessionList';

/** 抽屉分区：当前生效目标——本机（本地线程）或远端设备（远端会话） */
export type DrawerPartition = 'local' | 'remote';

/** 抽屉行：远端会话行（当前设备作用域，session 原样透传） */
export interface DrawerRemoteRow {
  kind: 'remote';
  id: string;
  /** 活跃时刻（sessionActivityMs：updatedAt 优先，收达时刻兜底） */
  updatedAt: number;
  session: SessionSummary;
}

/** 抽屉行：本地线程行（手机自身分区） */
export interface DrawerLocalRow {
  kind: 'local';
  id: string;
  updatedAt: number;
  thread: LocalThreadMeta;
  /** 该线程正在生成（行上呼吸点） */
  streaming: boolean;
  /** 该线程最近一次生成以失败收场（运行时 error 在场且不在生成中，批 D） */
  failed: boolean;
}

export type DrawerRow = DrawerRemoteRow | DrawerLocalRow;

/** 本地线程的抽屉输入（元数据 + 生成态；备料在 VM 层，与 hub 同源派生） */
export interface DrawerLocalThreadInput {
  meta: LocalThreadMeta;
  streaming: boolean;
  /** 最近一次生成失败（运行时 error 派生在 VM 层，与行呈现同源） */
  failed: boolean;
}

export interface DrawerRowsInput {
  /** 当前生效目标的分区（设备身份派生在 VM 层，与设备胶囊同源） */
  partition: DrawerPartition;
  /** 可见远端会话（归档已过滤；顺序 = store 呈现序，分区内原样保留） */
  remoteSessions: readonly SessionSummary[];
  /** 本地线程（手机自身分区） */
  localThreads: readonly DrawerLocalThreadInput[];
  query: string;
  /** 远端搜索预览（与 filterSessions 同注入面） */
  previewOf: (sessionId: string) => string;
  nowMs: number;
}

export interface DrawerRowsResult {
  today: DrawerRow[];
  earlier: DrawerRow[];
  /** 未过滤的可见远端会话数（空态文案事实） */
  remoteTotal: number;
  /** 未过滤的本地线程数（空态文案事实） */
  localTotal: number;
}

/** 本地行搜索：标题 + 摘要，忽略大小写；空关键词原样返回 */
export function filterLocalThreads(
  threads: readonly DrawerLocalThreadInput[],
  query: string
): readonly DrawerLocalThreadInput[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return threads;
  return threads.filter(
    (t) =>
      t.meta.title.toLowerCase().includes(needle) ||
      t.meta.preview.toLowerCase().includes(needle)
  );
}

function localRowOf(input: DrawerLocalThreadInput): DrawerLocalRow {
  return {
    kind: 'local',
    id: input.meta.id,
    updatedAt: input.meta.updatedAt,
    thread: input.meta,
    streaming: input.streaming,
    failed: input.failed,
  };
}

function remoteRowOf(session: SessionSummary): DrawerRemoteRow {
  return {
    kind: 'remote',
    id: session.id,
    updatedAt: sessionActivityMs(session),
    session,
  };
}

/** 本地线程组内序：活跃时刻降序；同刻以 id 升序兜底（确定性） */
function sortLocalThreads(
  threads: readonly DrawerLocalThreadInput[]
): DrawerLocalThreadInput[] {
  return [...threads].sort((a, b) => {
    if (a.meta.updatedAt !== b.meta.updatedAt) {
      return b.meta.updatedAt - a.meta.updatedAt;
    }
    return a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0;
  });
}

/**
 * 抽屉行组装：只组装当前分区的行——本地分区按日切本地线程（日界与
 * 远端同口径），远端分区走既有远端过滤 + 分组纯函数；另一分区零行。
 */
export function buildDrawerRows(input: DrawerRowsInput): DrawerRowsResult {
  const totals = {
    remoteTotal: input.remoteSessions.length,
    localTotal: input.localThreads.length,
  };
  if (input.partition === 'local') {
    const locals = sortLocalThreads(
      filterLocalThreads(input.localThreads, input.query)
    );
    const dayStart = startOfLocalDay(input.nowMs);
    return {
      today: locals.filter((t) => t.meta.updatedAt >= dayStart).map(localRowOf),
      earlier: locals
        .filter((t) => t.meta.updatedAt < dayStart)
        .map(localRowOf),
      ...totals,
    };
  }
  const remoteGroups = groupSessionsByDay(
    filterSessions(input.remoteSessions, input.query, input.previewOf),
    input.nowMs
  );
  return {
    today: remoteGroups.today.map(remoteRowOf),
    earlier: remoteGroups.earlier.map(remoteRowOf),
    ...totals,
  };
}
