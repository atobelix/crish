// @vitest-environment jsdom
/**
 * Wave 2 W2-6 契约测试：三方合并增量写屏障 (3-Way Merge & Delta Write Barrier)
 * 彻底根除 VULN-06 降级数据丢失。
 *
 * 核心验证矩阵：
 * 1. 增量写屏障：放行增量写入，拦截空冲刷与孤儿清空；
 * 2. 集合论无损合并器：新建会话保活并按活动时间置顶，历史会话完整恢复；
 * 3. 属性与消息合并：同一会话消息通过 mergeMessagesById 无损合流，元数据与用户标题优先；
 * 4. 时间戳规范化与排序一致性：全量产出合规 ISO 格式，排序严格单调；
 * 5. hydrateSessionsFromRust & persistAllSessionsRust 端到端防线集成。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionState,
  SessionMessage,
  SessionAgent,
} from '../../store/types';
import {
  sessionDeltaWriteBarrier,
  SessionDeltaWriteBarrier,
  reconcileLateArrivalSnapshot,
  getSessionActivityTime,
} from './sessionDeltaWriteBarrier';
import {
  hydrateSessionsFromRust,
  persistAllSessionsRust,
  __resetSessionBodyDirtyForTests,
} from './sessionRustDbHydrate';
import { mockTauriCommand } from '../../test-setup';
import {
  DEFAULT_SESSION_FOLDER,
  SESSION_INDEX_KEY,
  SESSION_ACTIVE_KEY,
} from './sessionPersistenceTypes';

function makeMsg(id: string, text: string, ts: number): SessionMessage {
  return {
    id,
    sender: 'user',
    text,
    timestamp: ts,
    status: 'completed',
  };
}

function makeSession(
  id: string,
  title: string,
  messages: SessionMessage[] = [],
  overrides?: Partial<SessionState>
): SessionState {
  const ts =
    messages.length > 0 && messages[messages.length - 1]?.timestamp
      ? new Date(
          messages[messages.length - 1].timestamp as number
        ).toISOString()
      : new Date(1_700_000_000_000).toISOString();

  return {
    id,
    title,
    folder: DEFAULT_SESSION_FOLDER,
    isPinned: false,
    isArchived: false,
    timestamp: ts,
    messages,
    messageCount: messages.length,
    messagesHydrated: true,
    ...overrides,
  };
}

describe('W2-6: sessionDeltaWriteBarrier 细粒度增量写屏障', () => {
  let barrier: SessionDeltaWriteBarrier;

  beforeEach(() => {
    barrier = new SessionDeltaWriteBarrier();
  });

  it('初始未水合或降级状态下：拦截全量清空型覆写，放行单会话增量写入', () => {
    barrier.setFallbackMode(true);
    expect(barrier.getIsFallbackMode()).toBe(true);
    expect(barrier.getIsHydrated()).toBe(false);

    // 空会话列表的全量持久化冲刷：必须拦截！
    expect(barrier.shouldBlockWrite('full_session_index', [])).toBe(true);
    expect(barrier.shouldBlockWrite('full_session_index', null)).toBe(true);

    // 孤儿清理：必须拦截（防止抹杀磁盘已有历史）！
    expect(barrier.shouldBlockWrite('orphan_cleanup', new Set(['s-new']))).toBe(
      true
    );

    // 单会话增量写入（用户在降级期创建新会话或发送新消息）：100% 放行！
    expect(
      barrier.shouldBlockWrite('single_session_delta', { id: 's-new' })
    ).toBe(false);
  });

  it('用户新建会话时正常放行，并支持登记与查询', () => {
    barrier.setFallbackMode(true);

    const sNew = makeSession('s-user-created', '新建工作会话');
    barrier.registerCreatedSession(sNew);

    expect(barrier.isNewlyCreatedSession('s-user-created')).toBe(true);
    expect(barrier.isNewlyCreatedSession('s-non-existent')).toBe(false);
    expect(barrier.getNewlyCreatedSessionIds().has('s-user-created')).toBe(
      true
    );
    expect(
      barrier.getLiveSessions().some((s) => s.id === 's-user-created')
    ).toBe(true);

    // 针对新会话的增量写入放行
    expect(barrier.shouldBlockWrite('single_session_delta', sNew)).toBe(false);
  });

  it('水合完成并退出降级后：全量覆写与孤儿清理全面放行', () => {
    barrier.setFallbackMode(true);
    expect(barrier.shouldBlockWrite('full_session_index', [])).toBe(true);

    // 标记水合完成
    barrier.setHydrated(true);
    expect(barrier.getIsHydrated()).toBe(true);
    expect(barrier.getIsFallbackMode()).toBe(false);

    // 正常状态下一律不拦截
    expect(barrier.shouldBlockWrite('full_session_index', [])).toBe(false);
    expect(barrier.shouldBlockWrite('orphan_cleanup', new Set())).toBe(false);
    expect(barrier.shouldBlockWrite('single_session_delta')).toBe(false);
  });

  it('reset() 能正确清空内部状态', () => {
    barrier.setFallbackMode(true);
    barrier.setHydrated(true);
    barrier.registerCreatedSession('test-id');

    barrier.reset();
    expect(barrier.getIsFallbackMode()).toBe(false);
    expect(barrier.getIsHydrated()).toBe(false);
    expect(barrier.getNewlyCreatedSessionIds().size).toBe(0);
    expect(barrier.getLiveSessions().length).toBe(0);
  });
});

describe('W2-6: reconcileLateArrivalSnapshot 集合论无损合并器', () => {
  it('防冲刷抹除：迟到磁盘快照到达时，现场新建会话不被抹除且置顶，历史会话完整恢复', () => {
    // 用户在水合延迟期间新建的活跃会话
    const liveNewSession = makeSession('user-new-1', '用户新建的重要任务', [
      makeMsg('m-live-1', '请帮我优化存储层', 1_700_000_100_000),
    ]);

    // 迟到的磁盘快照（包含 2 个历史会话）
    const diskSnapshot = [
      makeSession('hist-1', '历史分析报告', [
        makeMsg('m-disk-1', '初始调研结论', 1_700_000_010_000),
      ]),
      makeSession('hist-2', '日常周报', [
        makeMsg('m-disk-2', '本周工作进度', 1_700_000_005_000),
      ]),
    ];

    const result = reconcileLateArrivalSnapshot(diskSnapshot, [liveNewSession]);

    // 1. 会话总数集合求并：1 新建 + 2 历史 = 3，0 丢失！
    expect(result.length).toBe(3);
    const ids = result.map((s) => s.id);
    expect(ids).toContain('user-new-1');
    expect(ids).toContain('hist-1');
    expect(ids).toContain('hist-2');

    // 2. 置顶规则：现场新建的会话排在最前列（索引 0）
    expect(result[0].id).toBe('user-new-1');
    expect(result[0].title).toBe('用户新建的重要任务');
    expect(result[0].messages).toHaveLength(1);

    // 3. 历史会话紧随其后且保持完整
    expect(result[1].id).toBe('hist-1');
    expect(result[1].messages).toHaveLength(1);
    expect(result[2].id).toBe('hist-2');
    expect(result[2].messages).toHaveLength(1);

    // 4. activeSessionId 正确解析为新建置顶会话
    expect(result.activeSessionId).toBe('user-new-1');
  });

  it('多个新建会话时，按最晚活动时间降序置顶排列', () => {
    const liveEarly = makeSession('new-early', '早期新建会话', [
      makeMsg('m-e1', '早点发的内容', 1_700_000_050_000),
    ]);
    const liveLate = makeSession('new-late', '晚期新建会话', [
      makeMsg('m-l1', '刚发的新内容', 1_700_000_090_000),
    ]);

    const diskSnapshot = [
      makeSession('hist-1', '历史数据', [
        makeMsg('m-h1', '很久以前', 1_700_000_010_000),
      ]),
    ];

    const result = reconcileLateArrivalSnapshot(diskSnapshot, [
      liveEarly,
      liveLate,
    ]);

    expect(result.length).toBe(3);
    // new-late 活动时间 1_700_000_090_000 > new-early 1_700_000_050_000
    expect(result[0].id).toBe('new-late');
    expect(result[1].id).toBe('new-early');
    expect(result[2].id).toBe('hist-1');
  });

  it('属性与消息无损合并：同一会话历史消息与即时消息合流，用户标题优先', () => {
    // 磁盘快照上的某会话：包含 2 条历史消息
    const diskSession = makeSession(
      'sess-shared',
      '新会话', // 磁盘上还是默认标题
      [
        makeMsg('m-hist-1', '历史消息 1', 1_700_000_010_000),
        makeMsg('m-hist-2', '历史消息 2', 1_700_000_020_000),
      ],
      {
        folder: '项目A',
        isPinned: false,
        pinnedMessageIds: ['m-hist-1'],
      }
    );

    // 用户在降级期间打开该会话，修改了标题为自命名，并发送了第 3 条消息
    const liveSession = makeSession(
      'sess-shared',
      '重构方案讨论', // 用户自命名标题
      [makeMsg('m-live-3', '用户新发送的第三条消息', 1_700_000_030_000)],
      {
        titleSource: 'user',
        folder: '重构工作区',
        isPinned: true,
        pinnedMessageIds: ['m-live-3'],
      }
    );

    const result = reconcileLateArrivalSnapshot([diskSession], [liveSession]);

    expect(result.length).toBe(1);
    const merged = result[0];

    // 1. 消息无损合并：m-hist-1, m-hist-2, m-live-3 全部存在，3 条消息 0 丢失
    expect(merged.messages).toHaveLength(3);
    const msgIds = merged.messages.map((m) => m.id);
    expect(msgIds).toEqual(['m-hist-1', 'm-hist-2', 'm-live-3']);
    expect(merged.messageCount).toBe(3);

    // 2. 标题采用用户的修改
    expect(merged.title).toBe('重构方案讨论');
    expect(merged.titleSource).toBe('user');

    // 3. 元数据无损求并：保留置顶与文件夹
    expect(merged.isPinned).toBe(true);
    expect(merged.folder).toBe('重构工作区');
    expect(merged.pinnedMessageIds).toContain('m-hist-1');
    expect(merged.pinnedMessageIds).toContain('m-live-3');
  });

  it('协作子代理 (Agents) 列表无损合并', () => {
    const agentDisk: SessionAgent = {
      id: 'agent-1',
      description: '代码检索',
      mode: 'explore',
      status: 'completed',
      messages: [makeMsg('m-ag-1', '检索完成', 1_700_000_010_000)],
      startedAt: 1_700_000_000_000,
    };

    const agentLive: SessionAgent = {
      id: 'agent-2',
      description: '方案执行',
      mode: 'implement',
      status: 'running',
      messages: [makeMsg('m-ag-2', '正在生成修改', 1_700_000_050_000)],
      startedAt: 1_700_000_040_000,
    };

    const diskSession = makeSession('s-agent-test', '协作会话', [], {
      agents: [agentDisk],
    });
    const liveSession = makeSession('s-agent-test', '协作会话', [], {
      agents: [agentLive],
    });

    const result = reconcileLateArrivalSnapshot([diskSession], [liveSession]);
    expect(result.length).toBe(1);
    expect(result[0].agents).toHaveLength(2);
    expect(result[0].agents?.map((a) => a.id)).toEqual(['agent-1', 'agent-2']);
  });

  it('合并后所有会话的时间戳规范化为合法 ISO 字符串', () => {
    const diskSession = makeSession('s-ts-1', '测试1', [], {
      timestamp: '2026-08-01T00:00:00.000Z',
    });
    const liveSession = makeSession('s-ts-2', '测试2', [], {
      timestamp: '2026-08-02T12:00:00.000Z',
    });

    const result = reconcileLateArrivalSnapshot([diskSession], [liveSession]);
    for (const s of result) {
      expect(s.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const parsed = Date.parse(s.timestamp);
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed).toBeGreaterThan(0);
    }
  });

  it('支持传入对象入参与数组入参两种形态，并正确返回 ReconcileResult 双重接口', () => {
    const diskObj = {
      sessions: [makeSession('d1', '磁盘1')],
      activeSessionId: 'd1',
      folderOrder: ['常规会话', '归档'],
    };
    const liveObj = {
      sessions: [makeSession('l1', '内存1')],
      activeSessionId: 'l1',
      folderOrder: ['常用项目'],
    };

    const res = reconcileLateArrivalSnapshot(diskObj, liveObj);

    // 作为数组消费
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(2);

    // 作为结构化对象消费
    expect(res.sessions.length).toBe(2);
    expect(res.activeSessionId).toBe('l1'); // 现场优先
    expect(res.folderOrder).toContain('常用项目');
    expect(res.folderOrder).toContain('常规会话');
  });

  it('退化边界：单侧为空或双侧全空时的健全表现', () => {
    const live = [makeSession('l1', '仅现场')];
    const disk = [makeSession('d1', '仅磁盘')];

    // 磁盘为空
    const resDiskEmpty = reconcileLateArrivalSnapshot([], live);
    expect(resDiskEmpty.length).toBe(1);
    expect(resDiskEmpty[0].id).toBe('l1');

    // 现场为空
    const resLiveEmpty = reconcileLateArrivalSnapshot(disk, []);
    expect(resLiveEmpty.length).toBe(1);
    expect(resLiveEmpty[0].id).toBe('d1');

    // 双空
    const resAllEmpty = reconcileLateArrivalSnapshot([], []);
    expect(resAllEmpty.length).toBe(0);
  });
});

describe('W2-6: sessionRustDbHydrate 接入端到端链路验证', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetSessionBodyDirtyForTests();
    sessionDeltaWriteBarrier.reset();
  });

  it('hydrateSessionsFromRust 传入 liveSessions 时，自动无损合并迟到快照与现场会话', async () => {
    // 模拟磁盘上有 1 个历史会话
    localStorage.setItem(
      SESSION_INDEX_KEY,
      JSON.stringify([
        {
          id: 'hist-sqlite',
          title: '磁盘历史',
          folder: DEFAULT_SESSION_FOLDER,
          isPinned: false,
          isArchived: false,
          timestamp: new Date(1_700_000_000_000).toISOString(),
          updatedAt: 100,
          messageCount: 1,
        },
      ])
    );

    mockTauriCommand('list_sessions', async () => []);
    mockTauriCommand('load_session_body', async () => [
      {
        id: 'm-h',
        sender: 'user',
        text: '历史正文',
        timestamp: 1_700_000_000_001,
      },
    ]);
    mockTauriCommand('load_session_agents', async () => []);
    mockTauriCommand('get_session_meta', async () => null);

    // 现场会话（延迟水合期间用户新建）
    const liveSession = makeSession('live-user-session', '现场用户新建', [
      makeMsg('m-live', '用户新打的文字', 1_700_000_100_000),
    ]);

    // 调用水合链路，传入现场会话
    const res = await hydrateSessionsFromRust({ liveSessions: [liveSession] });

    // 断言两边会话无损合并：现场新建置顶 + 历史会话保留
    expect(res.sessions.length).toBe(2);
    expect(res.sessions[0].id).toBe('live-user-session');
    expect(res.sessions[1].id).toBe('hist-sqlite');

    // 水合完成后写屏障状态恢复正常
    expect(sessionDeltaWriteBarrier.getIsHydrated()).toBe(true);
    expect(sessionDeltaWriteBarrier.getIsFallbackMode()).toBe(false);
  });

  it('persistAllSessionsRust 在降级模式下，空列表全量持久化被写屏障拦截保护，不冲刷磁盘', async () => {
    sessionDeltaWriteBarrier.setFallbackMode(true);

    let listSessionsCalled = false;
    mockTauriCommand('list_sessions', async () => {
      listSessionsCalled = true;
      return [];
    });

    // 传入空列表试图全量冲刷
    await persistAllSessionsRust([], '', []);

    // 写屏障在执行 IPC probe 之前已直接拦截返回
    expect(listSessionsCalled).toBe(false);
  });

  it('persistAllSessionsRust 在降级模式下，用户新建会话的增量消息和 agents 正常落盘', async () => {
    sessionDeltaWriteBarrier.setFallbackMode(true);

    const savedBodies: Record<string, unknown[]> = {};
    const savedAgents: Record<string, unknown[]> = {};

    mockTauriCommand('list_sessions', async () => [{ id: 'probe-ok' }]);
    mockTauriCommand('save_session_body', async (args) => {
      const { sessionId, messages } = args as any;
      savedBodies[sessionId] = messages;
      return { status: 'ok' };
    });
    mockTauriCommand('save_session_agents', async (args) => {
      const { sessionId, agents } = args as any;
      savedAgents[sessionId] = agents;
      return { status: 'ok' };
    });
    mockTauriCommand('set_session_meta', async () => ({ status: 'ok' }));
    mockTauriCommand('cleanup_orphan_sessions', async () => ({ status: 'ok' }));

    const newSession = makeSession('user-new-sess', '新会话', [
      makeMsg('m-new', '新建会话的重要内容', 1_700_000_000_100),
    ]);

    // 执行持久化
    await persistAllSessionsRust([newSession], 'user-new-sess', [
      DEFAULT_SESSION_FOLDER,
    ]);

    // 单会话增量写入正常放行落盘！
    expect(savedBodies['user-new-sess']).toBeDefined();
    expect(savedBodies['user-new-sess']).toHaveLength(1);
    expect((savedBodies['user-new-sess'][0] as any).text).toBe(
      '新建会话的重要内容'
    );
  });
});
