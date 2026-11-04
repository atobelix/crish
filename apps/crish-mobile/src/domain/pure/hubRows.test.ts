// 主界面状态板行选择单测（用户裁决 2026-11-02，取代 hub 全量同列）：
// - 资格：仅 待审批 / 运行中（含本地生成中）/ 本次连接后完成 三类入板；
//   连接前完成的历史对话、无打点的普通会话一律不入（在完整列表页）；
// - 优先级 审批 > 运行中 > 刚完成，同一对话只出现一次；总数上限 4；
// - 分区：远端行只来自输入（当前设备列表），本地行不随远端输入变化。
import {
  selectStatusBoardRows,
  STATUS_BOARD_LIMIT,
  type HubLocalThreadInput,
} from './hubRows';
import type { SessionSummary } from '../store/sessionReducers';
import type { LocalThreadMeta } from '../types/localChat';

const NOW = 1_800_000_000_000;
/** 本次连接纪元（测试基准） */
const EPOCH = NOW - 10_000;

function remote(
  overrides: Partial<SessionSummary> & { id: string }
): SessionSummary {
  const { id, ...rest } = overrides;
  return {
    id,
    updatedAt: NOW,
    receivedAtMs: NOW,
    lastReadSequence: 0,
    unreadCount: 0,
    activeRunIds: [],
    pendingApprovalCount: 0,
    completedAtMs: null,
    ...rest,
  };
}

function local(
  id: string,
  updatedAt: number,
  opts: { streaming?: boolean; completedAtMs?: number | null } = {}
): HubLocalThreadInput {
  const meta: LocalThreadMeta = {
    id,
    title: `本地 ${id}`,
    titleSource: 'derived',
    preview: '',
    modelRef: null,
    createdAt: updatedAt,
    updatedAt,
  };
  return {
    meta,
    streaming: opts.streaming ?? false,
    completedAtMs: opts.completedAtMs ?? null,
  };
}

function board(
  remoteSessions: SessionSummary[],
  localThreads: HubLocalThreadInput[] = [],
  connectedSinceMs: number | null = EPOCH
) {
  return selectStatusBoardRows({
    remoteSessions,
    localThreads,
    connectedSinceMs,
  });
}

describe('selectStatusBoardRows 资格', () => {
  it('三类入板：待审批 / 运行中 / 本次连接后完成；段序 审批 > 运行 > 完成', () => {
    const rows = board([
      remote({ id: 'done', completedAtMs: NOW - 100, updatedAt: NOW - 100 }),
      remote({ id: 'run', activeRunIds: ['r1'], updatedAt: NOW - 200 }),
      remote({ id: 'pend', pendingApprovalCount: 1, updatedAt: NOW - 300 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['pend', 'run', 'done']);
  });

  it('历史完成不入：完成打点早于连接纪元、无打点、普通空闲会话、仅置顶都落选', () => {
    const rows = board([
      remote({ id: 'old-done', completedAtMs: EPOCH - 1 }),
      remote({ id: 'no-stamp', completedAtMs: null }),
      remote({ id: 'idle', updatedAt: NOW - 50 }),
      remote({ id: 'pin-only', isPinned: true, updatedAt: NOW - 10 }),
    ]);
    expect(rows).toEqual([]);
  });

  it('纪元为 null（未连接）：远端完成一律不入；审批/运行仍按数据面呈现', () => {
    const rows = board(
      [
        remote({ id: 'done', completedAtMs: NOW - 100 }),
        remote({ id: 'pend', pendingApprovalCount: 2 }),
      ],
      [],
      null
    );
    expect(rows.map((r) => r.id)).toEqual(['pend']);
  });

  it('本地线程：生成中入运行段、本进程完成入完成段、无状态不入', () => {
    const rows = board(
      [],
      [
        local('l-run', NOW - 100, { streaming: true }),
        local('l-done', NOW - 900, { completedAtMs: NOW - 150 }),
        local('l-idle', NOW - 50),
      ]
    );
    expect(rows.map((r) => r.id)).toEqual(['l-run', 'l-done']);
    expect(rows[0]).toMatchObject({ kind: 'local', streaming: true });
  });

  it('去重：同时待审批且运行中的远端会话只出现一次（归审批段）', () => {
    const rows = board([
      remote({
        id: 'both',
        pendingApprovalCount: 1,
        activeRunIds: ['r1'],
        updatedAt: NOW - 10,
      }),
      remote({ id: 'run', activeRunIds: ['r2'], updatedAt: NOW - 5 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['both', 'run']);
  });

  it('完成段按完成时刻降序（非更新时刻）：刚完成的在前', () => {
    const rows = board([
      remote({
        id: 'done-early',
        completedAtMs: NOW - 800,
        updatedAt: NOW - 10,
      }),
      remote({
        id: 'done-late',
        completedAtMs: NOW - 100,
        updatedAt: NOW - 900,
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['done-late', 'done-early']);
  });

  it('空输入产出空板', () => {
    expect(board([], [])).toEqual([]);
  });
});

describe('selectStatusBoardRows 上限与分区', () => {
  it('总数上限 4：低优先级段先被截断（审批与运行保全）', () => {
    const rows = board([
      remote({ id: 'p1', pendingApprovalCount: 1, updatedAt: NOW - 10 }),
      remote({ id: 'p2', pendingApprovalCount: 1, updatedAt: NOW - 20 }),
      remote({ id: 'r1', activeRunIds: ['a'], updatedAt: NOW - 30 }),
      remote({ id: 'r2', activeRunIds: ['b'], updatedAt: NOW - 40 }),
      remote({ id: 'd1', completedAtMs: NOW - 50 }),
      remote({ id: 'd2', completedAtMs: NOW - 60 }),
    ]);
    expect(rows).toHaveLength(STATUS_BOARD_LIMIT);
    expect(rows.map((r) => r.id)).toEqual(['p1', 'p2', 'r1', 'r2']);
  });

  it('设备分区：远端行只来自输入集合；本地合格行不随远端输入变化', () => {
    const locals = [
      local('l-run', NOW - 10, { streaming: true }),
      local('l-idle', NOW - 20),
    ];
    const rowsA = board(
      [remote({ id: 'a1', pendingApprovalCount: 1 })],
      locals
    );
    const rowsB = board([remote({ id: 'b1', activeRunIds: ['r'] })], locals);
    expect(rowsA.filter((r) => r.kind === 'remote').map((r) => r.id)).toEqual([
      'a1',
    ]);
    expect(rowsB.filter((r) => r.kind === 'remote').map((r) => r.id)).toEqual([
      'b1',
    ]);
    expect(rowsA.filter((r) => r.kind === 'local').map((r) => r.id)).toEqual(
      rowsB.filter((r) => r.kind === 'local').map((r) => r.id)
    );
  });
});
